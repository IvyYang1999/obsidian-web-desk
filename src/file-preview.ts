import { App, Component, MarkdownRenderer, setIcon, TFile } from "obsidian";
import {
  cardPlacementFrame,
  normalizeCardViewMode,
  type CardPlacement,
} from "./card-view-state";
import { renderCardPropertyIndicators } from "./card-properties-ui";
import {
  canvasFileKind,
  canvasFileKindLabel,
  supportsCanvasFilePreview,
} from "./file-preview-state";
import { CanvasFocusBoundary } from "./canvas-focus-boundary";

export interface FileCardVisualModel extends CardPlacement {
  file: TFile | null;
  path: string;
  title: string;
  description?: string;
  rating?: number;
  note?: string;
  onOpen?: () => void;
  onFullscreen?: () => void;
}

export interface CanvasFilePreviewHandle {
  close(): void;
}

export function renderFileCardVisual(
  app: App,
  owner: Component,
  el: HTMLElement,
  card: FileCardVisualModel,
): void {
  const mode = supportsCanvasFilePreview(card.path)
    ? normalizeCardViewMode(card.viewMode)
    : "icon";
  el.setAttribute("data-slot", "file-card");
  el.setAttribute("data-view-mode", mode);
  el.toggleClass("is-preview", mode === "preview");
  el.toggleClass("is-embed", mode === "embed");
  el.toggleClass("is-card-surface", mode !== "icon");
  updateFileCardFrame(el, { ...card, viewMode: mode });

  if (mode === "embed") renderEmbeddedFile(app, createFileRenderScope(owner, el), el, card);
  else if (mode === "preview") renderFilePreviewCard(app, createFileRenderScope(owner, el), el, card);
  else renderFileIcon(el, card);
}

export function updateFileCardFrame(el: HTMLElement, card: CardPlacement): void {
  const mode = normalizeCardViewMode(card.viewMode);
  const frame = cardPlacementFrame(card);
  el.style.width = `${frame.w}px`;
  if (mode === "icon") el.style.removeProperty("height");
  else el.style.height = `${frame.h}px`;
  const thumb = el.querySelector<HTMLElement>(".web-desk-icon-thumb");
  if (thumb && mode === "icon") {
    thumb.style.width = `${card.size}px`;
    thumb.style.height = `${card.size}px`;
  }
  const label = el.querySelector<HTMLElement>(".web-desk-icon-label");
  if (label && mode === "icon") label.style.width = `${frame.w}px`;
  const handle = el.querySelector<HTMLElement>(".web-desk-icon-resize");
  if (handle) handle.style.top = `${mode === "icon" ? card.size - 1 : frame.h - 5}px`;
}

export function openCanvasFilePreview(
  app: App,
  owner: Component,
  file: TFile,
  onClose?: () => void,
): CanvasFilePreviewHandle {
  let closed = false;
  const previousFocus = document.activeElement as HTMLElement | null;
  const child = new CanvasFilePreview(app, file, () => handle.close());
  const handle: CanvasFilePreviewHandle = {
    close: () => {
      if (closed) return;
      closed = true;
      owner.removeChild(child);
      previousFocus?.focus?.({ preventScroll: true });
      onClose?.();
    },
  };
  owner.addChild(child);
  return handle;
}

class CanvasFilePreview extends Component {
  private overlayEl: HTMLElement | null = null;
  private focusBoundary: CanvasFocusBoundary | null = null;

  constructor(
    private readonly app: App,
    private readonly file: TFile,
    private readonly closePreview: () => void,
  ) {
    super();
  }

  onload(): void {
    const body = document.body;
    const overlay = body.createDiv({ cls: "web-desk-file-fullscreen" });
    this.overlayEl = overlay;
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", `${this.file.basename} 全屏预览`);
    overlay.tabIndex = -1;

    const toolbar = overlay.createDiv({ cls: "web-desk-file-fullscreen-toolbar" });
    const back = toolbar.createEl("button", {
      cls: "web-desk-file-fullscreen-back",
      attr: { type: "button", "aria-label": "返回画布", title: "返回画布" },
    });
    const backIcon = back.createSpan({ cls: "web-desk-file-action-icon" });
    setIcon(backIcon, "arrow-left");
    back.createSpan({ text: "返回画布" });
    back.addEventListener("click", this.closePreview);

    const identity = toolbar.createDiv({ cls: "web-desk-file-fullscreen-identity" });
    identity.createSpan({ cls: "web-desk-file-kind", text: canvasFileKindLabel(this.file.path) });
    identity.createSpan({ cls: "web-desk-file-fullscreen-title", text: this.file.basename });

    const open = toolbar.createEl("button", {
      cls: "web-desk-file-fullscreen-open",
      attr: { type: "button", "aria-label": "在标签页打开", title: "在标签页打开" },
    });
    const openIcon = open.createSpan({ cls: "web-desk-file-action-icon" });
    setIcon(openIcon, "external-link");
    open.createSpan({ text: "打开" });
    open.addEventListener("click", () => void this.app.workspace.getLeaf("tab").openFile(this.file));

    const content = overlay.createDiv({ cls: "web-desk-file-fullscreen-content" });
    void renderReadableFile(this.app, this, content, this.file, true);
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.closePreview();
    }, true);
    this.focusBoundary = new CanvasFocusBoundary(overlay, body, back);
    this.focusBoundary.activate();
  }

  onunload(): void {
    this.focusBoundary?.release();
    this.focusBoundary = null;
    this.overlayEl?.remove();
    this.overlayEl = null;
  }
}

function renderFileIcon(el: HTMLElement, card: FileCardVisualModel): void {
  const thumb = el.createDiv({ cls: "web-desk-icon-thumb web-desk-file-thumb" });
  const icon = thumb.createDiv({ cls: "web-desk-file-icon" });
  const kind = canvasFileKind(card.path);
  setIcon(icon, kind === "pdf" ? "file-type-2" : "file-text");
  if (kind === "pdf") thumb.createSpan({ cls: "web-desk-file-badge", text: "PDF" });
  if (!card.file) el.addClass("is-file-missing");
  renderCardPropertyIndicators(thumb, card.rating, card.note);
  el.createDiv({ cls: "web-desk-icon-label", text: card.title });
}

function renderFilePreviewCard(
  app: App,
  owner: Component,
  el: HTMLElement,
  card: FileCardVisualModel,
): void {
  const surface = el.createEl("article", { cls: "web-desk-file-preview-card" });
  const header = surface.createDiv({ cls: "web-desk-file-card-header" });
  const icon = header.createSpan({ cls: "web-desk-file-card-icon" });
  setIcon(icon, canvasFileKind(card.path) === "pdf" ? "file-type-2" : "file-text");
  const heading = header.createDiv({ cls: "web-desk-file-card-heading" });
  heading.createSpan({ cls: "web-desk-file-kind", text: canvasFileKindLabel(card.path) });
  heading.createEl("h3", { cls: "web-desk-file-card-title", text: card.title });
  const content = surface.createDiv({ cls: "web-desk-file-card-preview" });
  if (card.file) void renderReadableFile(app, owner, content, card.file, false);
  else content.createDiv({ cls: "web-desk-file-error", text: "文件已移动或删除" });
  renderCardPropertyIndicators(surface, card.rating, card.note);
}

function renderEmbeddedFile(
  app: App,
  owner: Component,
  el: HTMLElement,
  card: FileCardVisualModel,
): void {
  const surface = el.createEl("article", { cls: "web-desk-file-embed" });
  const header = surface.createDiv({ cls: "web-desk-file-embed-header" });
  const identity = header.createDiv({ cls: "web-desk-file-embed-identity" });
  const icon = identity.createSpan({ cls: "web-desk-file-card-icon" });
  setIcon(icon, canvasFileKind(card.path) === "pdf" ? "file-type-2" : "file-text");
  identity.createSpan({ cls: "web-desk-file-embed-title", text: card.title });
  const actions = header.createDiv({ cls: "web-desk-file-embed-actions" });
  appendFileAction(actions, "maximize-2", "全屏", card.onFullscreen);
  appendFileAction(actions, "external-link", "打开", card.onOpen);
  const content = surface.createDiv({ cls: "web-desk-file-embed-content" });
  stopCanvasGesture(content);
  content.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });
  if (card.file) void renderReadableFile(app, owner, content, card.file, true);
  else content.createDiv({ cls: "web-desk-file-error", text: "文件已移动或删除" });
}

function appendFileAction(
  parent: HTMLElement,
  iconName: string,
  label: string,
  action?: () => void,
): void {
  const button = parent.createEl("button", {
    cls: "web-desk-file-embed-action",
    attr: { type: "button", title: label, "aria-label": label },
  });
  setIcon(button, iconName);
  stopCanvasGesture(button);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    action?.();
  });
}

async function renderReadableFile(
  app: App,
  owner: Component,
  parent: HTMLElement,
  file: TFile,
  interactive: boolean,
): Promise<void> {
  const kind = canvasFileKind(file.path);
  if (kind === "pdf") {
    const pdf = parent.createDiv({ cls: "web-desk-file-pdf-frame" });
    pdf.toggleClass("is-static", !interactive);
    if (await renderNativePdf(app, owner, pdf, file)) return;
    pdf.addClass("is-fallback");
    const frame = pdf.createEl("iframe", {
      attr: {
        src: `${app.vault.getResourcePath(file)}#toolbar=${interactive ? 1 : 0}&navpanes=0`,
        title: file.basename,
        loading: "lazy",
      },
    });
    if (!interactive) frame.tabIndex = -1;
    return;
  }
  if (kind === "markdown") {
    const scroll = parent.createDiv({ cls: "web-desk-file-markdown markdown-rendered" });
    const source = await app.vault.cachedRead(file);
    if (!scroll.isConnected) return;
    const markdown = interactive ? source : markdownExcerpt(source);
    await MarkdownRenderer.render(app, markdown, scroll, file.path, owner);
    return;
  }
  parent.createDiv({ cls: "web-desk-file-error", text: "此文件暂不支持画布内预览" });
}

interface InternalPdfEmbed extends Component {
  _loaded?: boolean;
  loadFile?: () => Promise<void> | void;
}

interface InternalEmbedRegistry {
  getEmbedCreator?: (file: TFile) => ((
    context: {
      app: App;
      linktext: string;
      sourcePath: string;
      containerEl: HTMLElement;
      displayMode: boolean;
      showInline: boolean;
      depth: number;
    },
    file: TFile,
    subpath: string,
  ) => InternalPdfEmbed) | null;
}

/** Obsidian 的 PDF.js 阅读器不是普通 iframe；优先走原生 embedRegistry，并保留公开资源 URL 兜底。 */
async function renderNativePdf(
  app: App,
  owner: Component,
  container: HTMLElement,
  file: TFile,
): Promise<boolean> {
  try {
    const registry = (app as App & { embedRegistry?: InternalEmbedRegistry }).embedRegistry;
    const create = registry?.getEmbedCreator?.(file);
    if (!create) return false;
    const embed = create({
      app,
      linktext: file.path,
      sourcePath: "",
      containerEl: container,
      displayMode: true,
      showInline: true,
      depth: 0,
    }, file, "");
    if (!embed) return false;
    owner.addChild(embed);
    // ItemView/MarkdownRenderChild 可能仍处于自身 onload；此时 addChild 只登记、不自动 load。
    if (!embed._loaded) embed.load();
    await embed.loadFile?.();
    container.addClass("is-native");
    return true;
  } catch (error) {
    container.empty();
    return false;
  }
}

function markdownExcerpt(source: string): string {
  const withoutFrontmatter = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return withoutFrontmatter.slice(0, 2400);
}

function stopCanvasGesture(element: HTMLElement): void {
  element.addEventListener("pointerdown", (event) => event.stopPropagation());
  element.addEventListener("dblclick", (event) => event.stopPropagation());
}

/** 画布重绘会直接移除旧 DOM；同步卸载其 Markdown/PDF 子组件，避免后台阅读器累积。 */
function createFileRenderScope(owner: Component, element: HTMLElement): Component {
  const scope = new Component();
  owner.addChild(scope);
  if (!(scope as Component & { _loaded?: boolean })._loaded) scope.load();
  const parent = element.parentElement;
  if (!parent) return scope;
  let removed = false;
  const observer = new MutationObserver(() => {
    if (removed || element.isConnected) return;
    removed = true;
    owner.removeChild(scope);
  });
  observer.observe(parent, { childList: true });
  scope.register(() => observer.disconnect());
  return scope;
}
