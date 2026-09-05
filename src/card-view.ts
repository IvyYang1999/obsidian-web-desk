import { setIcon } from "obsidian";
import { renderCardPropertyIndicators } from "./card-properties-ui";
import { shortcutKindIcon, type LocalShortcutKind } from "./shortcut-state";
import {
  cardPlacementFrame,
  normalizeCardViewMode,
  type CardPlacement,
} from "./card-view-state";
import { colorFromString, faviconUrl } from "./util";
import { normalizeCardStyle, type CardStyle } from "./canvas-ui-state";

export interface WebCardVisualModel extends CardPlacement {
  url: string;
  title: string;
  host: string;
  description?: string;
  previewImage?: string;
  rating?: number;
  note?: string;
  caption?: string;
  cardStyle?: CardStyle;
  captionEditing?: boolean;
  onCaptionInput?: (value: string) => void;
  onCaptionCommit?: (value: string) => void;
  onEmbedFallback?: () => void;
  onOpen?: () => void;
  /** 网站图标解析器；缺省时直接请求远程 favicon 并在失败时回落首字母。 */
  resolveIcon?: (host: string) => Promise<string | null>;
  fallbackKey: string;
}

export function renderWebCardVisual(el: HTMLElement, card: WebCardVisualModel): void {
  const mode = normalizeCardViewMode(card.viewMode);
  el.setAttribute("data-slot", "web-card");
  el.setAttribute("data-view-mode", mode);
  el.setAttribute("data-card-style", normalizeCardStyle(card.cardStyle));
  el.toggleClass("is-preview", mode === "preview");
  el.toggleClass("is-embed", mode === "embed");
  el.toggleClass("is-card-surface", mode !== "icon");
  updateWebCardElementFrame(el, card);

  if (mode === "embed") {
    renderEmbedCard(el, card);
  } else if (mode === "preview") {
    renderPreviewCard(el, card);
  } else {
    renderIconCard(el, card);
  }
  renderCaption(el, card);
}

export function updateWebCardElementFrame(el: HTMLElement, card: CardPlacement): void {
  const mode = normalizeCardViewMode(card.viewMode);
  const frame = cardPlacementFrame(card);
  el.style.width = `${frame.w}px`;
  if (mode !== "icon") el.style.height = `${frame.h}px`;
  else el.style.removeProperty("height");

  const thumb = el.querySelector<HTMLElement>(".web-desk-icon-thumb");
  if (thumb && mode === "icon") {
    thumb.style.width = `${card.size}px`;
    thumb.style.height = `${card.size}px`;
  }
  const label = el.querySelector<HTMLElement>(".web-desk-icon-label");
  if (label && mode === "icon") label.style.width = `${frame.w}px`;
  const letter = el.querySelector<HTMLElement>(".web-desk-icon-letter");
  if (letter && mode === "icon") letter.style.fontSize = `${Math.round(card.size * 0.42)}px`;
  const handle = el.querySelector<HTMLElement>(".web-desk-icon-resize");
  // 圆点手柄中心落在缩略图/卡片右下角（图标外层有 4px 内边距）。
  if (handle) handle.style.top = `${mode !== "icon" ? frame.h - 5 : card.size - 1}px`;
}

function renderIconCard(el: HTMLElement, card: WebCardVisualModel): void {
  const thumb = el.createDiv({ cls: "web-desk-icon-thumb" });
  mountSiteIcon(thumb, card, card.size, "web-desk-icon-img");
  renderCardPropertyIndicators(thumb, card.rating, card.note);
  el.createDiv({ cls: "web-desk-icon-label", text: card.title });
}

/**
 * 站点图标先用首字母色块占位，图标就绪后再替换：
 * 远程图标常常是 404 占位图或 16px 小图，只有解析器认可的才上画布。
 */
function mountSiteIcon(parent: HTMLElement, card: WebCardVisualModel, letterSize: number, imageClass: string): void {
  const letter = appendLetter(parent, card, letterSize);
  if (!card.host) return;
  if (card.resolveIcon) {
    void card.resolveIcon(card.host).then((src) => {
      if (src && parent.isConnected) swapLetterForImage(parent, letter, src, imageClass);
    });
    return;
  }
  swapLetterForImage(parent, letter, faviconUrl(card.host), imageClass);
}

function swapLetterForImage(parent: HTMLElement, letter: HTMLElement, src: string, imageClass: string): void {
  const image = parent.createEl("img", {
    cls: `${imageClass} is-loading`,
    attr: { src, alt: "", draggable: "false", "aria-hidden": "true" },
  });
  image.addEventListener("load", () => {
    image.removeClass("is-loading");
    letter.remove();
  });
  image.addEventListener("error", () => image.remove());
}

function renderPreviewCard(el: HTMLElement, card: WebCardVisualModel): void {
  const style = normalizeCardStyle(card.cardStyle);
  const surface = el.createEl("article", { cls: `web-desk-preview-card is-${style}` });
  surface.setAttribute("data-slot", "web-card-preview");
  const media = surface.createEl("figure", { cls: "web-desk-preview-media" });
  media.setAttribute("data-slot", "web-card-media");
  const imageUrl = safeRemoteImage(card.previewImage);
  if (imageUrl) {
    const image = media.createEl("img", {
      cls: "web-desk-preview-image",
      attr: { src: imageUrl, alt: "", draggable: "false", "aria-hidden": "true" },
    });
    image.addEventListener("error", () => {
      image.remove();
      surface.addClass("has-fallback");
      appendPreviewFallback(media, card);
    });
  } else {
    // 没有封面时封面区收窄，让标题和摘要成为主体，而不是一大块占位色。
    surface.addClass("has-fallback");
    appendPreviewFallback(media, card);
  }

  const body = surface.createDiv({ cls: "web-desk-preview-body" });
  body.setAttribute("data-slot", "web-card-body");
  body.createDiv({ cls: "web-desk-preview-host", text: card.host || "网页收藏" });
  body.createEl("h3", { cls: "web-desk-preview-title", text: card.title });
  if (style !== "visual") {
    body.createEl("p", {
      cls: "web-desk-preview-description",
      text: card.description?.trim() || "暂无摘要，打开网页查看内容。",
    });
  }
  renderCardPropertyIndicators(surface, card.rating, card.note);
}

function renderEmbedCard(el: HTMLElement, card: WebCardVisualModel): void {
  const surface = el.createEl("article", { cls: "web-desk-embed-card" });
  const source = safeEmbedUrl(card.url);
  if (source) {
    surface.createEl("iframe", {
      cls: "web-desk-embed-frame",
      attr: {
        src: source,
        title: card.title || card.host || "嵌入网页",
        sandbox: "allow-scripts",
        referrerpolicy: "no-referrer",
        loading: "lazy",
      },
    });
    const shield = surface.createDiv({ cls: "web-desk-embed-shield" });
    const enter = shield.createEl("button", { cls: "web-desk-embed-enter", text: "点击进入实时网页" });
    stopCanvasGesture(enter);
    enter.addEventListener("click", (event) => {
      event.stopPropagation();
      surface.addClass("is-live");
      surface.querySelector<HTMLIFrameElement>("iframe")?.focus();
    });
  } else {
    surface.createDiv({ cls: "web-desk-embed-error", text: "此链接不能安全嵌入" });
  }

  const footer = surface.createDiv({ cls: "web-desk-embed-footer" });
  footer.createSpan({ cls: "web-desk-embed-domain", text: card.host || "网页" });
  const actions = footer.createDiv({ cls: "web-desk-embed-actions" });
  const fallback = actions.createEl("button", {
    text: "恢复卡片",
    cls: "web-desk-embed-action",
    attr: { title: "网页空白时恢复卡片，并记住此站点" },
  });
  const open = actions.createEl("button", {
    text: "打开",
    cls: "web-desk-embed-action",
    attr: { title: "在浏览器打开" },
  });
  for (const button of [fallback, open]) stopCanvasGesture(button);
  fallback.addEventListener("click", (event) => {
    event.stopPropagation();
    card.onEmbedFallback?.();
  });
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    card.onOpen?.();
  });
}

/** 本机快捷方式：系统图标不套瓦片，加载前用种类占位图标。 */
export interface ShortcutCardVisualModel extends CardPlacement {
  title: string;
  kind: LocalShortcutKind;
  rating?: number;
  note?: string;
  caption?: string;
  captionEditing?: boolean;
  onCaptionInput?: (value: string) => void;
  onCaptionCommit?: (value: string) => void;
  /** 路径在本机不存在时降为提示态，但保留布局与属性。 */
  missing?: boolean;
  resolveIcon?: () => Promise<string | null>;
}

export function renderShortcutCardVisual(el: HTMLElement, card: ShortcutCardVisualModel): void {
  el.setAttribute("data-slot", "shortcut-card");
  el.setAttribute("data-view-mode", "icon");
  el.setAttribute("data-shortcut-kind", card.kind);
  el.removeClass("is-preview", "is-embed", "is-card-surface");
  el.toggleClass("is-shortcut-missing", Boolean(card.missing));
  updateWebCardElementFrame(el, { ...card, viewMode: "icon" });

  const thumb = el.createDiv({ cls: `web-desk-icon-thumb web-desk-shortcut-thumb is-${card.kind}` });
  const placeholder = thumb.createDiv({ cls: "web-desk-shortcut-placeholder" });
  setIcon(placeholder, shortcutKindIcon(card.kind));
  if (card.resolveIcon) {
    void card.resolveIcon().then((src) => {
      if (!src || !thumb.isConnected) return;
      const image = thumb.createEl("img", {
        cls: "web-desk-shortcut-img is-loading",
        attr: { src, alt: "", draggable: "false", "aria-hidden": "true" },
      });
      image.addEventListener("load", () => {
        image.removeClass("is-loading");
        placeholder.remove();
      });
      image.addEventListener("error", () => image.remove());
    });
  }
  renderCardPropertyIndicators(thumb, card.rating, card.note);
  el.createDiv({ cls: "web-desk-icon-label", text: card.title });
  renderCaption(el, card);
}

function renderCaption(
  el: HTMLElement,
  card: Pick<WebCardVisualModel, "caption" | "captionEditing" | "onCaptionInput" | "onCaptionCommit">,
): void {
  if (!card.caption && !card.captionEditing) return;
  const input = el.createEl("textarea", {
    cls: "web-desk-card-caption",
    attr: { rows: "1", placeholder: "添加说明", "aria-label": "网页说明" },
  });
  input.value = card.caption ?? "";
  resizeCaption(input);
  stopCanvasGesture(input);
  input.addEventListener("input", () => {
    resizeCaption(input);
    card.onCaptionInput?.(input.value);
  });
  input.addEventListener("blur", () => card.onCaptionCommit?.(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      input.blur();
    }
  });
  if (card.captionEditing) {
    input.addClass("is-editing");
    window.setTimeout(() => {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }
}

function resizeCaption(input: HTMLTextAreaElement): void {
  // 先让高度回到内容高度再量 scrollHeight，否则缩短文字时量到的是旧高度。
  input.setCssStyles({ height: "auto" });
  input.setCssStyles({ height: `${Math.min(88, Math.max(24, input.scrollHeight))}px` });
}

function stopCanvasGesture(element: HTMLElement): void {
  element.addEventListener("pointerdown", (event) => event.stopPropagation());
  element.addEventListener("dblclick", (event) => event.stopPropagation());
}

function appendPreviewFallback(parent: HTMLElement, card: WebCardVisualModel): void {
  const fallback = parent.createDiv({ cls: "web-desk-preview-fallback" });
  fallback.style.setProperty("--wd-site-color", colorFromString(card.host || card.fallbackKey));
  mountSiteIcon(fallback, card, 72, "web-desk-preview-favicon");
}

function appendLetter(parent: HTMLElement, card: WebCardVisualModel, size: number): HTMLElement {
  const letter = card.title.trim().charAt(0).toUpperCase() || "?";
  const block = parent.createDiv({ cls: "web-desk-icon-letter", text: letter });
  block.style.backgroundColor = colorFromString(card.host || card.fallbackKey);
  block.style.fontSize = `${Math.round(size * 0.42)}px`;
  return block;
}

function safeRemoteImage(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "app:", "blob:"].includes(parsed.protocol) ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function safeEmbedUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.toString() : "";
  } catch {
    return "";
  }
}
