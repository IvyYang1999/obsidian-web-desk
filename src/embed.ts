import { App, Menu, Notice, TFile, debounce } from "obsidian";
import {
  EmbedData,
  EmbedItem,
  EmbedTextBox,
  findAvailableEmbedItemPosition,
  parseEmbedData,
} from "./embed-state";
import {
  imageFilesFrom,
  imageFilesFromClipboard,
  imageResourceUrl,
  storeImageFile,
} from "./image-storage";
import {
  isEditablePasteTarget,
  shouldClaimEmbeddedCanvasPaste,
  splitCanvasPaste,
} from "./clipboard-state";
import { resizeImageToWidth } from "./image-state";
import { fetchBookmarkMeta } from "./importer";
import { GROUP_COLORS } from "./types";
import type { CanvasImage, WebDeskSettings } from "./types";
import { colorFromString, faviconUrl, getErrorMessage, isProbablyUrl } from "./util";

interface EmbedCtxLike {
  sourcePath: string;
  getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}

const EMBED_HEIGHT = 420;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
let pendingEmbedFocus: { key: string; expiresAt: number } | null = null;

/**
 * 笔记内嵌画布（```web-desk code block）。
 * 数据全部存在块内（纯 md 到底），编辑后写回块源码；
 * 主路径 getSectionInfo+replaceRange（阅读/实时预览），兜底按内容全文匹配（vault.process）。
 */
export class DeskEmbed {
  private data: EmbedData;
  /** 渲染时块里的原始内容（写回兜底用它定位要替换的块，而不是用新序列化去匹配）。 */
  private readonly originalSource: string;
  private readonly el: HTMLElement;
  private readonly app: App;
  private readonly ctx: EmbedCtxLike;
  private readonly filePath: string;
  private readonly settings: WebDeskSettings;

  private rootEl!: HTMLElement;
  private canvasEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private zoomEl!: HTMLElement;
  private embedKey = "";
  private iconEls = new Map<number, HTMLElement>();
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private busy = false;
  private editing = false;

  constructor(
    el: HTMLElement,
    source: string,
    app: App,
    ctx: EmbedCtxLike,
    settings: WebDeskSettings,
  ) {
    this.el = el;
    this.app = app;
    this.ctx = ctx;
    this.filePath = ctx.sourcePath;
    this.settings = settings;
    this.originalSource = source.trim();
    this.data = parseEmbedData(source);
  }

  render(): void {
    this.el.empty();
    this.el.addClass("web-desk-embed-host");
    this.embedKey = this.resolveEmbedKey();

    this.rootEl = this.el.createDiv({ cls: "web-desk-embed" });
    this.rootEl.tabIndex = 0;
    this.rootEl.style.height = `${EMBED_HEIGHT}px`;

    this.canvasEl = this.rootEl.createDiv({ cls: "web-desk-canvas web-desk-embed-canvas" });

    this.hintEl = this.rootEl.createDiv({ cls: "web-desk-hint" });
    this.hintEl.createDiv({
      cls: "web-desk-hint-body",
      text: "拖入网页链接或本地图片；Ctrl/Cmd+V 粘贴 URL、文本或图片",
    });

    const toolbar = this.rootEl.createDiv({ cls: "web-desk-toolbar" });
    const zoomOut = toolbar.createEl("button", { text: "－", cls: "web-desk-tool-btn" });
    this.zoomEl = toolbar.createEl("span", { cls: "web-desk-zoom-label", text: "100%" });
    const zoomIn = toolbar.createEl("button", { text: "＋", cls: "web-desk-tool-btn" });
    zoomOut.addEventListener("click", () => this.zoomAtCenter(1 / 1.2));
    zoomIn.addEventListener("click", () => this.zoomAtCenter(1.2));

    this.bindCanvasEvents();
    this.renderItems();
    this.updateHint();
    this.applyTransform();
    if (pendingEmbedFocus?.key === this.embedKey) {
      const pending = pendingEmbedFocus;
      pendingEmbedFocus = null;
      queueMicrotask(() => {
        if (Date.now() <= pending.expiresAt && this.rootEl.isConnected) {
          this.rootEl.focus({ preventScroll: true });
        }
      });
    }
  }

  private resolveEmbedKey(): string {
    const lineStart = this.ctx.getSectionInfo(this.el)?.lineStart;
    if (lineStart !== undefined) return `${this.filePath}:${lineStart}`;
    const leaf = this.el.closest(".workspace-leaf");
    const hosts = Array.from(leaf?.querySelectorAll(".web-desk-embed-host") ?? []);
    return `${this.filePath}:block-${Math.max(0, hosts.indexOf(this.el))}`;
  }

  // ---------- 渲染 ----------

  private renderItems(): void {
    this.iconEls.clear();
    this.canvasEl.empty();

    for (const image of this.data.images) {
      this.renderImage(image);
    }
    for (const box of this.data.textboxes ?? []) {
      this.renderTextBox(box);
    }
    for (let index = 0; index < this.data.items.length; index += 1) {
      this.renderItem(this.data.items[index], index);
    }
  }

  private renderItem(item: EmbedItem, index: number): void {
    const size = item.size ?? 96;
    const el = this.canvasEl.createDiv({ cls: "web-desk-icon" });
    el.style.left = `${item.x}px`;
    el.style.top = `${item.y}px`;
    el.style.width = `${size + 24}px`;

    const thumb = el.createDiv({ cls: "web-desk-icon-thumb" });
    thumb.style.width = `${size}px`;
    thumb.style.height = `${size}px`;

    let host = "";
    try { host = new URL(item.url).hostname.replace(/^www\./, ""); } catch { host = ""; }
    if (host) {
      const img = thumb.createEl("img", {
        cls: "web-desk-icon-img",
        attr: { src: faviconUrl(host), alt: host, draggable: "false" },
      });
      img.addEventListener("error", () => {
        img.remove();
        this.appendLetter(thumb, item, size);
      });
    } else {
      this.appendLetter(thumb, item, size);
    }

    el.createDiv({ cls: "web-desk-icon-label", text: item.title }).style.width = `${size + 24}px`;
    el.setAttribute("data-embed-index", String(index));
    el.setAttribute("aria-label", `${item.title}\n${item.url}`);

    el.addEventListener("pointerdown", (event) => this.onItemPointerDown(event, item, el));
    el.addEventListener("contextmenu", (event) => this.onItemContextMenu(event, item));

    this.iconEls.set(index, el);
  }

  private appendLetter(thumb: HTMLElement, item: EmbedItem, size: number): void {
    const letter = item.title.trim().charAt(0).toUpperCase() || "?";
    const block = thumb.createDiv({ cls: "web-desk-icon-letter", text: letter });
    block.style.backgroundColor = colorFromString(item.url);
    block.style.fontSize = `${Math.round(size * 0.42)}px`;
  }

  private renderTextBox(box: EmbedTextBox): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-textbox" });
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    const color = box.color ?? GROUP_COLORS[0];
    el.style.borderColor = color;
    el.style.backgroundColor = rgba(color, 0.08);
    el.setAttribute("data-tb-id", box.id);

    const text = el.createDiv({ cls: "web-desk-textbox-text", text: box.text });
    el.addEventListener("pointerdown", (event) => this.onTextBoxPointerDown(event, box, el));
    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.editTextBox(box, text);
    });
    el.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem((m) => m.setTitle("编辑文字").setIcon("pencil").onClick(() => this.editTextBox(box, text)));
      menu.addSeparator();
      menu.addItem((m) =>
        m.setTitle("删除文本框").setIcon("trash-2").onClick(() => {
          this.data.textboxes = (this.data.textboxes ?? []).filter((b) => b.id !== box.id);
          this.renderItems();
          this.scheduleWrite();
        }),
      );
      menu.showAtMouseEvent(event);
    });
  }

  private renderImage(image: CanvasImage): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-image" });
    el.style.left = `${image.x}px`;
    el.style.top = `${image.y}px`;
    el.style.width = `${image.w}px`;
    el.style.height = `${image.h}px`;
    el.setAttribute("data-image-id", image.id);
    el.setAttribute("aria-label", image.path);
    const resource = imageResourceUrl(this.app, image.path);
    if (resource) {
      el.createEl("img", {
        cls: "web-desk-image-content",
        attr: { src: resource, alt: image.path.split("/").pop() ?? "画布图片", draggable: "false" },
      });
    } else {
      el.addClass("is-missing");
      el.createDiv({ cls: "web-desk-image-missing", text: "图片文件已移动或删除" });
    }
    const handle = el.createDiv({ cls: "web-desk-image-resize" });
    el.addEventListener("pointerdown", (event) => this.onImagePointerDown(event, image, el));
    el.addEventListener("contextmenu", (event) => this.onImageContextMenu(event, image));
    handle.addEventListener("pointerdown", (event) =>
      this.onImageResizePointerDown(event, image, el),
    );
  }

  private onImagePointerDown(event: PointerEvent, image: CanvasImage, el: HTMLElement): void {
    if (
      event.button !== 0 ||
      this.editing ||
      (event.target as HTMLElement).closest(".web-desk-image-resize")
    ) return;
    event.stopPropagation();
    this.rootEl.focus();
    const start = { x: event.clientX, y: event.clientY };
    const origin = { x: image.x, y: image.y };
    let moved = false;
    try { el.setPointerCapture(event.pointerId); } catch {}
    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - start.x) / this.zoom;
      const dy = (moveEvent.clientY - start.y) / this.zoom;
      if (!moved && Math.hypot(dx, dy) * this.zoom < 4) return;
      moved = true;
      image.x = Math.round(origin.x + dx);
      image.y = Math.round(origin.y + dy);
      el.style.left = `${image.x}px`;
      el.style.top = `${image.y}px`;
    };
    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (moved) this.scheduleWrite();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  private onImageResizePointerDown(
    event: PointerEvent,
    image: CanvasImage,
    el: HTMLElement,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const origin = { w: image.w, h: image.h };
    let moved = false;
    try { el.setPointerCapture(event.pointerId); } catch {}
    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - start.x) / this.zoom;
      const dy = (moveEvent.clientY - start.y) / this.zoom;
      if (!moved && Math.hypot(dx, dy) * this.zoom < 4) return;
      moved = true;
      const widthDelta = Math.abs(dx) >= Math.abs(dy * (origin.w / origin.h))
        ? dx
        : dy * (origin.w / origin.h);
      const size = resizeImageToWidth(origin, origin.w + widthDelta);
      image.w = size.w;
      image.h = size.h;
      el.style.width = `${image.w}px`;
      el.style.height = `${image.h}px`;
    };
    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (moved) this.scheduleWrite();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  private onImageContextMenu(event: MouseEvent, image: CanvasImage): void {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle("打开图片文件").setIcon("image").onClick(() => {
        const file = this.app.vault.getAbstractFileByPath(image.path);
        if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
      }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("移出画布（保留附件）")
        .setIcon("image-minus")
        .onClick(() => {
          this.data.images = this.data.images.filter((entry) => entry.id !== image.id);
          this.renderItems();
          this.updateHint();
          this.scheduleWrite();
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private updateHint(): void {
    this.hintEl.style.display =
      this.data.items.length === 0 && this.data.images.length === 0 ? "flex" : "none";
  }

  // ---------- 交互 ----------

  private bindCanvasEvents(): void {
    // 卡片、图片等子元素不会自动把焦点交给可聚焦的画布祖先。
    // 明确认领焦点，确保下一次粘贴仍进入这个画布；文本框编辑态除外。
    this.rootEl.addEventListener("pointerdown", (event) => {
      if (!isEditablePasteTarget(event.target, this.rootEl)) {
        this.rootEl.focus({ preventScroll: true });
      }
    }, { capture: true });

    // 普通滚轮留给笔记滚动；Ctrl/Cmd+滚轮缩放画布
    this.rootEl.addEventListener("wheel", (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * 0.0022);
      this.zoomAt(event.clientX, event.clientY, factor);
    }, { passive: false });

    // 空白拖动 = 平移（不抢点击）
    this.rootEl.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      if (
        event.button !== 0 ||
        target.closest(".web-desk-icon") ||
        target.closest(".web-desk-image") ||
        target.closest(".web-desk-textbox") ||
        target.closest(".web-desk-toolbar")
      ) {
        return;
      }
      const startX = event.clientX;
      const startY = event.clientY;
      const baseX = this.panX;
      const baseY = this.panY;
      let moved = false;
      const onMove = (e: PointerEvent): void => {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        this.panX = baseX + dx;
        this.panY = baseY + dy;
        this.applyTransform();
      };
      const onUp = (): void => {
        this.rootEl.removeEventListener("pointermove", onMove);
        this.rootEl.removeEventListener("pointerup", onUp);
      };
      this.rootEl.addEventListener("pointermove", onMove);
      this.rootEl.addEventListener("pointerup", onUp);
    });

    this.rootEl.addEventListener("dragover", (event) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    this.rootEl.addEventListener("drop", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void this.onDrop(event);
    });
    this.rootEl.addEventListener("paste", (event) => void this.onPaste(event));

    this.rootEl.addEventListener("contextmenu", (event) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(".web-desk-icon") ||
        target.closest(".web-desk-image") ||
        target.closest(".web-desk-textbox")
      ) return;
      event.preventDefault();
      const menu = new Menu();
      menu.addItem((m) =>
        m.setTitle("添加链接…").setIcon("plus").onClick(() => {
          const url = window.prompt("链接地址");
          if (url) void this.addUrl(url, this.visibleCenter());
        }),
      );
      menu.addItem((m) =>
        m.setTitle("新建文本框").setIcon("sticky-note").onClick(() => this.addTextBox(this.visibleCenter())),
      );
      menu.showAtMouseEvent(event);
    });
  }

  private onItemPointerDown(event: PointerEvent, item: EmbedItem, el: HTMLElement): void {
    if (event.button !== 0 || this.editing) return;
    event.stopPropagation();

    const size = item.size ?? 96;
    const startClient = { x: event.clientX, y: event.clientY };
    const origin = { x: item.x, y: item.y };
    let moved = false;
    try { el.setPointerCapture(event.pointerId); } catch {}

    const onMove = (e: PointerEvent): void => {
      const dx = (e.clientX - startClient.x) / this.zoom;
      const dy = (e.clientY - startClient.y) / this.zoom;
      if (!moved && Math.hypot(dx, dy) * this.zoom < 5) return;
      moved = true;
      item.x = Math.round(origin.x + dx);
      item.y = Math.round(origin.y + dy);
      el.style.left = `${item.x}px`;
      el.style.top = `${item.y}px`;
    };
    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      if (!moved) {
        window.open(item.url, "_blank");
        return;
      }
      this.scheduleWrite();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  private onItemContextMenu(event: MouseEvent, item: EmbedItem): void {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((m) => m.setTitle("打开网页").setIcon("external-link").onClick(() => window.open(item.url, "_blank")));
    menu.addItem((m) =>
      m.setTitle("复制链接").setIcon("copy").onClick(() => {
        void navigator.clipboard.writeText(item.url);
        new Notice("已复制链接");
      }),
    );
    menu.addSeparator();
    menu.addItem((m) => m.setTitle("删除条目").setIcon("trash-2").onClick(() => {
      this.data.items = this.data.items.filter((entry) => entry !== item);
      this.renderItems();
      this.updateHint();
      this.scheduleWrite();
    }));
    menu.showAtMouseEvent(event);
  }

  private onTextBoxPointerDown(event: PointerEvent, box: EmbedTextBox, el: HTMLElement): void {
    if (event.button !== 0 || this.editing) return;
    event.stopPropagation();
    const startClient = { x: event.clientX, y: event.clientY };
    const origin = { x: box.x, y: box.y };
    let moved = false;
    try { el.setPointerCapture(event.pointerId); } catch {}
    const onMove = (e: PointerEvent): void => {
      const dx = (e.clientX - startClient.x) / this.zoom;
      const dy = (e.clientY - startClient.y) / this.zoom;
      if (!moved && Math.hypot(dx, dy) * this.zoom < 4) return;
      moved = true;
      box.x = Math.round(origin.x + dx);
      box.y = Math.round(origin.y + dy);
      el.style.left = `${box.x}px`;
      el.style.top = `${box.y}px`;
    };
    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      if (moved) this.scheduleWrite();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  }

  private editTextBox(box: EmbedTextBox, textEl: HTMLElement): void {
    this.editing = true;
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
      this.editing = false;
      const value = textEl.innerText.replace(/\u00a0/g, " ").trim();
      if (value !== box.text) {
        box.text = value;
        this.scheduleWrite();
      }
    };
    textEl.addEventListener("blur", commit);
    textEl.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") textEl.blur();
    });
  }

  // ---------- 缩放 ----------

  private applyTransform(): void {
    this.canvasEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    this.zoomEl.setText(`${Math.round(this.zoom * 100)}%`);
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = this.rootEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    const ratio = next / this.zoom;
    this.panX = px - (px - this.panX) * ratio;
    this.panY = py - (py - this.panY) * ratio;
    this.zoom = next;
    this.applyTransform();
  }

  private zoomAtCenter(factor: number): void {
    const rect = this.rootEl.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  private clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.rootEl.getBoundingClientRect();
    return {
      x: (clientX - rect.left - this.panX) / this.zoom,
      y: (clientY - rect.top - this.panY) / this.zoom,
    };
  }

  private visibleCenter(): { x: number; y: number } {
    const rect = this.rootEl.getBoundingClientRect();
    return this.clientToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  // ---------- 导入 ----------

  private async onDrop(event: DragEvent): Promise<void> {
    const point = this.clientToCanvas(event.clientX, event.clientY);
    const imageFiles = imageFilesFrom(event.dataTransfer?.files);
    if (imageFiles.length > 0) {
      await this.importImages(imageFiles, point);
      return;
    }
    const text =
      event.dataTransfer?.getData("text/uri-list") ||
      event.dataTransfer?.getData("text/plain") ||
      "";
    const urls = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && isProbablyUrl(l));
    if (urls.length === 0) {
      new Notice("没有识别到 http(s) 链接");
      return;
    }
    for (const url of urls) await this.addUrl(url, point, true);
    this.renderItems();
    this.updateHint();
    this.scheduleWrite();
  }

  private async onPaste(event: ClipboardEvent): Promise<void> {
    const imageFiles = imageFilesFromClipboard(event.clipboardData);
    const clipboardText =
      event.clipboardData?.getData("text/uri-list") ||
      event.clipboardData?.getData("text/plain") ||
      "";
    const paste = splitCanvasPaste(clipboardText);
    if (!shouldClaimEmbeddedCanvasPaste({
      defaultPrevented: event.defaultPrevented,
      editableTarget: isEditablePasteTarget(event.target, this.rootEl),
      imageCount: imageFiles.length,
      paste,
    })) return;

    if (imageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      await this.importImages(imageFiles, this.visibleCenter());
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    const point = this.visibleCenter();
    if (paste.text) this.addTextBox(point, paste.text);
    if (paste.urls.length > 0) {
      const urlPoint = paste.text ? { x: point.x + 190, y: point.y } : point;
      for (const url of paste.urls) await this.addUrl(url, urlPoint, true);
      this.renderItems();
      this.updateHint();
      this.scheduleWrite();
    }
  }

  private async importImages(files: File[], point: { x: number; y: number }): Promise<void> {
    for (let index = 0; index < files.length; index += 1) {
      try {
        const image = await storeImageFile(this.app, this.settings.imageFolder, files[index], {
          x: point.x + index * 32,
          y: point.y + index * 32,
        });
        this.data.images.push(image);
        new Notice(`已插入图片：${image.path.split("/").pop() ?? image.path}`);
      } catch (error) {
        new Notice(`插入图片失败：${getErrorMessage(error)}`, 6000);
      }
    }
    this.renderItems();
    this.updateHint();
    this.scheduleWrite();
  }

  private async addUrl(rawUrl: string, point: { x: number; y: number }, quiet = false): Promise<void> {
    if (this.data.items.some((item) => item.url === rawUrl)) {
      new Notice("这个链接已经在画布上了");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    try {
      new Notice(`正在抓取：${rawUrl}`);
      const meta = await fetchBookmarkMeta(rawUrl);
      const position = findAvailableEmbedItemPosition(this.data, {
        x: Math.round(point.x - 48),
        y: Math.round(point.y - 48),
      });
      this.data.items.push({
        url: meta.url,
        title: meta.title,
        description: meta.description,
        x: position.x,
        y: position.y,
        size: 96,
      });
      if (!quiet) {
        this.renderItems();
        this.updateHint();
        this.scheduleWrite();
      }
    } catch (error) {
      new Notice(`收藏失败：${getErrorMessage(error)}`, 8000);
    } finally {
      this.busy = false;
    }
  }

  private addTextBox(point: { x: number; y: number }, text = "双击编辑"): void {
    const boxes = this.data.textboxes ?? (this.data.textboxes = []);
    boxes.push({
      id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      text,
      x: Math.round(point.x - 130),
      y: Math.round(point.y - 60),
      w: 260,
      h: 120,
      color: GROUP_COLORS[boxes.length % GROUP_COLORS.length],
    });
    this.renderItems();
    this.scheduleWrite();
  }

  // ---------- 写回 ----------

  private serialize(): string {
    return JSON.stringify(this.data, null, 1);
  }

  private scheduleWrite = debounce(() => void this.writeBack(), 500);

  private async writeBack(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return;

    const active = this.rootEl.ownerDocument.activeElement;
    pendingEmbedFocus = active === this.rootEl || this.rootEl.contains(active)
      ? { key: this.embedKey, expiresAt: Date.now() + 2_000 }
      : null;

    const info = this.ctx.getSectionInfo(this.el);
    if (info) {
      // 主路径：编辑器精确替换块行
      const leafEl = this.el.closest(".workspace-leaf") as (HTMLElement & { view?: { editor?: { replaceRange: (t: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => void; getLine: (l: number) => string } } }) | null;
      const editor = leafEl?.view?.editor;
      if (editor) {
        const to = { line: info.lineEnd, ch: editor.getLine(info.lineEnd).length };
        editor.replaceRange(this.serialize(), { line: info.lineStart, ch: 0 }, to);
        return;
      }
    }

    // 兜底：全文按「渲染时的原始块内容」定位替换（LP 下 getSectionInfo 常为 null，此路径保命）
    const fresh = this.serialize();
    const marker = this.originalSource;
    try {
      await this.app.vault.process(file, (content) => {
        const index = content.indexOf(marker);
        if (index === -1) return content;
        // 只替换首次出现的这个块（同名块内容相同，替换任何一个等价）
        return content.slice(0, index) + fresh + content.slice(index + marker.length);
      });
    } catch (error) {
      new Notice(`写回画布失败：${getErrorMessage(error)}`, 5000);
    }
  }
}

function rgba(hex: string, alpha: number): string {
  const match = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return `rgba(127,127,127,${alpha})`;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 0xff},${(value >> 8) & 0xff},${value & 0xff},${alpha})`;
}
