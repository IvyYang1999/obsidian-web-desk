import { ItemView, Menu, Notice, Scope, setIcon, TFile, WorkspaceLeaf } from "obsidian";
import { CanvasDrilldown } from "./embed";
import { resolveCanvasReference } from "./canvas-reference";
import { importUrlAsBookmark } from "./importer";
import {
  imageFilesFrom,
  imageFilesFromClipboard,
  imageResourceUrl,
  storeImageFile,
} from "./image-storage";
import { isEditablePasteTarget, splitCanvasPaste } from "./clipboard-state";
import { resizeImageToWidth } from "./image-state";
import {
  createMarkdownShortcut,
  hasLocalMarkdownFileDrop,
  markdownFilesFromDrop,
} from "./file-link-storage";
import { planAutoPositions, readCard, writeDeskFields } from "./layout";
import { localFilePathsFromDrop } from "./file-link-storage";
import { localShortcutCandidates, shortcutKindIcon, shortcutKindLabel, type LocalShortcut } from "./shortcut-state";
import { createLocalShortcutNote, describeLocalShortcut } from "./shortcut-importer";
import { launchLocalShortcutWithNotice, localShortcutExists, revealLocalShortcut } from "./shortcut-launch";
import type { ShortcutIconResolve } from "./shortcut-icon";
import { renderShortcutCardVisual } from "./card-view";
import type { FaviconResolve } from "./favicon-cache";
import { applyRecentLayoutWrite, RecentLayoutWrite } from "./layout-state";
import { CanvasFileSuggestModal, CardPropertiesModal, ConfirmModal, PreviewFileSuggestModal, TextInputModal } from "./modals";
import { normalizeRatingValue, RATING_HEIGHT, RATING_WIDTH, ratingLinkState } from "./rating-state";
import { applyCardPropertiesToFrontmatter } from "./card-properties-state";
import { applyCardCaptionToFrontmatter, normalizeCardCaption } from "./card-caption-state";
import { cardAccessibleLabel, renderCardPropertyIndicators } from "./card-properties-ui";
import { renderWebCardVisual, updateWebCardElementFrame } from "./card-view";
import {
  cardPlacementFrame,
  DEFAULT_PREVIEW_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  resizeCardPlacement,
  scaleCardPlacement,
  switchCardViewMode,
  type CardViewMode,
} from "./card-view-state";
import { beginCanvasPointerSession } from "./canvas-pointer";
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
import { applyCanvasZoomBand, canvasSafeViewport, fitCanvasBounds } from "./canvas-viewport-state";
import { clampPanToRoom, deriveRoom, minZoomForRoom, type ContentBounds, type RoomRect } from "./canvas-room";
import { findFreePosition } from "./canvas-free-position";
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
  cycleColor,
  createGroupBox,
  groupAtPoint,
  hasArrowBetween,
  nextAvailableGroupName,
  pruneDanglingArrows as pruneSceneArrows,
  recomputeGroupMembership,
  renameGroupMembership,
} from "./canvas-state";
import {
  BookmarkCard,
  CardProperties,
  CanvasImage,
  CANVAS_BOUND,
  CanvasTransform,
  Arrow,
  ArrowEndpoint,
  GROUP_COLORS,
  GroupBox,
  Rating,
  TextBox,
  SIZE_LARGE,
  SIZE_MEDIUM,
  SIZE_SMALL,
  VIEW_TYPE_WEB_DESK,
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

export interface WebDeskHost {
  getSettings(): WebDeskSettings;
  getGroups(): GroupBox[];
  setGroups(groups: GroupBox[]): void;
  getTextBoxes(): TextBox[];
  setTextBoxes(boxes: TextBox[]): void;
  getArrows(): Arrow[];
  setArrows(arrows: Arrow[]): void;
  getImages(): CanvasImage[];
  setImages(images: CanvasImage[]): void;
  getRatings(): Rating[];
  setRatings(ratings: Rating[]): void;
  getTransform(): CanvasTransform;
  setTransform(transform: CanvasTransform): void;
  setBlockedEmbedHosts(hosts: string[]): void;
  /** 网站图标解析（Vault 缓存 + 远程择优）；缺省时退回首字母色块。 */
  resolveFavicon?: FaviconResolve;
  /** 本机应用 / 文件夹 / 文件的系统图标；缺省时用种类占位图标。 */
  resolveShortcutIcon?: ShortcutIconResolve;
}

interface Point {
  x: number;
  y: number;
}

interface ViewObject extends GroupObjectRect {
  kind: "card" | "image" | "textbox" | "rating";
  id: string;
  group: string;
  objectGroup: string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const SVG_NS = "http://www.w3.org/2000/svg";
const ARROW_SPAN = 20000;

export class WebDeskView extends ItemView {
  private readonly host: WebDeskHost;
  private rootEl!: HTMLElement;
  private canvasEl!: HTMLElement;
  private roomEl!: HTMLElement;
  private room: RoomRect = deriveRoom(null);
  private marqueeEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private zoomLabelEl!: HTMLElement;

  private cards: BookmarkCard[] = [];
  private iconEls = new Map<string, HTMLElement>();
  private imageEls = new Map<string, HTMLElement>();
  private groupEls = new Map<string, HTMLElement>();
  private textBoxEls = new Map<string, HTMLElement>();
  private ratingEls = new Map<string, HTMLElement>();
  private arrowsG: SVGGElement | null = null;
  private arrowMarkerIds = new Map<string, string>();
  private arrowEls = new Map<string, SVGPathElement>();
  private selectedArrowId: string | null = null;
  private arrowDraft: ArrowEndpoint | null = null;
  private pendingArrowStart = false;
  private editingTextBoxId: string | null = null;
  private editingGroupId: string | null = null;
  private spacePanning = false;
  private selected = new Set<string>();
  private objectSelectionEl: HTMLElement | null = null;
  private selectionToolbarEl: HTMLElement | null = null;
  private selectedGroupId: string | null = null;
  private pendingImports = new Map<string, PendingWebCard>();
  private snapGuideLayer: CanvasSnapGuideLayer | null = null;
  private transform: CanvasTransform = { panX: 0, panY: 0, zoom: 1 };

  /** >0 表示有交互进行中（拖拽/导入），推迟重绘。 */
  private interactionLock = 0;
  /** 近期本地写回的坐标（path → x/y/时刻）：metadataCache 滞后窗口内以本地为准，防视觉回跳。 */
  private layoutWrites = new Map<string, RecentLayoutWrite>();
  /** 最近由 Delete/移出画布隐藏的卡片；metadataCache 滞后时阻止它瞬间复活。 */
  private hiddenWrites = new Map<string, number>();
  private cardPropertyWrites = new Map<string, { properties: CardProperties; at: number }>();
  private cardCaptionWrites = new Map<string, { caption: string; at: number }>();
  private editingCaptionPath: string | null = null;
  private refreshTimer: number | null = null;
  private autoPlaceRunning = false;
  private drilldown: CanvasDrilldown | null = null;
  private filePreview: CanvasFilePreviewHandle | null = null;
  private canvasFileCache = new Map<string, { isCanvas: boolean; mtime: number }>();

  constructor(leaf: WorkspaceLeaf, host: WebDeskHost) {
    super(leaf);
    this.host = host;
    // Obsidian 的 Keymap 在 window 捕获阶段处理 Escape（回到最近的编辑器），DOM 监听里
    // stopPropagation 拦不住；视图自己的 Scope 会先于 app.scope 收到按键，返回 false 即吞掉。
    this.scope = new Scope(this.app.scope);
    this.scope.register([], "Escape", (event) => {
      this.handleEscape(event);
      return false;
    });
  }

  private handleEscape(event: KeyboardEvent): void {
    event.preventDefault();
    if (this.arrowDraft || this.pendingArrowStart) {
      this.cancelArrowDraft();
      return;
    }
    this.selected.clear();
    this.selectedGroupId = null;
    this.clearArrowSelection();
    this.syncSelection();
    this.rootEl.focus({ preventScroll: true });
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
    this.filePreview?.close();
    this.filePreview = null;
    this.drilldown?.close();
    this.drilldown = null;
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
    // 房间是画布这张“纸”本身：在最底层，随 transform 一起缩放平移。
    this.roomEl = this.canvasEl.createDiv({ cls: "web-desk-room" });

    this.marqueeEl = this.rootEl.createDiv({ cls: "web-desk-marquee" });
    this.marqueeEl.style.display = "none";

    this.hintEl = this.rootEl.createDiv({ cls: "web-desk-hint" });
    this.hintEl.createDiv({ cls: "web-desk-hint-title", text: "把第一个网页放进来" });
    this.hintEl.createDiv({
      cls: "web-desk-hint-body",
      text: "粘贴链接，或拖入网页、Markdown、PDF、图片与本机应用。",
    });
    const hintButton = this.hintEl.createEl("button", { cls: "web-desk-hint-action", text: "收藏 URL" });
    hintButton.addEventListener("click", (event) => {
      event.stopPropagation();
      this.promptForUrl(this.visibleCenter());
    });

    createCanvasCreateRail(this.rootEl, [
      { icon: "plus", label: "添加元素", onClick: (button) => this.showCreateMenu(button) },
      { icon: "sticky-note", label: "新建文本框", onClick: () => {
        const point = this.visibleCenter();
        this.addTextBox(point.x - 130, point.y - 60);
      } },
      { icon: "square-dashed", label: "新建区域", onClick: () => this.createGroupAt(this.visibleCenter()) },
      { icon: "ellipsis", label: "更多画布组件", onClick: (button) => this.showCreateMoreMenu(button) },
    ]);

    const toolbar = this.rootEl.createDiv({ cls: "web-desk-toolbar" });
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "画布缩放");
    const zoomOut = toolbar.createEl("button", { cls: "web-desk-tool-btn", attr: { type: "button", "aria-label": "缩小", title: "缩小" } });
    setIcon(zoomOut, "minus");
    this.zoomLabelEl = toolbar.createEl("span", { cls: "web-desk-zoom-label", text: "100%" });
    const zoomIn = toolbar.createEl("button", { cls: "web-desk-tool-btn", attr: { type: "button", "aria-label": "放大", title: "放大" } });
    setIcon(zoomIn, "plus");
    const fit = toolbar.createEl("button", { cls: "web-desk-tool-btn", attr: { type: "button", "aria-label": "适应内容", title: "适应内容" } });
    setIcon(fit, "maximize");

    zoomOut.addEventListener("click", () => this.zoomAtCenter(1 / 1.2));
    zoomIn.addEventListener("click", () => this.zoomAtCenter(1.2));
    fit.addEventListener("click", () => this.fitContent());

    this.rootEl.addEventListener("wheel", (event) => this.onWheel(event), { passive: false });
    this.rootEl.addEventListener("pointerdown", (event) => this.onCanvasPointerDown(event));
    this.rootEl.addEventListener("contextmenu", (event) => this.onCanvasContextMenu(event));
    this.rootEl.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.rootEl.addEventListener("keyup", (event) => {
      if (event.code === "Space") this.spacePanning = false;
    });
    this.rootEl.addEventListener("blur", () => { this.spacePanning = false; });
    const resizeObserver = new ResizeObserver(() => this.positionSelectionToolbar());
    resizeObserver.observe(this.rootEl);
    this.register(() => resizeObserver.disconnect());
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
    this.registerDomEvent(this.rootEl.ownerDocument, "paste", (event) => {
      if (this.app.workspace.activeLeaf?.view !== this) return;
      void this.onPaste(event);
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

    const now = Date.now();
    for (const [path, at] of this.hiddenWrites) {
      if (now - at > 10_000) this.hiddenWrites.delete(path);
    }
    this.cards = this.bookmarkFiles()
      .map((file) => readCard(file, this.app, this.settings.defaultIconSize))
      .filter((card): card is BookmarkCard => card !== null)
      .filter((card) => !this.hiddenWrites.has(card.path));

    // 写盘成功但 metadataCache 未跟上时，cache 给的是旧坐标——以本地近期写入为准，防拖拽回跳
    for (const card of this.cards) {
      const write = this.layoutWrites.get(card.path);
      if (write && applyRecentLayoutWrite(card, write, now) === "expired") {
        this.layoutWrites.delete(card.path);
      }
      const propertyWrite = this.cardPropertyWrites.get(card.path);
      if (propertyWrite && now - propertyWrite.at > 10_000) {
        this.cardPropertyWrites.delete(card.path);
      } else if (propertyWrite) {
        card.title = propertyWrite.properties.title;
        card.rating = propertyWrite.properties.rating;
        card.note = propertyWrite.properties.note;
      }
      const captionWrite = this.cardCaptionWrites.get(card.path);
      if (captionWrite && now - captionWrite.at > 10_000) {
        this.cardCaptionWrites.delete(card.path);
      } else if (captionWrite) {
        card.caption = captionWrite.caption;
      }
    }

    await this.autoPlaceNewcomers();
    this.pruneDanglingArrows();
    this.render();
    // 旧数据里的图片、文本和评分没有区域字段；按当前空间位置做一次兼容归属。
    void this.persistMovedObjects([], true);
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
    if (this.autoPlaceRunning || this.cards.every((card) => card.placed)) return;
    // 新卡片要避开所有可见对象（不只是已放置的图标格子），并落在当前视口中心附近。
    const unplaced = new Set(this.cards.filter((card) => !card.placed).map((card) => card.path));
    const occupied = [
      ...this.allViewObjects()
        .filter((object) => !(object.kind === "card" && unplaced.has(object.id)))
        .map(({ x, y, w, h }) => ({ x, y, w, h })),
      ...this.host.getGroups().map((group) => ({ x: group.x, y: group.y, w: group.w, h: group.h })),
    ];
    const rect = this.rootEl.getBoundingClientRect();
    const origin = rect.width > 0 && rect.height > 0
      ? this.clientToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2)
      : undefined;
    const plan = planAutoPositions(this.cards, { occupied, origin });
    if (plan.size === 0) {
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
    this.imageEls.clear();
    this.groupEls.clear();
    this.textBoxEls.clear();
    this.ratingEls.clear();
    this.canvasEl.empty();
    this.roomEl = this.canvasEl.createDiv({ cls: "web-desk-room" });
    this.snapGuideLayer = createCanvasSnapGuideLayer(this.canvasEl);

    this.buildSvgLayer();
    this.renderArrows();
    for (const group of this.host.getGroups()) {
      this.renderGroup(group);
    }
    this.renderImages();
    for (const card of this.cards) {
      this.renderIcon(card);
    }
    this.renderTextBoxes();
    this.renderRatings();
    for (const pending of this.pendingImports.values()) {
      renderPendingWebCard(
        this.canvasEl,
        pending,
        () => this.retryPendingImport(pending.id),
        () => this.dismissPendingImport(pending.id),
      );
    }
    this.syncSelection();

    this.syncRoom();

    this.hintEl.style.display = hasCanvasContent({
      cards: this.cards.length,
      images: this.host.getImages().length,
      textboxes: this.host.getTextBoxes().length,
      groups: this.host.getGroups().length,
      arrows: this.host.getArrows().length,
      ratings: this.host.getRatings().length,
      pending: this.pendingImports.size,
    }) ? "none" : "flex";
  }

  private renderIcon(card: BookmarkCard): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-icon" });
    if (card.objectGroup) el.addClass("is-object-grouped");
    if (card.targetPath) el.addClass("is-file-link");
    el.style.left = `${card.x}px`;
    el.style.top = `${card.y}px`;

    if (card.targetPath) {
      const file = this.app.vault.getAbstractFileByPath(card.targetPath);
      renderFileCardVisual(this.app, this, el, {
        ...card,
        file: file instanceof TFile ? file : null,
        path: card.targetPath,
        onOpen: () => this.openMarkdown(card),
        onFullscreen: () => this.previewCanvasFile(card.targetPath),
      });
      const icon = el.querySelector<HTMLElement>(".web-desk-file-icon, .web-desk-file-card-icon");
      if (icon) void this.decorateCanvasReference(card.targetPath, el, icon);
    } else if (card.appPath) {
      const shortcut = this.cardShortcut(card);
      el.addClass("is-local-shortcut");
      renderShortcutCardVisual(el, {
        x: card.x,
        y: card.y,
        size: card.size,
        viewMode: "icon",
        title: card.title,
        kind: shortcut.kind,
        rating: card.rating,
        note: card.note,
        caption: card.caption,
        captionEditing: this.editingCaptionPath === card.path,
        onCaptionInput: (value) => { card.caption = value; },
        onCaptionCommit: (value) => void this.persistCardCaption(card, value),
        missing: !localShortcutExists(shortcut.path),
        resolveIcon: this.host.resolveShortcutIcon
          ? () => this.host.resolveShortcutIcon!(shortcut)
          : undefined,
      });
    } else {
      renderWebCardVisual(el, {
        ...card,
        cardStyle: card.cardStyle,
        previewImage: previewImageSource(this.app, card.previewImage),
        captionEditing: this.editingCaptionPath === card.path,
        onCaptionInput: (value) => { card.caption = value; },
        onCaptionCommit: (value) => void this.persistCardCaption(card, value),
        onEmbedFallback: () => {
          this.host.setBlockedEmbedHosts(rememberBlockedEmbedHost(this.settings.blockedEmbedHosts, card.url));
          void this.setCardViewMode(card, "preview");
        },
        onOpen: () => window.open(card.url, "_blank", "noopener,noreferrer"),
        resolveIcon: this.host.resolveFavicon,
        fallbackKey: card.path,
      });
    }

    const handle = el.createDiv({ cls: "web-desk-icon-resize" });
    if (card.targetPath) updateFileCardFrame(el, card);
    else updateWebCardElementFrame(el, card);

    el.setAttribute("data-path", card.path);
    el.setAttribute("role", "link");
    el.tabIndex = 0;
    el.setAttribute("aria-label", cardAccessibleLabel(
      card.title,
      card.targetPath || card.url,
      card.rating,
      card.note,
    ));
    if (card.note) el.setAttribute("title", card.note);

    el.addEventListener("pointerdown", (event) => this.onIconPointerDown(event, card, el));
    el.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void this.activateCard(card);
    });
    el.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      void this.activateCard(card);
    });
    el.addEventListener("contextmenu", (event) => this.onIconContextMenu(event, card));
    if (card.targetPath) {
      el.addEventListener("mouseover", (event) => this.triggerFileHover(event, el, card.targetPath, card.path));
    }
    handle.addEventListener("pointerdown", (event) => this.onIconResizePointerDown(event, card, el));

    this.iconEls.set(card.path, el);
  }

  private renderGroup(group: GroupBox): void {
    const el = this.canvasEl.createDiv({ cls: "web-desk-group" });
    el.style.left = `${group.x}px`;
    el.style.top = `${group.y}px`;
    el.style.width = `${group.w}px`;
    el.style.height = `${group.h}px`;
    applyCanvasContainerAppearance(el, group);

    const header = el.createDiv({ cls: "web-desk-group-header", text: group.name });
    header.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.renameGroup(group);
    });

    const handle = el.createDiv({ cls: "web-desk-group-resize" });
    handle.addEventListener("pointerdown", (event) => this.onGroupResizePointerDown(event, group));
    el.addEventListener("pointerdown", (event) => this.onGroupPointerDown(event, group));
    el.addEventListener("contextmenu", (event) => {
      event.stopPropagation();
      this.onGroupContextMenu(event, group);
    });

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
    this.groupEls.set(group.id, el);
    if (this.editingGroupId === group.id) {
      window.requestAnimationFrame(() => {
        if (header.isConnected && this.editingGroupId === group.id) this.editGroupName(group, header);
      });
    }
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
    this.constrainTransform();
    this.canvasEl.style.transform = `translate(${this.transform.panX}px, ${this.transform.panY}px) scale(${this.transform.zoom})`;
    const grid = canvasGridBackground(this.transform.panX, this.transform.panY, this.transform.zoom);
    this.rootEl.style.backgroundSize = grid.size;
    this.rootEl.style.backgroundPosition = grid.position;
    applyCanvasZoomBand(this.rootEl, this.transform.zoom);
    this.zoomLabelEl.setText(`${Math.round(this.transform.zoom * 100)}%`);
    this.positionSelectionToolbar();
  }

  /** 内容包围盒；空画布返回 null，房间退回最小尺寸。 */
  private contentBounds(): ContentBounds | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const expand = (x: number, y: number, w: number, h: number): void => {
      minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
    };
    for (const object of this.allViewObjects()) expand(object.x, object.y, object.w, object.h);
    for (const group of this.host.getGroups()) expand(group.x, group.y, group.w, group.h);
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }

  /** 内容变化后重算房间：对象被拖到墙外，墙就自己长出来；拖回来又缩回去。 */
  private syncRoom(): void {
    this.room = deriveRoom(this.contentBounds());
    this.roomEl.style.left = `${this.room.x}px`;
    this.roomEl.style.top = `${this.room.y}px`;
    this.roomEl.style.width = `${this.room.w}px`;
    this.roomEl.style.height = `${this.room.h}px`;
  }

  /** 缩放下限跟着房间走，平移不许把墙拖进视口内侧。 */
  private constrainTransform(): void {
    const rect = this.rootEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const viewport = { width: rect.width, height: rect.height };
    const floor = minZoomForRoom(this.room, viewport, MIN_ZOOM);
    if (this.transform.zoom < floor) this.transform.zoom = floor;
    const pan = clampPanToRoom(
      { x: this.transform.panX, y: this.transform.panY },
      this.transform.zoom,
      this.room,
      viewport,
    );
    this.transform.panX = pan.x;
    this.transform.panY = pan.y;
  }

  private saveTransformDebounced(): void {
    this.host.setTransform({ ...this.transform });
  }

  private saveTransformNow(): void {
    this.host.setTransform({ ...this.transform });
  }

  // ---------- 画布级交互 ----------

  private onWheel(event: WheelEvent): void {
    const intent = canvasWheelIntent(event, this.rootEl.clientHeight);
    event.preventDefault();

    if (intent.kind === "zoom") {
      this.zoomAt(event.clientX, event.clientY, intent.factor);
      return;
    }

    this.transform.panX += intent.x;
    this.transform.panY += intent.y;
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
      const frame = cardPlacementFrame(card);
      expand(card.x, card.y);
      expand(card.x + frame.w, card.y + frame.h);
    }
    for (const group of this.host.getGroups()) {
      expand(group.x, group.y);
      expand(group.x + group.w, group.y + group.h);
    }
    for (const image of this.host.getImages()) {
      expand(image.x, image.y);
      expand(image.x + image.w, image.y + image.h);
    }
    for (const box of this.host.getTextBoxes()) {
      expand(box.x, box.y);
      expand(box.x + box.w, box.y + box.h);
    }
    for (const rating of this.host.getRatings()) {
      const scale = rating.scale ?? 1;
      expand(rating.x, rating.y);
      expand(rating.x + RATING_WIDTH * scale, rating.y + RATING_HEIGHT * scale);
    }

    // 适应内容 = 适应整个房间：让墙也进画面，用户才知道自己在多大的空间里。
    const rect = this.rootEl.getBoundingClientRect();
    const fitted = fitCanvasBounds(
      rect.width,
      rect.height,
      { minX: this.room.x, minY: this.room.y, maxX: this.room.x + this.room.w, maxY: this.room.y + this.room.h },
      MIN_ZOOM,
      1.25,
    );
    this.transform.zoom = fitted.zoom;
    this.transform.panX = fitted.panX;
    this.transform.panY = fitted.panY;
    this.applyTransform();
    this.saveTransformDebounced();
  }

  private onCanvasPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement;
    const blocked = Boolean(
      target.closest(".web-desk-icon") ||
      target.closest(".web-desk-group") ||
      target.closest(".web-desk-image") ||
      target.closest(".web-desk-textbox") ||
      target.closest(".web-desk-rating") ||
      target.closest(".web-desk-object-selection") ||
      target.closest(".web-desk-toolbar")
    );
    if ((event.button === 1 || (event.button === 0 && this.spacePanning)) && !blocked) {
      this.beginCanvasPan(event);
      return;
    }
    if (event.button !== 0 || blocked) {
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
          this.selectedGroupId = null;
          this.clearArrowSelection();
          this.syncSelection();
        }
        return;
      }

      const end = this.clientToCanvas(upEvent.clientX, upEvent.clientY);
      const rect = normalizeRect(start, end);
      const objects = this.allViewObjects();
      for (const object of objects) {
        if (rectsIntersect(rect, object)) baseSelection.add(object.key);
      }
      for (const group of this.host.getGroups()) {
        if (rectsIntersect(rect, group)) baseSelection.add(`group:${group.id}`);
      }
      const scene = this.endpointScene();
      for (const arrow of this.host.getArrows()) {
        if (arrowIntersectsRect(arrow, scene, rect)) baseSelection.add(`arrow:${arrow.id}`);
      }
      for (const object of objects) {
        if (object.objectGroup && baseSelection.has(object.key)) {
          objects.filter((entry) => entry.objectGroup === object.objectGroup)
            .forEach((entry) => baseSelection.add(entry.key));
        }
      }
      this.selected = baseSelection;
      this.selectedGroupId = null;
      this.clearArrowSelection();
      this.syncSelection();
    };

    this.rootEl.addEventListener("pointermove", onMove);
    this.rootEl.addEventListener("pointerup", onUp);
  }

  private beginCanvasPan(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const baseX = this.transform.panX;
    const baseY = this.transform.panY;
    const document = this.rootEl.ownerDocument;
    const onMove = (moveEvent: PointerEvent): void => {
      if (moveEvent.pointerId !== event.pointerId) return;
      this.transform.panX = baseX + moveEvent.clientX - startX;
      this.transform.panY = baseY + moveEvent.clientY - startY;
      this.applyTransform();
    };
    const onUp = (upEvent: PointerEvent): void => {
      if (upEvent.pointerId !== event.pointerId) return;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, true);
      document.removeEventListener("pointercancel", onUp, true);
      this.saveTransformDebounced();
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (
      event.code === "Space" &&
      !this.editingTextBoxId &&
      !isEditablePasteTarget(event.target)
    ) {
      this.spacePanning = true;
      event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      // 主路径走视图 Scope（见构造函数）；这里兜底处理焦点在画布内部元素上的情况。
      event.stopPropagation();
      this.handleEscape(event);
      return;
    }
    const isDeleteKey = event.key === "Delete" || event.key === "Backspace";
    if (isDeleteKey && isEditablePasteTarget(event.target)) return;
    if (isDeleteKey && this.selected.size > 0) {
      event.preventDefault();
      void this.removeSelectedObjectsFromCanvas();
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
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      this.selected = new Set([
        ...this.allViewObjects().map((object) => object.key),
        ...this.host.getGroups().map((group) => `group:${group.id}`),
        ...this.host.getArrows().map((arrow) => `arrow:${arrow.id}`),
      ]);
      this.selectedGroupId = null;
      this.clearArrowSelection();
      this.syncSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "g") {
      event.preventDefault();
      this.ungroupSelectedObjects();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "g") {
      event.preventDefault();
      this.groupSelectedObjects();
    }
  }

  private onCanvasContextMenu(event: MouseEvent): void {
    const target = event.target as HTMLElement;
    if (
      target.closest(".web-desk-icon") ||
      target.closest(".web-desk-group") ||
      target.closest(".web-desk-image") ||
      target.closest(".web-desk-rating") ||
      target.closest(".web-desk-object-selection")
    ) {
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
        .setTitle("新建区域")
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
        .setTitle("新建评分")
        .setIcon("star")
        .onClick(() => this.addRating(point)),
    );
    menu.addItem((item) =>
      item
        .setTitle("画箭头（点两点）")
        .setIcon("move-up-right")
        .onClick(() => this.beginArrowFromScratch()),
    );
    menu.addSeparator();
    this.appendObjectGroupMenu(menu);
    menu.addItem((item) =>
      item
        .setTitle("全选")
        .setIcon("box-select")
        .onClick(() => {
          this.selected = new Set([
            ...this.allViewObjects().map((object) => object.key),
            ...this.host.getGroups().map((group) => `group:${group.id}`),
            ...this.host.getArrows().map((arrow) => `arrow:${arrow.id}`),
          ]);
          this.selectedGroupId = null;
          this.clearArrowSelection();
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
    if (event.button !== 0 || (event.target as HTMLElement).closest(".web-desk-icon-resize")) {
      return;
    }
    if (this.interceptArrowClick(event)) {
      return;
    }
    this.onViewObjectPointerDown(event, card.path, el);
  }

  private onIconResizePointerDown(
    event: PointerEvent,
    card: BookmarkCard,
    el: HTMLElement,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.rootEl.focus();
    this.interactionLock += 1;
    const origin = { ...card };
    const originFrame = cardPlacementFrame(origin);
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([card.path])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.transform.zoom,
      resizing: true,
      onMove: ({ x: dx, y: dy }) => {
        const raw = resizeCardPlacement(origin, { x: dx, y: dy });
        const rawFrame = cardPlacementFrame(raw);
        const preview = origin.viewMode !== "icon";
        const dominantX = Math.abs(dx) >= Math.abs(dy);
        const snapped = snapSession.resize(
          { x: origin.x, y: origin.y, ...originFrame },
          { x: origin.x, y: origin.y, ...rawFrame },
          this.transform.zoom,
          preview ? undefined : { x: dominantX, y: !dominantX },
        );
        const delta = preview
          ? { x: snapped.rect.w - originFrame.w, y: snapped.rect.h - originFrame.h }
          : dominantX
            ? { x: snapped.rect.w - originFrame.w, y: 0 }
            : { x: 0, y: snapped.rect.h - originFrame.h };
        Object.assign(card, resizeCardPlacement(origin, delta));
        if (card.targetPath) updateFileCardFrame(el, card);
        else updateWebCardElementFrame(el, card);
        this.positionSelectionToolbar();
        const frame = cardPlacementFrame(card);
        this.snapGuideLayer?.show(
          snapGuidesMatchingRect({ x: card.x, y: card.y, ...frame }, snapped.guides),
          this.transform.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        if (!moved) {
          this.interactionLock -= 1;
          return;
        }
        this.roundViewObjectGeometry(this.allViewObjects().filter((object) => object.key === card.path));
        void this.persistIconSize(card).finally(() => {
          this.interactionLock -= 1;
        });
      },
    });
  }

  private cardShortcut(card: BookmarkCard): LocalShortcut {
    return { path: card.appPath, name: card.appName || card.title, kind: card.appKind };
  }

  private async activateCard(card: BookmarkCard): Promise<void> {
    if (card.appPath) {
      await launchLocalShortcutWithNotice(this.cardShortcut(card));
      return;
    }
    if (card.targetPath) {
      if (await this.isCanvasReference(card.targetPath)) {
        this.openCanvasReference(card.targetPath);
        return;
      }
      this.openMarkdown(card);
      return;
    }
    if (card.url) {
      window.open(card.url, "_blank");
      return;
    }
    this.openMarkdown(card);
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
    this.drilldown ??= new CanvasDrilldown({
      app: this.app,
      hostEl: this.rootEl,
      settings: this.settings,
      onSettingsChange: () => this.host.setBlockedEmbedHosts(this.settings.blockedEmbedHosts),
      originLabel: "网页桌面",
      resolveFavicon: this.host.resolveFavicon,
      resolveShortcutIcon: this.host.resolveShortcutIcon,
    });
    void this.drilldown.open(path);
  }

  private async persistDragged(cards: BookmarkCard[]): Promise<void> {
    this.interactionLock += 1;
    try {
      for (const card of cards) {
        const file = this.app.vault.getAbstractFileByPath(card.path);
        if (!(file instanceof TFile)) {
          continue;
        }
        const frame = cardPlacementFrame(card);
        const group = this.groupAt(card.x + frame.w / 2, card.y + frame.h / 2);
        card.group = group;
        await writeDeskFields(this.app, file, {
          x: card.x,
          y: card.y,
          group: group || null,
        });
        this.recordCardLayoutWrite(card);
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

    this.ensureObjectSelection(card.path);

    const menu = new Menu();

    if (card.targetPath) {
      if (this.canvasFileCache.get(card.targetPath)?.isCanvas) {
        menu.addItem((item) => item
          .setTitle("进入画布")
          .setIcon("panels-top-left")
          .onClick(() => this.openCanvasReference(card.targetPath)));
      }
      menu.addItem((item) => item
        .setTitle("在标签页打开")
        .setIcon("external-link")
        .onClick(() => this.openMarkdown(card)));
      if (supportsCanvasFilePreview(card.targetPath)) {
        menu.addItem((item) => item
          .setTitle("全屏预览")
          .setIcon("maximize-2")
          .onClick(() => this.previewCanvasFile(card.targetPath)));
        menu.addItem((item) => item
          .setTitle("切换展示方式")
          .setIcon("panels-top-left")
          .onClick(() => this.showCardModeMenu(card, this.iconEls.get(card.path) ?? this.rootEl)));
      }
      menu.addItem((item) => item
        .setTitle("复制双链")
        .setIcon("copy")
        .onClick(() => {
          const target = this.app.vault.getAbstractFileByPath(card.targetPath);
          if (target instanceof TFile) {
            void navigator.clipboard.writeText(this.app.fileManager.generateMarkdownLink(target, card.path));
            new Notice("已复制双链");
          }
        }));
    } else if (card.appPath) {
      const shortcut = this.cardShortcut(card);
      menu.addItem((item) => item
        .setTitle("启动")
        .setIcon("play")
        .onClick(() => void launchLocalShortcutWithNotice(shortcut)));
      menu.addItem((item) => item
        .setTitle("在 Finder 中显示")
        .setIcon("folder-open")
        .onClick(() => revealLocalShortcut(shortcut)));
      menu.addItem((item) => item
        .setTitle("复制路径")
        .setIcon("copy")
        .onClick(() => {
          void navigator.clipboard.writeText(shortcut.path);
          new Notice("已复制路径");
        }));
      menu.addItem((item) => item
        .setTitle("打开 Markdown")
        .setIcon("file-text")
        .onClick(() => this.openMarkdown(card)));
      menu.addItem((item) => item
        .setTitle("编辑名称、评分与备注…")
        .setIcon("square-pen")
        .onClick(() => this.editWebCardProperties(card)));
    } else {
      menu.addItem((item) => item
        .setTitle("打开网页")
        .setIcon("external-link")
        .onClick(() => {
          if (card.url) window.open(card.url, "_blank");
          else new Notice("该收藏没有 url 元信息");
        }));
      menu.addItem((item) => item
        .setTitle("打开 Markdown")
        .setIcon("file-text")
        .onClick(() => this.openMarkdown(card)));
      menu.addItem((item) => item
        .setTitle("复制链接")
        .setIcon("copy")
        .onClick(() => {
          if (card.url) {
            void navigator.clipboard.writeText(card.url);
            new Notice("已复制链接");
          }
        }));
      menu.addItem((item) => item
        .setTitle("编辑名称、评分与备注…")
        .setIcon("square-pen")
        .onClick(() => this.editWebCardProperties(card)));
      menu.addItem((item) => item
        .setTitle(card.viewMode === "preview" ? "显示为图标" : "显示为预览卡片")
        .setIcon(card.viewMode === "preview" ? "app-window" : "panel-top")
        .onClick(() => void this.setCardViewMode(card, card.viewMode === "preview" ? "icon" : "preview")));
    }
    menu.addItem((item) =>
      item
        .setTitle("从这里画箭头")
        .setIcon("move-up-right")
        .onClick(() => this.beginArrowDraft({ kind: "card", ref: card.path })),
    );
    if (card.targetPath) {
      menu.addItem((item) => item
        .setTitle("为此文件添加评分")
        .setIcon("star")
        .onClick(() => {
          const frame = cardPlacementFrame(card);
          this.addRating({ x: card.x + frame.w + 128, y: card.y + frame.h / 2 }, card);
        }));
    }
    menu.addSeparator();

    if (card.viewMode !== "icon") {
      menu.addItem((item) => item
        .setTitle("恢复默认预览尺寸")
        .setIcon("scaling")
        .onClick(() => void this.setDefaultPreviewSize(card)));
    } else {
      menu.addItem((item) => item.setTitle(`图标大小：小（${SIZE_SMALL}px）`).setIcon("minimize-2").onClick(() => void this.setIconSize(card, SIZE_SMALL)));
      menu.addItem((item) => item.setTitle(`图标大小：中（${SIZE_MEDIUM}px）`).setIcon("square").onClick(() => void this.setIconSize(card, SIZE_MEDIUM)));
      menu.addItem((item) => item.setTitle(`图标大小：大（${SIZE_LARGE}px）`).setIcon("maximize-2").onClick(() => void this.setIconSize(card, SIZE_LARGE)));
      menu.addItem((item) => item
        .setTitle("图标大小：自定义…")
        .setIcon("scaling")
        .onClick(() => {
          new TextInputModal(this.app, {
            title: "图标大小（像素）",
            initial: String(card.size),
            placeholder: "32 ~ 320",
            onSubmit: (value) => {
              const size = Number(value);
              if (Number.isFinite(size) && size >= 32 && size <= 320) void this.setIconSize(card, size);
              else new Notice("请输入 32 ~ 320 之间的数字");
            },
          }).open();
        }));
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("移出画布")
        .setIcon("square-minus")
        .onClick(() => void this.removeFromDesk(card)),
    );
    menu.addItem((item) =>
      item
        .setTitle("删除收藏文件…")
        .setIcon("trash-2")
        .onClick(() => this.confirmDelete(card)),
    );

    menu.addSeparator();
    this.appendObjectGroupMenu(menu);

    menu.showAtMouseEvent(event);
  }

  private async setIconSize(card: BookmarkCard, size: number): Promise<void> {
    card.size = size;
    await this.persistIconSize(card);
    this.render();
  }

  private async setCardViewMode(card: BookmarkCard, mode: CardViewMode, retry = false): Promise<void> {
    if (card.appPath) return;
    if (mode === "embed" && !card.targetPath) {
      const statusId = `embed:${card.path}`;
      const pending: PendingWebCard = {
        id: statusId,
        purpose: "embed",
        url: card.url,
        x: card.x,
        y: card.y,
        state: "loading",
        title: "正在检查实时嵌入",
        message: "正在读取网站的嵌入权限…",
      };
      this.pendingImports.set(statusId, pending);
      this.render();
      const assessment = await assessRemoteEmbed(card.url, retry ? [] : this.settings.blockedEmbedHosts);
      if (!assessment.allowed) {
        if (assessment.reason === "x-frame-options" || assessment.reason === "frame-ancestors") {
          this.host.setBlockedEmbedHosts(
            rememberBlockedEmbedHost(this.settings.blockedEmbedHosts, card.url),
          );
        }
        pending.state = "error";
        pending.title = "无法实时嵌入";
        pending.message = assessment.reason === "invalid-url"
          ? "实时嵌入只支持 HTTPS 网页"
          : "网站禁止 iframe 嵌入，已保留卡片视图";
        this.render();
        if (card.viewMode === "embed") mode = "preview";
        else return;
      } else {
        this.pendingImports.delete(statusId);
      }
    }
    Object.assign(card, switchCardViewMode(card, mode));
    await this.persistCardPlacement(card, { viewMode: mode === "icon" ? null : mode });
    this.render();
  }

  private async persistCardCaption(card: BookmarkCard, value: string): Promise<void> {
    const caption = normalizeCardCaption(value);
    const file = this.app.vault.getAbstractFileByPath(card.path);
    this.editingCaptionPath = null;
    if (!(file instanceof TFile)) {
      new Notice("找不到这个收藏对应的 Markdown 文件");
      return;
    }
    this.interactionLock += 1;
    try {
      await processFrontmatterSerially(this.app, file, (frontmatter: Record<string, unknown>) => {
        applyCardCaptionToFrontmatter(frontmatter, caption);
      });
      card.caption = caption;
      this.cardCaptionWrites.set(card.path, { caption, at: Date.now() });
      this.render();
    } catch (error) {
      new Notice(`保存 Caption 失败：${getErrorMessage(error)}`, 5000);
    } finally {
      this.interactionLock -= 1;
    }
  }

  private async setDefaultPreviewSize(card: BookmarkCard): Promise<void> {
    card.previewWidth = DEFAULT_PREVIEW_WIDTH;
    card.previewHeight = DEFAULT_PREVIEW_HEIGHT;
    await this.persistCardPlacement(card);
    this.render();
  }

  private editWebCardProperties(card: BookmarkCard): void {
    new CardPropertiesModal(this.app, {
      initial: { title: card.title, rating: card.rating, note: card.note },
      onSubmit: (properties) => void this.persistWebCardProperties(card, properties),
    }).open();
  }

  private async persistWebCardProperties(
    card: BookmarkCard,
    properties: CardProperties,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (!(file instanceof TFile)) {
      new Notice("找不到这个收藏对应的 Markdown 文件");
      return;
    }
    this.interactionLock += 1;
    try {
      await processFrontmatterSerially(this.app, file, (frontmatter: Record<string, unknown>) => {
        applyCardPropertiesToFrontmatter(frontmatter, properties);
      });
      this.cardPropertyWrites.set(card.path, { properties: { ...properties }, at: Date.now() });
      card.title = properties.title;
      card.rating = properties.rating;
      card.note = properties.note;
      this.render();
      new Notice("网页属性已保存");
    } catch (error) {
      new Notice(`保存网页属性失败：${getErrorMessage(error)}`, 5000);
    } finally {
      this.interactionLock -= 1;
    }
  }

  private async persistIconSize(card: BookmarkCard): Promise<void> {
    await this.persistCardPlacement(card);
  }

  private async persistCardPlacement(
    card: BookmarkCard,
    extra: { viewMode?: CardViewMode | null; cardStyle?: CardStyle | null } = {},
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (file instanceof TFile) {
      await writeDeskFields(this.app, file, {
        x: card.x,
        y: card.y,
        size: card.size,
        previewWidth: card.previewWidth,
        previewHeight: card.previewHeight,
        ...extra,
      });
    }
    this.recordCardLayoutWrite(card);
  }

  private recordCardLayoutWrite(card: BookmarkCard): void {
    this.layoutWrites.set(card.path, {
      x: card.x,
      y: card.y,
      size: card.size,
      group: card.group,
      objectGroup: card.objectGroup,
      viewMode: card.viewMode,
      cardStyle: card.cardStyle,
      previewWidth: card.previewWidth,
      previewHeight: card.previewHeight,
      at: Date.now(),
    });
  }

  private async removeFromDesk(card: BookmarkCard): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(card.path);
    if (file instanceof TFile) {
      await writeDeskFields(this.app, file, {
        x: null, y: null, size: null, group: null, objectGroup: null,
        viewMode: null, cardStyle: null, previewWidth: null, previewHeight: null,
        hidden: true,
      });
    }
    this.hiddenWrites.set(card.path, Date.now());
    this.selected.delete(card.path);
    await this.refresh();
    new Notice("已移出画布（文件保留在收藏夹文件夹）");
  }

  private confirmDelete(card: BookmarkCard): void {
    const selectedPaths = this.selectedCardPaths();
    const paths = this.selected.has(card.path) ? selectedPaths : [card.path];
    new ConfirmModal(this.app, {
      message: card.targetPath && paths.length === 1
        ? "删除这个文件卡片？（只移除卡片，原笔记不会被删除）"
        : `删除 ${paths.length} 个收藏的 md 文件？（移入仓库回收站，图标随之消失）`,
      okLabel: "删除",
      onOk: () => void this.deleteFiles(paths),
    }).open();
  }

  private selectedCardPaths(): string[] {
    const available = new Set(this.cards.map((card) => card.path));
    return [...this.selected].filter((key) => available.has(key));
  }

  private async removeSelectedObjectsFromCanvas(): Promise<void> {
    const plan = planCanvasObjectDeletion([
      ...this.allViewObjects(),
      ...this.host.getGroups().map((group) => ({ key: `group:${group.id}`, kind: "group" as const, id: group.id })),
      ...this.host.getArrows().map((arrow) => ({ key: `arrow:${arrow.id}`, kind: "arrow" as const, id: arrow.id })),
    ], this.selected);
    const count = plan.cardIds.length + plan.imageIds.length + plan.textBoxIds.length +
      plan.ratingIds.length + plan.groupIds.length + plan.arrowIds.length;
    if (count === 0) return;

    const cardIds = new Set(plan.cardIds);
    const imageIds = new Set(plan.imageIds);
    const textBoxIds = new Set(plan.textBoxIds);
    const ratingIds = new Set(plan.ratingIds);
    const groupIds = new Set(plan.groupIds);
    const arrowIds = new Set(plan.arrowIds);
    this.interactionLock += 1;
    try {
      const removedGroups = this.host.getGroups().filter((group) => groupIds.has(group.id));
      const removedGroupNames = new Set(removedGroups.map((group) => group.name));
      this.cards = this.cards.filter((card) => !cardIds.has(card.path));
      const images = this.host.getImages().filter((image) => !imageIds.has(image.id));
      const textBoxes = this.host.getTextBoxes().filter((box) => !textBoxIds.has(box.id));
      const ratings = this.host.getRatings().filter((rating) => !ratingIds.has(rating.id));
      for (const name of removedGroupNames) {
        clearGroupMembership(images, name);
        clearGroupMembership(textBoxes, name);
        clearGroupMembership(ratings, name);
      }
      this.host.setImages(images);
      this.host.setTextBoxes(textBoxes);
      this.host.setRatings(ratings);
      this.host.setGroups(this.host.getGroups().filter((group) => !groupIds.has(group.id)));
      let arrows = this.host.getArrows().filter((arrow) => !arrowIds.has(arrow.id));
      for (const cardId of cardIds) arrows = arrowsWithoutEndpoint(arrows, { kind: "card", ref: cardId });
      for (const textBoxId of textBoxIds) arrows = arrowsWithoutEndpoint(arrows, { kind: "textbox", ref: textBoxId });
      for (const groupId of groupIds) arrows = arrowsWithoutEndpoint(arrows, { kind: "group", ref: groupId });
      this.host.setArrows(arrows);
      this.selected.clear();
      this.selectedGroupId = null;
      this.clearArrowSelection();
      this.syncSelection();
      this.render();

      for (const cardId of cardIds) {
        const file = this.app.vault.getAbstractFileByPath(cardId);
        if (!(file instanceof TFile)) continue;
        await writeDeskFields(this.app, file, {
          x: null, y: null, size: null, group: null, objectGroup: null,
          viewMode: null, cardStyle: null, previewWidth: null, previewHeight: null,
          hidden: true,
        });
        this.hiddenWrites.set(cardId, Date.now());
        this.layoutWrites.delete(cardId);
      }
      for (const card of this.cards) {
        if (!removedGroupNames.has(card.group)) continue;
        card.group = "";
        const file = this.app.vault.getAbstractFileByPath(card.path);
        if (!(file instanceof TFile)) continue;
        await writeDeskFields(this.app, file, { group: null });
        this.recordCardLayoutWrite(card);
      }
    } catch (error) {
      new Notice(`移出画布失败：${getErrorMessage(error)}`, 5000);
    } finally {
      this.interactionLock -= 1;
    }
    await this.refresh();
    new Notice(`已从画布移除 ${count} 个元素`);
  }

  private removeSelectedGroupFromCanvas(): void {
    const group = this.host.getGroups().find((entry) => entry.id === this.selectedGroupId);
    if (!group) return;
    this.host.setGroups(this.host.getGroups().filter((entry) => entry.id !== group.id));
    this.host.setArrows(arrowsWithoutEndpoint(this.host.getArrows(), { kind: "group", ref: group.id }));
    this.selectedGroupId = null;
    void this.clearGroupMembership(group.name);
    this.render();
    new Notice("已从画布移除区域，区域内元素仍保留在画布上");
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
    const file = this.app.vault.getAbstractFileByPath(card.targetPath || card.path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf("tab").openFile(file);
    } else if (card.targetPath) {
      new Notice("原笔记已不存在");
    }
  }

  private triggerFileHover(event: MouseEvent, targetEl: HTMLElement, linktext: string, sourcePath: string): void {
    this.app.workspace.trigger("hover-link", {
      event,
      source: "web-desk",
      hoverParent: this,
      targetEl,
      linktext,
      sourcePath,
    });
  }

  private syncSelection(): void {
    for (const [path, el] of this.iconEls) {
      el.toggleClass("is-selected", this.selected.has(path));
    }
    for (const [id, el] of this.imageEls) {
      el.toggleClass("is-selected", this.selected.has(objectKey("image", id)));
    }
    for (const [id, el] of this.textBoxEls) {
      el.toggleClass("is-selected", this.selected.has(objectKey("textbox", id)));
    }
    for (const [id, el] of this.ratingEls) {
      el.toggleClass("is-selected", this.selected.has(objectKey("rating", id)));
    }
    for (const [id, el] of this.groupEls) {
      el.toggleClass("is-selected", id === this.selectedGroupId || this.selected.has(`group:${id}`));
    }
    this.renderArrows();
    this.renderObjectSelection();
    this.renderSelectionToolbar();
  }

  private renderSelectionToolbar(): void {
    this.selectionToolbarEl?.remove();
    this.selectionToolbarEl = null;
    if (this.selectedArrowId) {
      const arrow = this.host.getArrows().find((entry) => entry.id === this.selectedArrowId);
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
      const group = this.host.getGroups().find((entry) => entry.id === this.selectedGroupId);
      const target = group ? this.groupEls.get(group.id) : null;
      if (!group || !target) return;
      this.selectionToolbarEl = createCanvasObjectToolbar(this.rootEl, { icon: "square-dashed", label: "区域" }, [
        { icon: "pencil", label: "重命名区域", onClick: () => this.renameGroup(group) },
        { icon: "paintbrush", label: "设置区域外观", onClick: (button) => showCanvasContainerAppearanceMenu(this.app, button, group, () => {
          this.host.setGroups(this.host.getGroups());
          this.render();
        }) },
        { icon: "ellipsis", label: "更多区域操作", onClick: (button) => this.dispatchContextMenu(target, button) },
      ]);
      window.requestAnimationFrame(() => this.positionSelectionToolbar());
      return;
    }
    if (this.selected.size !== 1) return;
    const [path] = this.selected;
    const card = this.cards.find((entry) => entry.path === path);
    let target = card ? this.iconEls.get(card.path) : null;
    let identity = { icon: "layout-grid", label: "元素" };
    const actions: CanvasToolbarAction[] = [];
    if (card && target) {
      const isCanvasReference = Boolean(card.targetPath && this.canvasFileCache.get(card.targetPath)?.isCanvas);
      const fileKind = card.targetPath ? canvasFileKind(card.targetPath) : null;
      identity = card.appPath
        ? { icon: shortcutKindIcon(card.appKind), label: shortcutKindLabel(card.appKind) }
        : isCanvasReference
          ? { icon: "panels-top-left", label: "画布" }
          : card.targetPath
            ? { icon: fileKind === "pdf" ? "file-type-2" : "file-text", label: canvasFileKindLabel(card.targetPath) }
            : { icon: "globe-2", label: "网页" };
      actions.push({
        icon: card.appPath ? "play" : isCanvasReference ? "corner-down-right" : "external-link",
        label: card.appPath ? "启动" : isCanvasReference ? "进入画布" : card.targetPath ? "打开笔记" : "打开网页",
        onClick: () => { void this.activateCard(card); },
      });
      if (card.appPath) {
        actions.push(
          { icon: "folder-open", label: "在 Finder 中显示", onClick: () => revealLocalShortcut(this.cardShortcut(card)) },
          { icon: "square-pen", label: "编辑名称、评分与备注", onClick: () => this.editWebCardProperties(card) },
        );
      } else if (card.targetPath && !isCanvasReference && supportsCanvasFilePreview(card.targetPath)) {
        actions.push(
          { icon: "maximize-2", label: "全屏预览", onClick: () => this.previewCanvasFile(card.targetPath) },
          { icon: "panels-top-left", label: "切换展示方式", text: card.viewMode === "embed" ? "嵌入" : card.viewMode === "preview" ? "卡片" : "图标", onClick: (button) => this.showCardModeMenu(card, button) },
        );
      } else if (!card.targetPath) {
        actions.push(
          { icon: "square-pen", label: "编辑名称、评分与备注", onClick: () => this.editWebCardProperties(card) },
          { icon: "panels-top-left", label: "切换展示方式", text: card.viewMode === "embed" ? "嵌入" : card.viewMode === "preview" ? cardStyleLabel(card.cardStyle) : "图标", onClick: (button) => this.showCardModeMenu(card, button) },
          { icon: "captions", label: "编辑 Caption", onClick: () => { this.editingCaptionPath = card.path; this.render(); } },
        );
      }
      actions.push({ icon: "ellipsis", label: "更多操作", separatorBefore: true, onClick: (button) => this.dispatchContextMenu(target!, button) });
    } else {
      const parsed = splitObjectKey(path);
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
        const box = this.host.getTextBoxes().find((entry) => entry.id === parsed.id);
        if (box) actions.push({ icon: "paintbrush", label: "设置文本外观", onClick: (button) => showCanvasContainerAppearanceMenu(this.app, button, box, () => {
          this.host.setTextBoxes(this.host.getTextBoxes());
          this.render();
        }) });
      }
      actions.push({ icon: "ellipsis", label: "更多操作", onClick: (button) => this.dispatchContextMenu(target!, button) });
    }
    this.selectionToolbarEl = createCanvasObjectToolbar(this.rootEl, identity, actions);
    window.requestAnimationFrame(() => this.positionSelectionToolbar());
  }

  private showCardModeMenu(card: BookmarkCard, trigger: HTMLElement): void {
    const menu = new Menu();
    const modes: Array<{ mode: CardViewMode; label: string; icon: string }> = [
      { mode: "icon", label: "图标", icon: "layout-grid" },
      { mode: "preview", label: "卡片", icon: "panel-top" },
      {
        mode: "embed",
        label: card.targetPath
          ? "嵌入阅读"
          : isRememberedBlockedHost(this.settings.blockedEmbedHosts, card.url)
          ? "重新尝试实时嵌入（实验）"
          : "实时嵌入（实验）",
        icon: "app-window",
      },
    ];
    for (const entry of modes) {
      menu.addItem((item) => item
        .setTitle(entry.label)
        .setIcon(entry.icon)
        .setChecked(card.viewMode === entry.mode)
        .onClick(() => void this.setCardViewMode(card, entry.mode, entry.mode === "embed")));
    }
    if (!card.targetPath) {
      menu.addSeparator();
      for (const style of ["visual", "article", "compact"] as CardStyle[]) {
        menu.addItem((item) => item
          .setTitle(`卡片 · ${cardStyleLabel(style)}`)
          .setIcon(style === "visual" ? "image" : style === "compact" ? "rows-3" : "newspaper")
          .setChecked(card.viewMode === "preview" && normalizeCardStyle(card.cardStyle) === style)
          .onClick(() => void this.setCardStyle(card, style)));
      }
    }
    const rect = trigger.getBoundingClientRect();
    menu.setParentElement(this.rootEl).setUseNativeMenu(false).showAtPosition({ x: rect.left, y: rect.bottom + 6 }, trigger.ownerDocument);
  }

  private async setCardStyle(card: BookmarkCard, style: CardStyle): Promise<void> {
    card.cardStyle = style;
    if (card.viewMode !== "preview") Object.assign(card, switchCardViewMode(card, "preview"));
    await this.persistCardPlacement(card, { viewMode: "preview", cardStyle: style });
    this.render();
  }

  private selectionTarget(): HTMLElement | null {
    if (this.selected.size !== 1) return null;
    const [key] = this.selected;
    if (this.iconEls.has(key)) return this.iconEls.get(key) ?? null;
    const parsed = splitObjectKey(key);
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
    const image = this.host.getImages().find((entry) => entry.id === id);
    const file = image ? this.app.vault.getAbstractFileByPath(image.path) : null;
    if (file instanceof TFile) void this.app.workspace.getLeaf("tab").openFile(file);
  }

  private showCreateMenu(trigger: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("收藏 URL…").setIcon("link-2").onClick(() => this.promptForUrl(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("插入 Markdown / PDF…").setIcon("file-plus-2").onClick(() => this.choosePreviewFile(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("引用其它画布…").setIcon("panels-top-left").onClick(() => this.chooseCanvasReference(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("新建文本框").setIcon("sticky-note").onClick(() => {
      const point = this.visibleCenter();
      this.addTextBox(point.x - 130, point.y - 60);
    }));
    menu.addItem((item) => item.setTitle("新建区域").setIcon("square-dashed").onClick(() => this.createGroupAt(this.visibleCenter())));
    this.showMenuBelow(menu, trigger);
  }

  private choosePreviewFile(point: Point): void {
    new PreviewFileSuggestModal(this.app, "", (file) => {
      void this.importMarkdownFiles([file], point);
    }).open();
  }

  private chooseCanvasReference(point: Point): void {
    new CanvasFileSuggestModal(this.app, "", (file) => {
      void resolveCanvasReference(this.app, file.path).then((canvas) => {
        if (!canvas) {
          new Notice("这篇笔记里没有可用的网页收藏画布");
          return;
        }
        this.canvasFileCache.set(file.path, { isCanvas: true, mtime: file.stat.mtime });
        void this.importMarkdownFiles([file], point);
      });
    }).open();
  }

  private showCreateMoreMenu(trigger: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("新建评分").setIcon("star").onClick(() => this.addRating(this.visibleCenter())));
    menu.addItem((item) => item.setTitle("画箭头（点两点）").setIcon("move-up-right").onClick(() => this.beginArrowFromScratch()));
    menu.addItem((item) => item.setTitle("适应内容").setIcon("maximize").onClick(() => this.fitContent()));
    this.showMenuBelow(menu, trigger);
  }

  private showMenuBelow(menu: Menu, trigger: HTMLElement): void {
    const rect = trigger.getBoundingClientRect();
    menu.setParentElement(this.rootEl).setUseNativeMenu(false).showAtPosition({ x: rect.right + 8, y: rect.top }, trigger.ownerDocument);
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

  private allViewObjects(): ViewObject[] {
    return [
      ...this.cards.map((card) => {
        const frame = cardPlacementFrame(card);
        return {
          key: card.path,
          kind: "card" as const,
          id: card.path,
          group: card.group,
          objectGroup: card.objectGroup,
          x: card.x,
          y: card.y,
          w: frame.w,
          h: frame.h,
          minW: card.viewMode !== "icon" ? 220 : 56,
          minH: card.viewMode !== "icon" ? 160 : 76,
          maxW: card.viewMode !== "icon" ? 720 : 344,
          maxH: card.viewMode !== "icon" ? 640 : 364,
        };
      }),
      ...this.host.getImages().map((image) => ({
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
      ...this.host.getTextBoxes().map((box) => ({
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
      ...this.host.getRatings().map((rating) => {
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
      ...this.allViewObjects()
        .filter((object) => !excluded.has(object.key))
        .map(({ key, x, y, w, h }) => ({ key, x, y, w, h })),
      ...this.host.getGroups()
        .filter((group) => !excluded.has(`group:${group.id}`))
        .map((group) => ({ key: `group:${group.id}`, x: group.x, y: group.y, w: group.w, h: group.h })),
    ];
  }

  /** Presentation values stay continuous; only the commit boundary is quantized. */
  private roundViewObjectGeometry(objects: ViewObject[]): void {
    for (const object of objects) {
      this.applyObjectPosition(object.key, Math.round(object.x), Math.round(object.y));
      if (object.kind === "card") {
        const card = this.cards.find((entry) => entry.path === object.id);
        if (!card) continue;
        card.size = Math.round(card.size);
        if (card.previewWidth !== undefined) card.previewWidth = Math.round(card.previewWidth);
        if (card.previewHeight !== undefined) card.previewHeight = Math.round(card.previewHeight);
        const el = this.iconEls.get(object.id);
        if (el) {
          if (card.targetPath) updateFileCardFrame(el, card);
          else updateWebCardElementFrame(el, card);
        }
      } else if (object.kind === "image") {
        const image = this.host.getImages().find((entry) => entry.id === object.id);
        if (!image) continue;
        image.w = Math.round(image.w);
        image.h = Math.round(image.h);
        const el = this.imageEls.get(object.id);
        if (el) { el.style.width = `${image.w}px`; el.style.height = `${image.h}px`; }
      } else if (object.kind === "textbox") {
        const box = this.host.getTextBoxes().find((entry) => entry.id === object.id);
        if (!box) continue;
        box.w = Math.round(box.w);
        box.h = Math.round(box.h);
        const el = this.textBoxEls.get(object.id);
        if (el) { el.style.width = `${box.w}px`; el.style.height = `${box.h}px`; }
      } else {
        const rating = this.host.getRatings().find((entry) => entry.id === object.id);
        if (!rating) continue;
        rating.scale = Math.round((rating.scale ?? 1) * 1000) / 1000;
        const el = this.ratingEls.get(object.id);
        if (el) el.style.transform = `scale(${rating.scale})`;
      }
    }
    this.renderArrows();
    this.updateObjectSelectionFrame();
  }

  private selectedViewObjects(): ViewObject[] {
    return this.allViewObjects().filter((object) => this.selected.has(object.key));
  }

  private selectObject(key: string, additive: boolean): void {
    this.selectedGroupId = null;
    const object = this.allViewObjects().find((entry) => entry.key === key);
    if (!object) return;
    const keys = object.objectGroup
      ? this.allViewObjects().filter((entry) => entry.objectGroup === object.objectGroup).map((entry) => entry.key)
      : [key];
    if (!additive) this.selected.clear();
    const remove = additive && keys.every((entry) => this.selected.has(entry));
    for (const entry of keys) {
      if (remove) this.selected.delete(entry);
      else this.selected.add(entry);
    }
    this.clearArrowSelection();
    this.syncSelection();
  }

  private ensureObjectSelection(key: string): void {
    this.selectedGroupId = null;
    if (!this.selected.has(key)) this.selectObject(key, false);
  }

  private objectElement(object: ViewObject): HTMLElement | undefined {
    if (object.kind === "card") return this.iconEls.get(object.id);
    if (object.kind === "image") return this.imageEls.get(object.id);
    if (object.kind === "textbox") return this.textBoxEls.get(object.id);
    return this.ratingEls.get(object.id);
  }

  private applyObjectPosition(key: string, x: number, y: number): void {
    const parsed = splitObjectKey(key);
    if (!parsed) {
      const card = this.cards.find((entry) => entry.path === key);
      if (card) { card.x = x; card.y = y; }
      const el = this.iconEls.get(key);
      if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
      this.positionSelectionToolbar();
      return;
    }
    const collection = parsed.kind === "image"
      ? this.host.getImages()
      : parsed.kind === "textbox"
        ? this.host.getTextBoxes()
        : parsed.kind === "rating"
          ? this.host.getRatings()
          : [];
    const item = collection.find((entry) => entry.id === parsed.id);
    if (item) { item.x = x; item.y = y; }
    const object = this.allViewObjects().find((entry) => entry.key === key);
    const el = object ? this.objectElement(object) : undefined;
    if (el) { el.style.left = `${x}px`; el.style.top = `${y}px`; }
    this.positionSelectionToolbar();
  }

  private setObjectArea(key: string, areaName: string): void {
    const parsed = splitObjectKey(key);
    if (!parsed) {
      const card = this.cards.find((entry) => entry.path === key);
      if (card) card.group = areaName;
      return;
    }
    if (parsed.kind === "image") {
      const image = this.host.getImages().find((entry) => entry.id === parsed.id);
      if (image) image.group = areaName || undefined;
      return;
    }
    if (parsed.kind === "textbox") {
      const box = this.host.getTextBoxes().find((entry) => entry.id === parsed.id);
      if (box) box.group = areaName || undefined;
      return;
    }
    if (parsed.kind === "rating") {
      const rating = this.host.getRatings().find((entry) => entry.id === parsed.id);
      if (rating) rating.group = areaName || undefined;
    }
  }

  private updateAreaMembership(objects: ViewObject[]): ViewObject[] {
    const previous = new Map(objects.map((object) => [object.key, object.group]));
    recomputeGroupMembership(objects, this.host.getGroups());
    const changed = objects.filter((object) => previous.get(object.key) !== object.group);
    for (const object of changed) this.setObjectArea(object.key, object.group);
    return changed;
  }

  private showAreaDropTargets(objects: ViewObject[]): void {
    const targets = new Set(objects.map((object) => this.groupAt(
      object.x + object.w / 2,
      object.y + object.h / 2,
    )).filter(Boolean));
    for (const group of this.host.getGroups()) {
      this.groupEls.get(group.id)?.toggleClass("is-drop-target", targets.has(group.name));
    }
  }

  private clearAreaDropTargets(): void {
    for (const el of this.groupEls.values()) el.removeClass("is-drop-target");
  }

  private applyObjectScale(origin: ViewObject, x: number, y: number, scale: number): void {
    this.applyObjectPosition(origin.key, x, y);
    if (origin.kind === "card") {
      const card = this.cards.find((entry) => entry.path === origin.id);
      if (!card) return;
      Object.assign(card, scaleCardPlacement(card, scale, { w: origin.w, h: origin.h }));
      const el = this.iconEls.get(origin.id);
      if (el) {
        if (card.targetPath) updateFileCardFrame(el, card);
        else updateWebCardElementFrame(el, card);
      }
      this.positionSelectionToolbar();
      return;
    }
    if (origin.kind === "image") {
      const image = this.host.getImages().find((entry) => entry.id === origin.id);
      if (!image) return;
      image.w = origin.w * scale;
      image.h = origin.h * scale;
      const el = this.imageEls.get(origin.id);
      if (el) { el.style.width = `${image.w}px`; el.style.height = `${image.h}px`; }
      return;
    }
    if (origin.kind === "textbox") {
      const box = this.host.getTextBoxes().find((entry) => entry.id === origin.id);
      if (!box) return;
      box.w = origin.w * scale;
      box.h = origin.h * scale;
      const el = this.textBoxEls.get(origin.id);
      if (el) { el.style.width = `${box.w}px`; el.style.height = `${box.h}px`; }
      return;
    }
    const rating = this.host.getRatings().find((entry) => entry.id === origin.id);
    if (!rating) return;
    rating.scale = clamp((origin.w / RATING_WIDTH) * scale, 0.5, 3);
    const el = this.ratingEls.get(origin.id);
    if (el) el.style.transform = `scale(${rating.scale})`;
  }

  private renderObjectSelection(): void {
    this.objectSelectionEl?.remove();
    this.objectSelectionEl = null;
    const objects = this.selectedViewObjects();
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
      this.allViewObjects().filter((object) => object.objectGroup === groupId).length === objects.length;
    if (fullGroup) {
      const handle = el.createDiv({ cls: "web-desk-object-selection-resize" });
      handle.setAttribute("aria-label", "缩放组合");
      handle.addEventListener("pointerdown", (event) => this.onObjectGroupResizePointerDown(event, handle));
    } else {
      el.addClass("is-multiselect");
    }
    this.objectSelectionEl = el;
  }

  private onObjectGroupResizePointerDown(event: PointerEvent, handle: HTMLElement): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const origins = this.selectedViewObjects();
    const bounds = objectGroupBounds(origins);
    if (!bounds || origins.length < 2) return;
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set(origins.map((object) => object.key))));
    this.interactionLock += 1;
    beginCanvasPointerSession({
      event,
      element: handle,
      zoom: () => this.transform.zoom,
      resizing: true,
      onMove: (delta) => {
        const relativeX = delta.x / Math.max(bounds.w, 1);
        const relativeY = delta.y / Math.max(bounds.h, 1);
        const dominantX = Math.abs(relativeX) >= Math.abs(relativeY);
        const requested = 1 + (dominantX ? relativeX : relativeY);
        const raw = scaleObjectGroup(origins, requested);
        const rawBounds = objectGroupBounds(raw.objects);
        if (!rawBounds) return;
        const snapped = snapSession.resize(bounds, rawBounds, this.transform.zoom, {
          x: dominantX,
          y: !dominantX,
        });
        const snappedScale = dominantX ? snapped.rect.w / bounds.w : snapped.rect.h / bounds.h;
        const result = scaleObjectGroup(origins, snappedScale);
        result.objects.forEach((object, index) => {
          this.applyObjectScale(origins[index], object.x, object.y, result.scale);
        });
        const finalBounds = objectGroupBounds(result.objects);
        this.snapGuideLayer?.show(
          finalBounds ? snapGuidesMatchingRect(finalBounds, snapped.guides) : [],
          this.transform.zoom,
        );
        this.renderArrows();
        this.updateObjectSelectionFrame();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        this.interactionLock -= 1;
        if (moved) void this.persistScaledObjects(this.selectedViewObjects());
      },
    });
  }

  private updateObjectSelectionFrame(): void {
    if (!this.objectSelectionEl) return;
    const bounds = objectGroupBounds(this.selectedViewObjects());
    if (!bounds) return;
    this.objectSelectionEl.style.left = `${bounds.x}px`;
    this.objectSelectionEl.style.top = `${bounds.y}px`;
    this.objectSelectionEl.style.width = `${bounds.w}px`;
    this.objectSelectionEl.style.height = `${bounds.h}px`;
  }

  private async persistScaledObjects(objects: ViewObject[]): Promise<void> {
    this.roundViewObjectGeometry(objects);
    const keys = new Set(objects.map((object) => object.key));
    const freshObjects = this.allViewObjects().filter((object) => keys.has(object.key));
    this.updateAreaMembership(freshObjects);
    try {
      for (const object of freshObjects.filter((entry) => entry.kind === "card")) {
        const card = this.cards.find((entry) => entry.path === object.id);
        const file = this.app.vault.getAbstractFileByPath(object.id);
        if (!card || !(file instanceof TFile)) continue;
        await writeDeskFields(this.app, file, {
          x: card.x,
          y: card.y,
          size: card.size,
          previewWidth: card.previewWidth,
          previewHeight: card.previewHeight,
          group: card.group || null,
        });
        this.recordCardLayoutWrite(card);
      }
      if (freshObjects.some((entry) => entry.kind === "image")) this.host.setImages(this.host.getImages());
      if (freshObjects.some((entry) => entry.kind === "textbox")) this.host.setTextBoxes(this.host.getTextBoxes());
      if (freshObjects.some((entry) => entry.kind === "rating")) this.host.setRatings(this.host.getRatings());
    } catch (error) {
      new Notice(`保存组合缩放失败：${getErrorMessage(error)}`, 5000);
    }
    this.renderObjectSelection();
  }

  private async setSelectedObjectGroup(groupId: string): Promise<void> {
    const objects = this.selectedViewObjects();
    if (groupId && objects.length < 2) {
      new Notice("请先多选至少两个元素");
      return;
    }
    this.interactionLock += 1;
    try {
      for (const object of objects) {
        if (object.kind === "card") {
          const card = this.cards.find((entry) => entry.path === object.id);
          const file = this.app.vault.getAbstractFileByPath(object.id);
          if (!card || !(file instanceof TFile)) continue;
          card.objectGroup = groupId;
          await writeDeskFields(this.app, file, { objectGroup: groupId || null });
          this.recordCardLayoutWrite(card);
        } else if (object.kind === "image") {
          const image = this.host.getImages().find((entry) => entry.id === object.id);
          if (image) image.objectGroup = groupId || undefined;
        } else if (object.kind === "textbox") {
          const box = this.host.getTextBoxes().find((entry) => entry.id === object.id);
          if (box) box.objectGroup = groupId || undefined;
        } else {
          const rating = this.host.getRatings().find((entry) => entry.id === object.id);
          if (rating) rating.objectGroup = groupId || undefined;
        }
      }
      this.host.setImages(this.host.getImages());
      this.host.setTextBoxes(this.host.getTextBoxes());
      this.host.setRatings(this.host.getRatings());
    } catch (error) {
      new Notice(`保存组合失败：${getErrorMessage(error)}`, 5000);
    } finally {
      this.interactionLock -= 1;
    }
    this.render();
  }

  private groupSelectedObjects(): void {
    void this.setSelectedObjectGroup(`og${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`);
  }

  private ungroupSelectedObjects(): void {
    if (!this.selectedViewObjects().some((object) => object.objectGroup)) return;
    void this.setSelectedObjectGroup("");
  }

  private appendObjectGroupMenu(menu: Menu): void {
    const objects = this.selectedViewObjects();
    if (objects.length >= 2) {
      menu.addItem((item) => item.setTitle("组合所选元素").setIcon("combine").onClick(() => this.groupSelectedObjects()));
    }
    if (objects.some((object) => object.objectGroup)) {
      menu.addItem((item) => item.setTitle("取消组合").setIcon("ungroup").onClick(() => this.ungroupSelectedObjects()));
    }
  }

  private onViewObjectPointerDown(
    event: PointerEvent,
    key: string,
    el: HTMLElement,
    activate?: () => void,
  ): void {
    event.stopPropagation();
    this.rootEl.focus();
    this.selectedGroupId = null;
    if (event.shiftKey) {
      this.selectObject(key, true);
      return;
    }
    this.ensureObjectSelection(key);
    const origins = this.selectedViewObjects();
    const bounds = objectGroupBounds(origins);
    if (origins.length === 0 || !bounds) return;
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set(origins.map((object) => object.key))));
    this.interactionLock += 1;
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.transform.zoom,
      onMove: (delta) => {
        const snapped = snapSession.move(bounds, delta, this.transform.zoom);
        const translated = translateObjectGroup(origins, {
          x: snapped.rect.x - bounds.x,
          y: snapped.rect.y - bounds.y,
        });
        for (const object of translated) this.applyObjectPosition(object.key, object.x, object.y);
        this.showAreaDropTargets(translated);
        this.snapGuideLayer?.show(snapped.guides, this.transform.zoom);
        this.renderArrows();
        this.renderObjectSelection();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        this.clearAreaDropTargets();
        this.interactionLock -= 1;
        if (!moved) {
          activate?.();
          return;
        }
        void this.persistMovedObjects(this.selectedViewObjects());
      },
    });
  }

  private async persistMovedObjects(objects: ViewObject[], recomputeAllAreas = false): Promise<void> {
    this.roundViewObjectGeometry(objects);
    const movedKeys = new Set(objects.map((object) => object.key));
    const freshObjects = this.allViewObjects();
    const membershipScope = recomputeAllAreas
      ? freshObjects
      : freshObjects.filter((object) => movedKeys.has(object.key));
    const changed = this.updateAreaMembership(membershipScope);
    const affectedKeys = new Set([...movedKeys, ...changed.map((object) => object.key)]);
    const affected = this.allViewObjects().filter((object) => affectedKeys.has(object.key));
    const cards = affected
      .filter((object) => object.kind === "card")
      .map((object) => this.cards.find((card) => card.path === object.id))
      .filter((card): card is BookmarkCard => Boolean(card));
    if (cards.length > 0) await this.persistDragged(cards);
    if (affected.some((object) => object.kind === "image")) this.host.setImages(this.host.getImages());
    if (affected.some((object) => object.kind === "textbox")) this.host.setTextBoxes(this.host.getTextBoxes());
    if (affected.some((object) => object.kind === "rating")) this.host.setRatings(this.host.getRatings());
    this.renderObjectSelection();
  }

  // ---------- 分组 ----------

  private groupAt(cx: number, cy: number): string {
    return groupAtPoint(this.host.getGroups(), { x: cx, y: cy });
  }

  private createGroupAt(point: Point): void {
    const groups = this.host.getGroups();
    const group = createGroupBox({
      id: `g${Date.now().toString(36)}`,
      name: nextAvailableGroupName(groups.map((entry) => entry.name)),
      point,
      color: GROUP_COLORS[groups.length % GROUP_COLORS.length],
    });
    groups.push(group);
    this.editingGroupId = group.id;
    this.selected.clear();
    this.selectedGroupId = group.id;
    this.host.setGroups(groups);
    this.render();
    void this.persistMovedObjects([], true);
  }

  private onGroupPointerDown(event: PointerEvent, group: GroupBox): void {
    if (this.interceptArrowClick(event)) {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();
    this.rootEl.focus();
    this.selected.clear();
    this.selectedGroupId = group.id;
    this.clearArrowSelection();
    this.syncSelection();

    const el = this.groupEls.get(group.id);
    if (!el) {
      return;
    }

    this.interactionLock += 1;
    const originRect = { x: group.x, y: group.y, w: group.w, h: group.h };
    // 空间位置是区域归属的事实源；不依赖可能仍在等待 metadataCache 的 group 投影。
    const allObjects = this.allViewObjects();
    const memberOrigins = areaMembers(allObjects, this.host.getGroups(), group.name);
    const memberKeys = new Set(memberOrigins.map((object) => object.key));
    const excluded = new Set([`group:${group.id}`, ...memberKeys]);
    const snapSession = createCanvasSnapSession(this.snapTargets(excluded));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.transform.zoom,
      onMove: (delta) => {
        const snapped = snapSession.move(originRect, delta, this.transform.zoom);
        group.x = snapped.rect.x;
        group.y = snapped.rect.y;
        el.style.left = `${group.x}px`;
        el.style.top = `${group.y}px`;
        const translated = translateObjectGroup(memberOrigins, {
          x: snapped.rect.x - originRect.x,
          y: snapped.rect.y - originRect.y,
        });
        for (const object of translated) this.applyObjectPosition(object.key, object.x, object.y);
        this.positionSelectionToolbar();
        this.snapGuideLayer?.show(snapped.guides, this.transform.zoom);
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        this.interactionLock -= 1;
        if (moved) {
          group.x = Math.round(group.x);
          group.y = Math.round(group.y);
          el.style.left = `${group.x}px`;
          el.style.top = `${group.y}px`;
          this.host.setGroups(this.host.getGroups());
          const members = this.allViewObjects().filter((object) => memberKeys.has(object.key));
          void this.persistMovedObjects(members, true);
        }
      },
    });
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
    const origin = { w: group.w, h: group.h };
    const originRect = { x: group.x, y: group.y, w: group.w, h: group.h };
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([`group:${group.id}`])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.transform.zoom,
      resizing: true,
      onMove: (delta) => {
        const snapped = snapSession.resize(originRect, {
          ...originRect,
          w: Math.max(240, origin.w + delta.x),
          h: Math.max(180, origin.h + delta.y),
        }, this.transform.zoom);
        group.w = Math.max(240, snapped.rect.w);
        group.h = Math.max(180, snapped.rect.h);
        el.style.width = `${group.w}px`;
        el.style.height = `${group.h}px`;
        this.snapGuideLayer?.show(
          snapGuidesMatchingRect({ x: group.x, y: group.y, w: group.w, h: group.h }, snapped.guides),
          this.transform.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        this.interactionLock -= 1;
        if (moved) {
          group.w = Math.round(group.w);
          group.h = Math.round(group.h);
          el.style.width = `${group.w}px`;
          el.style.height = `${group.h}px`;
          this.host.setGroups(this.host.getGroups());
          void this.persistMovedObjects([], true);
        }
      },
    });
  }

  private onGroupContextMenu(event: MouseEvent, group: GroupBox): void {
    event.preventDefault();

    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("重命名区域")
        .setIcon("pencil")
        .onClick(() => this.renameGroup(group)),
    );
    menu.addItem((item) =>
      item
        .setTitle("从这里画箭头")
        .setIcon("move-up-right")
        .onClick(() => this.beginArrowDraft({ kind: "group", ref: group.id })),
    );

    menu.addSeparator();
    appendCanvasContainerAppearanceMenuItems(this.app, menu, group, () => {
      this.host.setGroups(this.host.getGroups());
      this.render();
    });
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle("删除区域（保留元素）")
        .setIcon("trash-2")
        .onClick(() => {
          const groups = this.host.getGroups().filter((entry) => entry.id !== group.id);
          this.host.setGroups(groups);
          this.host.setArrows(
            arrowsWithoutEndpoint(this.host.getArrows(), { kind: "group", ref: group.id }),
          );
          void this.clearGroupMembership(group.name);
          this.render();
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private renameGroup(group: GroupBox): void {
    const header = this.groupEls.get(group.id)?.querySelector<HTMLElement>(".web-desk-group-header");
    if (header) this.editGroupName(group, header);
  }

  private editGroupName(group: GroupBox, header: HTMLElement): void {
    if (this.editingGroupId && this.editingGroupId !== group.id) return;
    this.editingGroupId = group.id;
    beginInlineGroupNameEdit(header, {
      initial: group.name,
      onCommit: (name) => {
        this.editingGroupId = null;
        if (name !== group.name) void this.applyGroupRename(group, name);
      },
      onCancel: () => {
        this.editingGroupId = null;
      },
    });
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
      renameGroupMembership(this.host.getImages(), oldName, name);
      renameGroupMembership(this.host.getTextBoxes(), oldName, name);
      renameGroupMembership(this.host.getRatings(), oldName, name);
      for (const card of this.cards) {
        if (card.group === oldName) {
          card.group = name;
          const file = this.app.vault.getAbstractFileByPath(card.path);
          if (file instanceof TFile) {
            await writeDeskFields(this.app, file, { group: name });
          }
        }
      }
      this.host.setImages(this.host.getImages());
      this.host.setTextBoxes(this.host.getTextBoxes());
      this.host.setRatings(this.host.getRatings());
    } finally {
      this.interactionLock -= 1;
    }
    this.render();
  }

  private async clearGroupMembership(groupName: string): Promise<void> {
    this.interactionLock += 1;
    try {
      clearGroupMembership(this.host.getImages(), groupName);
      clearGroupMembership(this.host.getTextBoxes(), groupName);
      clearGroupMembership(this.host.getRatings(), groupName);
      for (const card of this.cards) {
        if (card.group === groupName) {
          card.group = "";
          const file = this.app.vault.getAbstractFileByPath(card.path);
          if (file instanceof TFile) {
            await writeDeskFields(this.app, file, { group: null });
          }
        }
      }
      this.host.setImages(this.host.getImages());
      this.host.setTextBoxes(this.host.getTextBoxes());
      this.host.setRatings(this.host.getRatings());
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

  private endpointScene() {
    return {
      cards: this.cards.map((card) => {
        const frame = cardPlacementFrame(card);
        return {
          ref: card.path,
          x: card.x,
          y: card.y,
          w: frame.w,
          h: frame.h,
          group: card.group,
        };
      }),
      textboxes: this.host.getTextBoxes(),
      groups: this.host.getGroups(),
    };
  }

  private renderArrows(): void {
    if (!this.arrowsG) {
      return;
    }
    this.arrowsG.empty();
    this.arrowEls.clear();

    const scene = this.endpointScene();
    for (const arrow of this.host.getArrows()) {
      const line = arrowLine(arrow.from, arrow.to, scene);
      if (!line) continue;
      const a = line.from;
      const b = line.to;
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
        arrow.id === this.selectedArrowId || this.selected.has(`arrow:${arrow.id}`)
          ? "web-desk-arrow is-selected"
          : "web-desk-arrow",
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
    this.selectedGroupId = null;
    this.renderArrows();
    this.syncSelection();
  }

  private onArrowContextMenu(event: MouseEvent, arrow: Arrow): void {
    event.preventDefault();
    event.stopPropagation();
    this.selectedArrowId = arrow.id;
    this.renderArrows();
    this.renderSelectionToolbar();

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
            target.color = cycleColor(GROUP_COLORS, target.color);
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

  private editArrowLabel(arrow: Arrow): void {
    new TextInputModal(this.app, {
      title: "箭头标签",
      initial: arrow.label,
      onSubmit: (value) => {
        arrow.label = value;
        this.host.setArrows(this.host.getArrows());
        this.renderArrows();
      },
    }).open();
  }

  private cycleArrowColor(arrow: Arrow): void {
    arrow.color = cycleColor(GROUP_COLORS, arrow.color);
    this.host.setArrows(this.host.getArrows());
    this.renderArrows();
  }

  private showArrowMoreMenu(arrow: Arrow, trigger: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle("删除箭头").setIcon("trash-2").onClick(() => this.removeArrow(arrow.id)));
    const rect = trigger.getBoundingClientRect();
    menu.setParentElement(this.rootEl).setUseNativeMenu(false).showAtPosition({ x: rect.left, y: rect.bottom + 6 }, trigger.ownerDocument);
  }

  private renderTextBoxes(): void {
    for (const box of this.host.getTextBoxes()) {
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

  private renderRatings(): void {
    const available = new Set(this.cards.map((card) => card.url || card.path));
    for (const rating of this.host.getRatings()) {
      rating.value = normalizeRatingValue(rating.value);
      const state = ratingLinkState(rating.link, available);
      const linkedCard = rating.link
        ? this.cards.find((card) => (card.url || card.path) === rating.link?.ref)
        : undefined;
      const el = this.canvasEl.createDiv({
        cls: `web-desk-rating is-${state}`,
      });
      if (rating.objectGroup) el.addClass("is-object-grouped");
      el.style.left = `${rating.x}px`;
      el.style.top = `${rating.y}px`;
      el.style.transform = `scale(${rating.scale ?? 1})`;
      el.style.transformOrigin = "top left";
      el.setAttribute("data-rating-id", rating.id);
      el.setAttribute("role", "group");
      el.setAttribute("aria-label", `${rating.link?.title ?? "独立评分"}：${rating.value || "未评分"}`);
      el.tabIndex = 0;

      // 独立评分只有星星；绑定评分在星星上方显示目标名，链接消失时显示 missing。
      if (state !== "standalone") {
        const header = el.createDiv({ cls: "web-desk-rating-header" });
        header.createSpan({
          cls: "web-desk-rating-link",
          text: state === "missing"
            ? `已移出 · ${rating.link?.title ?? "网页"}`
            : linkedCard?.title ?? rating.link?.title ?? "网页",
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
          this.setRatingValue(rating, rating.value === value ? 0 : value);
        });
      }

      el.addEventListener("pointerdown", (event) => this.onRatingPointerDown(event, rating, el));
      el.addEventListener("focus", () => this.ensureObjectSelection(objectKey("rating", rating.id)));
      el.addEventListener("contextmenu", (event) => this.onRatingContextMenu(event, rating));
      this.ratingEls.set(rating.id, el);
    }
  }

  private addRating(point: Point, card?: BookmarkCard): void {
    const ratings = this.host.getRatings();
    const ref = card ? card.url || card.path : "";
    if (ref && ratings.some((rating) => rating.link?.ref === ref)) {
      new Notice("这个链接已经有评分了");
      return;
    }
    ratings.push({
      id: `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      value: 0,
      x: Math.round(point.x - RATING_WIDTH / 2),
      y: Math.round(point.y - RATING_HEIGHT / 2),
      link: card ? { ref, title: card.title, url: card.url } : undefined,
    });
    this.host.setRatings(ratings);
    this.render();
  }

  private setRatingValue(rating: Rating, value: number): void {
    rating.value = normalizeRatingValue(value);
    this.host.setRatings(this.host.getRatings());
    this.render();
  }

  private onRatingPointerDown(event: PointerEvent, rating: Rating, el: HTMLElement): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    this.onViewObjectPointerDown(event, objectKey("rating", rating.id), el);
  }

  private onRatingContextMenu(event: MouseEvent, rating: Rating): void {
    event.preventDefault();
    event.stopPropagation();
    this.ensureObjectSelection(objectKey("rating", rating.id));
    const menu = new Menu();
    if (rating.link) {
      menu.addItem((item) =>
        item.setTitle("解除链接绑定").setIcon("unlink").onClick(() => {
          delete rating.link;
          this.host.setRatings(this.host.getRatings());
          this.render();
        }),
      );
      menu.addSeparator();
    }
    menu.addItem((item) =>
      item.setTitle("删除评分").setIcon("trash-2").onClick(() => {
        this.host.setRatings(this.host.getRatings().filter((entry) => entry.id !== rating.id));
        this.render();
      }),
    );
    menu.addSeparator();
    this.appendObjectGroupMenu(menu);
    menu.showAtMouseEvent(event);
  }

  private renderImages(): void {
    for (const image of this.host.getImages()) {
      const el = this.canvasEl.createDiv({ cls: "web-desk-image" });
      if (image.objectGroup) el.addClass("is-object-grouped");
      el.style.left = `${image.x}px`;
      el.style.top = `${image.y}px`;
      el.style.width = `${image.w}px`;
      el.style.height = `${image.h}px`;
      el.setAttribute("data-image-id", image.id);
      el.setAttribute("aria-label", image.path);
      el.setAttribute("role", "button");
      el.tabIndex = 0;

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
  }

  private onImagePointerDown(event: PointerEvent, image: CanvasImage, el: HTMLElement): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest(".web-desk-image-resize")) return;
    this.onViewObjectPointerDown(event, objectKey("image", image.id), el);
  }

  private onImageResizePointerDown(
    event: PointerEvent,
    image: CanvasImage,
    el: HTMLElement,
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.interactionLock += 1;
    const origin = { w: image.w, h: image.h };
    const originRect = { x: image.x, y: image.y, w: image.w, h: image.h };
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([objectKey("image", image.id)])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.transform.zoom,
      resizing: true,
      onMove: ({ x: dx, y: dy }) => {
        const widthDelta = Math.abs(dx) >= Math.abs(dy * (origin.w / origin.h))
          ? dx
          : dy * (origin.w / origin.h);
        const dominantX = Math.abs(dx) >= Math.abs(dy * (origin.w / origin.h));
        const raw = resizeImageToWidth(origin, origin.w + widthDelta);
        const snapped = snapSession.resize(originRect, { ...originRect, ...raw }, this.transform.zoom, {
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
          this.transform.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        this.interactionLock -= 1;
        if (moved) {
          const object = this.allViewObjects().filter((entry) => entry.key === objectKey("image", image.id));
          void this.persistMovedObjects(object);
        }
      },
    });
  }

  private onImageContextMenu(event: MouseEvent, image: CanvasImage): void {
    event.preventDefault();
    event.stopPropagation();
    this.ensureObjectSelection(objectKey("image", image.id));
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
          this.host.setImages(this.host.getImages().filter((entry) => entry.id !== image.id));
          this.render();
        }),
    );
    menu.addSeparator();
    this.appendObjectGroupMenu(menu);
    menu.showAtMouseEvent(event);
  }

  private onTextBoxPointerDown(event: PointerEvent, box: TextBox, el: HTMLElement): void {
    if (this.interceptArrowClick(event)) {
      return;
    }
    if (event.button !== 0 || this.editingTextBoxId === box.id) {
      return;
    }
    this.onViewObjectPointerDown(event, objectKey("textbox", box.id), el);
  }

  private onTextBoxResizePointerDown(event: PointerEvent, box: TextBox, el: HTMLElement): void {
    if (event.button !== 0) {
      return;
    }
    event.stopPropagation();

    this.interactionLock += 1;
    const origin = { w: box.w, h: box.h };
    const originRect = { x: box.x, y: box.y, w: box.w, h: box.h };
    const snapSession = createCanvasSnapSession(this.snapTargets(new Set([objectKey("textbox", box.id)])));
    beginCanvasPointerSession({
      event,
      element: el,
      zoom: () => this.transform.zoom,
      resizing: true,
      onMove: (delta) => {
        const snapped = snapSession.resize(originRect, {
          ...originRect,
          w: Math.max(140, origin.w + delta.x),
          h: Math.max(60, origin.h + delta.y),
        }, this.transform.zoom);
        box.w = Math.max(140, snapped.rect.w);
        box.h = Math.max(60, snapped.rect.h);
        el.style.width = `${box.w}px`;
        el.style.height = `${box.h}px`;
        this.snapGuideLayer?.show(
          snapGuidesMatchingRect({ x: box.x, y: box.y, w: box.w, h: box.h }, snapped.guides),
          this.transform.zoom,
        );
        this.renderArrows();
      },
      onEnd: (moved) => {
        snapSession.clear();
        this.snapGuideLayer?.hide();
        this.interactionLock -= 1;
        if (moved) {
          const object = this.allViewObjects().filter((entry) => entry.key === objectKey("textbox", box.id));
          void this.persistMovedObjects(object);
        }
      },
    });
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
    this.ensureObjectSelection(objectKey("textbox", box.id));
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("编辑文字")
        .setIcon("pencil")
        .onClick(() => this.editTextBox(box, textEl)),
    );
    menu.addSeparator();
    appendCanvasContainerAppearanceMenuItems(this.app, menu, box, () => {
      this.host.setTextBoxes(this.host.getTextBoxes());
      this.render();
    });
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
    menu.addSeparator();
    this.appendObjectGroupMenu(menu);
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
    const kept = pruneSceneArrows(arrows, this.endpointScene());
    if (kept.length !== arrows.length) {
      this.host.setArrows(kept);
    }
  }

  /** 公共 API：右键菜单与冒烟测试共用。 */
  addTextBox(x: number, y: number, text = "双击编辑文本"): TextBox {
    const boxes = this.host.getTextBoxes();
    // 从工具栏新建时落点是视口中心，那里往往已经有东西：按矩形找最近空位并选中新对象。
    const occupied = [
      ...this.allViewObjects().map(({ x, y, w, h }) => ({ x, y, w, h })),
      ...this.host.getGroups().map((group) => ({ x: group.x, y: group.y, w: group.w, h: group.h })),
    ];
    const position = findFreePosition(occupied, { x, y }, { w: 260, h: 120 }, { step: 140, grid: 24 });
    const box: TextBox = {
      id: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`,
      text,
      x: position.x,
      y: position.y,
      w: 260,
      h: 120,
      color: GROUP_COLORS[boxes.length % GROUP_COLORS.length],
    };
    boxes.push(box);
    this.host.setTextBoxes(boxes);
    this.render();
    this.selectObject(objectKey("textbox", box.id), false);
    return box;
  }

  removeTextBox(id: string): void {
    this.host.setTextBoxes(this.host.getTextBoxes().filter((box) => box.id !== id));
    this.host.setArrows(arrowsWithoutEndpoint(
      this.host.getArrows(),
      { kind: "textbox", ref: id },
    ));
    this.render();
  }

  addArrow(from: ArrowEndpoint, to: ArrowEndpoint, label = ""): Arrow {
    const arrows = this.host.getArrows();
    if (hasArrowBetween(arrows, from, to)) {
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
    const point = this.clientToCanvas(event.clientX, event.clientY);
    const imageFiles = imageFilesFrom(event.dataTransfer?.files);
    if (imageFiles.length > 0) {
      await this.importImages(imageFiles, point);
      return;
    }
    const markdownFiles = markdownFilesFromDrop(this.app, event.dataTransfer, "");
    if (markdownFiles.length > 0) {
      await this.importMarkdownFiles(markdownFiles, point);
      return;
    }
    if (hasLocalMarkdownFileDrop(event.dataTransfer)) {
      new Notice("这个 Markdown/PDF 不在当前 Vault 中；请先移入 Vault 再拖到画布");
      return;
    }
    const shortcutPaths = localShortcutCandidates(localFilePathsFromDrop(event.dataTransfer));
    if (shortcutPaths.length > 0) {
      await this.importLocalShortcuts(shortcutPaths, point);
      return;
    }
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

    await this.importUrls(urls, point);
  }

  private async importMarkdownFiles(files: TFile[], point: Point): Promise<void> {
    this.interactionLock += 1;
    try {
      for (let index = 0; index < files.length; index += 1) {
        const target = files[index];
        const existing = this.cards.find((card) => card.path === target.path || card.targetPath === target.path);
        if (existing) {
          this.selected = new Set([existing.path]);
          new Notice(`${target.basename} 已经在画布上了`);
          continue;
        }
        const dropPoint = {
          x: point.x + index * (this.settings.defaultIconSize + 36),
          y: point.y,
        };
        const result = await createMarkdownShortcut(this.app, this.settings, target, dropPoint);
        const x = Math.round(dropPoint.x - this.settings.defaultIconSize / 2);
        const y = Math.round(dropPoint.y - this.settings.defaultIconSize / 2);
        await writeDeskFields(this.app, result.file, {
          x, y, size: this.settings.defaultIconSize, hidden: null,
        });
        this.hiddenWrites.delete(result.file.path);
        this.layoutWrites.set(result.file.path, {
          x, y, size: this.settings.defaultIconSize, at: Date.now(),
        });
        new Notice(result.created ? `已创建文件卡片：${target.basename}` : `${target.basename} 已经在画布上了`);
      }
    } catch (error) {
      new Notice(`插入文件失败：${getErrorMessage(error)}`, 6000);
    } finally {
      this.interactionLock -= 1;
    }
    await this.refresh();
  }

  /** 本机应用 / 文件夹 / 文件拖入：每个路径一个收藏 Markdown，图标由系统提供。 */
  async importLocalShortcuts(paths: string[], point: Point): Promise<void> {
    this.interactionLock += 1;
    try {
      for (let index = 0; index < paths.length; index += 1) {
        const shortcut = describeLocalShortcut(paths[index]);
        const existing = this.cards.find((card) => card.appPath === shortcut.path);
        if (existing) {
          this.selected = new Set([existing.path]);
          new Notice(`${shortcut.name} 已经在画布上了`);
          continue;
        }
        // 多个一起拖入时按图标宽度横向排开，而不是斜向叠放。
        const dropPoint = { x: point.x + index * (this.settings.defaultIconSize + 36), y: point.y };
        const result = await createLocalShortcutNote(this.app, this.settings, shortcut, dropPoint);
        const x = Math.round(dropPoint.x - this.settings.defaultIconSize / 2);
        const y = Math.round(dropPoint.y - this.settings.defaultIconSize / 2);
        await writeDeskFields(this.app, result.file, {
          x, y, size: this.settings.defaultIconSize, hidden: null,
        });
        this.hiddenWrites.delete(result.file.path);
        this.layoutWrites.set(result.file.path, {
          x, y, size: this.settings.defaultIconSize, at: Date.now(),
        });
        new Notice(result.created
          ? `已添加${shortcutKindLabel(shortcut.kind)}：${shortcut.name}`
          : `${shortcut.name} 已经在画布上了`);
      }
    } catch (error) {
      new Notice(`添加快捷方式失败：${getErrorMessage(error)}`, 6000);
    } finally {
      this.interactionLock -= 1;
    }
    await this.refresh();
  }

  private async onPaste(event: ClipboardEvent): Promise<void> {
    if (event.defaultPrevented || isEditablePasteTarget(event.target)) return;
    const imageFiles = imageFilesFromClipboard(event.clipboardData);
    if (imageFiles.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      await this.importImages(imageFiles, this.visibleCenter());
      return;
    }

    const clipboardText =
      event.clipboardData?.getData("text/uri-list") ||
      event.clipboardData?.getData("text/plain") ||
      "";
    const paste = splitCanvasPaste(clipboardText);
    if (paste.urls.length === 0 && !paste.text) return;

    event.preventDefault();
    event.stopPropagation();
    const point = this.visibleCenter();
    if (paste.text) this.addTextBox(point.x - 130, point.y - 60, paste.text);
    if (paste.urls.length > 0) {
      await this.importUrls(
        paste.urls,
        paste.text ? { x: point.x + 190, y: point.y } : point,
      );
    }
  }

  private async importImages(files: File[], point: Point): Promise<void> {
    this.interactionLock += 1;
    const images = this.host.getImages();
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        try {
          const image = await storeImageFile(this.app, this.settings.imageFolder, file, {
            x: point.x + index * 32,
            y: point.y + index * 32,
          });
          images.push(image);
          new Notice(`已插入图片：${image.path.split("/").pop() ?? image.path}`);
        } catch (error) {
          new Notice(`插入图片失败：${getErrorMessage(error)}`, 6000);
        }
      }
      this.host.setImages(images);
    } finally {
      this.interactionLock -= 1;
    }
    this.render();
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

        const x = point.x + index * 40 - this.settings.defaultIconSize / 2;
        const y = point.y + index * 40 - this.settings.defaultIconSize / 2;
        const pending: PendingWebCard = {
          id: `p${Date.now().toString(36)}${index}`,
          url: rawUrl,
          x,
          y,
          state: "loading",
        };
        this.pendingImports.set(pending.id, pending);
        this.render();
        try {
          const result = await importUrlAsBookmark(this.app, this.settings, rawUrl, {
            x,
            y,
            size: this.settings.defaultIconSize,
          });
          await writeDeskFields(this.app, result.file, {
            x, y, size: this.settings.defaultIconSize, hidden: null,
          });
          this.hiddenWrites.delete(result.file.path);
          this.layoutWrites.set(result.file.path, {
            x, y, size: this.settings.defaultIconSize, at: Date.now(),
          });
          this.pendingImports.delete(pending.id);
          new Notice(`已收藏：${result.file.basename}`);
        } catch (error) {
          pending.state = "error";
          pending.message = getErrorMessage(error);
          this.render();
        }
      }
    } finally {
      this.interactionLock -= 1;
    }
    await this.refresh();
  }

  private retryPendingImport(id: string): void {
    const pending = this.pendingImports.get(id);
    if (!pending) return;
    this.pendingImports.delete(id);
    if (pending.purpose === "embed") {
      const card = this.cards.find((entry) => entry.path === id.slice("embed:".length));
      if (card) void this.setCardViewMode(card, "embed", true);
      return;
    }
    void this.importUrls([pending.url], { x: pending.x + 48, y: pending.y + 48 });
  }

  private dismissPendingImport(id: string): void {
    this.pendingImports.delete(id);
    this.render();
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
    const viewport = canvasSafeViewport(rect.width, rect.height);
    return this.clientToCanvas(rect.left + viewport.centerX, rect.top + viewport.centerY);
  }

  /** 供插件命令调用：设置变更等外部原因触发的刷新。 */
  async refreshExternal(): Promise<void> {
    await this.refresh();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cardStyleLabel(style: CardStyle): string {
  return style === "visual" ? "视觉" : style === "compact" ? "紧凑" : "文章";
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
