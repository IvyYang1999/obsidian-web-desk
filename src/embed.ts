import { App, Menu, Notice, setIcon, TFile } from "obsidian";
import {
  EmbedData,
  EmbedItem,
  EmbedTextBox,
  embedItemRef,
  MAX_EMBED_HEIGHT,
  MIN_EMBED_HEIGHT,
  findAvailableEmbedItemPosition,
  findAvailableEmbedRatingPosition,
  normalizeEmbedHeight,
  parseEmbedData,
} from "./embed-state";
import { extractEmbeddedMarkdownPaths } from "./file-link-state";
import { hasLocalMarkdownFileDrop, markdownFilesFromDrop } from "./file-link-storage";
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
import { replaceEmbedMarker } from "./embed-write-state";
import { normalizeRatingValue, ratingLinkState } from "./rating-state";
import { fetchBookmarkMeta } from "./importer";
import { TextInputModal } from "./modals";
import { beginCanvasPointerSession } from "./canvas-pointer";
import {
  GroupObjectRect,
  objectGroupBounds,
  objectKey,
  scaleObjectGroup,
  splitObjectKey,
  translateObjectGroup,
} from "./object-group-state";
import {
  arrowLine,
  arrowsWithoutEndpoint,
  clearGroupMembership,
  createGroupBox,
  cycleColor,
  hasArrowBetween,
  pruneDanglingArrows,
  recomputeGroupMembership,
  renameGroupMembership,
} from "./canvas-state";
import { GROUP_COLORS } from "./types";
import type {
  Arrow,
  ArrowEndpoint,
  CanvasImage,
  GroupBox,
  Rating,
  TextBox,
  WebDeskSettings,
} from "./types";
import { colorFromString, faviconUrl, getErrorMessage, isProbablyUrl } from "./util";

interface EmbedCtxLike {
  sourcePath: string;
  getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_SPAN = 20000;
let pendingEmbedFocus: { key: string; expiresAt: number; viaPointer: boolean } | null = null;

interface EmbedViewObject extends GroupObjectRect {
  kind: "card" | "image" | "textbox" | "rating";
  id: string;
  objectGroup: string;
}

/**
 * 笔记内嵌画布（```web-desk code block）。
 * 数据全部存在块内（纯 md 到底），编辑后写回块源码；
 * 主路径 getSectionInfo+replaceRange（阅读/实时预览），兜底按内容全文匹配（vault.process）。
 */
export class DeskEmbed {
  private data: EmbedData;
  /** 上一次成功写入的块内容；兜底写回用它定位，成功后随即前移。 */
  private sourceMarker: string;
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
  private imageEls = new Map<string, HTMLElement>();
  private textBoxEls = new Map<string, HTMLElement>();
  private ratingEls = new Map<string, HTMLElement>();
  private groupEls = new Map<string, HTMLElement>();
  private marqueeEl!: HTMLElement;
  private objectSelectionEl: HTMLElement | null = null;
  private selectedObjects = new Set<string>();
  private arrowsG: SVGGElement | null = null;
  private arrowMarkerIds = new Map<string, string>();
  private selectedArrowId: string | null = null;
  private arrowDraft: ArrowEndpoint | null = null;
  private pendingArrowStart = false;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private busy = false;
  private editing = false;
  private spacePanning = false;
  /** 所有块写入严格串行，旧提交不能晚于新提交落盘。 */
  private writeQueue: Promise<void> = Promise.resolve();

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
    this.sourceMarker = source.trim();
    this.data = parseEmbedData(source);
  }

  render(): void {
    this.el.empty();
    this.el.addClass("web-desk-embed-host");
    this.embedKey = this.resolveEmbedKey();

    this.rootEl = this.el.createDiv({ cls: "web-desk-embed" });
    this.rootEl.tabIndex = 0;
    this.rootEl.style.height = `${this.data.height}px`;

    this.canvasEl = this.rootEl.createDiv({ cls: "web-desk-canvas web-desk-embed-canvas" });
    this.marqueeEl = this.rootEl.createDiv({ cls: "web-desk-marquee" });
    this.marqueeEl.style.display = "none";

    this.hintEl = this.rootEl.createDiv({ cls: "web-desk-hint" });
    this.hintEl.createDiv({
      cls: "web-desk-hint-body",
      text: "拖入或粘贴内容；拖框多选，Ctrl/Cmd+G 组合，Space+拖动平移",
    });

    const toolbar = this.rootEl.createDiv({ cls: "web-desk-toolbar" });
    const zoomOut = toolbar.createEl("button", { text: "－", cls: "web-desk-tool-btn" });
    this.zoomEl = toolbar.createEl("span", { cls: "web-desk-zoom-label", text: "100%" });
    const zoomIn = toolbar.createEl("button", { text: "＋", cls: "web-desk-tool-btn" });
    zoomOut.addEventListener("click", () => this.zoomAtCenter(1 / 1.2));
    zoomIn.addEventListener("click", () => this.zoomAtCenter(1.2));

    const heightHandle = this.rootEl.createDiv({
      cls: "web-desk-embed-height-resize",
      attr: {
        role: "separator",
        "aria-label": "拖拽调整画布高度",
        "aria-orientation": "horizontal",
        "aria-valuemin": String(MIN_EMBED_HEIGHT),
        "aria-valuemax": String(MAX_EMBED_HEIGHT),
        "aria-valuenow": String(this.data.height),
        title: "拖拽调整画布高度",
      },
    });
    heightHandle.addEventListener("pointerdown", (event) =>
      this.onEmbedHeightResizePointerDown(event, heightHandle),
    );

    this.bindCanvasEvents();
    this.renderItems();
    this.updateHint();
    this.applyTransform();
    if (pendingEmbedFocus?.key === this.embedKey) {
      const pending = pendingEmbedFocus;
      pendingEmbedFocus = null;
      queueMicrotask(() => {
        if (Date.now() <= pending.expiresAt && this.rootEl.isConnected) {
          this.rootEl.toggleClass("is-pointer-focused", pending.viaPointer);
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
    this.imageEls.clear();
    this.textBoxEls.clear();
    this.ratingEls.clear();
    this.groupEls.clear();
    this.canvasEl.empty();

    this.pruneDanglingArrows();
    this.buildSvgLayer();
    for (const group of this.data.groups) {
      this.renderGroup(group);
    }
    for (const image of this.data.images) {
      this.renderImage(image);
    }
    for (const box of this.data.textboxes) {
      this.renderTextBox(box);
    }
    this.renderRatings();
    for (let index = 0; index < this.data.items.length; index += 1) {
      this.renderItem(this.data.items[index], index);
    }
    this.renderArrows();
    this.syncObjectSelection();
  }

  private renderItem(item: EmbedItem, index: number): void {
    const size = item.size ?? 96;
    const el = this.canvasEl.createDiv({ cls: "web-desk-icon" });
    if (item.objectGroup) el.addClass("is-object-grouped");
    el.style.left = `${item.x}px`;
    el.style.top = `${item.y}px`;
    el.style.width = `${size + 24}px`;

    const thumb = el.createDiv({ cls: "web-desk-icon-thumb" });
    thumb.style.width = `${size}px`;
    thumb.style.height = `${size}px`;

    let host = "";
    try { host = new URL(item.url).hostname.replace(/^www\./, ""); } catch { host = ""; }
    if (item.path) {
      el.addClass("is-file-link");
      thumb.addClass("web-desk-file-thumb");
      const icon = thumb.createDiv({ cls: "web-desk-file-icon" });
      setIcon(icon, "file-text");
      if (!(this.app.vault.getAbstractFileByPath(item.path) instanceof TFile)) {
        el.addClass("is-file-missing");
      }
    } else if (host) {
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
    const handle = el.createDiv({ cls: "web-desk-icon-resize" });
    handle.style.top = `${size - 4}px`;
    el.setAttribute("data-embed-index", String(index));
    el.setAttribute("data-card-ref", embedItemRef(item));
    el.setAttribute("aria-label", `${item.title}\n${item.path || item.url}`);

    el.addEventListener("pointerdown", (event) => this.onItemPointerDown(event, item, el));
    el.addEventListener("contextmenu", (event) => this.onItemContextMenu(event, item));
    if (item.path) {
      el.addEventListener("mouseover", (event) => this.triggerFileHover(event, el, item.path!));
    }
    handle.addEventListener("pointerdown", (event) => this.onItemResizePointerDown(event, item, el));

    this.iconEls.set(index, el);
  }

  private appendLetter(thumb: HTMLElement, item: EmbedItem, size: number): void {
    const letter = item.title.trim().charAt(0).toUpperCase() || "?";
    const block = thumb.createDiv({ cls: "web-desk-icon-letter", text: letter });
    block.style.backgroundColor = colorFromString(item.path || item.url);
    block.style.fontSize = `${Math.round(size * 0.42)}px`;
  }

  private allEmbedObjects(): EmbedViewObject[] {
    return [
      ...this.data.items.map((item) => {
        const size = item.size ?? 96;
        return {
          key: embedItemRef(item),
          kind: "card" as const,
          id: embedItemRef(item),
          objectGroup: item.objectGroup ?? "",
          x: item.x,
          y: item.y,
          w: size + 24,
          h: size + 44,
          minW: 56,
          minH: 76,
          maxW: 344,
          maxH: 364,
        };
      }),
      ...this.data.images.map((image) => ({
        key: objectKey("image", image.id),
        kind: "image" as const,
        id: image.id,
        objectGroup: image.objectGroup ?? "",
        x: image.x,
        y: image.y,
        w: image.w,
        h: image.h,
        minW: 80,
        minH: image.h * (80 / image.w),
      })),
      ...this.data.textboxes.map((box) => ({
        key: objectKey("textbox", box.id),
        kind: "textbox" as const,
        id: box.id,
        objectGroup: box.objectGroup ?? "",
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        minW: 140,
        minH: 60,
      })),
      ...this.data.ratings.map((rating) => {
        const scale = rating.scale ?? 1;
        return {
          key: objectKey("rating", rating.id),
          kind: "rating" as const,
          id: rating.id,
          objectGroup: rating.objectGroup ?? "",
          x: rating.x,
          y: rating.y,
          w: 208 * scale,
          h: 86 * scale,
          minW: 104,
          minH: 43,
          maxW: 624,
          maxH: 258,
        };
      }),
    ];
  }

  private selectedEmbedObjects(): EmbedViewObject[] {
    return this.allEmbedObjects().filter((object) => this.selectedObjects.has(object.key));
  }

  private selectEmbedObject(key: string, additive: boolean): void {
    const objects = this.allEmbedObjects();
    const object = objects.find((entry) => entry.key === key);
    if (!object) return;
    const keys = object.objectGroup
      ? objects.filter((entry) => entry.objectGroup === object.objectGroup).map((entry) => entry.key)
      : [key];
    if (!additive) this.selectedObjects.clear();
    const remove = additive && keys.every((entry) => this.selectedObjects.has(entry));
    for (const entry of keys) {
      if (remove) this.selectedObjects.delete(entry);
      else this.selectedObjects.add(entry);
    }
    this.selectedArrowId = null;
    this.syncObjectSelection();
  }

  private ensureEmbedObjectSelection(key: string): void {
    if (!this.selectedObjects.has(key)) this.selectEmbedObject(key, false);
  }

  private embedObjectElement(object: EmbedViewObject): HTMLElement | undefined {
    if (object.kind === "card") {
      const index = this.data.items.findIndex((item) => embedItemRef(item) === object.id);
      return this.iconEls.get(index);
    }
    if (object.kind === "image") return this.imageEls.get(object.id);
    if (object.kind === "textbox") return this.textBoxEls.get(object.id);
    return this.ratingEls.get(object.id);
  }

  private applyEmbedObjectPosition(key: string, x: number, y: number): void {
    const parsed = splitObjectKey(key);
    if (!parsed) {
      const item = this.data.items.find((entry) => embedItemRef(entry) === key);
      if (item) { item.x = x; item.y = y; }
      const index = this.data.items.findIndex((entry) => embedItemRef(entry) === key);
      const el = this.iconEls.get(index);
      if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
      return;
    }
    const collection = parsed.kind === "image"
      ? this.data.images
      : parsed.kind === "textbox"
        ? this.data.textboxes
        : parsed.kind === "rating"
          ? this.data.ratings
          : [];
    const item = collection.find((entry) => entry.id === parsed.id);
    if (item) { item.x = x; item.y = y; }
    const object = this.allEmbedObjects().find((entry) => entry.key === key);
    const el = object ? this.embedObjectElement(object) : undefined;
    if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
  }

  private applyEmbedObjectScale(origin: EmbedViewObject, x: number, y: number, scale: number): void {
    this.applyEmbedObjectPosition(origin.key, x, y);
    if (origin.kind === "card") {
      const item = this.data.items.find((entry) => embedItemRef(entry) === origin.id);
      if (!item) return;
      item.size = Math.min(320, Math.max(32, Math.round((origin.w - 24) * scale)));
      const index = this.data.items.findIndex((entry) => embedItemRef(entry) === origin.id);
      const el = this.iconEls.get(index);
      if (el) updateEmbedIconElementSize(el, item.size);
      return;
    }
    if (origin.kind === "image") {
      const image = this.data.images.find((entry) => entry.id === origin.id);
      if (!image) return;
      image.w = Math.round(origin.w * scale);
      image.h = Math.round(origin.h * scale);
      const el = this.imageEls.get(origin.id);
      if (el) { el.style.width = `${image.w}px`; el.style.height = `${image.h}px`; }
      return;
    }
    if (origin.kind === "textbox") {
      const box = this.data.textboxes.find((entry) => entry.id === origin.id);
      if (!box) return;
      box.w = Math.round(origin.w * scale);
      box.h = Math.round(origin.h * scale);
      const el = this.textBoxEls.get(origin.id);
      if (el) { el.style.width = `${box.w}px`; el.style.height = `${box.h}px`; }
      return;
    }
    const rating = this.data.ratings.find((entry) => entry.id === origin.id);
    if (!rating) return;
    rating.scale = Math.min(3, Math.max(0.5, (origin.w / 208) * scale));
    const el = this.ratingEls.get(origin.id);
    if (el) el.style.transform = `scale(${rating.scale})`;
  }

  private syncObjectSelection(): void {
    this.data.items.forEach((item, index) => this.iconEls.get(index)?.toggleClass("is-selected", this.selectedObjects.has(embedItemRef(item))));
    for (const [id, el] of this.imageEls) el.toggleClass("is-selected", this.selectedObjects.has(objectKey("image", id)));
    for (const [id, el] of this.textBoxEls) el.toggleClass("is-selected", this.selectedObjects.has(objectKey("textbox", id)));
    for (const [id, el] of this.ratingEls) el.toggleClass("is-selected", this.selectedObjects.has(objectKey("rating", id)));
    this.renderEmbedObjectSelection();
  }

  private renderEmbedObjectSelection(): void {
    this.objectSelectionEl?.remove();
    this.objectSelectionEl = null;
    const objects = this.selectedEmbedObjects();
    if (objects.length < 2) return;
    const bounds = objectGroupBounds(objects);
    if (!bounds) return;
    const el = this.canvasEl.createDiv({ cls: "web-desk-object-selection" });
    el.style.left = `${bounds.x}px`;
    el.style.top = `${bounds.y}px`;
    el.style.width = `${bounds.w}px`;
    el.style.height = `${bounds.h}px`;
    const groupId = objects[0].objectGroup;
    const fullGroup = Boolean(groupId) && objects.every((object) => object.objectGroup === groupId) &&
      this.allEmbedObjects().filter((object) => object.objectGroup === groupId).length === objects.length;
    if (fullGroup) {
      const handle = el.createDiv({ cls: "web-desk-object-selection-resize" });
      handle.setAttribute("aria-label", "缩放组合");
      handle.addEventListener("pointerdown", (event) => this.onEmbedGroupResizePointerDown(event, handle));
    } else {
      el.addClass("is-multiselect");
    }
    this.objectSelectionEl = el;
  }

  private onEmbedGroupResizePointerDown(event: PointerEvent, handle: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origins = this.selectedEmbedObjects();
    const bounds = objectGroupBounds(origins);
    if (!bounds || origins.length < 2) return;
    beginCanvasPointerSession({
      event,
      element: handle,
      zoom: () => this.zoom,
      resizing: true,
      onMove: (delta) => {
        const relativeX = delta.x / Math.max(bounds.w, 1);
        const relativeY = delta.y / Math.max(bounds.h, 1);
        const requested = 1 + (Math.abs(relativeX) >= Math.abs(relativeY) ? relativeX : relativeY);
        const result = scaleObjectGroup(origins, requested);
        result.objects.forEach((object, index) => {
          this.applyEmbedObjectScale(origins[index], object.x, object.y, result.scale);
        });
        this.renderArrows();
        this.updateEmbedObjectSelectionFrame();
      },
      onEnd: (moved) => {
        if (moved) this.scheduleWrite();
      },
    });
  }

  private updateEmbedObjectSelectionFrame(): void {
    if (!this.objectSelectionEl) return;
    const bounds = objectGroupBounds(this.selectedEmbedObjects());
    if (!bounds) return;
    this.objectSelectionEl.style.left = `${bounds.x}px`;
    this.objectSelectionEl.style.top = `${bounds.y}px`;
    this.objectSelectionEl.style.width = `${bounds.w}px`;
    this.objectSelectionEl.style.height = `${bounds.h}px`;
  }

  private setSelectedEmbedObjectGroup(groupId: string): void {
    const objects = this.selectedEmbedObjects();
    if (groupId && objects.length < 2) {
      new Notice("请先多选至少两个元素");
      return;
    }
    for (const object of objects) {
      if (object.kind === "card") {
        const item = this.data.items.find((entry) => embedItemRef(entry) === object.id);
        if (item) item.objectGroup = groupId || undefined;
      } else if (object.kind === "image") {
        const image = this.data.images.find((entry) => entry.id === object.id);
        if (image) image.objectGroup = groupId || undefined;
      } else if (object.kind === "textbox") {
        const box = this.data.textboxes.find((entry) => entry.id === object.id);
        if (box) box.objectGroup = groupId || undefined;
      } else {
        const rating = this.data.ratings.find((entry) => entry.id === object.id);
        if (rating) rating.objectGroup = groupId || undefined;
      }
    }
    this.renderItems();
    this.scheduleWrite();
  }

  private groupSelectedEmbedObjects(): void {
    this.setSelectedEmbedObjectGroup(`og${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
  }

  private ungroupSelectedEmbedObjects(): void {
    if (!this.selectedEmbedObjects().some((object) => object.objectGroup)) return;
    this.setSelectedEmbedObjectGroup("");
  }

  private appendEmbedObjectGroupMenu(menu: Menu): void {
    const objects = this.selectedEmbedObjects();
    if (objects.length >= 2) {
      menu.addItem((item) => item.setTitle("组合所选元素").setIcon("combine").onClick(() => this.groupSelectedEmbedObjects()));
    }
    if (objects.some((object) => object.objectGroup)) {
      menu.addItem((item) => item.setTitle("取消组合").setIcon("ungroup").onClick(() => this.ungroupSelectedEmbedObjects()));
    }
  }

  private onEmbedObjectPointerDown(
    event: PointerEvent,
    key: string,
    el: HTMLElement,
    activate?: () => void,
  ): void {
    event.stopPropagation();
    this.rootEl.focus();
    if (event.shiftKey) {
      this.selectEmbedObject(key, true);
      return;
    }
    this.ensureEmbedObjectSelection(key);
    const origins = this.selectedEmbedObjects();
    if (origins.length === 0) return;
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      onMove: (delta) => {
        const translated = translateObjectGroup(origins, delta);
        for (const object of translated) this.applyEmbedObjectPosition(object.key, object.x, object.y);
        this.renderArrows();
        this.renderEmbedObjectSelection();
      },
      onEnd: (moved) => {
        if (!moved) {
          activate?.();
          return;
        }
        this.recomputeEmbedGroupMembership();
        this.scheduleWrite();
      },
    });
  }

  private renderRatings(): void {
    const available = new Set(this.data.items.map(embedItemRef));
    for (const rating of this.data.ratings ?? []) {
      rating.value = normalizeRatingValue(rating.value);
      const state = ratingLinkState(rating.link, available);
      const linkedItem = rating.link
        ? this.data.items.find((item) => embedItemRef(item) === rating.link?.ref)
        : undefined;
      const el = this.canvasEl.createDiv({ cls: `web-desk-rating is-${state}` });
      if (rating.objectGroup) el.addClass("is-object-grouped");
      el.style.left = `${rating.x}px`;
      el.style.top = `${rating.y}px`;
      el.style.transform = `scale(${rating.scale ?? 1})`;
      el.style.transformOrigin = "top left";
      el.setAttribute("data-rating-id", rating.id);

      const header = el.createDiv({ cls: "web-desk-rating-header" });
      header.createSpan({
        cls: "web-desk-rating-link",
        text: state === "standalone"
          ? "独立评分"
          : state === "missing"
            ? `原链接已移出 · ${rating.link?.title ?? "网页"}`
            : linkedItem?.title ?? rating.link?.title ?? "网页",
      });
      header.createSpan({
        cls: "web-desk-rating-value",
        text: rating.value > 0 ? `${rating.value}/5` : "未评分",
      });

      const stars = el.createDiv({ cls: "web-desk-rating-stars" });
      for (let value = 1; value <= 5; value += 1) {
        const star = stars.createEl("button", {
          cls: `web-desk-rating-star${value <= rating.value ? " is-active" : ""}`,
          text: "★",
          attr: {
            "aria-label": `${value} 星`,
            "aria-pressed": String(value <= rating.value),
            title: `${value} 星`,
          },
        });
        star.addEventListener("pointerdown", (event) => event.stopPropagation());
        star.addEventListener("click", (event) => {
          event.stopPropagation();
          rating.value = rating.value === value ? 0 : value;
          this.renderItems();
          this.scheduleWrite();
        });
      }

      el.addEventListener("pointerdown", (event) => this.onRatingPointerDown(event, rating, el));
      el.addEventListener("contextmenu", (event) => this.onRatingContextMenu(event, rating));
      this.ratingEls.set(rating.id, el);
    }
  }

  private renderGroup(group: GroupBox): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-group" });
    el.style.left = `${group.x}px`;
    el.style.top = `${group.y}px`;
    el.style.width = `${group.w}px`;
    el.style.height = `${group.h}px`;
    el.style.borderColor = group.color;
    el.style.backgroundColor = rgba(group.color, 0.06);
    el.setAttribute("data-group-id", group.id);

    const header = el.createDiv({ cls: "web-desk-group-header" });
    header.style.color = group.color;
    header.createSpan({ text: group.name });
    header.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.renameGroup(group);
    });

    const handle = el.createDiv({ cls: "web-desk-group-resize" });
    handle.addEventListener("pointerdown", (event) => this.onGroupResizePointerDown(event, group, el));
    el.addEventListener("pointerdown", (event) => this.onGroupPointerDown(event, group, el));
    el.addEventListener("contextmenu", (event) => this.onGroupContextMenu(event, group));
    this.groupEls.set(group.id, el);
  }

  private buildSvgLayer(): void {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "web-desk-arrows");
    svg.setAttribute(
      "style",
      `position:absolute;left:${-ARROW_SPAN}px;top:${-ARROW_SPAN}px;width:${ARROW_SPAN * 2}px;height:${ARROW_SPAN * 2}px;pointer-events:none;overflow:visible`,
    );
    svg.setAttribute("viewBox", `${-ARROW_SPAN} ${-ARROW_SPAN} ${ARROW_SPAN * 2} ${ARROW_SPAN * 2}`);

    const defs = document.createElementNS(SVG_NS, "defs");
    const prefix = markerPrefix(this.embedKey);
    const addMarker = (id: string, color: string): void => {
      const marker = document.createElementNS(SVG_NS, "marker");
      marker.setAttribute("id", id);
      marker.setAttribute("viewBox", "0 0 10 10");
      marker.setAttribute("refX", "9");
      marker.setAttribute("refY", "5");
      marker.setAttribute("markerWidth", "7");
      marker.setAttribute("markerHeight", "7");
      marker.setAttribute("orient", "auto-start-reverse");
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", "M0,0 L10,5 L0,10 z");
      path.style.fill = color;
      marker.appendChild(path);
      defs.appendChild(marker);
    };
    this.arrowMarkerIds.clear();
    addMarker(`${prefix}-accent`, "var(--interactive-accent)");
    GROUP_COLORS.forEach((color, index) => {
      const id = `${prefix}-${index}`;
      addMarker(id, color);
      this.arrowMarkerIds.set(color, id);
    });
    this.arrowMarkerIds.set("", `${prefix}-accent`);
    svg.appendChild(defs);

    const group = document.createElementNS(SVG_NS, "g");
    svg.appendChild(group);
    this.canvasEl.appendChild(svg);
    this.arrowsG = group;
  }

  private endpointScene() {
    return {
      cards: this.data.items.map((item) => {
        const size = item.size ?? 96;
        return {
          ref: embedItemRef(item),
          x: item.x,
          y: item.y,
          w: size + 24,
          h: size + 44,
          group: item.group,
        };
      }),
      textboxes: this.data.textboxes,
      groups: this.data.groups,
    };
  }

  private renderArrows(): void {
    if (!this.arrowsG) return;
    this.arrowsG.innerHTML = "";
    const scene = this.endpointScene();
    for (const arrow of this.data.arrows) {
      const line = arrowLine(arrow.from, arrow.to, scene);
      if (!line) continue;
      const d = `M ${line.from.x} ${line.from.y} L ${line.to.x} ${line.to.y}`;

      const hit = document.createElementNS(SVG_NS, "path");
      hit.setAttribute("d", d);
      hit.setAttribute("class", "web-desk-arrow-hit");
      hit.addEventListener("pointerdown", (event) => this.onArrowPointerDown(event, arrow));
      hit.addEventListener("contextmenu", (event) => this.onArrowContextMenu(event, arrow));
      this.arrowsG.appendChild(hit);

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", arrow.id === this.selectedArrowId ? "web-desk-arrow is-selected" : "web-desk-arrow");
      path.style.stroke = arrow.color || "var(--interactive-accent)";
      path.setAttribute(
        "marker-end",
        `url(#${this.arrowMarkerIds.get(arrow.color) ?? this.arrowMarkerIds.get("")})`,
      );
      this.arrowsG.appendChild(path);

      if (arrow.label) {
        const label = document.createElementNS(SVG_NS, "text");
        label.setAttribute("class", "web-desk-arrow-label");
        label.setAttribute("x", String((line.from.x + line.to.x) / 2));
        label.setAttribute("y", String((line.from.y + line.to.y) / 2 - 6));
        label.setAttribute("text-anchor", "middle");
        label.textContent = arrow.label;
        this.arrowsG.appendChild(label);
      }
    }
  }

  private onGroupPointerDown(event: PointerEvent, group: GroupBox, el: HTMLElement): void {
    if (event.button !== 0 || this.interceptArrowClick(event)) return;
    event.stopPropagation();
    const origin = { x: group.x, y: group.y };
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      onMove: (delta) => {
        group.x = Math.round(origin.x + delta.x);
        group.y = Math.round(origin.y + delta.y);
        el.style.left = `${group.x}px`;
        el.style.top = `${group.y}px`;
        this.renderArrows();
      },
      onEnd: (moved) => {
        if (!moved) return;
        this.recomputeEmbedGroupMembership();
        this.scheduleWrite();
      },
    });
  }

  private onGroupResizePointerDown(event: PointerEvent, group: GroupBox, el: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = { w: group.w, h: group.h };
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      resizing: true,
      onMove: (delta) => {
        group.w = Math.max(240, Math.round(origin.w + delta.x));
        group.h = Math.max(180, Math.round(origin.h + delta.y));
        el.style.width = `${group.w}px`;
        el.style.height = `${group.h}px`;
        this.renderArrows();
      },
      onEnd: (moved) => {
        if (!moved) return;
        this.recomputeEmbedGroupMembership();
        this.scheduleWrite();
      },
    });
  }

  private onEmbedHeightResizePointerDown(event: PointerEvent, handle: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = this.data.height;
    this.rootEl.addClass("is-resizing-height");
    beginCanvasPointerSession({
      event,
      element: handle,
      zoom: () => 1,
      resizing: true,
      onMove: (delta) => {
        this.data.height = normalizeEmbedHeight(origin + delta.y);
        this.rootEl.style.height = `${this.data.height}px`;
        handle.setAttribute("aria-valuenow", String(this.data.height));
      },
      onEnd: (moved) => {
        this.rootEl.removeClass("is-resizing-height");
        if (moved) this.scheduleWrite();
      },
    });
  }

  private onGroupContextMenu(event: MouseEvent, group: GroupBox): void {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("重命名").setIcon("pencil").onClick(() => this.renameGroup(group)));
    menu.addItem((item) => item.setTitle("从这里画箭头").setIcon("move-up-right").onClick(() => {
      this.beginArrowDraft({ kind: "group", ref: group.id });
    }));
    menu.addItem((item) => item.setTitle("换颜色").setIcon("palette").onClick(() => {
      group.color = cycleColor(GROUP_COLORS, group.color);
      this.renderItems();
      this.scheduleWrite();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除分组").setIcon("trash-2").onClick(() => {
      this.data.groups = this.data.groups.filter((entry) => entry.id !== group.id);
      clearGroupMembership(this.data.items, group.name);
      this.data.arrows = arrowsWithoutEndpoint(this.data.arrows, { kind: "group", ref: group.id });
      this.renderItems();
      this.updateHint();
      this.scheduleWrite();
    }));
    menu.showAtMouseEvent(event);
  }

  private renameGroup(group: GroupBox): void {
    new TextInputModal(this.app, {
      title: "重命名分组",
      initial: group.name,
      onSubmit: (name) => {
        const oldName = group.name;
        group.name = name;
        renameGroupMembership(this.data.items, oldName, name);
        this.renderItems();
        this.scheduleWrite();
      },
    }).open();
  }

  private createGroupAt(point: { x: number; y: number }): void {
    new TextInputModal(this.app, {
      title: "新建分组",
      placeholder: "分组名称，如：工具 / 读文档",
      onSubmit: (name) => {
        this.data.groups.push(createGroupBox({
          id: `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
          name,
          point,
          width: 360,
          height: 240,
          centered: true,
          color: GROUP_COLORS[this.data.groups.length % GROUP_COLORS.length],
        }));
        this.recomputeEmbedGroupMembership();
        this.renderItems();
        this.updateHint();
        this.scheduleWrite();
      },
    }).open();
  }

  private renderTextBox(box: EmbedTextBox): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-textbox" });
    if (box.objectGroup) el.addClass("is-object-grouped");
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    const color = box.color ?? GROUP_COLORS[0];
    el.style.borderColor = color;
    el.style.backgroundColor = rgba(color, 0.08);
    el.setAttribute("data-tb-id", box.id);

    const text = el.createDiv({ cls: "web-desk-textbox-text", text: box.text });
    const handle = el.createDiv({ cls: "web-desk-textbox-resize" });
    el.addEventListener("pointerdown", (event) => this.onTextBoxPointerDown(event, box, el));
    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.editTextBox(box, text);
    });
    el.addEventListener("contextmenu", (event) => this.onTextBoxContextMenu(event, box, text));
    handle.addEventListener("pointerdown", (event) => this.onTextBoxResizePointerDown(event, box, el));
    this.textBoxEls.set(box.id, el);
  }

  private renderImage(image: CanvasImage): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-image" });
    if (image.objectGroup) el.addClass("is-object-grouped");
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
    this.imageEls.set(image.id, el);
  }

  private onImagePointerDown(event: PointerEvent, image: CanvasImage, el: HTMLElement): void {
    if (
      event.button !== 0 ||
      this.editing ||
      (event.target as HTMLElement).closest(".web-desk-image-resize")
    ) return;
    this.onEmbedObjectPointerDown(event, objectKey("image", image.id), el);
  }

  private onImageResizePointerDown(
    event: PointerEvent,
    image: CanvasImage,
    el: HTMLElement,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    el.addClass("is-resizing");
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
      el.removeClass("is-resizing");
      if (moved) this.scheduleWrite();
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  private onImageContextMenu(event: MouseEvent, image: CanvasImage): void {
    event.preventDefault();
    event.stopPropagation();
    this.ensureEmbedObjectSelection(objectKey("image", image.id));
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
    menu.addSeparator();
    this.appendEmbedObjectGroupMenu(menu);
    menu.showAtMouseEvent(event);
  }

  private updateHint(): void {
    this.hintEl.style.display =
      this.data.items.length === 0 &&
      this.data.images.length === 0 &&
      this.data.textboxes.length === 0 &&
      this.data.groups.length === 0 &&
      this.data.arrows.length === 0 &&
      this.data.ratings.length === 0
        ? "flex"
        : "none";
  }

  // ---------- 交互 ----------

  private bindCanvasEvents(): void {
    // 卡片、图片等子元素不会自动把焦点交给可聚焦的画布祖先。
    // 明确认领焦点，确保下一次粘贴仍进入这个画布；文本框编辑态除外。
    this.rootEl.addEventListener("pointerdown", (event) => {
      this.rootEl.addClass("is-pointer-focused");
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

    this.rootEl.addEventListener("keydown", (event) => {
      this.rootEl.removeClass("is-pointer-focused");
      if (event.code === "Space" && !this.editing) {
        this.spacePanning = true;
        event.preventDefault();
      }
      if (event.key === "Escape" && (this.arrowDraft || this.pendingArrowStart)) {
        event.preventDefault();
        this.cancelArrowDraft();
        return;
      }
      if (event.key === "Escape") {
        this.selectedObjects.clear();
        this.syncObjectSelection();
        return;
      }
      if ((event.key === "Delete" || event.key === "Backspace") && this.selectedArrowId) {
        event.preventDefault();
        this.removeArrow(this.selectedArrowId);
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "g") {
        event.preventDefault();
        this.ungroupSelectedEmbedObjects();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
        event.preventDefault();
        this.groupSelectedEmbedObjects();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        this.selectedObjects = new Set(this.allEmbedObjects().map((object) => object.key));
        this.syncObjectSelection();
      }
    });
    this.rootEl.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spacePanning = false;
    });
    this.rootEl.addEventListener("blur", () => {
      this.spacePanning = false;
      this.rootEl.removeClass("is-pointer-focused");
    });

    // 空白拖动 = 平移（不抢点击）
    this.rootEl.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      if (event.button === 0 && (this.arrowDraft || this.pendingArrowStart) && this.interceptArrowClick(event)) return;
      if (
        (event.button !== 0 && event.button !== 1) ||
        target.closest(".web-desk-icon") ||
        target.closest(".web-desk-group") ||
        target.closest(".web-desk-image") ||
        target.closest(".web-desk-textbox") ||
        target.closest(".web-desk-rating") ||
        target.closest(".web-desk-object-selection") ||
        target.closest(".web-desk-toolbar")
      ) {
        return;
      }
      if (event.button === 0 && !this.spacePanning) {
        this.beginEmbedMarquee(event, event.shiftKey);
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
        if (!moved) {
          this.selectedObjects.clear();
          this.syncObjectSelection();
        }
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
        target.closest(".web-desk-group") ||
        target.closest(".web-desk-image") ||
        target.closest(".web-desk-textbox") ||
        target.closest(".web-desk-rating") ||
        target.closest(".web-desk-object-selection")
      ) return;
      event.preventDefault();
      const menu = new Menu();
      const point = this.clientToCanvas(event.clientX, event.clientY);
      menu.addItem((m) =>
        m.setTitle("添加链接…").setIcon("plus").onClick(() => {
          const url = window.prompt("链接地址");
          if (url) void this.addUrl(url, point);
        }),
      );
      menu.addItem((m) =>
        m.setTitle("新建分组").setIcon("square-dashed").onClick(() => this.createGroupAt(point)),
      );
      menu.addItem((m) =>
        m.setTitle("新建文本框").setIcon("sticky-note").onClick(() => this.addTextBox(point)),
      );
      menu.addItem((m) =>
        m.setTitle("新建评分").setIcon("star").onClick(() => this.addRating(point)),
      );
      menu.addItem((m) =>
        m.setTitle("画箭头（点两点）").setIcon("move-up-right").onClick(() => this.beginArrowFromScratch()),
      );
      menu.addSeparator();
      this.appendEmbedObjectGroupMenu(menu);
      menu.showAtMouseEvent(event);
    });
  }

  private beginEmbedMarquee(event: PointerEvent, additive: boolean): void {
    event.preventDefault();
    const start = this.clientToCanvas(event.clientX, event.clientY);
    const base = additive ? new Set(this.selectedObjects) : new Set<string>();
    let moved = false;
    try { this.rootEl.setPointerCapture(event.pointerId); } catch {}
    const onMove = (moveEvent: PointerEvent): void => {
      const current = this.clientToCanvas(moveEvent.clientX, moveEvent.clientY);
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const w = Math.abs(current.x - start.x);
      const h = Math.abs(current.y - start.y);
      if (!moved && w < 4 && h < 4) return;
      moved = true;
      this.marqueeEl.style.display = "block";
      this.marqueeEl.style.left = `${x * this.zoom + this.panX}px`;
      this.marqueeEl.style.top = `${y * this.zoom + this.panY}px`;
      this.marqueeEl.style.width = `${w * this.zoom}px`;
      this.marqueeEl.style.height = `${h * this.zoom}px`;
    };
    const onUp = (upEvent: PointerEvent): void => {
      this.rootEl.removeEventListener("pointermove", onMove);
      this.rootEl.removeEventListener("pointerup", onUp);
      this.marqueeEl.style.display = "none";
      if (!moved) return;
      const rect = normalizeRect(start, this.clientToCanvas(upEvent.clientX, upEvent.clientY));
      const objects = this.allEmbedObjects();
      for (const object of objects) {
        if (rectsIntersect(rect, object)) base.add(object.key);
      }
      for (const object of objects) {
        if (object.objectGroup && base.has(object.key)) {
          objects.filter((entry) => entry.objectGroup === object.objectGroup)
            .forEach((entry) => base.add(entry.key));
        }
      }
      this.selectedObjects = base;
      this.syncObjectSelection();
    };
    this.rootEl.addEventListener("pointermove", onMove);
    this.rootEl.addEventListener("pointerup", onUp);
  }

  private onItemPointerDown(event: PointerEvent, item: EmbedItem, el: HTMLElement): void {
    if (event.button === 0 && this.interceptArrowClick(event)) return;
    if (
      event.button !== 0 ||
      this.editing ||
      (event.target as HTMLElement).closest(".web-desk-icon-resize")
    ) return;
    this.onEmbedObjectPointerDown(event, embedItemRef(item), el, () => this.activateItem(item));
  }

  private activateItem(item: EmbedItem): void {
    if (!item.path) {
      window.open(item.url, "_blank");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice("原笔记已不存在");
    }
  }

  private triggerFileHover(event: MouseEvent, targetEl: HTMLElement, linktext: string): void {
    this.app.workspace.trigger("hover-link", {
      event,
      source: "web-desk",
      hoverParent: this,
      targetEl,
      linktext,
      sourcePath: this.filePath,
    });
  }

  private onItemResizePointerDown(
    event: PointerEvent,
    item: EmbedItem,
    el: HTMLElement,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    el.addClass("is-resizing");
    const start = { x: event.clientX, y: event.clientY };
    const origin = item.size ?? 96;
    let moved = false;
    try { el.setPointerCapture(event.pointerId); } catch {}
    const onMove = (moveEvent: PointerEvent): void => {
      const dx = (moveEvent.clientX - start.x) / this.zoom;
      const dy = (moveEvent.clientY - start.y) / this.zoom;
      if (!moved && Math.hypot(dx, dy) * this.zoom < 4) return;
      moved = true;
      const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      item.size = Math.min(320, Math.max(32, Math.round(origin + delta)));
      updateEmbedIconElementSize(el, item.size);
      this.renderArrows();
    };
    const onUp = (): void => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeClass("is-resizing");
      if (moved) {
        this.recomputeEmbedGroupMembership();
        this.scheduleWrite();
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }

  private onItemContextMenu(event: MouseEvent, item: EmbedItem): void {
    event.preventDefault();
    event.stopPropagation();
    const ref = embedItemRef(item);
    this.ensureEmbedObjectSelection(ref);
    const menu = new Menu();
    if (item.path) {
      menu.addItem((m) => m.setTitle("打开笔记").setIcon("file-text").onClick(() => this.activateItem(item)));
      menu.addItem((m) => m.setTitle("复制双链").setIcon("copy").onClick(() => {
        const file = this.app.vault.getAbstractFileByPath(item.path!);
        if (file instanceof TFile) {
          void navigator.clipboard.writeText(this.app.fileManager.generateMarkdownLink(file, this.filePath));
          new Notice("已复制双链");
        }
      }));
    } else {
      menu.addItem((m) => m.setTitle("打开网页").setIcon("external-link").onClick(() => window.open(item.url, "_blank")));
      menu.addItem((m) => m.setTitle("复制链接").setIcon("copy").onClick(() => {
        void navigator.clipboard.writeText(item.url);
        new Notice("已复制链接");
      }));
    }
    menu.addItem((m) =>
      m.setTitle(item.path ? "为此文件添加评分" : "为此链接添加评分").setIcon("star").onClick(() => {
        const size = item.size ?? 96;
        this.addRating({ x: item.x + size + 152, y: item.y + 43 }, item);
      }),
    );
    menu.addItem((m) =>
      m.setTitle("从这里画箭头").setIcon("move-up-right").onClick(() => {
        this.beginArrowDraft({ kind: "card", ref });
      }),
    );
    menu.addSeparator();
    menu.addItem((m) => m.setTitle("删除条目").setIcon("trash-2").onClick(() => {
      this.data.items = this.data.items.filter((entry) => entry !== item);
      this.data.arrows = arrowsWithoutEndpoint(this.data.arrows, { kind: "card", ref });
      this.renderItems();
      this.updateHint();
      this.scheduleWrite(Boolean(item.path));
    }));
    menu.addSeparator();
    this.appendEmbedObjectGroupMenu(menu);
    menu.showAtMouseEvent(event);
  }

  private addRating(point: { x: number; y: number }, item?: EmbedItem): void {
    const ratings = this.data.ratings;
    if (item && ratings.some((rating) => rating.link?.ref === embedItemRef(item))) {
      new Notice("这个链接已经有评分了");
      return;
    }
    const desired = {
      x: Math.round(point.x - 104),
      y: Math.round(point.y - 43),
    };
    const position = item
      ? findAvailableEmbedRatingPosition(this.data, desired)
      : desired;
    ratings.push({
      id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      value: 0,
      x: position.x,
      y: position.y,
      link: item ? { ref: embedItemRef(item), title: item.title, url: item.url } : undefined,
    });
    this.renderItems();
    this.updateHint();
    this.scheduleWrite();
  }

  private onRatingPointerDown(event: PointerEvent, rating: Rating, el: HTMLElement): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    this.onEmbedObjectPointerDown(event, objectKey("rating", rating.id), el);
  }

  private onRatingContextMenu(event: MouseEvent, rating: Rating): void {
    event.preventDefault();
    event.stopPropagation();
    this.ensureEmbedObjectSelection(objectKey("rating", rating.id));
    const menu = new Menu();
    if (rating.link) {
      menu.addItem((item) =>
        item.setTitle("解除链接绑定").setIcon("unlink").onClick(() => {
          delete rating.link;
          this.renderItems();
          this.scheduleWrite();
        }),
      );
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item.setTitle("删除评分").setIcon("trash-2").onClick(() => {
        this.data.ratings = (this.data.ratings ?? []).filter((entry) => entry.id !== rating.id);
        this.renderItems();
        this.updateHint();
        this.scheduleWrite();
      }),
    );
    menu.addSeparator();
    this.appendEmbedObjectGroupMenu(menu);
    menu.showAtMouseEvent(event);
  }

  private onTextBoxPointerDown(event: PointerEvent, box: EmbedTextBox, el: HTMLElement): void {
    if (event.button === 0 && this.interceptArrowClick(event)) return;
    if (
      event.button !== 0 ||
      this.editing ||
      (event.target as HTMLElement).closest(".web-desk-textbox-resize")
    ) return;
    this.onEmbedObjectPointerDown(event, objectKey("textbox", box.id), el);
  }

  private onTextBoxResizePointerDown(event: PointerEvent, box: TextBox, el: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = { w: box.w, h: box.h };
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      resizing: true,
      onMove: (delta) => {
        box.w = Math.max(140, Math.round(origin.w + delta.x));
        box.h = Math.max(60, Math.round(origin.h + delta.y));
        el.style.width = `${box.w}px`;
        el.style.height = `${box.h}px`;
        this.renderArrows();
      },
      onEnd: (moved) => {
        if (moved) this.scheduleWrite();
      },
    });
  }

  private onTextBoxContextMenu(event: MouseEvent, box: TextBox, textEl: HTMLElement): void {
    event.preventDefault();
    event.stopPropagation();
    this.ensureEmbedObjectSelection(objectKey("textbox", box.id));
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("编辑文字").setIcon("pencil").onClick(() => this.editTextBox(box, textEl)));
    menu.addItem((item) => item.setTitle("换颜色").setIcon("palette").onClick(() => {
      box.color = cycleColor(GROUP_COLORS, box.color);
      this.renderItems();
      this.scheduleWrite();
    }));
    menu.addItem((item) => item.setTitle("从这里画箭头").setIcon("move-up-right").onClick(() => {
      this.beginArrowDraft({ kind: "textbox", ref: box.id });
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除文本框").setIcon("trash-2").onClick(() => {
      this.data.textboxes = this.data.textboxes.filter((entry) => entry.id !== box.id);
      this.data.arrows = arrowsWithoutEndpoint(this.data.arrows, { kind: "textbox", ref: box.id });
      this.renderItems();
      this.updateHint();
      this.scheduleWrite();
    }));
    menu.addSeparator();
    this.appendEmbedObjectGroupMenu(menu);
    menu.showAtMouseEvent(event);
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

  private onArrowPointerDown(event: PointerEvent, arrow: Arrow): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    this.selectedArrowId = this.selectedArrowId === arrow.id ? null : arrow.id;
    this.renderArrows();
  }

  private onArrowContextMenu(event: MouseEvent, arrow: Arrow): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedArrowId = arrow.id;
    this.renderArrows();
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("编辑标签…").setIcon("tag").onClick(() => {
      new TextInputModal(this.app, {
        title: "箭头标签",
        initial: arrow.label,
        onSubmit: (label) => {
          arrow.label = label;
          this.renderArrows();
          this.scheduleWrite();
        },
      }).open();
    }));
    menu.addItem((item) => item.setTitle("换颜色").setIcon("palette").onClick(() => {
      arrow.color = cycleColor(GROUP_COLORS, arrow.color);
      this.renderArrows();
      this.scheduleWrite();
    }));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除箭头").setIcon("trash-2").onClick(() => this.removeArrow(arrow.id)));
    menu.showAtMouseEvent(event);
  }

  private interceptArrowClick(event: PointerEvent): boolean {
    if (!this.arrowDraft && !this.pendingArrowStart) return false;
    event.preventDefault();
    event.stopPropagation();
    const endpoint = this.endpointFromEvent(event);
    if (this.pendingArrowStart) {
      if (endpoint) {
        this.arrowDraft = endpoint;
        this.pendingArrowStart = false;
        new Notice("再点击箭头终点（Esc 取消）", 2500);
      }
      return true;
    }
    if (this.arrowDraft) {
      if (endpoint) this.addArrow(this.arrowDraft, endpoint);
      this.cancelArrowDraft();
      return true;
    }
    return false;
  }

  private endpointFromEvent(event: PointerEvent | MouseEvent): ArrowEndpoint | null {
    const target = event.target as HTMLElement;
    const icon = target.closest<HTMLElement>(".web-desk-icon");
    if (icon) {
      const ref = icon.getAttribute("data-card-ref");
      return ref ? { kind: "card", ref } : null;
    }
    const textBox = target.closest<HTMLElement>(".web-desk-textbox");
    if (textBox) {
      const ref = textBox.getAttribute("data-tb-id");
      return ref ? { kind: "textbox", ref } : null;
    }
    const group = target.closest<HTMLElement>(".web-desk-group");
    if (group) {
      const ref = group.getAttribute("data-group-id");
      return ref ? { kind: "group", ref } : null;
    }
    if (target.closest(".web-desk-toolbar")) return null;
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

  private addArrow(from: ArrowEndpoint, to: ArrowEndpoint): void {
    if (hasArrowBetween(this.data.arrows, from, to)) {
      new Notice("这两个之间已经有箭头了");
      return;
    }
    this.data.arrows.push({
      id: `a${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      from,
      to,
      label: "",
      color: "",
    });
    this.renderArrows();
    this.scheduleWrite();
  }

  private removeArrow(id: string): void {
    this.data.arrows = this.data.arrows.filter((arrow) => arrow.id !== id);
    if (this.selectedArrowId === id) this.selectedArrowId = null;
    this.renderArrows();
    this.scheduleWrite();
  }

  private pruneDanglingArrows(): void {
    const kept = pruneDanglingArrows(this.data.arrows, this.endpointScene());
    if (kept.length !== this.data.arrows.length) {
      this.data.arrows = kept;
      if (this.selectedArrowId && !kept.some((arrow) => arrow.id === this.selectedArrowId)) {
        this.selectedArrowId = null;
      }
    }
  }

  private recomputeEmbedGroupMembership(): void {
    const cards = this.endpointScene().cards;
    if (recomputeGroupMembership(cards, this.data.groups) === 0) return;
    const groupsByRef = new Map(cards.map((card) => [card.ref, card.group ?? ""]));
    for (const item of this.data.items) item.group = groupsByRef.get(embedItemRef(item)) ?? "";
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
    const markdownFiles = markdownFilesFromDrop(this.app, event.dataTransfer, this.filePath);
    if (markdownFiles.length > 0) {
      this.addMarkdownFiles(markdownFiles, point);
      return;
    }
    if (hasLocalMarkdownFileDrop(event.dataTransfer)) {
      new Notice("这个 Markdown 不在当前 Vault 中；请先移入 Vault 再拖到画布");
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

  private addMarkdownFiles(files: TFile[], point: { x: number; y: number }): void {
    let added = 0;
    for (const file of files) {
      if (this.data.items.some((item) => item.path === file.path)) {
        new Notice(`${file.basename} 已经在画布上了`);
        continue;
      }
      const position = findAvailableEmbedItemPosition(this.data, {
        x: Math.round(point.x - 48 + added * 32),
        y: Math.round(point.y - 48 + added * 32),
      });
      this.data.items.push({
        url: "",
        path: file.path,
        title: file.basename,
        description: file.parent?.path || "Vault 根目录",
        x: position.x,
        y: position.y,
        size: 96,
      });
      added += 1;
    }
    if (added === 0) return;
    this.recomputeEmbedGroupMembership();
    this.renderItems();
    this.updateHint();
    this.scheduleWrite(true);
    new Notice(`已插入 ${added} 个文件卡片`);
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
      this.recomputeEmbedGroupMembership();
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
    const boxes = this.data.textboxes;
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

  /**
   * 调用点都位于点击、拖拽结束或批量导入完成等提交边界，无需再次 debounce。
   * 立即入队可在 Obsidian 重渲染旧块之前把权威坐标写进编辑器/文件。
   */
  private scheduleWrite(syncBacklinks = false): void {
    const fresh = this.serialize();
    this.writeQueue = this.writeQueue
      .then(async () => {
        await this.writeBack(fresh);
        if (syncBacklinks) await this.syncBacklinksAfterWrite(fresh);
      })
      .catch((error) => {
        new Notice(`写回画布失败：${getErrorMessage(error)}`, 5000);
      });
  }

  private async syncBacklinksAfterWrite(fresh: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return;

    let content = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      content = await this.app.vault.read(file);
      if (content.includes(fresh)) break;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    }
    if (!content.includes(fresh)) {
      throw new Error("编辑器尚未把画布写入磁盘，已暂停同步双链以避免覆盖正文");
    }

    const paths = extractEmbeddedMarkdownPaths(content);
    const links = paths.map((path) => {
      const target = this.app.vault.getAbstractFileByPath(path);
      return target instanceof TFile
        ? this.app.fileManager.generateMarkdownLink(target, file.path)
        : `[[${path.replace(/\.md$/i, "")}]]`;
    });
    await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      if (links.length > 0) frontmatter.web_desk_links = links;
      else delete frontmatter.web_desk_links;
    });
  }

  private async writeBack(fresh: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return;

    const active = this.rootEl.ownerDocument.activeElement;
    pendingEmbedFocus = active === this.rootEl || this.rootEl.contains(active)
      ? {
        key: this.embedKey,
        expiresAt: Date.now() + 2_000,
        viaPointer: this.rootEl.classList.contains("is-pointer-focused"),
      }
      : null;

    const info = this.ctx.getSectionInfo(this.el);
    if (info) {
      // 主路径：编辑器精确替换块行
      const leafEl = this.el.closest(".workspace-leaf") as (HTMLElement & { view?: { editor?: { replaceRange: (t: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => void; getLine: (l: number) => string } } }) | null;
      const editor = leafEl?.view?.editor;
      if (editor) {
        const to = { line: info.lineEnd, ch: editor.getLine(info.lineEnd).length };
        editor.replaceRange(fresh, { line: info.lineStart, ch: 0 }, to);
        this.sourceMarker = fresh;
        return;
      }
    }

    // 兜底：用上一次成功内容做 compare-and-replace，外部已改动时拒绝覆盖。
    let outcome = replaceEmbedMarker("", this.sourceMarker, fresh);
    await this.app.vault.process(file, (content) => {
      outcome = replaceEmbedMarker(content, this.sourceMarker, fresh);
      return outcome.content;
    });
    if (!outcome.replaced && !outcome.alreadyCurrent) {
      throw new Error("代码块已在别处变化；为避免覆盖，已拒绝旧画布写回");
    }
    this.sourceMarker = outcome.marker;
  }
}

function rgba(hex: string, alpha: number): string {
  const match = hex.match(/^#?([0-9a-f]{6})$/i);
  if (!match) return `rgba(127,127,127,${alpha})`;
  const value = Number.parseInt(match[1], 16);
  return `rgba(${(value >> 16) & 0xff},${(value >> 8) & 0xff},${value & 0xff},${alpha})`;
}

function updateEmbedIconElementSize(el: HTMLElement, size: number): void {
  el.style.width = `${size + 24}px`;
  const thumb = el.querySelector<HTMLElement>(".web-desk-icon-thumb");
  if (thumb) {
    thumb.style.width = `${size}px`;
    thumb.style.height = `${size}px`;
  }
  const label = el.querySelector<HTMLElement>(".web-desk-icon-label");
  if (label) label.style.width = `${size + 24}px`;
  const letter = el.querySelector<HTMLElement>(".web-desk-icon-letter");
  if (letter) letter.style.fontSize = `${Math.round(size * 0.42)}px`;
  const handle = el.querySelector<HTMLElement>(".web-desk-icon-resize");
  if (handle) handle.style.top = `${size - 4}px`;
}

function markerPrefix(key: string): string {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `wd-embed-arrow-${(hash >>> 0).toString(36)}`;
}

function normalizeRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

function rectsIntersect(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
