import { App, MarkdownRenderChild, Menu, Notice, setIcon, TFile } from "obsidian";
import { canEnterCanvasReference } from "./canvas-reference-state";
import { resolveCanvasReference } from "./canvas-reference";
import { findFreePosition } from "./canvas-free-position";
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
import { normalizeRatingValue, RATING_HEIGHT, RATING_WIDTH, ratingLinkState } from "./rating-state";
import { importUrlAsBookmark } from "./importer";
import { CanvasFileSuggestModal, CardPropertiesModal, ConfirmModal, PreviewFileSuggestModal, TextInputModal } from "./modals";
import { normalizeCardRating } from "./card-properties-state";
import { normalizeCardCaption } from "./card-caption-state";
import { cardAccessibleLabel } from "./card-properties-ui";
import { renderShortcutCardVisual, renderWebCardVisual, updateWebCardElementFrame } from "./card-view";
import { localFilePathsFromDrop } from "./file-link-storage";
import { localShortcutCandidates, normalizeShortcutKind, shortcutKindIcon, shortcutKindLabel, type LocalShortcut } from "./shortcut-state";
import { describeLocalShortcut } from "./shortcut-importer";
import { launchLocalShortcutWithNotice, localShortcutExists, revealLocalShortcut } from "./shortcut-launch";
import type { ShortcutIconResolve } from "./shortcut-icon";
import type { FaviconResolve } from "./favicon-cache";
import {
  cardPlacementFrame,
  DEFAULT_PREVIEW_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  normalizeCardViewMode,
  resizeCardPlacement,
  scaleCardPlacement,
  switchCardViewMode,
  type CardViewMode,
} from "./card-view-state";
import { beginCanvasPointerSession, type CanvasPointerSessionHandle } from "./canvas-pointer";
import { CanvasEdgePan } from "./canvas-edge-pan";
import { planCanvasObjectDeletion } from "./canvas-delete";
import {
  canvasGridBackground,
  createCanvasSnapGuideLayer,
  createCanvasSnapSession,
  snapGuidesMatchingRect,
  type CanvasSnapGuideLayer,
  type SnapRect,
} from "./canvas-snap";
import { canvasWheelIntent } from "./canvas-wheel";
import { CanvasFocusBoundary } from "./canvas-focus-boundary";
import { canvasSafeViewport, fitCanvasBounds, applyCanvasZoomBand } from "./canvas-viewport-state";
import { clampPanToRoom, deriveRoom, elasticPanToRoom, minZoomForRoom, type ContentBounds, type RoomRect } from "./canvas-room";
import { processFrontmatterSerially } from "./frontmatter-write";
import {
  GroupObjectRect,
  objectGroupBounds,
  objectKey,
  scaleObjectGroup,
  splitObjectKey,
  translateObjectGroup,
} from "./object-group-state";
import {
  areaMembers,
  arrowIntersectsRect,
  arrowLine,
  arrowsWithoutEndpoint,
  clearGroupMembership,
  createGroupBox,
  cycleColor,
  groupAtPoint,
  hasArrowBetween,
  nextAvailableGroupName,
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
import { getErrorMessage, isProbablyUrl } from "./util";
import { previewImageSource } from "./preview-assets";
import {
  openCanvasFilePreview,
  renderFileCardVisual,
  updateFileCardFrame,
  type CanvasFilePreviewHandle,
} from "./file-preview";
import { canvasFileKind, canvasFileKindLabel, supportsCanvasFilePreview } from "./file-preview-state";
import { assessRemoteEmbed } from "./web-embed-policy-runtime";
import { isRememberedBlockedHost, rememberBlockedEmbedHost } from "./web-embed-policy";
import {
  appendCanvasContainerAppearanceMenuItems,
  applyCanvasContainerAppearance,
  beginInlineGroupNameEdit,
  createCanvasCreateRail,
  createCanvasObjectToolbar,
  positionCanvasObjectToolbar,
  renderPendingWebCard,
  showCanvasContainerAppearanceMenu,
  type CanvasToolbarAction,
} from "./canvas-chrome";
import {
  hasCanvasContent,
  normalizeCardStyle,
  type CardStyle,
  type PendingWebCard,
} from "./canvas-ui-state";
import {
  enqueueEmbedWrite,
  publishEmbedHandoff,
  registerEmbedInstance,
  type EmbedInstanceHandoff,
} from "./embed-instance-coordinator";

interface EmbedCtxLike {
  sourcePath: string;
  getSectionInfo(el: HTMLElement): { text: string; lineStart: number; lineEnd: number } | null;
}

interface CanvasNavigationDelegate {
  openCanvas(path: string): void;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2;
const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_SPAN = 20000;
const embedLeafIds = new WeakMap<HTMLElement, number>();
let nextEmbedLeafId = 0;

function embedLeafScope(el: HTMLElement): string {
  const leaf = el.closest<HTMLElement>(".workspace-leaf");
  if (!leaf) return "detached";
  let id = embedLeafIds.get(leaf);
  if (!id) {
    id = ++nextEmbedLeafId;
    embedLeafIds.set(leaf, id);
  }
  return `leaf-${id}`;
}

interface EmbedViewObject extends GroupObjectRect {
  kind: "card" | "image" | "textbox" | "rating";
  id: string;
  group: string;
  objectGroup: string;
}

/**
 * 笔记内嵌画布（```web-desk code block）。
 * 数据全部存在块内（纯 md 到底），编辑后写回块源码；
 * 主路径 getSectionInfo+replaceRange（阅读/实时预览），兜底按内容全文匹配（vault.process）。
 */
export class DeskEmbed extends MarkdownRenderChild {
  private data: EmbedData;
  /** 上一次成功写入的块内容；兜底写回用它定位，成功后随即前移。 */
  private sourceMarker: string;
  private readonly el: HTMLElement;
  private readonly app: App;
  private readonly ctx: EmbedCtxLike;
  private readonly filePath: string;
  private readonly settings: WebDeskSettings;
  private readonly onSettingsChange?: () => void;
  private readonly navigation?: CanvasNavigationDelegate;

  private rootEl!: HTMLElement;
  private canvasEl!: HTMLElement;
  private room: RoomRect = deriveRoom(null);
  private settleFrame: number | null = null;
  private settleTimer: number | null = null;
  private edgePan: CanvasEdgePan | null = null;
  private hintEl!: HTMLElement;
  private zoomEl!: HTMLElement;
  private fullscreenButtonEl!: HTMLButtonElement;
  private fullscreenPlaceholder: Comment | null = null;
  private embedKey = "";
  private instanceScopeKey = "";
  private instanceId = 0;
  private iconEls = new Map<number, HTMLElement>();
  private imageEls = new Map<string, HTMLElement>();
  private textBoxEls = new Map<string, HTMLElement>();
  private ratingEls = new Map<string, HTMLElement>();
  private groupEls = new Map<string, HTMLElement>();
  private marqueeEl!: HTMLElement;
  private objectSelectionEl: HTMLElement | null = null;
  private selectionToolbarEl: HTMLElement | null = null;
  private selectedGroupId: string | null = null;
  private pendingImports = new Map<string, PendingWebCard>();
  private snapGuideLayer: CanvasSnapGuideLayer | null = null;
  private selectedObjects = new Set<string>();
  private arrowsG: SVGGElement | null = null;
  private arrowMarkerIds = new Map<string, string>();
  private selectedArrowId: string | null = null;
  private arrowEls = new Map<string, SVGPathElement>();
  private arrowDraft: ArrowEndpoint | null = null;
  private pendingArrowStart = false;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private busy = false;
  private editing = false;
  private editingGroupId: string | null = null;
  private pendingNewGroupIds = new Set<string>();
  private spacePanning = false;
  private isFullscreen = false;
  private editingCaptionRef: string | null = null;
  private drilldown: CanvasDrilldown | null = null;
  private filePreview: CanvasFilePreviewHandle | null = null;
  private fullscreenFocusBoundary: CanvasFocusBoundary | null = null;
  private canvasFileCache = new Map<string, { isCanvas: boolean; mtime: number }>();
  private resolveFavicon?: FaviconResolve;
  private resolveShortcutIcon?: ShortcutIconResolve;
  /** 上一实例交来的、尚未在本实例 DOM 上落实的状态；被再次接管时必须原样传下去。 */
  private pendingHandoff: EmbedInstanceHandoff | null = null;

  constructor(
    el: HTMLElement,
    source: string,
    app: App,
    ctx: EmbedCtxLike,
    settings: WebDeskSettings,
    onSettingsChange?: () => void,
    navigation?: CanvasNavigationDelegate,
    resolveFavicon?: FaviconResolve,
    resolveShortcutIcon?: ShortcutIconResolve,
  ) {
    super(el);
    this.el = el;
    this.app = app;
    this.ctx = ctx;
    this.filePath = ctx.sourcePath;
    this.settings = settings;
    this.onSettingsChange = onSettingsChange;
    this.navigation = navigation;
    this.resolveFavicon = resolveFavicon;
    this.resolveShortcutIcon = resolveShortcutIcon;
    this.sourceMarker = source.trim();
    this.data = parseEmbedData(source);
  }

  render(): void {
    this.el.empty();
    this.el.addClass("web-desk-embed-host");
    this.embedKey = this.resolveEmbedKey();
    this.instanceScopeKey = `${embedLeafScope(this.el)}:${this.embedKey}`;
    const registration = registerEmbedInstance(this.instanceScopeKey, () => this.supersede());
    this.instanceId = registration.instanceId;
    const handoff = registration.handoff;
    if (handoff) {
      this.zoom = handoff.zoom;
      this.panX = handoff.panX;
      this.panY = handoff.panY;
      this.selectedObjects = new Set(handoff.selectedObjects ?? []);
      this.selectedGroupId = handoff.selectedGroupId ?? null;
      this.selectedArrowId = handoff.selectedArrowId ?? null;
    }

    this.rootEl = this.el.createDiv({ cls: "web-desk-embed" });
    this.rootEl.tabIndex = 0;
    this.rootEl.style.height = `${this.data.height}px`;

    this.canvasEl = this.rootEl.createDiv({ cls: "web-desk-canvas web-desk-embed-canvas" });
    this.marqueeEl = this.rootEl.createDiv({ cls: "web-desk-marquee" });
    this.marqueeEl.removeClass("is-active");

    this.hintEl = this.rootEl.createDiv({ cls: "web-desk-hint" });
    this.hintEl.createDiv({ cls: "web-desk-hint-title", text: "把第一个网页放进来" });
    this.hintEl.createDiv({
      cls: "web-desk-hint-body",
      text: "粘贴链接，或拖入网页、Markdown、PDF、图片与本机应用。",
    });
    const hintButton = this.hintEl.createEl("button", { cls: "web-desk-hint-action", text: "收藏 URL" });
    hintButton.addEventListener("click", (event) => { event.stopPropagation(); this.promptForEmbedUrl(this.visibleCenter()); });

    createCanvasCreateRail(this.rootEl, [
      { icon: "plus", label: "添加元素", onClick: (button) => this.showCreateMenu(button) },
      { icon: "sticky-note", label: "新建文本框", onClick: () => this.addTextBox(this.visibleCenter()) },
      { icon: "square-dashed", label: "新建区域", onClick: () => this.createGroupAt(this.visibleCenter()) },
      { icon: "ellipsis", label: "更多画布组件", onClick: (button) => this.showCreateMoreMenu(button) },
    ]);

    const toolbar = this.rootEl.createDiv({ cls: "web-desk-toolbar" });
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "画布缩放");
    const zoomOut = toolbar.createEl("button", { cls: "web-desk-tool-btn", attr: { type: "button", "aria-label": "缩小", title: "缩小" } });
    setIcon(zoomOut, "minus");
    this.zoomEl = toolbar.createEl("span", { cls: "web-desk-zoom-label", text: "100%" });
    const zoomIn = toolbar.createEl("button", { cls: "web-desk-tool-btn", attr: { type: "button", "aria-label": "放大", title: "放大" } });
    setIcon(zoomIn, "plus");
    const fit = toolbar.createEl("button", { cls: "web-desk-tool-btn", attr: { type: "button", "aria-label": "适应内容", title: "适应内容" } });
    setIcon(fit, "maximize");
    this.fullscreenButtonEl = toolbar.createEl("button", {
      cls: "web-desk-tool-btn web-desk-fullscreen-btn",
      attr: { type: "button", "aria-pressed": "false" },
    });
    this.updateFullscreenButton();
    zoomOut.addEventListener("click", () => this.zoomAtCenter(1 / 1.2));
    zoomIn.addEventListener("click", () => this.zoomAtCenter(1.2));
    fit.addEventListener("click", () => this.fitContent());
    this.fullscreenButtonEl.addEventListener("click", () => this.setFullscreen(!this.isFullscreen));

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

    const resizeObserver = new ResizeObserver(() => this.positionSelectionToolbar());
    resizeObserver.observe(this.rootEl);
    this.register(() => resizeObserver.disconnect());

    this.bindCanvasEvents();
    this.renderItems();
    this.updateHint();
    this.applyTransform();
    // Obsidian 的实时预览会在一次写回后连续渲染两次代码块；全屏和焦点的落实放在 microtask 里，
    // 若在此之前就被下一次渲染接管，currentHandoff 需要把这份尚未落实的状态继续传下去。
    if (handoff && (handoff.fullscreen || handoff.focused)) {
      this.pendingHandoff = handoff;
      queueMicrotask(() => {
        const pending = this.pendingHandoff;
        this.pendingHandoff = null;
        if (!pending || !this.rootEl.isConnected) return;
        if (pending.fullscreen) this.setFullscreen(true);
        if (pending.focused) {
          this.rootEl.toggleClass("is-pointer-focused", pending.pointerFocused);
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

  private setFullscreen(fullscreen: boolean): void {
    if (fullscreen === this.isFullscreen) return;
    this.isFullscreen = fullscreen;
    if (fullscreen) {
      this.fullscreenPlaceholder = this.rootEl.ownerDocument.createComment("web-desk-fullscreen-origin");
      this.rootEl.before(this.fullscreenPlaceholder);
      this.rootEl.ownerDocument.body.appendChild(this.rootEl);
      this.rootEl.setAttribute("role", "dialog");
      this.rootEl.setAttribute("aria-modal", "true");
      this.rootEl.setAttribute("aria-label", "网页收藏画布全屏编辑");
      this.fullscreenFocusBoundary = new CanvasFocusBoundary(
        this.rootEl,
        this.rootEl.ownerDocument.body,
        this.fullscreenButtonEl,
      );
      this.fullscreenFocusBoundary.activate();
    } else if (this.fullscreenPlaceholder) {
      this.fullscreenFocusBoundary?.release({ restoreFocus: false });
      this.fullscreenFocusBoundary = null;
      this.rootEl.removeAttribute("role");
      this.rootEl.removeAttribute("aria-modal");
      this.rootEl.removeAttribute("aria-label");
      this.fullscreenPlaceholder.replaceWith(this.rootEl);
      this.fullscreenPlaceholder = null;
    }
    this.rootEl.toggleClass("is-fullscreen", fullscreen);
    this.updateFullscreenButton();
    this.fullscreenButtonEl.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      if (!this.rootEl.isConnected) return;
      this.applyTransform();
      this.syncObjectSelection();
    });
  }

  /** 新 processor 接管同一代码块时，旧 DOM 立即退出交互和全屏占位。 */
  private currentHandoff(): EmbedInstanceHandoff {
    const active = this.rootEl.ownerDocument.activeElement;
    const pending = this.pendingHandoff;
    const focused = Boolean(pending?.focused) || active === this.rootEl || this.rootEl.contains(active);
    return {
      zoom: this.zoom,
      panX: this.panX,
      panY: this.panY,
      fullscreen: this.isFullscreen || Boolean(pending?.fullscreen),
      focused,
      pointerFocused: pending?.focused
        ? pending.pointerFocused
        : focused && this.rootEl.classList.contains("is-pointer-focused"),
      selectedObjects: [...this.selectedObjects],
      selectedGroupId: this.selectedGroupId,
      selectedArrowId: this.selectedArrowId,
      expiresAt: Date.now() + 2_000,
    };
  }

  private supersede(): EmbedInstanceHandoff {
    const handoff = this.currentHandoff();
    this.pendingHandoff = null;
    this.rootEl.addClass("is-superseded");
    if (this.isFullscreen) {
      this.isFullscreen = false;
      this.fullscreenFocusBoundary?.release({ restoreFocus: false });
      this.fullscreenFocusBoundary = null;
      this.rootEl.removeAttribute("role");
      this.rootEl.removeAttribute("aria-modal");
      this.rootEl.removeAttribute("aria-label");
      this.rootEl.removeClass("is-fullscreen");
      this.fullscreenPlaceholder?.remove();
      this.fullscreenPlaceholder = null;
    }
    this.rootEl.remove();
    return handoff;
  }

  onunload(): void {
    this.filePreview?.close();
    this.filePreview = null;
    this.drilldown?.close();
    this.drilldown = null;
    if (this.isFullscreen) {
      this.isFullscreen = false;
      this.fullscreenFocusBoundary?.release({ restoreFocus: false });
      this.fullscreenFocusBoundary = null;
      this.rootEl.removeAttribute("role");
      this.rootEl.removeAttribute("aria-modal");
      this.rootEl.removeAttribute("aria-label");
      this.rootEl.removeClass("is-fullscreen");
      if (this.fullscreenPlaceholder) {
        this.fullscreenPlaceholder.replaceWith(this.rootEl);
        this.fullscreenPlaceholder = null;
      }
    }
  }

  private updateFullscreenButton(): void {
    const label = this.isFullscreen ? "退出全屏" : "全屏";
    this.fullscreenButtonEl.empty();
    const icon = this.fullscreenButtonEl.createSpan({ cls: "web-desk-fullscreen-icon" });
    setIcon(icon, this.isFullscreen ? "minimize-2" : "maximize-2");
    this.fullscreenButtonEl.createSpan({ text: label });
    this.fullscreenButtonEl.setAttribute("title", label);
    this.fullscreenButtonEl.setAttribute("aria-label", label);
    this.fullscreenButtonEl.setAttribute("aria-pressed", String(this.isFullscreen));
  }

  // ---------- 渲染 ----------

  private renderItems(): void {
    // 旧代码块里的图片、文本和评分没有区域字段；按当前空间位置兼容归属。
    this.recomputeEmbedGroupMembership();
    this.iconEls.clear();
    this.imageEls.clear();
    this.textBoxEls.clear();
    this.ratingEls.clear();
    this.groupEls.clear();
    this.canvasEl.empty();
    this.snapGuideLayer = createCanvasSnapGuideLayer(this.canvasEl);

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
    for (const pending of this.pendingImports.values()) {
      renderPendingWebCard(
        this.canvasEl,
        pending,
        () => this.retryPendingImport(pending.id),
        () => { this.pendingImports.delete(pending.id); this.renderItems(); this.updateHint(); },
      );
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
    if (item.appPath) {
      const shortcut = this.itemShortcut(item);
      el.addClass("is-local-shortcut");
      renderShortcutCardVisual(el, {
        x: item.x,
        y: item.y,
        size,
        viewMode: "icon",
        title: item.title || shortcut.name,
        kind: shortcut.kind,
        rating: item.rating,
        note: item.note,
        caption: item.caption,
        captionEditing: this.editingCaptionRef === embedItemRef(item),
        onCaptionInput: (value) => { item.caption = value; },
        onCaptionCommit: (value) => this.persistEmbedCaption(item, value),
        missing: !localShortcutExists(shortcut.path),
        resolveIcon: this.resolveShortcutIcon
          ? () => this.resolveShortcutIcon!(shortcut)
          : undefined,
      });
    } else if (item.path) {
      el.addClass("is-file-link");
      const file = this.app.vault.getAbstractFileByPath(item.path);
      renderFileCardVisual(this.app, this, el, {
        ...item,
        size,
        file: file instanceof TFile ? file : null,
        path: item.path,
        onOpen: () => this.openMarkdownPath(item.path!),
        onFullscreen: () => this.previewCanvasFile(item.path!),
      });
      const icon = el.querySelector<HTMLElement>(".web-desk-file-icon, .web-desk-file-card-icon");
      if (icon) void this.decorateCanvasReference(item.path, el, icon);
    } else {
      let host = "";
      try { host = new URL(item.url).hostname.replace(/^www\./, ""); } catch { host = ""; }
      renderWebCardVisual(el, {
        x: item.x,
        y: item.y,
        size,
        viewMode: normalizeCardViewMode(item.viewMode),
        cardStyle: normalizeCardStyle(item.cardStyle),
        previewWidth: item.previewWidth,
        previewHeight: item.previewHeight,
        url: item.url,
        title: item.title,
        host,
        description: item.description,
        previewImage: previewImageSource(this.app, item.previewImage),
        rating: item.rating,
        note: item.note,
        caption: item.caption,
        captionEditing: this.editingCaptionRef === embedItemRef(item),
        onCaptionInput: (value) => { item.caption = value; },
        onCaptionCommit: (value) => this.persistEmbedCaption(item, value),
        onEmbedFallback: () => {
          this.settings.blockedEmbedHosts = rememberBlockedEmbedHost(this.settings.blockedEmbedHosts, item.url);
          this.onSettingsChange?.();
          void this.setEmbedCardViewMode(item, "preview");
        },
        onOpen: () => window.open(item.url, "_blank", "noopener,noreferrer"),
        resolveIcon: this.resolveFavicon,
        fallbackKey: item.url,
      });
    }

    const handle = el.createDiv({ cls: "web-desk-icon-resize" });
    if (item.path) updateFileCardFrame(el, { ...item, size });
    else updateWebCardElementFrame(el, { ...item, size });
    el.setAttribute("data-embed-index", String(index));
    el.setAttribute("data-card-ref", embedItemRef(item));
    el.setAttribute("role", "link");
    el.tabIndex = 0;
    el.setAttribute("aria-label", cardAccessibleLabel(
      item.title,
      item.path || item.url,
      item.rating,
      item.note,
    ));
    if (item.note?.trim()) el.setAttribute("title", item.note.trim());

    el.addEventListener("pointerdown", (event) => this.onItemPointerDown(event, item, el));
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      this.activateItem(item);
    });
    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.activateItem(item);
    });
    el.addEventListener("contextmenu", (event) => this.onItemContextMenu(event, item));
    if (item.path) {
      el.addEventListener("mouseover", (event) => this.triggerFileHover(event, el, item.path!));
    }
    handle.addEventListener("pointerdown", (event) => this.onItemResizePointerDown(event, item, el));

    this.iconEls.set(index, el);
  }

  private allEmbedObjects(): EmbedViewObject[] {
    return [
      ...this.data.items.map((item) => {
        const size = item.size ?? 96;
        const mode = normalizeCardViewMode(item.viewMode);
        const frame = cardPlacementFrame({ ...item, size, viewMode: mode });
        return {
          key: embedItemRef(item),
          kind: "card" as const,
          id: embedItemRef(item),
          group: item.group ?? "",
          objectGroup: item.objectGroup ?? "",
          x: item.x,
          y: item.y,
          w: frame.w,
          h: frame.h,
          minW: mode !== "icon" ? 220 : 56,
          minH: mode !== "icon" ? 160 : 76,
          maxW: mode !== "icon" ? 720 : 344,
          maxH: mode !== "icon" ? 640 : 364,
        };
      }),
      ...this.data.images.map((image) => ({
        key: objectKey("image", image.id),
        kind: "image" as const,
        id: image.id,
        group: image.group ?? "",
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
        group: box.group ?? "",
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
          group: rating.group ?? "",
          objectGroup: rating.objectGroup ?? "",
          x: rating.x,
          y: rating.y,
          w: RATING_WIDTH * scale,
          h: RATING_HEIGHT * scale,
          minW: 104,
          minH: 43,
          maxW: 624,
          maxH: 258,
        };
      }),
    ];
  }

  private snapTargets(excluded: Set<string>): SnapRect[] {
    return [
      ...this.allEmbedObjects()
        .filter((object) => !excluded.has(object.key))
        .map(({ key, x, y, w, h }) => ({ key, x, y, w, h })),
      ...this.data.groups
        .filter((group) => !excluded.has(`group:${group.id}`))
        .map((group) => ({ key: `group:${group.id}`, x: group.x, y: group.y, w: group.w, h: group.h })),
    ];
  }

  /** Presentation values stay continuous; only the Markdown commit is quantized. */
  private roundEmbedObjectGeometry(objects: EmbedViewObject[]): void {
    for (const object of objects) {
      this.applyEmbedObjectPosition(object.key, Math.round(object.x), Math.round(object.y));
      if (object.kind === "card") {
        const item = this.data.items.find((entry) => embedItemRef(entry) === object.id);
        if (!item) continue;
        item.size = Math.round(item.size ?? 96);
        if (item.previewWidth !== undefined) item.previewWidth = Math.round(item.previewWidth);
        if (item.previewHeight !== undefined) item.previewHeight = Math.round(item.previewHeight);
        const index = this.data.items.findIndex((entry) => embedItemRef(entry) === object.id);
        const el = this.iconEls.get(index);
        if (el) {
          if (item.path) updateFileCardFrame(el, { ...item, size: item.size });
          else updateWebCardElementFrame(el, { ...item, size: item.size });
        }
      } else if (object.kind === "image") {
        const image = this.data.images.find((entry) => entry.id === object.id);
        if (!image) continue;
        image.w = Math.round(image.w);
        image.h = Math.round(image.h);
        const el = this.imageEls.get(object.id);
        if (el) { el.style.width = `${image.w}px`; el.style.height = `${image.h}px`; }
      } else if (object.kind === "textbox") {
        const box = this.data.textboxes.find((entry) => entry.id === object.id);
        if (!box) continue;
        box.w = Math.round(box.w);
        box.h = Math.round(box.h);
        const el = this.textBoxEls.get(object.id);
        if (el) { el.style.width = `${box.w}px`; el.style.height = `${box.h}px`; }
      } else {
        const rating = this.data.ratings.find((entry) => entry.id === object.id);
        if (!rating) continue;
        rating.scale = Math.round((rating.scale ?? 1) * 1000) / 1000;
        const el = this.ratingEls.get(object.id);
        if (el) el.style.transform = `scale(${rating.scale})`;
      }
    }
    this.renderArrows();
    this.updateEmbedObjectSelectionFrame();
  }

  private selectedEmbedObjects(): EmbedViewObject[] {
    return this.allEmbedObjects().filter((object) => this.selectedObjects.has(object.key));
  }

  private selectEmbedObject(key: string, additive: boolean): void {
    this.selectedGroupId = null;
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
    this.selectedGroupId = null;
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
      this.positionSelectionToolbar();
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
    this.positionSelectionToolbar();
  }

  private setEmbedObjectArea(key: string, areaName: string): void {
    const parsed = splitObjectKey(key);
    if (!parsed) {
      const item = this.data.items.find((entry) => embedItemRef(entry) === key);
      if (item) item.group = areaName || undefined;
      return;
    }
    if (parsed.kind === "image") {
      const image = this.data.images.find((entry) => entry.id === parsed.id);
      if (image) image.group = areaName || undefined;
      return;
    }
    if (parsed.kind === "textbox") {
      const box = this.data.textboxes.find((entry) => entry.id === parsed.id);
      if (box) box.group = areaName || undefined;
      return;
    }
    if (parsed.kind === "rating") {
      const rating = this.data.ratings.find((entry) => entry.id === parsed.id);
      if (rating) rating.group = areaName || undefined;
    }
  }

  private showAreaDropTargets(objects: EmbedViewObject[]): void {
    const targets = new Set(objects.map((object) => groupAtPoint(this.data.groups, {
      x: object.x + object.w / 2,
      y: object.y + object.h / 2,
    })).filter(Boolean));
    for (const group of this.data.groups) {
      this.groupEls.get(group.id)?.toggleClass("is-drop-target", targets.has(group.name));
    }
  }

  private clearAreaDropTargets(): void {
    for (const el of this.groupEls.values()) el.removeClass("is-drop-target");
  }

  private applyEmbedObjectScale(origin: EmbedViewObject, x: number, y: number, scale: number): void {
    this.applyEmbedObjectPosition(origin.key, x, y);
    if (origin.kind === "card") {
      const item = this.data.items.find((entry) => embedItemRef(entry) === origin.id);
      if (!item) return;
      Object.assign(item, scaleCardPlacement(
        { ...item, size: item.size ?? 96, viewMode: item.viewMode },
        scale,
        { w: origin.w, h: origin.h },
      ));
      const index = this.data.items.findIndex((entry) => embedItemRef(entry) === origin.id);
      const el = this.iconEls.get(index);
      if (el) {
        if (item.path) updateFileCardFrame(el, { ...item, size: item.size ?? 96 });
        else updateWebCardElementFrame(el, { ...item, size: item.size ?? 96 });
      }
      this.positionSelectionToolbar();
      return;
    }
    if (origin.kind === "image") {
      const image = this.data.images.find((entry) => entry.id === origin.id);
      if (!image) return;
      image.w = origin.w * scale;
      image.h = origin.h * scale;
      const el = this.imageEls.get(origin.id);
      if (el) { el.style.width = `${image.w}px`; el.style.height = `${image.h}px`; }
      return;
    }
    if (origin.kind === "textbox") {
      const box = this.data.textboxes.find((entry) => entry.id === origin.id);
      if (!box) return;
      box.w = origin.w * scale;
      box.h = origin.h * scale;
      const el = this.textBoxEls.get(origin.id);
      if (el) { el.style.width = `${box.w}px`; el.style.height = `${box.h}px`; }
      return;
    }
    const rating = this.data.ratings.find((entry) => entry.id === origin.id);
    if (!rating) return;
    rating.scale = Math.min(3, Math.max(0.5, (origin.w / RATING_WIDTH) * scale));
    const el = this.ratingEls.get(origin.id);
    if (el) el.style.transform = `scale(${rating.scale})`;
  }

  private syncObjectSelection(): void {
    this.data.items.forEach((item, index) => this.iconEls.get(index)?.toggleClass("is-selected", this.selectedObjects.has(embedItemRef(item))));
    for (const [id, el] of this.imageEls) el.toggleClass("is-selected", this.selectedObjects.has(objectKey("image", id)));
    for (const [id, el] of this.textBoxEls) el.toggleClass("is-selected", this.selectedObjects.has(objectKey("textbox", id)));
    for (const [id, el] of this.ratingEls) el.toggleClass("is-selected", this.selectedObjects.has(objectKey("rating", id)));
    for (const [id, el] of this.groupEls) {
      el.toggleClass("is-selected", id === this.selectedGroupId || this.selectedObjects.has(`group:${id}`));
    }
    this.renderArrows();
    this.renderEmbedObjectSelection();
    this.renderSelectionToolbar();
  }

  private renderSelectionToolbar(): void {
    this.selectionToolbarEl?.remove();
    this.selectionToolbarEl = null;
    if (this.selectedArrowId) {
      const arrow = this.data.arrows.find((entry) => entry.id === this.selectedArrowId);
      const target = arrow ? this.arrowEls.get(arrow.id) : null;
      if (!arrow || !target) return;
      this.selectionToolbarEl = createCanvasObjectToolbar(this.rootEl, { icon: "move-up-right", label: "箭头" }, [
        { icon: "tag", label: "编辑箭头标签", onClick: () => this.editArrowLabel(arrow) },
        { icon: "palette", label: "更换箭头颜色", onClick: () => this.cycleArrowColor(arrow) },
        { icon: "ellipsis", label: "更多箭头操作", onClick: (button) => this.showArrowMoreMenu(arrow, button) },
      ]);
      window.requestAnimationFrame(() => this.positionSelectionToolbar());
      return;
    }
    if (this.selectedGroupId) {
      const group = this.data.groups.find((entry) => entry.id === this.selectedGroupId);
      const target = group ? this.groupEls.get(group.id) : null;
      if (!group || !target) return;
      this.selectionToolbarEl = createCanvasObjectToolbar(this.rootEl, { icon: "square-dashed", label: "区域" }, [
        { icon: "pencil", label: "重命名区域", onClick: () => this.renameGroup(group) },
        { icon: "paintbrush", label: "设置区域外观", onClick: (button) => showCanvasContainerAppearanceMenu(this.app, button, group, () => {
          this.renderItems();
          this.scheduleWrite();
        }) },
        { icon: "ellipsis", label: "更多区域操作", onClick: (button) => this.dispatchContextMenu(target, button) },
      ]);
      window.requestAnimationFrame(() => this.positionSelectionToolbar());
      return;
    }
    if (this.selectedObjects.size !== 1) return;
    const [ref] = this.selectedObjects;
    const index = this.data.items.findIndex((entry) => embedItemRef(entry) === ref);
    const item = this.data.items[index];
    let target = item ? this.iconEls.get(index) : null;
    let identity = { icon: "layout-grid", label: "元素" };
    const actions: CanvasToolbarAction[] = [];
    if (item && target) {
      const isCanvasReference = Boolean(item.path && this.canvasFileCache.get(item.path)?.isCanvas);
      const fileKind = item.path ? canvasFileKind(item.path) : null;
      const shortcutKind = item.appPath ? normalizeShortcutKind(item.appKind) : null;
      identity = shortcutKind
        ? { icon: shortcutKindIcon(shortcutKind), label: shortcutKindLabel(shortcutKind) }
        : isCanvasReference
          ? { icon: "panels-top-left", label: "画布" }
          : item.path
            ? { icon: fileKind === "pdf" ? "file-type-2" : "file-text", label: canvasFileKindLabel(item.path) }
            : { icon: "globe-2", label: "网页" };
      actions.push({
        icon: item.appPath ? "play" : isCanvasReference ? "corner-down-right" : "external-link",
        label: item.appPath ? "启动" : isCanvasReference ? "进入画布" : item.path ? "打开笔记" : "打开网页",
        onClick: () => { void this.activateItem(item); },
      });
      if (item.appPath) {
        actions.push(
          { icon: "folder-open", label: "在 Finder 中显示", onClick: () => revealLocalShortcut(this.itemShortcut(item)) },
          { icon: "square-pen", label: "编辑名称、评分与备注", onClick: () => this.editWebItemProperties(item) },
        );
      } else if (item.path && !isCanvasReference && supportsCanvasFilePreview(item.path)) {
        const mode = normalizeCardViewMode(item.viewMode);
        actions.push(
          { icon: "maximize-2", label: "全屏预览", onClick: () => this.previewCanvasFile(item.path!) },
          { icon: "panels-top-left", label: "切换展示方式", text: mode === "embed" ? "嵌入" : mode === "preview" ? "卡片" : "图标", onClick: (button) => this.showCardModeMenu(item, button) },
        );
      } else if (!item.path) {
        const mode = normalizeCardViewMode(item.viewMode);
        actions.push(
          { icon: "square-pen", label: "编辑名称、评分与备注", onClick: () => this.editWebItemProperties(item) },
          { icon: "panels-top-left", label: "切换展示方式", text: mode === "embed" ? "嵌入" : mode === "preview" ? cardStyleLabel(normalizeCardStyle(item.cardStyle)) : "图标", onClick: (button) => this.showCardModeMenu(item, button) },
          { icon: "captions", label: "编辑 Caption", onClick: () => { this.editingCaptionRef = embedItemRef(item); this.renderItems(); } },
        );
      }
      actions.push({ icon: "ellipsis", label: "更多操作", separatorBefore: true, onClick: (button) => this.dispatchContextMenu(target!, button) });
    } else {
      const parsed = splitObjectKey(ref);
      if (!parsed) return;
      target = parsed.kind === "image" ? this.imageEls.get(parsed.id)
        : parsed.kind === "textbox" ? this.textBoxEls.get(parsed.id)
          : this.ratingEls.get(parsed.id);
      if (!target) return;
      identity = parsed.kind === "image" ? { icon: "image", label: "图片" }
        : parsed.kind === "textbox" ? { icon: "sticky-note", label: "文本" }
          : { icon: "star", label: "评分" };
      if (parsed.kind === "image") actions.push({ icon: "external-link", label: "打开图片文件", onClick: () => this.openCanvasImage(parsed.id) });
      if (parsed.kind === "textbox") {
        actions.push({ icon: "pencil", label: "编辑文字", onClick: () => target!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })) });
        const box = this.data.textboxes.find((entry) => entry.id === parsed.id);
        if (box) actions.push({ icon: "paintbrush", label: "设置文本外观", onClick: (button) => showCanvasContainerAppearanceMenu(this.app, button, box, () => {
          this.renderItems();
          this.scheduleWrite();
        }) });
      }
      actions.push({ icon: "ellipsis", label: "更多操作", onClick: (button) => this.dispatchContextMenu(target!, button) });
    }
    this.selectionToolbarEl = createCanvasObjectToolbar(this.rootEl, identity, actions);
    window.requestAnimationFrame(() => this.positionSelectionToolbar());
  }

  private showCardModeMenu(item: EmbedItem, trigger: HTMLElement): void {
    if (item.appPath) return;
    const current = normalizeCardViewMode(item.viewMode);
    const menu = new Menu();
    const modes: Array<{ mode: CardViewMode; label: string; icon: string }> = [
      { mode: "icon", label: "图标", icon: "layout-grid" },
      { mode: "preview", label: "卡片", icon: "panel-top" },
      {
        mode: "embed",
        label: item.path
          ? "嵌入阅读"
          : isRememberedBlockedHost(this.settings.blockedEmbedHosts, item.url)
          ? "重新尝试实时嵌入（实验）"
          : "实时嵌入（实验）",
        icon: "app-window",
      },
    ];
    for (const entry of modes) {
      menu.addItem((menuItem) => menuItem
        .setTitle(entry.label)
        .setIcon(entry.icon)
        .setChecked(current === entry.mode)
        .onClick(() => void this.setEmbedCardViewMode(item, entry.mode, entry.mode === "embed")));
    }
    if (!item.path) {
      menu.addSeparator();
      for (const style of ["visual", "article", "compact"] as CardStyle[]) {
        menu.addItem((menuItem) => menuItem
          .setTitle(`卡片 · ${cardStyleLabel(style)}`)
          .setIcon(style === "visual" ? "image" : style === "compact" ? "rows-3" : "newspaper")
          .setChecked(current === "preview" && normalizeCardStyle(item.cardStyle) === style)
          .onClick(() => this.setEmbedCardStyle(item, style)));
      }
    }
    const rect = trigger.getBoundingClientRect();
    menu.setParentElement(this.rootEl).setUseNativeMenu(false).showAtPosition({ x: rect.left, y: rect.bottom + 6 }, trigger.ownerDocument);
  }

  private setEmbedCardStyle(item: EmbedItem, style: CardStyle): void {
    item.cardStyle = style;
    if (normalizeCardViewMode(item.viewMode) !== "preview") {
      Object.assign(item, switchCardViewMode({ ...item, size: item.size ?? 96 }, "preview"));
    }
    item.viewMode = "preview";
    this.renderItems();
    this.scheduleWrite();
  }

  private selectionTarget(): HTMLElement | null {
    if (this.selectedObjects.size !== 1) return null;
    const [ref] = this.selectedObjects;
    const index = this.data.items.findIndex((entry) => embedItemRef(entry) === ref);
    if (index >= 0) return this.iconEls.get(index) ?? null;
    const parsed = splitObjectKey(ref);
    if (!parsed) return null;
    return parsed.kind === "image" ? this.imageEls.get(parsed.id) ?? null
      : parsed.kind === "textbox" ? this.textBoxEls.get(parsed.id) ?? null
        : this.ratingEls.get(parsed.id) ?? null;
  }

  private dispatchContextMenu(target: HTMLElement, trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left,
      clientY: rect.bottom + 6,
    }));
  }

  private openCanvasImage(id: string): void {
    const image = this.data.images.find((entry) => entry.id === id);
    const file = image ? this.app.vault.getAbstractFileByPath(image.path) : null;
    if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
  }

  private showCreateMenu(trigger: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("收藏 URL…").setIcon("link-2").onClick(() => this.promptForEmbedUrl(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("插入 Markdown / PDF…").setIcon("file-plus-2").onClick(() => this.choosePreviewFile(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("引用其它画布…").setIcon("panels-top-left").onClick(() => this.chooseCanvasReference(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("新建文本框").setIcon("sticky-note").onClick(() => this.addTextBox(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("新建区域").setIcon("square-dashed").onClick(() => this.createGroupAt(this.visibleCenter())));
    this.showMenuBeside(menu, trigger);
  }

  private choosePreviewFile(point: { x: number; y: number }): void {
    new PreviewFileSuggestModal(this.app, this.filePath, (file) => {
      this.addMarkdownFiles([file], point);
    }).open();
  }

  private chooseCanvasReference(point: { x: number; y: number }): void {
    new CanvasFileSuggestModal(this.app, this.filePath, (file) => {
      void resolveCanvasReference(this.app, file.path).then((canvas) => {
        if (!canvas) {
          new Notice("这篇笔记里没有可用的网页收藏画布");
          return;
        }
        this.canvasFileCache.set(file.path, { isCanvas: true, mtime: file.stat.mtime });
        this.addMarkdownFiles([file], point);
      });
    }).open();
  }

  private showCreateMoreMenu(trigger: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("新建评分").setIcon("star").onClick(() => this.addRating(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("画箭头（点两点）").setIcon("move-up-right").onClick(() => this.beginArrowFromScratch()));
    menu.addItem((item) => item.setTitle("适应内容").setIcon("maximize").onClick(() => this.fitContent()));
    this.showMenuBeside(menu, trigger);
  }

  private showMenuBeside(menu: Menu, trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    menu.setParentElement(this.rootEl).setUseNativeMenu(false).showAtPosition({ x: rect.right + 8, y: rect.top }, trigger.ownerDocument);
  }

  private promptForEmbedUrl(point: { x: number; y: number }): void {
    new TextInputModal(this.app, {
      title: "收藏 URL 到画布",
      placeholder: "https://example.com/article",
      submitLabel: "添加",
      onSubmit: (value) => void this.addUrl(value, point),
    }).open();
  }

  private positionSelectionToolbar(): void {
    const toolbar = this.selectionToolbarEl;
    if (!toolbar) return;
    const target = this.selectedArrowId
      ? this.arrowEls.get(this.selectedArrowId)
      : this.selectedGroupId
        ? this.groupEls.get(this.selectedGroupId)
        : this.selectionTarget();
    if (!target) return;
    positionCanvasObjectToolbar(toolbar, target, this.rootEl);
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
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set(origins.map((object) => object.key))));
    beginCanvasPointerSession({
      event,
      element: handle,
      zoom: () => this.zoom,
      resizing: true,
      onMove: (delta) => {
        const relativeX = delta.x / Math.max(bounds.w, 1);
        const relativeY = delta.y / Math.max(bounds.h, 1);
        const dominantX = Math.abs(relativeX) >= Math.abs(relativeY);
        const requested = 1 + (dominantX ? relativeX : relativeY);
        const raw = scaleObjectGroup(origins, requested);
        const rawBounds = objectGroupBounds(raw.objects);
        if (!rawBounds) return;
        const snapped = snapSession.resize(bounds, rawBounds, this.zoom, {
          x: dominantX,
          y: !dominantX,
        });
        const snappedScale = dominantX ? snapped.rect.w / bounds.w : snapped.rect.h / bounds.h;
        const result = scaleObjectGroup(origins, snappedScale);
        result.objects.forEach((object, index) => {
          this.applyEmbedObjectScale(origins[index], object.x, object.y, result.scale);
        });
        const finalBounds = objectGroupBounds(result.objects);
        this.snapGuideLayer?.show(
          finalBounds ? snapGuidesMatchingRect(finalBounds, snapped.guides) : [],
          this.zoom,
        );
        this.renderArrows();
        this.updateEmbedObjectSelectionFrame();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        if (moved) {
          this.roundEmbedObjectGeometry(this.selectedEmbedObjects());
          this.recomputeEmbedGroupMembership();
          this.scheduleWrite();
        }
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
    this.selectedGroupId = null;
    if (event.shiftKey) {
      this.selectEmbedObject(key, true);
      return;
    }
    this.ensureEmbedObjectSelection(key);
    const origins = this.selectedEmbedObjects();
    const bounds = objectGroupBounds(origins);
    if (origins.length === 0 || !bounds) return;
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set(origins.map((object) => object.key))));
    const session = beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      pan: () => ({ x: this.panX, y: this.panY }),
      onPointerMove: (client) => this.edgePan?.update(client),
      onMove: (delta) => {
        const snapped = snapSession.move(bounds, delta, this.zoom);
        const translated = translateObjectGroup(origins, {
          x: snapped.rect.x - bounds.x,
          y: snapped.rect.y - bounds.y,
        });
        for (const object of translated) this.applyEmbedObjectPosition(object.key, object.x, object.y);
        this.showAreaDropTargets(translated);
        this.snapGuideLayer?.show(snapped.guides, this.zoom);
        this.renderArrows();
        this.renderEmbedObjectSelection();
      },
      onEnd: (moved) => {
        this.edgePan?.stop();
        this.edgePan = null;
        snapSession.clear();
        this.snapGuideLayer?.hide();
        this.clearAreaDropTargets();
        if (!moved) {
          activate?.();
          return;
        }
        this.roundEmbedObjectGeometry(this.selectedEmbedObjects());
        this.recomputeEmbedGroupMembership();
        this.scheduleWrite();
      },
    });
    this.edgePan = this.createEdgePan(session);
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
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", `${rating.link?.title ?? "独立评分"}：${rating.value || "未评分"}`);
      el.tabIndex = 0;

      if (state !== "standalone") {
        const header = el.createDiv({ cls: "web-desk-rating-header" });
        header.createSpan({
          cls: "web-desk-rating-link",
          text: state === "missing"
            ? `已移出 · ${rating.link?.title ?? "网页"}`
            : linkedItem?.title ?? rating.link?.title ?? "网页",
        });
      }

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
      el.addEventListener("focus", () => this.ensureEmbedObjectSelection(objectKey("rating", rating.id)));
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
    applyCanvasContainerAppearance(el, group);
    el.setAttribute("data-group-id", group.id);
    el.setAttribute("role", "group");
    el.setAttribute("aria-label", `区域：${group.name}`);
    el.tabIndex = 0;
    el.addEventListener("keydown", (event) => {
      if (event.key === "F2" || event.key === "Enter") {
        event.preventDefault();
        this.renameGroup(group);
      }
    });

    const header = el.createDiv({ cls: "web-desk-group-header", text: group.name });
    header.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.renameGroup(group);
    });

    const handle = el.createDiv({ cls: "web-desk-group-resize" });
    handle.addEventListener("pointerdown", (event) => this.onGroupResizePointerDown(event, group, el));
    el.addEventListener("pointerdown", (event) => this.onGroupPointerDown(event, group, el));
    el.addEventListener("contextmenu", (event) => this.onGroupContextMenu(event, group));
    this.groupEls.set(group.id, el);
    if (this.editingGroupId === group.id) {
      window.requestAnimationFrame(() => {
        if (header.isConnected && this.editingGroupId === group.id) this.editGroupName(group, header);
      });
    }
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
        const frame = cardPlacementFrame({
          ...item,
          size,
          viewMode: normalizeCardViewMode(item.viewMode),
        });
        return {
          ref: embedItemRef(item),
          x: item.x,
          y: item.y,
          w: frame.w,
          h: frame.h,
          group: item.group,
        };
      }),
      textboxes: this.data.textboxes,
      groups: this.data.groups,
    };
  }

  private renderArrows(): void {
    if (!this.arrowsG) return;
    this.arrowsG.empty();
    this.arrowEls.clear();
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
      path.setAttribute(
        "class",
        arrow.id === this.selectedArrowId || this.selectedObjects.has(`arrow:${arrow.id}`)
          ? "web-desk-arrow is-selected"
          : "web-desk-arrow",
      );
      path.style.stroke = arrow.color || "var(--interactive-accent)";
      path.setAttribute(
        "marker-end",
        `url(#${this.arrowMarkerIds.get(arrow.color) ?? this.arrowMarkerIds.get("")})`,
      );
      this.arrowsG.appendChild(path);
      this.arrowEls.set(arrow.id, path);

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
    this.selectedObjects.clear();
    this.selectedGroupId = group.id;
    this.selectedArrowId = null;
    this.syncObjectSelection();
    const originRect = { x: group.x, y: group.y, w: group.w, h: group.h };
    // 与主画布一致，以当前几何关系而非缓存字段决定区域携带成员。
    const memberOrigins = areaMembers(this.allEmbedObjects(), this.data.groups, group.name);
    const memberKeys = new Set(memberOrigins.map((object) => object.key));
    const excluded = new Set([`group:${group.id}`, ...memberKeys]);
    const snapSession = createCanvasSnapSession(this.snapTargets(excluded));
    const session = beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      pan: () => ({ x: this.panX, y: this.panY }),
      onPointerMove: (client) => this.edgePan?.update(client),
      onMove: (delta) => {
        const snapped = snapSession.move(originRect, delta, this.zoom);
        group.x = snapped.rect.x;
        group.y = snapped.rect.y;
        el.style.left = `${group.x}px`;
        el.style.top = `${group.y}px`;
        const translated = translateObjectGroup(memberOrigins, {
          x: snapped.rect.x - originRect.x,
          y: snapped.rect.y - originRect.y,
        });
        for (const object of translated) this.applyEmbedObjectPosition(object.key, object.x, object.y);
        this.positionSelectionToolbar();
        this.snapGuideLayer?.show(snapped.guides, this.zoom);
        this.renderArrows();
      },
      onEnd: (moved) => {
        this.edgePan?.stop();
        this.edgePan = null;
        snapSession.clear();
        this.snapGuideLayer?.hide();
        if (!moved) return;
        group.x = Math.round(group.x);
        group.y = Math.round(group.y);
        el.style.left = `${group.x}px`;
        el.style.top = `${group.y}px`;
        this.roundEmbedObjectGeometry(this.allEmbedObjects().filter((object) => memberKeys.has(object.key)));
        this.recomputeEmbedGroupMembership();
        this.scheduleWrite();
      },
    });
    this.edgePan = this.createEdgePan(session);
  }

  private createEdgePan(session: CanvasPointerSessionHandle): CanvasEdgePan {
    return new CanvasEdgePan({
      rect: () => this.rootEl.getBoundingClientRect(),
      step: (dx, dy) => {
        this.panX += dx;
        this.panY += dy;
        session.replay();
        this.syncRoom();
        this.applyTransform();
      },
    });
  }

  private onGroupResizePointerDown(event: PointerEvent, group: GroupBox, el: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = { w: group.w, h: group.h };
    const originRect = { x: group.x, y: group.y, w: group.w, h: group.h };
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([`group:${group.id}`])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      resizing: true,
      onMove: (delta) => {
        const snapped = snapSession.resize(originRect, {
          ...originRect,
          w: Math.max(240, origin.w + delta.x),
          h: Math.max(180, origin.h + delta.y),
        }, this.zoom);
        group.w = Math.max(240, snapped.rect.w);
        group.h = Math.max(180, snapped.rect.h);
        el.style.width = `${group.w}px`;
        el.style.height = `${group.h}px`;
        this.snapGuideLayer?.show(
          snapGuidesMatchingRect({ x: group.x, y: group.y, w: group.w, h: group.h }, snapped.guides),
          this.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        if (!moved) return;
        group.w = Math.round(group.w);
        group.h = Math.round(group.h);
        el.style.width = `${group.w}px`;
        el.style.height = `${group.h}px`;
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
    menu.addItem((item) => item.setTitle("重命名区域").setIcon("pencil").onClick(() => this.renameGroup(group)));
    menu.addItem((item) => item.setTitle("从这里画箭头").setIcon("move-up-right").onClick(() => {
      this.beginArrowDraft({ kind: "group", ref: group.id });
    }));
    menu.addSeparator();
    appendCanvasContainerAppearanceMenuItems(this.app, menu, group, () => {
      this.renderItems();
      this.scheduleWrite();
    });
    menu.addSeparator();
    menu.addItem((item) => item.setTitle("删除区域（保留元素）").setIcon("trash-2").onClick(() => {
      this.data.groups = this.data.groups.filter((entry) => entry.id !== group.id);
      clearGroupMembership(this.data.items, group.name);
      clearGroupMembership(this.data.images, group.name);
      clearGroupMembership(this.data.textboxes, group.name);
      clearGroupMembership(this.data.ratings, group.name);
      this.data.arrows = arrowsWithoutEndpoint(this.data.arrows, { kind: "group", ref: group.id });
      this.renderItems();
      this.updateHint();
      this.scheduleWrite();
    }));
    menu.showAtMouseEvent(event);
  }

  private renameGroup(group: GroupBox): void {
    const header = this.groupEls.get(group.id)?.querySelector<HTMLElement>(".web-desk-group-header");
    if (header) this.editGroupName(group, header);
  }

  private editGroupName(group: GroupBox, header: HTMLElement): void {
    if (this.editingGroupId && this.editingGroupId !== group.id) return;
    this.editingGroupId = group.id;
    this.editing = true;
    beginInlineGroupNameEdit(header, {
      initial: group.name,
      onCommit: (name) => {
        const wasNew = this.pendingNewGroupIds.delete(group.id);
        const changed = name !== group.name;
        this.editingGroupId = null;
        this.editing = false;
        if (changed) {
          const oldName = group.name;
          group.name = name;
          renameGroupMembership(this.data.items, oldName, name);
          renameGroupMembership(this.data.images, oldName, name);
          renameGroupMembership(this.data.textboxes, oldName, name);
          renameGroupMembership(this.data.ratings, oldName, name);
          this.renderItems();
        }
        if (wasNew || changed) this.scheduleWrite();
      },
      onCancel: () => {
        const wasNew = this.pendingNewGroupIds.delete(group.id);
        this.editingGroupId = null;
        this.editing = false;
        if (wasNew) this.scheduleWrite();
      },
    });
  }

  private createGroupAt(point: { x: number; y: number }): void {
    const group = createGroupBox({
      id: `g${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      name: nextAvailableGroupName(this.data.groups.map((entry) => entry.name)),
      point,
      width: 360,
      height: 240,
      centered: true,
      color: GROUP_COLORS[this.data.groups.length % GROUP_COLORS.length],
    });
    this.data.groups.push(group);
    this.pendingNewGroupIds.add(group.id);
    this.editingGroupId = group.id;
    this.selectedObjects.clear();
    this.selectedGroupId = group.id;
    this.recomputeEmbedGroupMembership();
    this.renderItems();
    this.updateHint();
  }

  private renderTextBox(box: EmbedTextBox): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-textbox" });
    if (box.objectGroup) el.addClass("is-object-grouped");
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    el.style.height = `${box.h}px`;
    applyCanvasContainerAppearance(el, box);
    el.setAttribute("data-tb-id", box.id);
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", `文本框：${box.text}`);
    el.tabIndex = 0;

    const text = el.createDiv({ cls: "web-desk-textbox-text", text: box.text });
    const handle = el.createDiv({ cls: "web-desk-textbox-resize" });
    el.addEventListener("pointerdown", (event) => this.onTextBoxPointerDown(event, box, el));
    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.editTextBox(box, text);
    });
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "F2") {
        event.preventDefault();
        this.editTextBox(box, text);
      }
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
    el.setAttribute("role", "button");
    el.setAttribute("aria-label", image.path);
    el.tabIndex = 0;
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
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const file = this.app.vault.getAbstractFileByPath(image.path);
      if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
    });
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
    const origin = { w: image.w, h: image.h };
    const originRect = { x: image.x, y: image.y, w: image.w, h: image.h };
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([objectKey("image", image.id)])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      resizing: true,
      onMove: ({ x: dx, y: dy }) => {
        const widthDelta = Math.abs(dx) >= Math.abs(dy * (origin.w / origin.h))
          ? dx
          : dy * (origin.w / origin.h);
        const dominantX = Math.abs(dx) >= Math.abs(dy * (origin.w / origin.h));
        const raw = resizeImageToWidth(origin, origin.w + widthDelta);
        const snapped = snapSession.resize(originRect, { ...originRect, ...raw }, this.zoom, {
          x: dominantX,
          y: !dominantX,
        });
        const requestedWidth = dominantX
          ? snapped.rect.w
          : snapped.rect.h * (origin.w / origin.h);
        const size = resizeImageToWidth(origin, requestedWidth);
        image.w = size.w;
        image.h = size.h;
        el.style.width = `${image.w}px`;
        el.style.height = `${image.h}px`;
        this.snapGuideLayer?.show(
          snapGuidesMatchingRect({ x: image.x, y: image.y, w: image.w, h: image.h }, snapped.guides),
          this.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        if (moved) {
          this.roundEmbedObjectGeometry(this.allEmbedObjects().filter((object) => object.key === objectKey("image", image.id)));
          this.recomputeEmbedGroupMembership();
          this.scheduleWrite();
        }
      },
    });
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

  /** 渲染后重算房间，内容长大墙就跟着长。 */
  private updateHint(): void {
    this.syncRoom();
    this.hintEl.toggleClass("is-hidden", hasCanvasContent({
      cards: this.data.items.length,
      images: this.data.images.length,
      textboxes: this.data.textboxes.length,
      groups: this.data.groups.length,
      arrows: this.data.arrows.length,
      ratings: this.data.ratings.length,
      pending: this.pendingImports.size,
    }));
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

    // 指针位于画布内时，双指/滚轮平移，触控板捏合或 Ctrl/Cmd+滚轮缩放。
    // 正文仍可从画布外滚动，避免依赖无法可靠识别设备类型的 wheel 猜测。
    this.rootEl.addEventListener("wheel", (event) => {
      const intent = canvasWheelIntent(event, this.rootEl.clientHeight);
      event.preventDefault();
      if (intent.kind === "zoom") {
        this.zoomAt(event.clientX, event.clientY, intent.factor);
        return;
      }
      this.panX += intent.x;
      this.panY += intent.y;
      this.applyTransform(true);
      this.scheduleSettle();
    }, { passive: false });

    this.rootEl.addEventListener("keydown", (event) => {
      this.rootEl.removeClass("is-pointer-focused");
      if (
        event.code === "Space" &&
        !this.editing &&
        !isEditablePasteTarget(event.target, this.rootEl)
      ) {
        this.spacePanning = true;
        event.preventDefault();
      }
      if (event.key === "Escape" && (this.arrowDraft || this.pendingArrowStart)) {
        event.preventDefault();
        this.cancelArrowDraft();
        return;
      }
      if (event.key === "Escape" && this.isFullscreen) {
        event.preventDefault();
        event.stopPropagation();
        this.setFullscreen(false);
        return;
      }
      if (event.key === "Escape") {
        // 与主画布一致：消费掉 Esc，避免 Obsidian 全局处理把焦点交还编辑器。
        event.preventDefault();
        event.stopPropagation();
        this.selectedObjects.clear();
        this.selectedGroupId = null;
        this.selectedArrowId = null;
        this.syncObjectSelection();
        return;
      }
      const isDeleteKey = event.key === "Delete" || event.key === "Backspace";
      if (isDeleteKey && isEditablePasteTarget(event.target, this.rootEl)) return;
      if (isDeleteKey && this.selectedObjects.size > 0) {
        event.preventDefault();
        this.removeSelectedObjectsFromCanvas();
        return;
      }
      if (isDeleteKey && this.selectedGroupId) {
        event.preventDefault();
        this.removeSelectedGroupFromCanvas();
        return;
      }
      if (isDeleteKey && this.selectedArrowId) {
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
        this.selectedObjects = new Set([
          ...this.allEmbedObjects().map((object) => object.key),
          ...this.data.groups.map((group) => `group:${group.id}`),
          ...this.data.arrows.map((arrow) => `arrow:${arrow.id}`),
        ]);
        this.selectedGroupId = null;
        this.selectedArrowId = null;
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
      event.preventDefault();
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
        this.applyTransform(true);
      };
      const onUp = (): void => {
        this.rootEl.removeEventListener("pointermove", onMove);
        this.rootEl.removeEventListener("pointerup", onUp);
        if (moved) this.settlePan();
        if (!moved) {
          this.selectedObjects.clear();
          this.selectedGroupId = null;
          this.selectedArrowId = null;
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
        m.setTitle("收藏 URL…").setIcon("plus").onClick(() => {
          const url = window.prompt("链接地址");
          if (url) void this.addUrl(url, point);
        }),
      );
      menu.addItem((m) =>
        m.setTitle("新建区域").setIcon("square-dashed").onClick(() => this.createGroupAt(point)),
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
      menu.addSeparator();
      menu.addItem((m) =>
        m.setTitle("全选").setIcon("scan").onClick(() => {
          this.selectedObjects = new Set([
            ...this.allEmbedObjects().map((object) => object.key),
            ...this.data.groups.map((group) => `group:${group.id}`),
            ...this.data.arrows.map((arrow) => `arrow:${arrow.id}`),
          ]);
          this.selectedGroupId = null;
          this.selectedArrowId = null;
          this.syncObjectSelection();
        }),
      );
      menu.addItem((m) =>
        m.setTitle("适应内容").setIcon("maximize").onClick(() => this.fitContent()),
      );
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
      this.marqueeEl.addClass("is-active");
      this.marqueeEl.style.left = `${x * this.zoom + this.panX}px`;
      this.marqueeEl.style.top = `${y * this.zoom + this.panY}px`;
      this.marqueeEl.style.width = `${w * this.zoom}px`;
      this.marqueeEl.style.height = `${h * this.zoom}px`;
    };
    const onUp = (upEvent: PointerEvent): void => {
      this.rootEl.removeEventListener("pointermove", onMove);
      this.rootEl.removeEventListener("pointerup", onUp);
      this.marqueeEl.removeClass("is-active");
      if (!moved) {
        // 单击空白处：与主画布一致，非加选时清空选择。
        if (!additive && (this.selectedObjects.size || this.selectedGroupId || this.selectedArrowId)) {
          this.selectedObjects.clear();
          this.selectedGroupId = null;
          this.selectedArrowId = null;
          this.syncObjectSelection();
        }
        return;
      }
      const rect = normalizeRect(start, this.clientToCanvas(upEvent.clientX, upEvent.clientY));
      const objects = this.allEmbedObjects();
      for (const object of objects) {
        if (rectsIntersect(rect, object)) base.add(object.key);
      }
      for (const group of this.data.groups) {
        if (rectsIntersect(rect, group)) base.add(`group:${group.id}`);
      }
      const scene = this.endpointScene();
      for (const arrow of this.data.arrows) {
        if (arrowIntersectsRect(arrow, scene, rect)) base.add(`arrow:${arrow.id}`);
      }
      for (const object of objects) {
        if (object.objectGroup && base.has(object.key)) {
          objects.filter((entry) => entry.objectGroup === object.objectGroup)
            .forEach((entry) => base.add(entry.key));
        }
      }
      this.selectedObjects = base;
      this.selectedGroupId = null;
      this.selectedArrowId = null;
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
    this.onEmbedObjectPointerDown(event, embedItemRef(item), el);
  }

  private itemShortcut(item: EmbedItem): LocalShortcut {
    return { path: item.appPath ?? "", name: item.appName || item.title, kind: normalizeShortcutKind(item.appKind) };
  }

  private async activateItem(item: EmbedItem): Promise<void> {
    if (item.appPath) {
      await launchLocalShortcutWithNotice(this.itemShortcut(item));
      return;
    }
    if (!item.path) {
      window.open(item.url, "_blank");
      return;
    }
    if (await this.isCanvasReference(item.path)) {
      this.openCanvasReference(item.path);
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(item.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice("原笔记已不存在");
    }
  }

  private previewCanvasFile(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice("文件已移动或删除");
      return;
    }
    if (!supportsCanvasFilePreview(file.path)) {
      new Notice("此文件暂不支持画布内预览");
      return;
    }
    this.filePreview?.close();
    this.filePreview = openCanvasFilePreview(this.app, this, file, () => {
      this.filePreview = null;
    });
  }

  private openMarkdownPath(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) void this.app.workspace.getLeaf(false).openFile(file);
    else new Notice("原笔记已不存在");
  }

  private async isCanvasReference(path: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(path);
    const mtime = file instanceof TFile ? file.stat.mtime : -1;
    const cached = this.canvasFileCache.get(path);
    if (cached?.mtime === mtime) return cached.isCanvas;
    const isCanvas = Boolean(await resolveCanvasReference(this.app, path));
    this.canvasFileCache.set(path, { isCanvas, mtime });
    return isCanvas;
  }

  private async decorateCanvasReference(
    path: string,
    cardEl: HTMLElement,
    iconEl: HTMLElement,
  ): Promise<void> {
    if (!(await this.isCanvasReference(path)) || !cardEl.isConnected) return;
    cardEl.addClass("is-canvas-reference");
    setIcon(iconEl, "panels-top-left");
    const thumb = cardEl.querySelector<HTMLElement>(".web-desk-icon-thumb");
    if (thumb && !thumb.querySelector(".web-desk-canvas-reference-badge")) {
      const badge = thumb.createSpan({ cls: "web-desk-canvas-reference-badge", text: "画布" });
      badge.setAttribute("aria-hidden", "true");
    }
    const title = cardEl.querySelector<HTMLElement>(".web-desk-icon-label")?.textContent ?? path;
    cardEl.setAttribute("aria-label", `画布引用：${title}`);
  }

  private openCanvasReference(path: string): void {
    if (this.navigation) {
      this.navigation.openCanvas(path);
      return;
    }
    const originFile = this.app.vault.getAbstractFileByPath(this.filePath);
    this.drilldown ??= new CanvasDrilldown({
      app: this.app,
      hostEl: this.rootEl,
      settings: this.settings,
      onSettingsChange: this.onSettingsChange,
      originLabel: originFile instanceof TFile ? originFile.basename : "当前画布",
      originPath: this.filePath,
      resolveFavicon: this.resolveFavicon,
      resolveShortcutIcon: this.resolveShortcutIcon,
    });
    void this.drilldown.open(path);
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
    const origin = { ...item, size: item.size ?? 96, viewMode: item.viewMode };
    const originFrame = cardPlacementFrame(origin);
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([embedItemRef(item)])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      resizing: true,
      onMove: ({ x: dx, y: dy }) => {
        const raw = resizeCardPlacement(origin, { x: dx, y: dy });
        const rawFrame = cardPlacementFrame(raw);
        const preview = origin.viewMode !== "icon";
        const dominantX = Math.abs(dx) >= Math.abs(dy);
        const snapped = snapSession.resize(
          { x: origin.x, y: origin.y, ...originFrame },
          { x: origin.x, y: origin.y, ...rawFrame },
          this.zoom,
          preview ? undefined : { x: dominantX, y: !dominantX },
        );
        const delta = preview
          ? { x: snapped.rect.w - originFrame.w, y: snapped.rect.h - originFrame.h }
          : dominantX
            ? { x: snapped.rect.w - originFrame.w, y: 0 }
            : { x: 0, y: snapped.rect.h - originFrame.h };
        Object.assign(item, resizeCardPlacement(origin, delta));
        if (item.path) updateFileCardFrame(el, { ...item, size: item.size ?? 96 });
        else updateWebCardElementFrame(el, { ...item, size: item.size ?? 96 });
        this.positionSelectionToolbar();
        const frame = cardPlacementFrame({ ...item, size: item.size ?? 96, viewMode: item.viewMode });
        this.snapGuideLayer?.show(
          snapGuidesMatchingRect({ x: item.x, y: item.y, ...frame }, snapped.guides),
          this.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        if (moved) {
          this.roundEmbedObjectGeometry(this.allEmbedObjects().filter((object) => object.key === embedItemRef(item)));
          this.recomputeEmbedGroupMembership();
          this.scheduleWrite();
        }
      },
    });
  }

  private onItemContextMenu(event: MouseEvent, item: EmbedItem): void {
    event.preventDefault();
    event.stopPropagation();
    const ref = embedItemRef(item);
    this.ensureEmbedObjectSelection(ref);
    const menu = new Menu();
    if (item.path) {
      if (this.canvasFileCache.get(item.path)?.isCanvas) {
        menu.addItem((m) => m.setTitle("进入画布").setIcon("panels-top-left").onClick(() => this.openCanvasReference(item.path!)));
      }
      menu.addItem((m) => m.setTitle("在标签页打开").setIcon("external-link").onClick(() => this.openMarkdownPath(item.path!)));
      if (supportsCanvasFilePreview(item.path)) {
        menu.addItem((m) => m.setTitle("全屏预览").setIcon("maximize-2").onClick(() => this.previewCanvasFile(item.path!)));
        menu.addItem((m) => m.setTitle("切换展示方式").setIcon("panels-top-left").onClick(() => {
          const trigger = this.iconEls.get(this.data.items.indexOf(item)) ?? this.rootEl;
          this.showCardModeMenu(item, trigger);
        }));
        if (normalizeCardViewMode(item.viewMode) !== "icon") {
          menu.addItem((m) => m.setTitle("恢复默认预览尺寸").setIcon("scaling").onClick(() => {
            item.previewWidth = DEFAULT_PREVIEW_WIDTH;
            item.previewHeight = DEFAULT_PREVIEW_HEIGHT;
            this.renderItems();
            this.scheduleWrite();
          }));
        }
      }
      menu.addItem((m) => m.setTitle("复制双链").setIcon("copy").onClick(() => {
        const file = this.app.vault.getAbstractFileByPath(item.path!);
        if (file instanceof TFile) {
          void navigator.clipboard.writeText(this.app.fileManager.generateMarkdownLink(file, this.filePath));
          new Notice("已复制双链");
        }
      }));
    } else if (item.appPath) {
      const shortcut = this.itemShortcut(item);
      menu.addItem((m) => m.setTitle("启动").setIcon("play").onClick(() => void launchLocalShortcutWithNotice(shortcut)));
      menu.addItem((m) => m.setTitle("在 Finder 中显示").setIcon("folder-open").onClick(() => revealLocalShortcut(shortcut)));
      menu.addItem((m) => m.setTitle("复制路径").setIcon("copy").onClick(() => {
        void navigator.clipboard.writeText(shortcut.path);
        new Notice("已复制路径");
      }));
      menu.addItem((m) => m.setTitle("编辑名称、评分与备注…").setIcon("square-pen").onClick(() => this.editWebItemProperties(item)));
    } else {
      menu.addItem((m) => m.setTitle("打开网页").setIcon("external-link").onClick(() => window.open(item.url, "_blank")));
      if (item.bookmarkPath) {
        menu.addItem((m) => m
          .setTitle("打开 Markdown")
          .setIcon("file-text")
          .onClick(() => this.openBookmarkMarkdown(item)));
      } else {
        menu.addItem((m) => m
          .setTitle("创建并关联 Markdown…")
          .setIcon("file-plus-2")
          .onClick(() => void this.ensureBookmarkMarkdown(item)));
      }
      menu.addItem((m) => m.setTitle("复制链接").setIcon("copy").onClick(() => {
        void navigator.clipboard.writeText(item.url);
        new Notice("已复制链接");
      }));
      menu.addItem((m) => m
        .setTitle("编辑名称、评分与备注…")
        .setIcon("square-pen")
        .onClick(() => this.editWebItemProperties(item)));
      menu.addItem((m) => m
        .setTitle(normalizeCardViewMode(item.viewMode) === "preview" ? "显示为图标" : "显示为预览卡片")
        .setIcon(normalizeCardViewMode(item.viewMode) === "preview" ? "app-window" : "panel-top")
        .onClick(() => this.setEmbedCardViewMode(
          item,
          normalizeCardViewMode(item.viewMode) === "preview" ? "icon" : "preview",
        )));
      if (normalizeCardViewMode(item.viewMode) === "preview") {
        menu.addItem((m) => m
          .setTitle("恢复默认预览尺寸")
          .setIcon("scaling")
          .onClick(() => {
            item.previewWidth = DEFAULT_PREVIEW_WIDTH;
            item.previewHeight = DEFAULT_PREVIEW_HEIGHT;
            this.renderItems();
            this.scheduleWrite();
          }));
      }
    }
    if (item.path) {
      menu.addItem((m) =>
        m.setTitle("为此文件添加评分").setIcon("star").onClick(() => {
          const frame = cardPlacementFrame({ ...item, size: item.size ?? 96, viewMode: "icon" });
          this.addRating({ x: item.x + frame.w + 128, y: item.y + frame.h / 2 }, item);
        }),
      );
    }
    menu.addItem((m) =>
      m.setTitle("从这里画箭头").setIcon("move-up-right").onClick(() => {
        this.beginArrowDraft({ kind: "card", ref });
      }),
    );
    menu.addSeparator();
    menu.addItem((m) => m
      .setTitle("移出画布")
      .setIcon("square-minus")
      .onClick(() => this.removeItemFromEmbed(item)));
    if (!item.path && item.bookmarkPath) {
      menu.addItem((m) => m
        .setTitle("删除收藏文件…")
        .setIcon("trash-2")
        .onClick(() => this.confirmDeleteBookmark(item)));
    }
    menu.addSeparator();
    this.appendEmbedObjectGroupMenu(menu);
    menu.showAtMouseEvent(event);
  }

  private openBookmarkMarkdown(item: EmbedItem): void {
    const file = item.bookmarkPath
      ? this.app.vault.getAbstractFileByPath(item.bookmarkPath)
      : null;
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file);
    } else {
      new Notice("对应的收藏 Markdown 已不存在");
    }
  }

  private async ensureBookmarkMarkdown(item: EmbedItem): Promise<void> {
    if (!item.url) return;
    try {
      const result = await importUrlAsBookmark(this.app, this.settings, item.url, {
        size: this.settings.defaultIconSize,
      });
      item.bookmarkPath = result.file.path;
      item.url = result.meta.url;
      if (!item.title.trim()) item.title = result.meta.title;
      if (!item.description) item.description = result.meta.description;
      if (!item.previewImage) item.previewImage = result.meta.image;
      this.renderItems();
      this.scheduleWrite(true);
      new Notice(result.created ? `已创建收藏：${result.file.basename}` : `已关联收藏：${result.file.basename}`);
    } catch (error) {
      new Notice(`创建收藏失败：${getErrorMessage(error)}`, 6000);
    }
  }

  private removeItemFromEmbed(item: EmbedItem): void {
    const ref = embedItemRef(item);
    this.data.items = this.data.items.filter((entry) => entry !== item);
    this.data.arrows = arrowsWithoutEndpoint(this.data.arrows, { kind: "card", ref });
    this.selectedObjects.delete(ref);
    this.renderItems();
    this.updateHint();
    this.scheduleWrite(Boolean(item.path || item.bookmarkPath));
  }

  private removeSelectedObjectsFromCanvas(): void {
    const plan = planCanvasObjectDeletion([
      ...this.allEmbedObjects(),
      ...this.data.groups.map((group) => ({ key: `group:${group.id}`, kind: "group" as const, id: group.id })),
      ...this.data.arrows.map((arrow) => ({ key: `arrow:${arrow.id}`, kind: "arrow" as const, id: arrow.id })),
    ], this.selectedObjects);
    const count = plan.cardIds.length + plan.imageIds.length + plan.textBoxIds.length +
      plan.ratingIds.length + plan.groupIds.length + plan.arrowIds.length;
    if (count === 0) return;

    const cardIds = new Set(plan.cardIds);
    const imageIds = new Set(plan.imageIds);
    const textBoxIds = new Set(plan.textBoxIds);
    const ratingIds = new Set(plan.ratingIds);
    const groupIds = new Set(plan.groupIds);
    const arrowIds = new Set(plan.arrowIds);
    const removedItems = this.data.items.filter((item) => cardIds.has(embedItemRef(item)));
    const removedGroups = this.data.groups.filter((group) => groupIds.has(group.id));
    this.data.items = this.data.items.filter((item) => !cardIds.has(embedItemRef(item)));
    this.data.images = this.data.images.filter((image) => !imageIds.has(image.id));
    this.data.textboxes = this.data.textboxes.filter((box) => !textBoxIds.has(box.id));
    this.data.ratings = this.data.ratings.filter((rating) => !ratingIds.has(rating.id));
    this.data.groups = this.data.groups.filter((group) => !groupIds.has(group.id));
    for (const group of removedGroups) {
      clearGroupMembership(this.data.items, group.name);
      clearGroupMembership(this.data.images, group.name);
      clearGroupMembership(this.data.textboxes, group.name);
      clearGroupMembership(this.data.ratings, group.name);
    }
    this.data.arrows = this.data.arrows.filter((arrow) => !arrowIds.has(arrow.id));
    for (const groupId of groupIds) {
      this.data.arrows = arrowsWithoutEndpoint(this.data.arrows, { kind: "group", ref: groupId });
    }
    this.data.arrows = pruneDanglingArrows(this.data.arrows, this.endpointScene());
    this.selectedObjects.clear();
    this.selectedGroupId = null;
    this.selectedArrowId = null;
    this.renderItems();
    this.updateHint();
    this.scheduleWrite(removedItems.some((item) => Boolean(item.path || item.bookmarkPath)));
    new Notice(`已从画布移除 ${count} 个元素`);
  }

  private removeSelectedGroupFromCanvas(): void {
    const group = this.data.groups.find((entry) => entry.id === this.selectedGroupId);
    if (!group) return;
    this.data.groups = this.data.groups.filter((entry) => entry.id !== group.id);
    clearGroupMembership(this.data.items, group.name);
    clearGroupMembership(this.data.images, group.name);
    clearGroupMembership(this.data.textboxes, group.name);
    clearGroupMembership(this.data.ratings, group.name);
    this.data.arrows = arrowsWithoutEndpoint(this.data.arrows, { kind: "group", ref: group.id });
    this.selectedGroupId = null;
    this.renderItems();
    this.updateHint();
    this.scheduleWrite();
    new Notice("已从画布移除区域，区域内元素仍保留在画布上");
  }

  private confirmDeleteBookmark(item: EmbedItem): void {
    new ConfirmModal(this.app, {
      message: "删除这个收藏的 Markdown 文件？（移入仓库回收站，并从文内画布移除）",
      okLabel: "删除",
      onOk: () => void this.deleteBookmarkFile(item),
    }).open();
  }

  private async deleteBookmarkFile(item: EmbedItem): Promise<void> {
    const file = item.bookmarkPath
      ? this.app.vault.getAbstractFileByPath(item.bookmarkPath)
      : null;
    if (file instanceof TFile) await this.app.vault.trash(file, false);
    this.removeItemFromEmbed(item);
  }

  private async setEmbedCardViewMode(item: EmbedItem, mode: CardViewMode, retry = false): Promise<void> {
    if (mode === "embed" && !item.path) {
      const statusId = `embed:${embedItemRef(item)}`;
      const pending: PendingWebCard = {
        id: statusId,
        purpose: "embed",
        url: item.url,
        x: item.x,
        y: item.y,
        state: "loading",
        title: "正在检查实时嵌入",
        message: "正在读取网站的嵌入权限…",
      };
      this.pendingImports.set(statusId, pending);
      this.renderItems();
      this.updateHint();
      const assessment = await assessRemoteEmbed(item.url, retry ? [] : this.settings.blockedEmbedHosts);
      if (!assessment.allowed) {
        if (assessment.reason === "x-frame-options" || assessment.reason === "frame-ancestors") {
          this.settings.blockedEmbedHosts = rememberBlockedEmbedHost(
            this.settings.blockedEmbedHosts,
            item.url,
          );
          this.onSettingsChange?.();
        }
        pending.state = "error";
        pending.title = "无法实时嵌入";
        pending.message = assessment.reason === "invalid-url"
          ? "实时嵌入只支持 HTTPS 网页"
          : "网站禁止 iframe 嵌入，已保留卡片视图";
        this.renderItems();
        if (normalizeCardViewMode(item.viewMode) === "embed") mode = "preview";
        else return;
      } else {
        this.pendingImports.delete(statusId);
      }
    }
    Object.assign(item, switchCardViewMode({ ...item, size: item.size ?? 96 }, mode));
    item.viewMode = mode === "icon" ? undefined : mode;
    this.renderItems();
    this.scheduleWrite();
  }

  private persistEmbedCaption(item: EmbedItem, value: string): void {
    item.caption = normalizeCardCaption(value) || undefined;
    this.editingCaptionRef = null;
    this.renderItems();
    this.scheduleWrite();
  }

  private editWebItemProperties(item: EmbedItem): void {
    new CardPropertiesModal(this.app, {
      initial: {
        title: item.title,
        rating: normalizeCardRating(item.rating),
        note: item.note ?? "",
      },
      onSubmit: (properties) => {
        item.title = properties.title;
        item.rating = properties.rating || undefined;
        item.note = properties.note || undefined;
        this.renderItems();
        this.scheduleWrite();
        new Notice("网页属性已保存");
      },
    }).open();
  }

  private addRating(point: { x: number; y: number }, item?: EmbedItem): void {
    const ratings = this.data.ratings;
    if (item && ratings.some((rating) => rating.link?.ref === embedItemRef(item))) {
      new Notice("这个链接已经有评分了");
      return;
    }
    const desired = {
      x: Math.round(point.x - RATING_WIDTH / 2),
      y: Math.round(point.y - RATING_HEIGHT / 2),
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
    const originRect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([objectKey("textbox", box.id)])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.zoom,
      resizing: true,
      onMove: (delta) => {
        const snapped = snapSession.resize(originRect, {
          ...originRect,
          w: Math.max(140, origin.w + delta.x),
          h: Math.max(60, origin.h + delta.y),
        }, this.zoom);
        box.w = Math.max(140, snapped.rect.w);
        box.h = Math.max(60, snapped.rect.h);
        el.style.width = `${box.w}px`;
        el.style.height = `${box.h}px`;
        this.snapGuideLayer?.show(
          snapGuidesMatchingRect({ x: box.x, y: box.y, w: box.w, h: box.h }, snapped.guides),
          this.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        if (moved) {
          this.roundEmbedObjectGeometry(this.allEmbedObjects().filter((object) => object.key === objectKey("textbox", box.id)));
          this.recomputeEmbedGroupMembership();
          this.scheduleWrite();
        }
      },
    });
  }

  private onTextBoxContextMenu(event: MouseEvent, box: TextBox, textEl: HTMLElement): void {
    event.preventDefault();
    event.stopPropagation();
    this.ensureEmbedObjectSelection(objectKey("textbox", box.id));
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("编辑文字").setIcon("pencil").onClick(() => this.editTextBox(box, textEl)));
    menu.addSeparator();
    appendCanvasContainerAppearanceMenuItems(this.app, menu, box, () => {
      this.renderItems();
      this.scheduleWrite();
    });
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
    this.selectedObjects.clear();
    this.selectedGroupId = null;
    this.renderArrows();
    this.syncObjectSelection();
  }

  private onArrowContextMenu(event: MouseEvent, arrow: Arrow): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedArrowId = arrow.id;
    this.renderArrows();
    this.renderSelectionToolbar();
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

  private editArrowLabel(arrow: Arrow): void {
    new TextInputModal(this.app, {
      title: "箭头标签",
      initial: arrow.label,
      onSubmit: (label) => {
        arrow.label = label;
        this.renderArrows();
        this.scheduleWrite();
      },
    }).open();
  }

  private cycleArrowColor(arrow: Arrow): void {
    arrow.color = cycleColor(GROUP_COLORS, arrow.color);
    this.renderArrows();
    this.scheduleWrite();
  }

  private showArrowMoreMenu(arrow: Arrow, trigger: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("删除箭头").setIcon("trash-2").onClick(() => this.removeArrow(arrow.id)));
    const rect = trigger.getBoundingClientRect();
    menu.setParentElement(this.rootEl).setUseNativeMenu(false).showAtPosition({ x: rect.left, y: rect.bottom + 6 }, trigger.ownerDocument);
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
    const objects = this.allEmbedObjects();
    const previous = new Map(objects.map((object) => [object.key, object.group]));
    if (recomputeGroupMembership(objects, this.data.groups) === 0) return;
    for (const object of objects) {
      if (previous.get(object.key) !== object.group) this.setEmbedObjectArea(object.key, object.group);
    }
  }

  // ---------- 缩放 ----------

  private applyTransform(elastic = false): void {
    this.constrainTransform(elastic);
    this.canvasEl.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
    const grid = canvasGridBackground(this.panX, this.panY, this.zoom);
    this.rootEl.style.backgroundSize = grid.size;
    this.rootEl.style.backgroundPosition = grid.position;
    applyCanvasZoomBand(this.rootEl, this.zoom);
    this.zoomEl.setText(`${Math.round(this.zoom * 100)}%`);
    this.positionSelectionToolbar();
  }

  private contentBounds(): ContentBounds | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const expand = (x: number, y: number, w: number, h: number): void => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    };
    for (const object of this.allEmbedObjects()) expand(object.x, object.y, object.w, object.h);
    for (const group of this.data.groups) expand(group.x, group.y, group.w, group.h);
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  private syncRoom(): void {
    this.room = deriveRoom(this.contentBounds());
  }

  private constrainTransform(elastic = false): void {
    const rect = this.rootEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const viewport = { width: rect.width, height: rect.height };
    const floor = minZoomForRoom(this.room, viewport, MIN_ZOOM);
    if (this.zoom < floor) this.zoom = floor;
    const place = elastic ? elasticPanToRoom : clampPanToRoom;
    const pan = place({ x: this.panX, y: this.panY }, this.zoom, this.room, viewport);
    this.panX = pan.x;
    this.panY = pan.y;
  }

  /** 手势结束后把拉过墙的部分弹回去。 */
  private settlePan(): void {
    if (this.settleFrame !== null) window.cancelAnimationFrame(this.settleFrame);
    const rect = this.rootEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const viewport = { width: rect.width, height: rect.height };
    const target = clampPanToRoom({ x: this.panX, y: this.panY }, this.zoom, this.room, viewport);
    const fromX = this.panX;
    const fromY = this.panY;
    if (Math.abs(target.x - fromX) < 0.5 && Math.abs(target.y - fromY) < 0.5) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      this.panX = target.x;
      this.panY = target.y;
      this.applyTransform();
      return;
    }
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - start) / 220);
      const ease = 1 - Math.pow(1 - t, 3);
      this.panX = fromX + (target.x - fromX) * ease;
      this.panY = fromY + (target.y - fromY) * ease;
      this.applyTransform();
      if (t < 1) this.settleFrame = window.requestAnimationFrame(step);
      else this.settleFrame = null;
    };
    this.settleFrame = window.requestAnimationFrame(step);
  }

  private scheduleSettle(): void {
    if (this.settleTimer !== null) window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => {
      this.settleTimer = null;
      this.settlePan();
    }, 140);
  }

  private zoomFloor(rect: DOMRect): number {
    return minZoomForRoom(this.room, { width: rect.width, height: rect.height }, MIN_ZOOM);
  }

  private zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = this.rootEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    // 下限在这里就夹住，否则 pan 会按未被夹的缩放算，内容每缩一次就漂。
    const next = Math.min(MAX_ZOOM, Math.max(this.zoomFloor(rect), this.zoom * factor));
    if (Math.abs(next - this.zoom) < 1e-6) return;
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

  private fitContent(): void {
    // 取景按内容走，边界归房间管。
    this.syncRoom();
    const rect = this.rootEl.getBoundingClientRect();
    const content = this.contentBounds();
    const margin = 48;
    const bounds = content
      ? { minX: content.minX - margin, minY: content.minY - margin, maxX: content.maxX + margin, maxY: content.maxY + margin }
      : { minX: this.room.x, minY: this.room.y, maxX: this.room.x + this.room.w, maxY: this.room.y + this.room.h };
    const fitted = fitCanvasBounds(
      rect.width,
      rect.height,
      bounds,
      this.zoomFloor(rect),
      1.25,
    );
    this.zoom = fitted.zoom;
    this.panX = fitted.panX;
    this.panY = fitted.panY;
    this.applyTransform();
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
    const viewport = canvasSafeViewport(rect.width, rect.height);
    return this.clientToCanvas(rect.left + viewport.centerX, rect.top + viewport.centerY);
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
      new Notice("这个 Markdown/PDF 不在当前 Vault 中；请先移入 Vault 再拖到画布");
      return;
    }
    const shortcutPaths = localShortcutCandidates(localFilePathsFromDrop(event.dataTransfer));
    if (shortcutPaths.length > 0) {
      this.addLocalShortcuts(shortcutPaths, point);
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

  /** 本机应用 / 文件夹 / 文件拖入文内画布：条目直接记录路径与名称，不生成 Markdown。 */
  addLocalShortcuts(paths: string[], point: { x: number; y: number }): void {
    let added = 0;
    for (const path of paths) {
      const shortcut = describeLocalShortcut(path);
      if (this.data.items.some((item) => item.appPath === shortcut.path)) {
        new Notice(`${shortcut.name} 已经在画布上了`);
        continue;
      }
      const position = findAvailableEmbedItemPosition(this.data, {
        x: Math.round(point.x - 48 + added * 132),
        y: Math.round(point.y - 48),
      });
      this.data.items.push({
        url: "",
        appPath: shortcut.path,
        appName: shortcut.name,
        appKind: shortcut.kind,
        title: shortcut.name,
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
    new Notice(`已添加 ${added} 个本机快捷方式`);
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
    const pending: PendingWebCard = {
      id: `p${Date.now().toString(36)}`,
      url: rawUrl,
      x: Math.round(point.x - 48),
      y: Math.round(point.y - 48),
      state: "loading",
    };
    this.pendingImports.set(pending.id, pending);
    this.renderItems();
    this.updateHint();
    try {
      const result = await importUrlAsBookmark(this.app, this.settings, rawUrl, {
        size: this.settings.defaultIconSize,
      });
      const meta = result.meta;
      const position = findAvailableEmbedItemPosition(this.data, {
        x: Math.round(point.x - 48),
        y: Math.round(point.y - 48),
      });
      this.data.items.push({
        url: meta.url,
        bookmarkPath: result.file.path,
        title: meta.title,
        description: meta.description,
        previewImage: meta.image,
        x: position.x,
        y: position.y,
        size: 96,
        cardStyle: "article",
      });
      this.pendingImports.delete(pending.id);
      this.recomputeEmbedGroupMembership();
      if (!quiet) {
        this.renderItems();
        this.updateHint();
        this.scheduleWrite();
        new Notice(result.created ? `已收藏：${result.file.basename}` : `已关联收藏：${result.file.basename}`);
      }
    } catch (error) {
      pending.state = "error";
      pending.message = getErrorMessage(error);
      this.renderItems();
      this.updateHint();
    } finally {
      this.busy = false;
    }
  }

  private retryPendingImport(id: string): void {
    const pending = this.pendingImports.get(id);
    if (!pending) return;
    this.pendingImports.delete(id);
    if (pending.purpose === "embed") {
      const ref = id.slice("embed:".length);
      const item = this.data.items.find((entry) => embedItemRef(entry) === ref);
      if (item) void this.setEmbedCardViewMode(item, "embed", true);
      return;
    }
    void this.addUrl(pending.url, { x: pending.x + 48, y: pending.y + 48 });
  }

  private addTextBox(point: { x: number; y: number }, text = "双击编辑"): void {
    const boxes = this.data.textboxes;
    const occupied = [
      ...this.allEmbedObjects().map(({ x, y, w, h }) => ({ x, y, w, h })),
      ...this.data.groups.map((group) => ({ x: group.x, y: group.y, w: group.w, h: group.h })),
    ];
    const position = findFreePosition(occupied, { x: point.x - 130, y: point.y - 60 }, { w: 260, h: 120 }, { step: 140, grid: 24 });
    const id = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    boxes.push({
      id,
      text,
      x: position.x,
      y: position.y,
      w: 260,
      h: 120,
      color: GROUP_COLORS[boxes.length % GROUP_COLORS.length],
    });
    this.selectedObjects.clear();
    this.selectedObjects.add(objectKey("textbox", id));
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
    void enqueueEmbedWrite(this.instanceScopeKey, this.instanceId, async () => {
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
    await processFrontmatterSerially(this.app, file, (frontmatter: Record<string, unknown>) => {
      if (links.length > 0) frontmatter.web_desk_links = links;
      else delete frontmatter.web_desk_links;
    });
  }

  private async writeBack(fresh: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return;

    publishEmbedHandoff(this.instanceScopeKey, this.instanceId, this.currentHandoff());

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

interface CanvasDrilldownOptions {
  app: App;
  hostEl: HTMLElement;
  settings: WebDeskSettings;
  onSettingsChange?: () => void;
  originLabel: string;
  originPath?: string;
  resolveFavicon?: FaviconResolve;
  resolveShortcutIcon?: ShortcutIconResolve;
}

/**
 * 原位下钻导航：每一层仍是同一个 DeskEmbed 实现，只替换当前可见层。
 * 引用是惰性打开的，因此层级可以很深，同时不会递归渲染整棵画布树。
 */
export class CanvasDrilldown {
  private readonly resolveFavicon?: FaviconResolve;
  private readonly resolveShortcutIcon?: ShortcutIconResolve;
  private readonly app: App;
  private readonly hostEl: HTMLElement;
  private readonly settings: WebDeskSettings;
  private readonly onSettingsChange?: () => void;
  private readonly originLabel: string;
  private readonly originPath?: string;
  private entries: Array<{ path: string; label: string }> = [];
  private overlayEl: HTMLElement | null = null;
  private child: DeskEmbed | null = null;
  private renderToken = 0;
  private focusBoundary: CanvasFocusBoundary | null = null;

  constructor(options: CanvasDrilldownOptions) {
    this.app = options.app;
    this.hostEl = options.hostEl;
    this.settings = options.settings;
    this.onSettingsChange = options.onSettingsChange;
    this.originLabel = options.originLabel;
    this.originPath = options.originPath;
    this.resolveFavicon = options.resolveFavicon;
    this.resolveShortcutIcon = options.resolveShortcutIcon;
  }

  async open(path: string): Promise<void> {
    const stack = [this.originPath, ...this.entries.map((entry) => entry.path)]
      .filter((entry): entry is string => Boolean(entry));
    const decision = canEnterCanvasReference(stack, path);
    if (!decision.allowed) {
      new Notice(decision.reason === "cycle" ? "检测到画布循环引用，已停止继续下钻" : "画布引用路径为空");
      return;
    }
    const resolved = await resolveCanvasReference(this.app, path);
    if (!resolved) {
      new Notice("目标笔记不存在，或里面没有可用的网页收藏画布");
      return;
    }
    this.entries.push({ path: resolved.file.path, label: resolved.file.basename });
    await this.renderCurrent();
  }

  close(): void {
    this.renderToken += 1;
    this.child?.unload();
    this.child = null;
    this.focusBoundary?.release();
    this.focusBoundary = null;
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.entries = [];
    if (this.hostEl.ownerDocument.activeElement === this.hostEl.ownerDocument.body) {
      this.hostEl.focus({ preventScroll: true });
    }
  }

  private async renderCurrent(): Promise<void> {
    const current = this.entries[this.entries.length - 1];
    if (!current) {
      this.close();
      return;
    }
    const token = ++this.renderToken;
    const resolved = await resolveCanvasReference(this.app, current.path);
    if (token !== this.renderToken) return;
    if (!resolved) {
      this.entries.pop();
      new Notice("目标画布已移动、删除或变成无效数据");
      if (this.entries.length > 0) await this.renderCurrent();
      else this.close();
      return;
    }

    this.child?.unload();
    this.child = null;
    this.focusBoundary?.release({ restoreFocus: false });
    this.focusBoundary = null;
    this.overlayEl?.remove();

    const overlay = this.hostEl.createDiv({ cls: "web-desk-drilldown" });
    overlay.tabIndex = -1;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", `${current.label} 画布`);
    for (const eventName of ["pointerdown", "click", "dblclick", "contextmenu", "wheel", "paste", "drop", "dragover"] as const) {
      overlay.addEventListener(eventName, (event) => event.stopPropagation());
    }
    const nav = overlay.createDiv({ cls: "web-desk-drilldown-nav" });
    const back = nav.createEl("button", {
      cls: "web-desk-drilldown-back",
      attr: { type: "button", "aria-label": "返回上一层" },
    });
    setIcon(back, "chevron-left");
    back.addEventListener("click", () => this.goBack());

    const crumbs = nav.createDiv({ cls: "web-desk-drilldown-crumbs", attr: { "aria-label": "画布层级" } });
    this.appendCrumb(crumbs, this.originLabel, () => this.close());
    this.entries.forEach((entry, index) => {
      const separator = crumbs.createSpan({ cls: "web-desk-drilldown-separator" });
      setIcon(separator, "chevron-right");
      this.appendCrumb(crumbs, entry.label, () => {
        if (index === this.entries.length - 1) return;
        this.entries = this.entries.slice(0, index + 1);
        void this.renderCurrent();
      }, index === this.entries.length - 1);
    });

    const close = nav.createEl("button", {
      cls: "web-desk-drilldown-close",
      attr: { type: "button", "aria-label": "退出下钻" },
    });
    setIcon(close, "x");
    close.addEventListener("click", () => this.close());

    const childHost = overlay.createDiv({ cls: "web-desk-drilldown-content" });
    const child = new DeskEmbed(
      childHost,
      resolved.source,
      this.app,
      { sourcePath: resolved.file.path, getSectionInfo: () => null },
      this.settings,
      this.onSettingsChange,
      { openCanvas: (targetPath) => { void this.open(targetPath); } },
      this.resolveFavicon,
      this.resolveShortcutIcon,
    );
    child.render();
    childHost.querySelector<HTMLElement>(".web-desk-embed")?.addClass("is-drilldown-surface");
    overlay.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        this.goBack();
      }
    });
    this.overlayEl = overlay;
    this.child = child;
    this.focusBoundary = new CanvasFocusBoundary(overlay, this.hostEl, back);
    this.focusBoundary.activate();
  }

  private appendCrumb(
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    current = false,
  ): void {
    const button = parent.createEl("button", {
      text: label,
      cls: `web-desk-drilldown-crumb${current ? " is-current" : ""}`,
      attr: { type: "button", ...(current ? { "aria-current": "page" } : {}) },
    });
    button.addEventListener("click", onClick);
  }

  private goBack(): void {
    if (this.entries.length <= 1) {
      this.close();
      return;
    }
    this.entries.pop();
    void this.renderCurrent();
  }
}

function cardStyleLabel(style: CardStyle): string {
  return style === "visual" ? "视觉" : style === "compact" ? "紧凑" : "文章";
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
