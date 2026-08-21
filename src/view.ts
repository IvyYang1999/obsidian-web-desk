import { ItemView, Menu, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { importUrlAsBookmark } from "./importer";
import { planAutoPositions, readCard, writeDeskFields } from "./layout";
import { ConfirmModal, TextInputModal } from "./modals";
import {
  BookmarkCard,
  CANVAS_BOUND,
  CanvasTransform,
  GROUP_COLORS,
  GroupBox,
  SIZE_LARGE,
  SIZE_MEDIUM,
  SIZE_SMALL,
  VIEW_TYPE_WEB_DESK,
  WebDeskSettings,
} from "./types";
import { colorFromString, faviconUrl, getErrorMessage, isProbablyUrl } from "./util";

export interface WebDeskHost {
  getSettings(): WebDeskSettings;
  getGroups(): GroupBox[];
  setGroups(groups: GroupBox[]): void;
  getTransform(): CanvasTransform;
  setTransform(transform: CanvasTransform): void;
}

interface Point {
  x: number;
  y: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;

export class WebDeskView extends ItemView {
  private readonly host: WebDeskHost;
  private rootEl!: HTMLElement;
  private canvasEl!: HTMLElement;
  private marqueeEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;

  private cards: BookmarkCard[] = [];
  private iconEls = new Map<string, HTMLElement>();
  private groupEls = new Map<string, HTMLElement>();
  private selected = new Set<string>();
  private transform: CanvasTransform = { panX: 0, panY: 0, zoom: 1 };

  /** >0 表示有交互进行中（拖拽/导入），推迟重绘。 */
  private interactionLock = 0;
  private refreshTimer: number | null = null;
  private autoPlaceRunning = false;

  constructor(leaf: WorkspaceLeaf, host: WebDeskHost) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return VIEW_TYPE_WEB_DESK;
  }

  getDisplayText(): string {
    return "网页桌面";
  }

  getIcon(): string {
    return "layout-grid";
  }

  async onOpen(): Promise<void> {
    this.transform = { ...this.host.getTransform() };
    this.buildDom();
    this.registerEvents();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    this.saveTransformNow();
  }

  // ---------- DOM ----------

  private buildDom(): void {
    this.contentEl.empty();
    this.contentEl.addClass("web-desk-view");

    this.rootEl = this.contentEl.createDiv({ cls: "web-desk-root" });
    this.rootEl.tabIndex = 0;

    // 画布 div 锚在 (0,0)，只作 transform 容器；坐标空间以 (0,0) 为中心，
    // 图标可为任意（含负）坐标，由 root 的 overflow:hidden 裁剪出视口。
    // （V1 曾把 div 偏移 -BOUND 却没给图标坐标加偏移，导致所有图标渲染在屏幕外。）
    this.canvasEl = this.rootEl.createDiv({ cls: "web-desk-canvas" });

    this.marqueeEl = this.rootEl.createDiv({ cls: "web-desk-marquee" });
    this.marqueeEl.style.display = "none";

    this.hintEl = this.rootEl.createDiv({ cls: "web-desk-hint" });
    this.hintEl.createDiv({ cls: "web-desk-hint-title", text: "网页桌面" });
    this.hintEl.createDiv({
      cls: "web-desk-hint-body",
      text: "把网页链接拖到这里，或右键画布 → 收藏 URL。像整理电脑桌面一样拖拽归类。",
    });

    const toolbar = this.rootEl.createDiv({ cls: "web-desk-toolbar" });
    const zoomOut = toolbar.createEl("button", { text: "－", cls: "web-desk-tool-btn" });
    this.zoomLabelEl = toolbar.createEl("span", { cls: "web-desk-zoom-label", text: "100%" });
    const zoomIn = toolbar.createEl("button", { text: "＋", cls: "web-desk-tool-btn" });
    const fit = toolbar.createEl("button", { text: "适应", cls: "web-desk-tool-btn" });

    zoomOut.addEventListener("click", () => this.zoomAtCenter(1 / 1.2));
    zoomIn.addEventListener("click", () => this.zoomAtCenter(1.2));
    fit.addEventListener("click", () => this.fitContent());

    this.rootEl.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.rootEl.addEventListener("pointerdown", (event) => this.onCanvasPointerDown(event));
    this.rootEl.addEventListener("contextmenu", (event) => this.onCanvasContextMenu(event));
    this.rootEl.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.rootEl.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    });
    this.rootEl.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.onDrop(event);
    });

    this.applyTransform();
  }

  // ---------- 数据 ----------

  private get settings(): WebDeskSettings {
    return this.host.getSettings();
  }

  private bookmarkFiles(): TFile[] {
    const folder = this.settings.bookmarkFolder;
    const prefix = `${folder}/`;
    return this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(prefix));
  }

  async refresh(): Promise<void> {
    if (this.interactionLock > 0) {
      this.scheduleRefresh(400);
      return;
    }

    this.cards = this.bookmarkFiles()
      .map((file) => readCard(file, this.app, this.settings.defaultIconSize))
      .filter((card): card is BookmarkCard => card !== null);

    await this.autoPlaceNewcomers();
    this.render();
  }

  private scheduleRefresh(delayMs = 300): void {
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
  }

  /** 给没有坐标的卡片（手动移进收藏夹的旧文件）规划网格落点并写回。 */
  private async autoPlaceNewcomers(): Promise<void> {
    const plan = planAutoPositions(this.cards);
    if (plan.size === 0 || this.autoPlaceRunning) {
      return;
    }
    this.autoPlaceRunning = true;
    this.interactionLock += 1;
    try {
      for (const card of this.cards) {
        const pos = plan.get(card.path);
        if (!pos) {
          continue;
        }
        const file = this.app.vault.getAbstractFileByPath(card.path);
        if (file instanceof TFile) {
          await writeDeskFields(this.app, file, { x: pos.x, y: pos.y });
        }
        card.x = pos.x;
        card.y = pos.y;
        card.placed = true;
      }
    } catch (error) {
      new Notice(`自动排布失败：${getErrorMessage(error)}`, 5000);
    } finally {
      this.interactionLock -= 1;
      this.autoPlaceRunning = false;
    }
  }

  private registerEvents(): void {
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (file.path.startsWith(`${this.settings.bookmarkFolder}/`)) {
          this.scheduleRefresh();
        }
      }),
    );
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRefresh()));
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (
          file.path.startsWith(`${this.settings.bookmarkFolder}/`) ||
          oldPath.startsWith(`${this.settings.bookmarkFolder}/`)
        ) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  // ---------- 渲染 ----------

  private render(): void {
    this.iconEls.clear();
    this.groupEls.clear();
    this.canvasEl.empty();

    for (const group of this.host.getGroups()) {
      this.renderGroup(group);
    }
    for (const card of this.cards) {
      this.renderIcon(card);
    }

    this.hintEl.style.display = this.cards.length === 0 ? "flex" : "none";
    this.syncSelection();
  }

  private renderIcon(card: BookmarkCard): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-icon" });
    el.style.left = `${card.x}px`;
    el.style.top = `${card.y}px`;
    el.style.width = `${card.size + 24}px`;

    const thumb = el.createDiv({ cls: "web-desk-icon-thumb" });
    thumb.style.width = `${card.size}px`;
    thumb.style.height = `${card.size}px`;

    if (card.url && card.host) {
      const img = thumb.createEl("img", {
        cls: "web-desk-icon-img",
        attr: { src: faviconUrl(card.host), alt: card.host, draggable: "false" },
      });
      img.addEventListener("error", () => {
        img.remove();
        this.appendLetterBlock(thumb, card);
      });
    } else {
      this.appendLetterBlock(thumb, card);
    }

    const label = el.createDiv({ cls: "web-desk-icon-label", text: card.title });
    label.style.width = `${card.size + 24}px`;

    el.setAttribute("data-path", card.path);
    el.setAttribute("aria-label", card.url ? `${card.title}\n${card.url}` : card.title);

    el.addEventListener("pointerdown", (event) => this.onIconPointerDown(event, card, el));
    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.openMarkdown(card);
    });
    el.addEventListener("contextmenu", (event) => this.onIconContextMenu(event, card));

    this.iconEls.set(card.path, el);
  }

  private appendLetterBlock(thumb: HTMLElement, card: BookmarkCard): void {
    const letter = card.title.trim().charAt(0).toUpperCase() || "?";
    const block = thumb.createDiv({ cls: "web-desk-icon-letter", text: letter });
    block.style.backgroundColor = colorFromString(card.host || card.path);
    block.style.fontSize = `${Math.round(card.size * 0.42)}px`;
  }

  private renderGroup(group: GroupBox): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-group" });
    el.style.left = `${group.x}px`;
    el.style.top = `${group.y}px`;
    el.style.width = `${group.w}px`;
    el.style.height = `${group.h}px`;
    el.style.borderColor = group.color;
    el.style.backgroundColor = hexToRgba(group.color, 0.06);

    const header = el.createDiv({ cls: "web-desk-group-header" });
    header.style.color = group.color;
    header.createSpan({ text: group.name });
    header.addEventListener("pointerdown", (event) =>
      this.onGroupHeaderPointerDown(event, group),
    );
    header.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.renameGroup(group);
    });
    header.addEventListener("contextmenu", (event) => {
      event.stopPropagation();
      this.onGroupContextMenu(event, group);
    });

    const handle = el.createDiv({ cls: "web-desk-group-resize" });
    handle.addEventListener("pointerdown", (event) => this.onGroupResizePointerDown(event, group));

    el.setAttribute("data-group-id", group.id);
    this.groupEls.set(group.id, el);
  }

  // ---------- 坐标换算 ----------

  private clientToCanvas(clientX: number, clientY: number): Point {
    const rect = this.rootEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.transform.panX) / this.transform.zoom,
      y: (clientY - rect.top - this.transform.panY) / this.transform.zoom,
    };
  }

  private applyTransform(): void {
    this.canvasEl.style.transform = `translate(${this.transform.panX}px, ${this.transform.panY}px) scale(${this.transform.zoom})`;
    this.zoomLabelEl.setText(`${Math.round(this.transform.zoom * 100)}%`);
  }

  private saveTransformDebounced(): void {
    this.host.setTransform({ ...this.transform });
  }

  private saveTransformNow(): void {
    this.host.setTransform({ ...this.transform });
  }

  // ---------- 画布级交互 ----------

  private onWheel(event: WheelEvent): void {
    event.preventDefault();

    if (event.ctrlKey || event.metaKey) {
      const factor = Math.exp(-event.deltaY * 0.0022);
      this.zoomAt(event.clientX, event.clientY, factor);
      return;
    }

    this.transform.panX -= event.deltaX;
    this.transform.panY -= event.deltaY;
    this.applyTransform();
    this.saveTransformDebounced();
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = this.rootEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const nextZoom = clamp(this.transform.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const ratio = nextZoom / this.transform.zoom;

    this.transform.panX = px - (px - this.transform.panX) * ratio;
    this.transform.panY = py - (py - this.transform.panY) * ratio;
    this.transform.zoom = nextZoom;
    this.applyTransform();
    this.saveTransformDebounced();
  }

  private zoomAtCenter(factor: number): void {
    const rect = this.rootEl.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  private fitContent(): void {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const expand = (x: number, y: number): void => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    };

    for (const card of this.cards) {
      expand(card.x, card.y);
      expand(card.x + card.size + 24, card.y + card.size + 44);
    }
    for (const group of this.host.getGroups()) {
      expand(group.x, group.y);
      expand(group.x + group.w, group.y + group.h);
    }

    if (minX === Infinity) {
      this.transform = { panX: 0, panY: 0, zoom: 1 };
      this.applyTransform();
      this.saveTransformDebounced();
      return;
    }

    const rect = this.rootEl.getBoundingClientRect();
    const padding = 60;
    const zoom = clamp(
      Math.min(
        (rect.width - padding * 2) / (maxX - minX + 1),
        (rect.height - padding * 2) / (maxY - minY + 1),
      ),
      MIN_ZOOM,
      1.25,
    );
    this.transform.zoom = zoom;
    this.transform.panX = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
    this.transform.panY = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
    this.applyTransform();
    this.saveTransformDebounced();
  }

  private onCanvasPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    if (
      event.button !== 0 ||
      target.closest(".web-desk-icon") ||
      target.closest(".web-desk-group") ||
      target.closest(".web-desk-toolbar")
    ) {
      return;
    }

    this.rootEl.focus();

    const start = this.clientToCanvas(event.clientX, event.clientY);
    const baseSelection = event.shiftKey ? new Set(this.selected) : new Set<string>();
    let moved = false;

    try { this.rootEl.setPointerCapture(event.pointerId); } catch {}

    const onMove = (moveEvent: PointerEvent): void => {
      const current = this.clientToCanvas(moveEvent.clientX, moveEvent.clientY);
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const w = Math.abs(current.x - start.x);
      const h = Math.abs(current.y - start.y);

      if (!moved && w < 4 && h < 4) {
        return;
      }
      moved = true;
      this.marqueeEl.style.display = "block";
      this.marqueeEl.style.left = `${x * this.transform.zoom + this.transform.panX}px`;
      this.marqueeEl.style.top = `${y * this.transform.zoom + this.transform.panY}px`;
      this.marqueeEl.style.width = `${w * this.transform.zoom}px`;
      this.marqueeEl.style.height = `${h * this.transform.zoom}px`;
    };

    const onUp = (upEvent: PointerEvent): void => {
      this.rootEl.removeEventListener("pointermove", onMove);
      this.rootEl.removeEventListener("pointerup", onUp);
      this.marqueeEl.style.display = "none";

      if (!moved) {
        if (!upEvent.shiftKey) {
          this.selected.clear();
          this.syncSelection();
        }
        return;
      }

      const end = this.clientToCanvas(upEvent.clientX, upEvent.clientY);
      const rect = normalizeRect(start, end);
      for (const card of this.cards) {
        const cardRect = { x: card.x, y: card.y, w: card.size + 24, h: card.size + 44 };
        if (rectsIntersect(rect, cardRect)) {
          baseSelection.add(card.path);
        }
      }
      this.selected = baseSelection;
      this.syncSelection();
    };

    this.rootEl.addEventListener("pointermove", onMove);
    this.rootEl.addEventListener("pointerup", onUp);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.selected.clear();
      this.syncSelection();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selected.size > 0) {
      event.preventDefault();
      this.confirmDeleteSelected();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selected = new Set(this.cards.map((card) => card.path));
      this.syncSelection();
    }
  }

  private onCanvasContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (target.closest(".web-desk-icon") || target.closest(".web-desk-group")) {
      return;
    }
    event.preventDefault();

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("收藏 URL…")
        .setIcon("plus")
        .onClick(() => this.promptForUrl(this.clientToCanvas(event.clientX, event.clientY))),
    );
    menu.addItem((item) =>
      item
        .setTitle("新建分组")
        .setIcon("square-dashed")
        .onClick(() => this.createGroupAt(this.clientToCanvas(event.clientX, event.clientY))),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("全选")
        .setIcon("box-select")
        .onClick(() => {
          this.selected = new Set(this.cards.map((card) => card.path));
          this.syncSelection();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("适应内容")
        .setIcon("maximize")
        .onClick(() => this.fitContent()),
    );
    menu.showAtMouseEvent(event);
  }

  // ---------- 图标交互 ----------

  private onIconPointerDown(event: PointerEvent, card: BookmarkCard, el: HTMLElement): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    this.rootEl.focus();

    if (event.shiftKey) {
      if (this.selected.has(card.path)) {
        this.selected.delete(card.path);
      } else {
        this.selected.add(card.path);
      }
      this.syncSelection();
      return;
    }

    if (!this.selected.has(card.path)) {
      this.selected.clear();
      this.selected.add(card.path);
      this.syncSelection();
    }

    const startClient = { x: event.clientX, y: event.clientY };
    const dragged = [...this.selected]
      .map((path) => {
        const target = this.cards.find((item) => item.path === path);
        const iconEl = this.iconEls.get(path);
        if (!target || !iconEl) {
          return null;
        }
        return { card: target, el: iconEl, origin: { x: target.x, y: target.y } };
      })
      .filter(
        (entry): entry is { card: BookmarkCard; el: HTMLElement; origin: Point } => entry !== null,
      );

    if (dragged.length === 0) {
      return;
    }

    let moved = false;
    try { el.setPointerCapture(event.pointerId); } catch {}

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startClient.x) / this.transform.zoom;
      const dy = (moveEvent.clientY - startClient.y) / this.transform.zoom;
      if (!moved && Math.hypot(dx, dy) * this.transform.zoom < 5) {
        return;
      }
      moved = true;
      for (const entry of dragged) {
        entry.card.x = clamp(entry.origin.x + dx, -CANVAS_BOUND, CANVAS_BOUND);
        entry.card.y = clamp(entry.origin.y + dy, -CANVAS_BOUND, CANVAS_BOUND);
        entry.el.style.left = `${entry.card.x}px`;
        entry.el.style.top = `${entry.card.y}px`;
      }
    };

    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);

      if (!moved) {
        this.activateCard(card);
        return;
      }
      void this.persistDragged(
        dragged.map((entry) => entry.card),
      );
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  private activateCard(card: BookmarkCard): void {
    if (card.url) {
      window.open(card.url, "_blank");
      return;
    }
    this.openMarkdown(card);
  }

  private async persistDragged(cards: BookmarkCard[]): Promise<void> {
    this.interactionLock += 1;
    try {
      for (const card of cards) {
        const file = this.app.vault.getAbstractFileByPath(card.path);
        if (!(file instanceof TFile)) {
          continue;
        }
        const group = this.groupAt(
          card.x + (card.size + 24) / 2,
          card.y + (card.size + 44) / 2,
        );
        card.group = group;
        await writeDeskFields(this.app, file, {
          x: card.x,
          y: card.y,
          group: group || null,
        });
      }
    } catch (error) {
      new Notice(`保存位置失败：${getErrorMessage(error)}`, 5000);
    } finally {
      this.interactionLock -= 1;
    }
  }

  private onIconContextMenu(event: MouseEvent, card: BookmarkCard): void {
    event.preventDefault();
    event.stopPropagation();

    if (!this.selected.has(card.path)) {
      this.selected.clear();
      this.selected.add(card.path);
      this.syncSelection();
    }

    const menu = new Menu();

    menu.addItem((item) =>
      item
        .setTitle("打开网页")
        .setIcon("external-link")
        .onClick(() => {
          if (card.url) {
            window.open(card.url, "_blank");
          } else {
            new Notice("该收藏没有 url 元信息");
          }
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("打开 Markdown")
        .setIcon("file-text")
        .onClick(() => this.openMarkdown(card)),
    );
    menu.addItem((item) =>
      item
        .setTitle("复制链接")
        .setIcon("copy")
        .onClick(() => {
          if (card.url) {
            void navigator.clipboard.writeText(card.url);
            new Notice("已复制链接");
          }
        }),
    );
    menu.addSeparator();

    menu.addItem((item) =>
      item
        .setTitle(`图标大小：小（${SIZE_SMALL}px）`)
        .setIcon("minimize-2")
        .onClick(() => void this.setIconSize(card, SIZE_SMALL)),
    );
    menu.addItem((item) =>
      item
        .setTitle(`图标大小：中（${SIZE_MEDIUM}px）`)
        .setIcon("square")
        .onClick(() => void this.setIconSize(card, SIZE_MEDIUM)),
    );
    menu.addItem((item) =>
      item
        .setTitle(`图标大小：大（${SIZE_LARGE}px）`)
        .setIcon("maximize-2")
        .onClick(() => void this.setIconSize(card, SIZE_LARGE)),
    );
    menu.addItem((item) =>
      item
        .setTitle("图标大小：自定义…")
        .setIcon("scaling")
        .onClick(() => {
          new TextInputModal(this.app, {
            title: "图标大小（像素）",
            initial: String(card.size),
            placeholder: "32 ~ 320",
            onSubmit: (value) => {
              const size = Number(value);
              if (Number.isFinite(size) && size >= 32 && size <= 320) {
                void this.setIconSize(card, size);
              } else {
                new Notice("请输入 32 ~ 320 之间的数字");
              }
            },
          }).open();
        }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("移出画布")
        .setIcon("square-minus")
        .onClick(() => void this.removeFromDesk(card)),
    );
    menu.addItem((item) =>
      item
        .setTitle("删除文件…")
        .setIcon("trash-2")
        .onClick(() => this.confirmDelete(card)),
    );

    menu.showAtMouseEvent(event);
  }

  private async setIconSize(card: BookmarkCard, size: number): Promise<void> {
    card.size = size;
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (file instanceof TFile) {
      await writeDeskFields(this.app, file, { size });
    }
    this.render();
  }

  private async removeFromDesk(card: BookmarkCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (file instanceof TFile) {
      await writeDeskFields(this.app, file, { x: null, y: null, size: null, group: null });
    }
    this.selected.delete(card.path);
    await this.refresh();
    new Notice("已移出画布（文件保留在收藏夹文件夹）");
  }

  private confirmDelete(card: BookmarkCard): void {
    const paths = this.selected.has(card.path) ? [...this.selected] : [card.path];
    new ConfirmModal(this.app, {
      message: `删除 ${paths.length} 个收藏的 md 文件？（移入仓库回收站，图标随之消失）`,
      okLabel: "删除",
      onOk: () => void this.deleteFiles(paths),
    }).open();
  }

  private confirmDeleteSelected(): void {
    const paths = [...this.selected];
    if (paths.length === 0) {
      return;
    }
    new ConfirmModal(this.app, {
      message: `删除 ${paths.length} 个收藏的 md 文件？（移入仓库回收站，图标随之消失）`,
      okLabel: "删除",
      onOk: () => void this.deleteFiles(paths),
    }).open();
  }

  private async deleteFiles(paths: string[]): Promise<void> {
    this.interactionLock += 1;
    try {
      for (const path of paths) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
          await this.app.vault.trash(file, false);
        }
        this.selected.delete(path);
      }
    } finally {
      this.interactionLock -= 1;
    }
    await this.refresh();
  }

  private openMarkdown(card: BookmarkCard): void {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf("tab").openFile(file);
    }
  }

  private syncSelection(): void {
    for (const [path, el] of this.iconEls) {
      el.toggleClass("is-selected", this.selected.has(path));
    }
  }

  // ---------- 分组 ----------

  private groupAt(cx: number, cy: number): string {
    for (const group of this.host.getGroups()) {
      if (cx >= group.x && cx <= group.x + group.w && cy >= group.y && cy <= group.y + group.h) {
        return group.name;
      }
    }
    return "";
  }

  private createGroupAt(point: Point): void {
    new TextInputModal(this.app, {
      title: "新建分组",
      placeholder: "分组名称，如：工具 / 读文档",
      onSubmit: (name) => {
        const groups = this.host.getGroups();
        const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
        groups.push({
          id: `g${Date.now().toString(36)}`,
          name,
          x: Math.round(point.x),
          y: Math.round(point.y),
          w: 480,
          h: 360,
          color,
        });
        this.host.setGroups(groups);
        this.render();
      },
    }).open();
  }

  private onGroupHeaderPointerDown(event: PointerEvent, group: GroupBox): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    this.rootEl.focus();

    const el = this.groupEls.get(group.id);
    if (!el) {
      return;
    }

    const startClient = { x: event.clientX, y: event.clientY };
    const origin = { x: group.x, y: group.y };
    let moved = false;

    try { el.setPointerCapture(event.pointerId); } catch {}

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startClient.x) / this.transform.zoom;
      const dy = (moveEvent.clientY - startClient.y) / this.transform.zoom;
      if (!moved && Math.hypot(dx, dy) * this.transform.zoom < 4) {
        return;
      }
      moved = true;
      group.x = Math.round(origin.x + dx);
      group.y = Math.round(origin.y + dy);
      el.style.left = `${group.x}px`;
      el.style.top = `${group.y}px`;
    };

    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      if (moved) {
        this.host.setGroups(this.host.getGroups());
        void this.recomputeGroupMembership();
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  private onGroupResizePointerDown(event: PointerEvent, group: GroupBox): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();

    const el = this.groupEls.get(group.id);
    if (!el) {
      return;
    }

    const startClient = { x: event.clientX, y: event.clientY };
    const origin = { w: group.w, h: group.h };
    let moved = false;

    try { el.setPointerCapture(event.pointerId); } catch {}

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startClient.x) / this.transform.zoom;
      const dy = (moveEvent.clientY - startClient.y) / this.transform.zoom;
      if (!moved && Math.hypot(dx, dy) * this.transform.zoom < 4) {
        return;
      }
      moved = true;
      group.w = Math.max(240, Math.round(origin.w + dx));
      group.h = Math.max(180, Math.round(origin.h + dy));
      el.style.width = `${group.w}px`;
      el.style.height = `${group.h}px`;
    };

    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      if (moved) {
        this.host.setGroups(this.host.getGroups());
        void this.recomputeGroupMembership();
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  private onGroupContextMenu(event: MouseEvent, group: GroupBox): void {
    event.preventDefault();

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("重命名")
        .setIcon("pencil")
        .onClick(() => this.renameGroup(group)),
    );

    menu.addItem((item) =>
      item
        .setTitle("换颜色")
        .setIcon("palette")
        .onClick(() => {
          const colors = GROUP_COLORS;
          const index = colors.indexOf(group.color);
          group.color = colors[(index + 1) % colors.length];
          this.host.setGroups(this.host.getGroups());
          this.render();
        }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("删除分组")
        .setIcon("trash-2")
        .onClick(() => {
          const groups = this.host.getGroups().filter((entry) => entry.id !== group.id);
          this.host.setGroups(groups);
          void this.clearGroupMembership(group.name);
          this.render();
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private renameGroup(group: GroupBox): void {
    new TextInputModal(this.app, {
      title: "重命名分组",
      initial: group.name,
      onSubmit: (name) => {
        void this.applyGroupRename(group, name);
      },
    }).open();
  }

  private async applyGroupRename(group: GroupBox, name: string): Promise<void> {
    const oldName = group.name;
    const groups = this.host.getGroups();
    const target = groups.find((entry) => entry.id === group.id);
    if (target) {
      target.name = name;
      this.host.setGroups(groups);
    }
    this.interactionLock += 1;
    try {
      for (const card of this.cards) {
        if (card.group === oldName) {
          card.group = name;
          const file = this.app.vault.getAbstractFileByPath(card.path);
          if (file instanceof TFile) {
            await writeDeskFields(this.app, file, { group: name });
          }
        }
      }
    } finally {
      this.interactionLock -= 1;
    }
    this.render();
  }

  /** 框移动/改大小后，按「图标中心是否在框内」重算归属。 */
  private async recomputeGroupMembership(): Promise<void> {
    this.interactionLock += 1;
    try {
      for (const card of this.cards) {
        const group = this.groupAt(
          card.x + (card.size + 24) / 2,
          card.y + (card.size + 44) / 2,
        );
        if (group !== card.group) {
          card.group = group;
          const file = this.app.vault.getAbstractFileByPath(card.path);
          if (file instanceof TFile) {
            await writeDeskFields(this.app, file, { group: group || null });
          }
        }
      }
    } finally {
      this.interactionLock -= 1;
    }
  }

  private async clearGroupMembership(groupName: string): Promise<void> {
    this.interactionLock += 1;
    try {
      for (const card of this.cards) {
        if (card.group === groupName) {
          card.group = "";
          const file = this.app.vault.getAbstractFileByPath(card.path);
          if (file instanceof TFile) {
            await writeDeskFields(this.app, file, { group: null });
          }
        }
      }
    } finally {
      this.interactionLock -= 1;
    }
  }

  // ---------- 导入 ----------

  private async onDrop(event: DragEvent): Promise<void> {
    const text =
      event.dataTransfer?.getData("text/uri-list") ||
      event.dataTransfer?.getData("text/plain") ||
      "";
    const urls = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && isProbablyUrl(line));

    if (urls.length === 0) {
      new Notice("没有识别到 http(s) 链接（从浏览器地址栏或网页链接直接拖过来即可）");
      return;
    }

    const point = this.clientToCanvas(event.clientX, event.clientY);
    await this.importUrls(urls, point);
  }

  private async importUrls(urls: string[], point: Point): Promise<void> {
    this.interactionLock += 1;
    try {
      for (let index = 0; index < urls.length; index += 1) {
        const rawUrl = urls[index];
        const existing = this.cards.find((card) => card.url === rawUrl);
        if (existing) {
          this.selected.clear();
          this.selected.add(existing.path);
          this.syncSelection();
          new Notice("这个链接已经在画布上了");
          continue;
        }

        new Notice(`正在抓取：${rawUrl}`);
        const x = point.x + index * 40 - this.settings.defaultIconSize / 2;
        const y = point.y + index * 40 - this.settings.defaultIconSize / 2;
        try {
          const result = await importUrlAsBookmark(this.app, this.settings, rawUrl, {
            x,
            y,
            size: this.settings.defaultIconSize,
          });
          new Notice(`已收藏：${result.file.basename}`);
        } catch (error) {
          new Notice(`收藏失败：${getErrorMessage(error)}`, 8000);
        }
      }
    } finally {
      this.interactionLock -= 1;
    }
    await this.refresh();
  }

  private promptForUrl(point: Point): void {
    new TextInputModal(this.app, {
      title: "收藏 URL 到网页桌面",
      placeholder: "https://example.com/article",
      submitLabel: "收藏",
      onSubmit: (value) => {
        void this.importUrls([value], point);
      },
    }).open();
  }

  /** 供插件命令调用：在当前视口中心落点弹 URL 输入框。 */
  promptForUrlAtCenter(): void {
    this.promptForUrl(this.visibleCenter());
  }

  private visibleCenter(): Point {
    const rect = this.rootEl.getBoundingClientRect();
    return this.clientToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  /** 供插件命令调用：设置变更等外部原因触发的刷新。 */
  async refreshExternal(): Promise<void> {
    await this.refresh();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function normalizeRect(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function hexToRgba(hex: string, alpha: number): string {
  const match = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!match) {
    return `rgba(127,127,127,${alpha})`;
  }
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
