import { App, Modal } from "obsidian";
import { normalizeCardProperties } from "./card-properties-state";
import type { CardProperties } from "./types";

export class CardPropertiesModal extends Modal {
  private readonly initial: CardProperties;
  private readonly onSubmit: (value: CardProperties) => void;

  constructor(
    app: App,
    options: { initial: CardProperties; onSubmit: (value: CardProperties) => void },
  ) {
    super(app);
    this.initial = normalizeCardProperties(options.initial, options.initial.title);
    this.onSubmit = options.onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("web-desk-card-properties");
    contentEl.createEl("h2", { text: "编辑网页属性" });

    const form = contentEl.createEl("form");
    const titleField = form.createDiv({ cls: "web-desk-property-field" });
    titleField.createEl("label", { text: "名称" });
    const titleInput = titleField.createEl("input", { type: "text" });
    titleInput.value = this.initial.title;
    titleInput.required = true;

    const ratingField = form.createDiv({ cls: "web-desk-property-field" });
    ratingField.createEl("label", { text: "评分" });
    const ratingButtons = ratingField.createDiv({ cls: "web-desk-property-rating" });
    let rating = this.initial.rating;
    const buttons: HTMLButtonElement[] = [];
    const refreshRating = (): void => {
      buttons.forEach((button, index) => {
        const value = index + 1;
        button.toggleClass("is-active", value <= rating);
        button.setAttribute("aria-pressed", String(value <= rating));
      });
    };
    for (let value = 1; value <= 5; value += 1) {
      const button = ratingButtons.createEl("button", {
        text: "★",
        attr: { "aria-label": `${value} 星` },
      });
      button.type = "button";
      button.addEventListener("click", () => {
        rating = rating === value ? 0 : value;
        refreshRating();
      });
      buttons.push(button);
    }
    const clearRating = ratingButtons.createEl("button", {
      text: "清除",
      cls: "web-desk-property-rating-clear",
    });
    clearRating.type = "button";
    clearRating.addEventListener("click", () => {
      rating = 0;
      refreshRating();
    });
    refreshRating();

    const noteField = form.createDiv({ cls: "web-desk-property-field" });
    noteField.createEl("label", { text: "备注" });
    const noteInput = noteField.createEl("textarea");
    noteInput.rows = 5;
    noteInput.placeholder = "写下你对这个网页的判断、用途或下一步…";
    noteInput.value = this.initial.note;

    const actions = form.createDiv({ cls: "web-desk-modal-buttons" });
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    const save = actions.createEl("button", { text: "保存", cls: "mod-cta" });
    save.type = "submit";

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const properties = normalizeCardProperties({
        title: titleInput.value,
        rating,
        note: noteInput.value,
      }, this.initial.title);
      this.close();
      this.onSubmit(properties);
    });

    window.setTimeout(() => {
      titleInput.focus();
      titleInput.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.removeClass("web-desk-card-properties");
    this.contentEl.empty();
  }
}

export class TextInputModal extends Modal {
  private readonly title: string;
  private readonly placeholder: string;
  private readonly initial: string;
  private readonly submitLabel: string;
  private readonly onSubmit: (value: string) => void;

  constructor(
    app: App,
    options: {
      title: string;
      placeholder?: string;
      initial?: string;
      submitLabel?: string;
      onSubmit: (value: string) => void;
    },
  ) {
    super(app);
    this.title = options.title;
    this.placeholder = options.placeholder ?? "";
    this.initial = options.initial ?? "";
    this.submitLabel = options.submitLabel ?? "确定";
    this.onSubmit = options.onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });

    const form = contentEl.createEl("form");
    const input = form.createEl("input");
    input.type = "text";
    input.placeholder = this.placeholder;
    input.value = this.initial;
    input.autocomplete = "off";

    form.createEl("button", { text: this.submitLabel, type: "submit" });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        return;
      }
      this.close();
      this.onSubmit(value);
    });

    window.setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export class ConfirmModal extends Modal {
  private readonly message: string;
  private readonly okLabel: string;
  private readonly onOk: () => void;

  constructor(
    app: App,
    options: { message: string; okLabel?: string; onOk: () => void },
  ) {
    super(app);
    this.message = options.message;
    this.okLabel = options.okLabel ?? "确定";
    this.onOk = options.onOk;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "确认" });
    contentEl.createEl("p", { text: this.message });

    const buttons = contentEl.createDiv({ cls: "web-desk-modal-buttons" });
    const cancel = buttons.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());

    const ok = buttons.createEl("button", { text: this.okLabel, cls: "mod-warning" });
    ok.addEventListener("click", () => {
      this.close();
      this.onOk();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
