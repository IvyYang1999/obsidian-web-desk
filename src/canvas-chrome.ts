import { App, Menu, Modal, setIcon } from "obsidian";
import { canvasColorInputValue, normalizeCanvasHexColor } from "./canvas-color-state";
import {
  canvasContainerAppearance,
  toggleCanvasContainerAppearance,
} from "./canvas-container-state";
import type { PendingWebCard } from "./canvas-ui-state";
import { GROUP_COLOR_PRESETS, type CanvasContainerAppearance } from "./types";

export interface CanvasToolbarAction {
  icon: string;
  label: string;
  text?: string;
  separatorBefore?: boolean;
  onClick: (button: HTMLButtonElement) => void;
}

interface InlineGroupNameEditOptions {
  initial: string;
  onCommit: (name: string) => void;
  onCancel?: () => void;
}

export function beginInlineGroupNameEdit(
  element: HTMLElement,
  options: InlineGroupNameEditOptions,
): void {
  let settled = false;
  let cancelled = false;

  const finish = (): void => {
    if (settled) return;
    settled = true;
    element.removeEventListener("blur", finish);
    element.removeEventListener("keydown", onKeyDown);
    element.removeEventListener("pointerdown", stopPointerDown);
    element.removeAttribute("contenteditable");
    element.removeAttribute("role");
    element.removeAttribute("aria-label");
    element.removeClass("is-editing");
    if (cancelled) {
      element.setText(options.initial);
      options.onCancel?.();
      return;
    }
    const name = element.innerText.replace(/\u00a0/g, " ").trim() || options.initial;
    element.setText(name);
    options.onCommit(name);
  };
  const stopPointerDown = (event: PointerEvent): void => event.stopPropagation();
  const onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      element.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelled = true;
      element.blur();
    }
  };

  element.setText(options.initial);
  element.setAttribute("contenteditable", "plaintext-only");
  element.setAttribute("role", "textbox");
  element.setAttribute("aria-label", "区域名称");
  element.addClass("is-editing");
  element.addEventListener("blur", finish);
  element.addEventListener("keydown", onKeyDown);
  element.addEventListener("pointerdown", stopPointerDown);
  element.focus();

  const selection = element.ownerDocument.defaultView?.getSelection();
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export function applyCanvasContainerAppearance(
  element: HTMLElement,
  target: CanvasContainerAppearance,
): void {
  const appearance = canvasContainerAppearance(target);
  element.classList.toggle("has-border", appearance.showBorder);
  element.classList.toggle("has-fill", appearance.showFill);
  element.style.setProperty("--wd-container-color", target.color);
}

export function appendCanvasContainerAppearanceMenuItems(
  app: App,
  menu: Menu,
  target: CanvasContainerAppearance,
  onChange: () => void,
): void {
  const appearance = canvasContainerAppearance(target);
  menu.addItem((item) => item
    .setTitle("显示边框")
    .setIcon("square-dashed")
    .setChecked(appearance.showBorder)
    .onClick(() => {
      toggleCanvasContainerAppearance(target, "showBorder");
      onChange();
    }));
  menu.addItem((item) => item
    .setTitle("显示底色")
    .setIcon("paint-bucket")
    .setChecked(appearance.showFill)
    .onClick(() => {
      toggleCanvasContainerAppearance(target, "showFill");
      onChange();
    }));
  menu.addItem((item) => item
    .setTitle("更换颜色")
    .setIcon("palette")
    .onClick(() => {
      new CanvasColorPickerModal(app, target.color, (color) => {
        target.color = color;
        onChange();
      }).open();
    }));
}

export function showCanvasContainerAppearanceMenu(
  app: App,
  trigger: HTMLElement,
  target: CanvasContainerAppearance,
  onChange: () => void,
): void {
  const menu = new Menu();
  appendCanvasContainerAppearanceMenuItems(app, menu, target, onChange);
  const rect = trigger.getBoundingClientRect();
  menu
    .setParentElement(trigger.closest<HTMLElement>(".web-desk-root, .web-desk-embed") ?? trigger.ownerDocument.body)
    .setUseNativeMenu(false)
    .showAtPosition(
    { x: rect.left, y: rect.bottom + 6 },
    trigger.ownerDocument,
  );
}

class CanvasColorPickerModal extends Modal {
  constructor(
    app: App,
    private readonly currentColor: string,
    private readonly onSelect: (color: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("web-desk-color-picker");
    contentEl.createEl("h2", { text: "选择颜色" });
    contentEl.createDiv({
      cls: "web-desk-color-picker-description",
      text: "选择一个预设色，或输入自己的 HEX 颜色。",
    });

    const normalizedCurrent = canvasColorInputValue(
      this.currentColor,
      GROUP_COLOR_PRESETS[0].value,
    );
    const palette = contentEl.createDiv({
      cls: "web-desk-color-presets",
      attr: { role: "group", "aria-label": "预设颜色" },
    });
    for (const preset of GROUP_COLOR_PRESETS) {
      const selected = normalizedCurrent === preset.value;
      const button = palette.createEl("button", {
        cls: `web-desk-color-swatch${selected ? " is-selected" : ""}`,
        attr: {
          type: "button",
          title: preset.name,
          "aria-label": preset.name,
          "aria-pressed": String(selected),
        },
      });
      button.style.setProperty("--wd-swatch-color", preset.value);
      const color = button.createSpan({ cls: "web-desk-color-swatch-fill" });
      if (selected) setIcon(color, "check");
      button.addEventListener("click", () => {
        this.onSelect(preset.value);
        this.close();
      });
    }

    const custom = contentEl.createEl("form", { cls: "web-desk-custom-color" });
    custom.createEl("label", { text: "自定义颜色", attr: { for: "web-desk-custom-color-hex" } });
    const controls = custom.createDiv({ cls: "web-desk-custom-color-controls" });
    const picker = controls.createEl("input", {
      cls: "web-desk-custom-color-native",
      attr: { type: "color", "aria-label": "打开系统取色器" },
    });
    picker.value = normalizedCurrent;
    const hex = controls.createEl("input", {
      cls: "web-desk-custom-color-hex",
      attr: {
        id: "web-desk-custom-color-hex",
        type: "text",
        inputmode: "text",
        autocomplete: "off",
        spellcheck: "false",
        placeholder: "#7aa2f7",
        "aria-label": "HEX 颜色",
      },
    });
    hex.value = normalizedCurrent;
    const error = custom.createDiv({ cls: "web-desk-custom-color-error" });
    error.setAttribute("aria-live", "polite");

    const actions = custom.createDiv({ cls: "web-desk-modal-buttons" });
    const cancel = actions.createEl("button", { text: "取消", attr: { type: "button" } });
    const apply = actions.createEl("button", { text: "应用", cls: "mod-cta", attr: { type: "submit" } });

    const validate = (): string | null => {
      const color = normalizeCanvasHexColor(hex.value);
      apply.disabled = !color;
      error.setText(color ? "" : "请输入 #RRGGBB 或 #RGB 格式");
      hex.toggleClass("is-invalid", !color);
      return color;
    };
    picker.addEventListener("input", () => {
      hex.value = picker.value;
      validate();
    });
    hex.addEventListener("input", () => {
      const color = validate();
      if (color) picker.value = color;
    });
    cancel.addEventListener("click", () => this.close());
    custom.addEventListener("submit", (event) => {
      event.preventDefault();
      const color = validate();
      if (!color) return;
      this.onSelect(color);
      this.close();
    });
    validate();
  }

  onClose(): void {
    this.contentEl.removeClass("web-desk-color-picker");
    this.contentEl.empty();
  }
}

export function createCanvasObjectToolbar(
  root: HTMLElement,
  identity: { icon: string; label: string },
  actions: CanvasToolbarAction[],
): HTMLElement {
  const toolbar = root.createDiv({ cls: "web-desk-selection-toolbar" });
  toolbar.setAttribute("role", "toolbar");
  toolbar.setAttribute("aria-label", `${identity.label}工具栏`);
  toolbar.addEventListener("pointerdown", (event) => event.stopPropagation());
  const badge = toolbar.createDiv({ cls: "web-desk-selection-identity" });
  const badgeIcon = badge.createSpan({ cls: "web-desk-selection-tool-icon" });
  setIcon(badgeIcon, identity.icon);
  badge.createSpan({ cls: "web-desk-selection-identity-label", text: identity.label });
  for (const action of actions) {
    const button = toolbar.createEl("button", {
      cls: `web-desk-selection-tool${action.separatorBefore ? " has-separator" : ""}`,
      attr: { type: "button", title: action.label, "aria-label": action.label },
    });
    const iconEl = button.createSpan({ cls: "web-desk-selection-tool-icon" });
    setIcon(iconEl, action.icon);
    if (action.text) button.createSpan({ cls: "web-desk-selection-tool-label", text: action.text });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      action.onClick(button);
    });
  }
  return toolbar;
}

export function positionCanvasObjectToolbar(
  toolbar: HTMLElement,
  target: Element,
  root: HTMLElement,
): void {
  const rootRect = root.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  toolbar.classList.toggle("is-compact", rootRect.width <= 520);
  toolbar.style.maxWidth = `${Math.max(1, rootRect.width - 16)}px`;
  const width = toolbar.offsetWidth;
  const height = toolbar.offsetHeight;
  const left = Math.min(
    Math.max(8, targetRect.left - rootRect.left + targetRect.width / 2 - width / 2),
    Math.max(8, rootRect.width - width - 8),
  );
  let top = targetRect.top - rootRect.top - height - 10;
  const below = top < 8;
  if (below) top = Math.min(rootRect.height - height - 8, targetRect.bottom - rootRect.top + 10);
  toolbar.classList.toggle("is-below", below);
  toolbar.style.left = `${Math.round(left)}px`;
  toolbar.style.top = `${Math.round(top)}px`;
}

export function createCanvasCreateRail(
  root: HTMLElement,
  actions: Array<{ icon: string; label: string; onClick: (button: HTMLButtonElement) => void }>,
): HTMLElement {
  const rail = root.createDiv({ cls: "web-desk-create-rail" });
  rail.setAttribute("role", "toolbar");
  rail.setAttribute("aria-label", "创建画布元素");
  rail.addEventListener("pointerdown", (event) => event.stopPropagation());
  rail.addEventListener("contextmenu", (event) => event.stopPropagation());
  for (const action of actions) {
    const button = rail.createEl("button", {
      cls: "web-desk-create-tool",
      attr: { type: "button", title: action.label, "aria-label": action.label },
    });
    setIcon(button, action.icon);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      action.onClick(button);
    });
  }
  return rail;
}

export function renderPendingWebCard(
  canvas: HTMLElement,
  pending: PendingWebCard,
  onRetry: () => void,
  onDismiss: () => void,
): HTMLElement {
  const el = canvas.createDiv({ cls: `web-desk-pending-card is-${pending.state}` });
  el.style.left = `${pending.x}px`;
  el.style.top = `${pending.y}px`;
  el.setAttribute("role", pending.state === "loading" ? "status" : "alert");
  el.setAttribute("aria-live", "polite");
  const visual = el.createDiv({ cls: "web-desk-pending-visual" });
  const icon = visual.createSpan({ cls: "web-desk-pending-icon" });
  setIcon(icon, pending.state === "loading" ? "loader-circle" : "circle-alert");
  visual.createDiv({
    cls: "web-desk-pending-title",
    text: pending.title ?? (pending.state === "loading" ? "正在生成网页卡片" : "网页导入失败"),
  });
  visual.createDiv({ cls: "web-desk-pending-url", text: pending.url });
  if (pending.message) visual.createDiv({ cls: "web-desk-pending-message", text: pending.message });
  if (pending.state === "error") {
    const actions = visual.createDiv({ cls: "web-desk-pending-actions" });
    const retry = actions.createEl("button", { text: "重试", attr: { type: "button" } });
    const dismiss = actions.createEl("button", { text: "移除", attr: { type: "button" } });
    retry.addEventListener("click", (event) => { event.stopPropagation(); onRetry(); });
    dismiss.addEventListener("click", (event) => { event.stopPropagation(); onDismiss(); });
  }
  return el;
}
