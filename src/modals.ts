import { App, Modal } from "obsidian";

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
