import { ItemView, Menu, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { importUrlAsBookmark } from "./importer";
import { planAutoPositions, readCard, writeDeskFields } from "./layout";
import { ConfirmModal, TextInputModal } from "./modals";
import {
  BookmarkCard,
  CANVAS_BOUND,
  CanvasTransform,
  Arrow,
  ArrowEndpoint,
  GROUP_COLORS,
  GroupBox,
  TextBox,
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
  getTextBoxes(): TextBox[];
  setTextBoxes(boxes: TextBox[]): void;
  getArrows(): Arrow[];
  setArrows(arrows: Arrow[]): void;
  getTransform(): CanvasTransform;
  setTransform(transform: CanvasTransform): void;
}

interface Point {
  x: number;
  y: number;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_SPAN = 20000;

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
  private textBoxEls = new Map<string, HTMLElement>();
  private arrowsG: SVGGElement | null = null;
  private arrowMarkerIds = new Map<string, string>();
  private arrowEls = new Map<string, SVGPathElement>();
  private selectedArrowId: string | null = null;
  private arrowDraft: ArrowEndpoint | null = null;
  private pendingArrowStart = false;
  private editingTextBoxId: string | null = null;
  private selected = new Set<string>();
  private transform: CanvasTransform = { panX: 0, panY: 0, zoom: 1 };

  /** >0 表示有交互进行中（拖拽/导入），推迟重绘。 */
  private interactionLock = 0;
  /** 近期本地写回的坐标（path → x/y/时刻）：metadataCache 滞后窗口内以本地为准，防视觉回跳。 */
  private layoutWrites = new Map<string, { x: number; y: number; at: number }>();
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
      text: "把网页链接拖到这里收藏。右键画布可新建分组 / 文本框 / 箭头，右键图标可从它画箭头。",
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

    // 写盘成功但 metadataCache 未跟上时，cache 给的是旧坐标——以本地近期写入为准，防拖拽回跳
    const now = Date.now();
    for (const card of this.cards) {
      const write = this.layoutWrites.get(card.path);
      if (!write) continue;
      if (now - write.at > 10_000) {
        this.layoutWrites.delete(card.path);
        continue;
      }
      if (card.x !== write.x || card.y !== write.y) {
        card.x = write.x;
        card.y = write.y;
      }
    }

    await this.autoPlaceNewcomers();
    this.pruneDanglingArrows();
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
    this.textBoxEls.clear();
    this.canvasEl.empty();

    this.buildSvgLayer();
    this.renderArrows();
    for (const group of this.host.getGroups()) {
      this.renderGroup(group);
    }
    for (const card of this.cards) {
      this.renderIcon(card);
    }
    this.renderTextBoxes();

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
      target.closest(".web-desk-textbox") ||
      target.closest(".web-desk-toolbar")
    ) {
      return;
    }

    this.rootEl.focus();

    if (this.interceptArrowClick(event)) {
      return;
    }

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
          this.clearArrowSelection();
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
      if (this.arrowDraft || this.pendingArrowStart) {
        this.cancelArrowDraft();
        return;
      }
      this.selected.clear();
      this.clearArrowSelection();
      this.syncSelection();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selected.size > 0) {
      event.preventDefault();
      this.confirmDeleteSelected();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && this.selectedArrowId) {
      event.preventDefault();
      this.removeArrow(this.selectedArrowId);
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
    const point = this.clientToCanvas(event.clientX, event.clientY);

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
        .onClick(() => this.createGroupAt(point)),
    );
    menu.addItem((item) =>
      item
        .setTitle("新建文本框")
        .setIcon("sticky-note")
        .onClick(() => this.addTextBox(point.x - 130, point.y - 60)),
    );
    menu.addItem((item) =>
      item
        .setTitle("画箭头（点两点）")
        .setIcon("move-up-right")
        .onClick(() => this.beginArrowFromScratch()),
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
    if (this.interceptArrowClick(event)) {
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

    // 拖拽全程持锁：期间 vault 变化触发的 refresh 不得重建 DOM（否则拖拽悬空）
    this.interactionLock += 1;
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
        this.interactionLock -= 1;
        this.activateCard(card);
        return;
      }
      void this.persistDragged(
        dragged.map((entry) => entry.card),
      ).finally(() => {
        this.interactionLock -= 1;
      });
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
        console.warn("[webdesk] persistDragged", card.path, "file=", file ? "TFile" : String(file), "->", Math.round(card.x), Math.round(card.y));
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
        this.layoutWrites.set(card.path, { x: card.x, y: card.y, at: Date.now() });
        console.warn("[webdesk] writeDeskFields done", card.path, "disk-now=", (await this.app.vault.adapter.read(card.path)).match(/^desk_x:.*$/m)?.[0]);
      }
    } catch (error) {
      new Notice(`保存位置失败：${getErrorMessage(error)}`, 5000);
    } finally {
      this.interactionLock -= 1;
    }
    this.renderArrows();
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
    menu.addItem((item) =>
      item
        .setTitle("从这里画箭头")
        .setIcon("move-up-right")
        .onClick(() => this.beginArrowDraft({ kind: "card", ref: card.path })),
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
    if (this.interceptArrowClick(event)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    this.rootEl.focus();

    const el = this.groupEls.get(group.id);
    if (!el) {
      return;
    }

    this.interactionLock += 1;
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
      this.interactionLock -= 1;
      if (moved) {
        this.host.setGroups(this.host.getGroups());
        this.renderArrows();
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

    this.interactionLock += 1;
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
      this.interactionLock -= 1;
      if (moved) {
        this.host.setGroups(this.host.getGroups());
        this.renderArrows();
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
        .setTitle("从这里画箭头")
        .setIcon("move-up-right")
        .onClick(() => this.beginArrowDraft({ kind: "group", ref: group.id })),
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

  // ---------- 文本框与箭头 ----------

  private buildSvgLayer(): void {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "web-desk-arrows");
    svg.setAttribute(
      "style",
      `position:absolute;left:${-ARROW_SPAN}px;top:${-ARROW_SPAN}px;width:${ARROW_SPAN * 2}px;height:${ARROW_SPAN * 2}px;pointer-events:none;overflow:visible`,
    );
    svg.setAttribute("viewBox", `${-ARROW_SPAN} ${-ARROW_SPAN} ${ARROW_SPAN * 2} ${ARROW_SPAN * 2}`);

    const defs = document.createElementNS(SVG_NS, "defs");
    const addMarker = (id: string, color: string): void => {
      const marker = document.createElementNS(SVG_NS, "marker");
      marker.setAttribute("id", id);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto-start-reverse");
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", "M0,0 L10,5 L0,10 z");
      p.style.fill = color;
      marker.appendChild(p);
      defs.appendChild(marker);
    };
    this.arrowMarkerIds.clear();
    addMarker("wd-arrow-accent", "var(--interactive-accent)");
    GROUP_COLORS.forEach((color, index) => {
      const id = `wd-arrow-${index}`;
      addMarker(id, color);
      this.arrowMarkerIds.set(color, id);
    });
    svg.appendChild(defs);

    const g = document.createElementNS(SVG_NS, "g");
    svg.appendChild(g);
    this.canvasEl.appendChild(svg);
    this.arrowsG = g;
  }

  private endpointRect(ep: ArrowEndpoint): Rect | null {
    if (ep.kind === "card") {
      const card = this.cards.find((entry) => entry.path === ep.ref);
      return card ? { x: card.x, y: card.y, w: card.size + 24, h: card.size + 44 } : null;
    }
    if (ep.kind === "textbox") {
      const box = this.host.getTextBoxes().find((entry) => entry.id === ep.ref);
      return box ? { x: box.x, y: box.y, w: box.w, h: box.h } : null;
    }
    if (ep.kind === "group") {
      const group = this.host.getGroups().find((entry) => entry.id === ep.ref);
      return group ? { x: group.x, y: group.y, w: group.w, h: group.h } : null;
    }
    return null;
  }

  private endpointPoint(ep: ArrowEndpoint): Point | null {
    const rect = this.endpointRect(ep);
    if (rect) {
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
    }
    if (ep.kind === "point") {
      const [x, y] = ep.ref.split(",").map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        return { x, y };
      }
    }
    return null;
  }

  private renderArrows(): void {
    if (!this.arrowsG) {
      return;
    }
    this.arrowsG.innerHTML = "";
    this.arrowEls.clear();

    for (const arrow of this.host.getArrows()) {
      const p1 = this.endpointPoint(arrow.from);
      const p2 = this.endpointPoint(arrow.to);
      if (!p1 || !p2) {
        continue;
      }
      const r1 = this.endpointRect(arrow.from);
      const r2 = this.endpointRect(arrow.to);
      const a = r1 ? rectEdgePoint(r1, p2) : p1;
      const b = r2 ? rectEdgePoint(r2, p1) : p2;
      const d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;

      // 透明加粗命中层（负责事件），可见细线层（负责显示）
      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "web-desk-arrow-hit");
      hit.addEventListener("pointerdown", (event) => this.onArrowPointerDown(event, arrow));
      hit.addEventListener("contextmenu", (event) => this.onArrowContextMenu(event, arrow));
      this.arrowsG.appendChild(hit);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute(
        "class",
        arrow.id === this.selectedArrowId ? "web-desk-arrow is-selected" : "web-desk-arrow",
      );
      path.style.stroke = arrow.color || "var(--interactive-accent)";
      path.setAttribute("marker-end", `url(#${this.arrowMarkerIds.get(arrow.color) ?? "wd-arrow-accent"})`);
      this.arrowsG.appendChild(path);
      this.arrowEls.set(arrow.id, path);

      if (arrow.label) {
        const text = document.createElementNS(SVG_NS, "text");
        text.setAttribute("class", "web-desk-arrow-label");
        text.setAttribute("x", String((a.x + b.x) / 2));
        text.setAttribute("y", String((a.y + b.y) / 2 - 6));
        text.setAttribute("text-anchor", "middle");
        text.textContent = arrow.label;
        this.arrowsG.appendChild(text);
      }
    }
  }

  private onArrowPointerDown(event: PointerEvent, arrow: Arrow): void {
    if (this.interceptArrowClick(event)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    this.selectedArrowId = this.selectedArrowId === arrow.id ? null : arrow.id;
    this.selected.clear();
    this.syncSelection();
    this.renderArrows();
  }

  private onArrowContextMenu(event: MouseEvent, arrow: Arrow): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedArrowId = arrow.id;
    this.renderArrows();

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("编辑标签…")
        .setIcon("tag")
        .onClick(() => {
          new TextInputModal(this.app, {
            title: "箭头标签",
            initial: arrow.label,
            onSubmit: (value) => {
              const arrows = this.host.getArrows();
              const target = arrows.find((entry) => entry.id === arrow.id);
              if (target) {
                target.label = value;
                this.host.setArrows(arrows);
              }
              this.renderArrows();
            },
          }).open();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("换颜色")
        .setIcon("palette")
        .onClick(() => {
          const arrows = this.host.getArrows();
          const target = arrows.find((entry) => entry.id === arrow.id);
          if (target) {
            const index = GROUP_COLORS.indexOf(target.color);
            target.color = GROUP_COLORS[(index + 1) % GROUP_COLORS.length];
            this.host.setArrows(arrows);
          }
          this.renderArrows();
        }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("删除箭头")
        .setIcon("trash-2")
        .onClick(() => this.removeArrow(arrow.id)),
    );
    menu.showAtMouseEvent(event);
  }

  private renderTextBoxes(): void {
    for (const box of this.host.getTextBoxes()) {
      const el = this.canvasEl.createDiv({ cls: "web-desk-textbox" });
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
      el.style.borderColor = box.color;
      el.style.backgroundColor = hexToRgba(box.color, 0.08);
      el.setAttribute("data-tb-id", box.id);

      const text = el.createDiv({ cls: "web-desk-textbox-text", text: box.text });
      const handle = el.createDiv({ cls: "web-desk-textbox-resize" });

      el.addEventListener("pointerdown", (event) => this.onTextBoxPointerDown(event, box, el));
      el.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        this.editTextBox(box, text);
      });
      el.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onTextBoxContextMenu(event, box, text);
      });
      handle.addEventListener("pointerdown", (event) =>
        this.onTextBoxResizePointerDown(event, box, el),
      );

      this.textBoxEls.set(box.id, el);
    }
  }

  private onTextBoxPointerDown(event: PointerEvent, box: TextBox, el: HTMLElement): void {
    if (this.interceptArrowClick(event)) {
      return;
    }
    if (event.button !== 0 || this.editingTextBoxId === box.id) {
      return;
    }
    event.stopPropagation();
    this.rootEl.focus();

    this.interactionLock += 1;
    const startClient = { x: event.clientX, y: event.clientY };
    const origin = { x: box.x, y: box.y };
    let moved = false;

    try { el.setPointerCapture(event.pointerId); } catch {}

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startClient.x) / this.transform.zoom;
      const dy = (moveEvent.clientY - startClient.y) / this.transform.zoom;
      if (!moved && Math.hypot(dx, dy) * this.transform.zoom < 4) {
        return;
      }
      moved = true;
      box.x = Math.round(origin.x + dx);
      box.y = Math.round(origin.y + dy);
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
    };

    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      this.interactionLock -= 1;
      if (moved) {
        this.host.setTextBoxes(this.host.getTextBoxes());
        this.renderArrows();
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  private onTextBoxResizePointerDown(event: PointerEvent, box: TextBox, el: HTMLElement): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();

    this.interactionLock += 1;
    const startClient = { x: event.clientX, y: event.clientY };
    const origin = { w: box.w, h: box.h };
    let moved = false;

    try { el.setPointerCapture(event.pointerId); } catch {}

    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - startClient.x) / this.transform.zoom;
      const dy = (moveEvent.clientY - startClient.y) / this.transform.zoom;
      if (!moved && Math.hypot(dx, dy) * this.transform.zoom < 4) {
        return;
      }
      moved = true;
      box.w = Math.max(140, Math.round(origin.w + dx));
      box.h = Math.max(60, Math.round(origin.h + dy));
      el.style.width = `${box.w}px`;
      el.style.height = `${box.h}px`;
    };

    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      this.interactionLock -= 1;
      if (moved) {
        this.host.setTextBoxes(this.host.getTextBoxes());
        this.renderArrows();
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  private editTextBox(box: TextBox, textEl: HTMLElement): void {
    if (this.editingTextBoxId) {
      return;
    }
    this.editingTextBoxId = box.id;
    textEl.setAttribute("contenteditable", "plaintext-only");
    textEl.addClass("is-editing");
    textEl.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textEl);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const commit = (): void => {
      textEl.removeAttribute("contenteditable");
      textEl.removeClass("is-editing");
      textEl.removeEventListener("blur", commit);
      this.editingTextBoxId = null;
      const value = textEl.innerText.replace(/\u00a0/g, " ").trim();
      if (value !== box.text) {
        const boxes = this.host.getTextBoxes();
        const target = boxes.find((entry) => entry.id === box.id);
        if (target) {
          target.text = value;
          this.host.setTextBoxes(boxes);
        }
      }
    };
    textEl.addEventListener("blur", commit);
    textEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        textEl.blur();
      }
    });
  }

  private onTextBoxContextMenu(event: MouseEvent, box: TextBox, textEl: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("编辑文字")
        .setIcon("pencil")
        .onClick(() => this.editTextBox(box, textEl)),
    );
    menu.addItem((item) =>
      item
        .setTitle("换颜色")
        .setIcon("palette")
        .onClick(() => {
          const boxes = this.host.getTextBoxes();
          const target = boxes.find((entry) => entry.id === box.id);
          if (target) {
            const index = GROUP_COLORS.indexOf(target.color);
            target.color = GROUP_COLORS[(index + 1) % GROUP_COLORS.length];
            this.host.setTextBoxes(boxes);
          }
          this.render();
        }),
    );
    menu.addItem((item) =>
      item
        .setTitle("从这里画箭头")
        .setIcon("move-up-right")
        .onClick(() => this.beginArrowDraft({ kind: "textbox", ref: box.id })),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("删除文本框")
        .setIcon("trash-2")
        .onClick(() => this.removeTextBox(box.id)),
    );
    menu.showAtMouseEvent(event);
  }

  /** 箭头草稿模式：所有 pointerdown 处理器先问它，true=已消费。 */
  private interceptArrowClick(event: PointerEvent): boolean {
    if (this.pendingArrowStart) {
      const ep = this.endpointFromEvent(event);
      if (ep) {
        this.arrowDraft = ep;
        this.pendingArrowStart = false;
        new Notice("再点击箭头终点（Esc 取消）", 2500);
      }
      return true;
    }
    if (this.arrowDraft) {
      const ep = this.endpointFromEvent(event);
      if (ep) {
        this.addArrow(this.arrowDraft, ep);
      }
      this.cancelArrowDraft();
      return true;
    }
    return false;
  }

  private endpointFromEvent(event: PointerEvent | MouseEvent): ArrowEndpoint | null {
    const target = event.target as HTMLElement;
    const icon = target.closest<HTMLElement>(".web-desk-icon");
    if (icon) {
      const path = icon.getAttribute("data-path");
      return path ? { kind: "card", ref: path } : null;
    }
    const tb = target.closest<HTMLElement>(".web-desk-textbox");
    if (tb) {
      const id = tb.getAttribute("data-tb-id");
      return id ? { kind: "textbox", ref: id } : null;
    }
    const group = target.closest<HTMLElement>(".web-desk-group");
    if (group) {
      const id = group.getAttribute("data-group-id");
      return id ? { kind: "group", ref: id } : null;
    }
    if (target.closest(".web-desk-toolbar")) {
      return null;
    }
    const point = this.clientToCanvas(event.clientX, event.clientY);
    return { kind: "point", ref: `${Math.round(point.x)},${Math.round(point.y)}` };
  }

  private beginArrowDraft(from: ArrowEndpoint): void {
    this.arrowDraft = from;
    this.pendingArrowStart = false;
    this.rootEl.style.cursor = "crosshair";
    new Notice("点击箭头终点（Esc 取消）", 2500);
  }

  private beginArrowFromScratch(): void {
    this.pendingArrowStart = true;
    this.rootEl.style.cursor = "crosshair";
    new Notice("点击箭头起点", 2500);
  }

  private cancelArrowDraft(): void {
    this.arrowDraft = null;
    this.pendingArrowStart = false;
    this.rootEl.style.cursor = "";
  }

  private clearArrowSelection(): void {
    if (this.selectedArrowId === null) {
      return;
    }
    this.selectedArrowId = null;
    this.renderArrows();
  }

  private pruneDanglingArrows(): void {
    const arrows = this.host.getArrows();
    const paths = new Set(this.cards.map((card) => card.path));
    const tbIds = new Set(this.host.getTextBoxes().map((box) => box.id));
    const groupIds = new Set(this.host.getGroups().map((group) => group.id));
    const alive = (ep: ArrowEndpoint): boolean => {
      if (ep.kind === "card") return paths.has(ep.ref);
      if (ep.kind === "textbox") return tbIds.has(ep.ref);
      if (ep.kind === "group") return groupIds.has(ep.ref);
      return true;
    };
    const kept = arrows.filter((arrow) => alive(arrow.from) && alive(arrow.to));
    if (kept.length !== arrows.length) {
      this.host.setArrows(kept);
    }
  }

  /** 公共 API：右键菜单与冒烟测试共用。 */
  addTextBox(x: number, y: number, text = "双击编辑文本"): TextBox {
    const boxes = this.host.getTextBoxes();
    const box: TextBox = {
      id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      text,
      x: Math.round(x),
      y: Math.round(y),
      w: 260,
      h: 120,
      color: GROUP_COLORS[boxes.length % GROUP_COLORS.length],
    };
    boxes.push(box);
    this.host.setTextBoxes(boxes);
    this.render();
    return box;
  }

  removeTextBox(id: string): void {
    this.host.setTextBoxes(this.host.getTextBoxes().filter((box) => box.id !== id));
    this.host.setArrows(
      this.host.getArrows().filter((arrow) => arrow.from.ref !== id && arrow.to.ref !== id),
    );
    this.render();
  }

  addArrow(from: ArrowEndpoint, to: ArrowEndpoint, label = ""): Arrow {
    const arrows = this.host.getArrows();
    const dup = arrows.some(
      (arrow) =>
        (arrow.from.ref === from.ref && arrow.to.ref === to.ref) ||
        (arrow.from.ref === to.ref && arrow.to.ref === from.ref),
    );
    if (dup) {
      new Notice("这两个之间已经有箭头了");
      return { id: "", from, to, label, color: "" };
    }
    const arrow: Arrow = {
      id: `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      from,
      to,
      label,
      color: "",
    };
    arrows.push(arrow);
    this.host.setArrows(arrows);
    this.renderArrows();
    return arrow;
  }

  removeArrow(id: string): void {
    this.host.setArrows(this.host.getArrows().filter((arrow) => arrow.id !== id));
    if (this.selectedArrowId === id) {
      this.selectedArrowId = null;
    }
    this.renderArrows();
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

/** 线段从 rect 中心指向 towards，求与矩形边框的交点（箭头端点裁剪）。 */
function rectEdgePoint(rect: Rect, towards: Point): Point {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = towards.x - cx;
  const dy = towards.y - cy;
  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }
  const sx = dx === 0 ? Infinity : rect.w / 2 / Math.abs(dx);
  const sy = dy === 0 ? Infinity : rect.h / 2 / Math.abs(dy);
  const scale = Math.min(sx, sy);
  return { x: cx + dx * scale, y: cy + dy * scale };
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
