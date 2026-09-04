import { Editor, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { DeskEmbed } from "./embed";
import { FaviconResolver } from "./favicon-cache";
import { ShortcutIconResolver } from "./shortcut-icon";
import { createEmptyEmbedBlock } from "./embed-state";
import { TextInputModal } from "./modals";
import { WebDeskSettingTab } from "./settings";
import {
  Arrow,
  CanvasImage,
  CanvasTransform,
  DEFAULT_SETTINGS,
  GroupBox,
  Rating,
  TextBox,
  VIEW_TYPE_WEB_DESK,
  WebDeskSettings,
} from "./types";
import { WebDeskHost, WebDeskView } from "./view";
import { getErrorMessage } from "./util";

interface WebDeskPluginData {
  settings?: Partial<WebDeskSettings>;
  groups?: GroupBox[];
  textboxes?: TextBox[];
  arrows?: Arrow[];
  images?: CanvasImage[];
  ratings?: Rating[];
  view?: CanvasTransform;
}

export default class WebDeskPlugin extends Plugin {
  settings: WebDeskSettings = { ...DEFAULT_SETTINGS };
  private groups: GroupBox[] = [];
  private textBoxes: TextBox[] = [];
  private arrows: Arrow[] = [];
  private images: CanvasImage[] = [];
  private ratings: Rating[] = [];
  private viewTransform: CanvasTransform = { panX: 0, panY: 0, zoom: 1 };
  private saveDataTimer: number | null = null;
  private favicons!: FaviconResolver;
  private shortcutIcons!: ShortcutIconResolver;

  async onload(): Promise<void> {
    await this.loadDataInto();

    // 画布上悬停即弹出页面预览会遮住一大片画布；默认要求按住 Cmd/Ctrl，用户可在“页面预览”设置里改。
    this.registerHoverLinkSource("web-desk", {
      display: "网页桌面",
      defaultMod: true,
    });
    this.favicons = new FaviconResolver(this.app, () => this.settings.imageFolder);
    this.shortcutIcons = new ShortcutIconResolver(this.app, () => this.settings.imageFolder);

    const host: WebDeskHost = {
      getSettings: () => this.settings,
      getGroups: () => this.groups,
      setGroups: (groups) => {
        this.groups = groups;
        this.saveDataDebounced();
      },
      getTextBoxes: () => this.textBoxes,
      setTextBoxes: (boxes) => {
        this.textBoxes = boxes;
        this.saveDataDebounced();
      },
      getArrows: () => this.arrows,
      setArrows: (arrows) => {
        this.arrows = arrows;
        this.saveDataDebounced();
      },
      getImages: () => this.images,
      setImages: (images) => {
        this.images = images;
        this.saveDataDebounced();
      },
      getRatings: () => this.ratings,
      setRatings: (ratings) => {
        this.ratings = ratings;
        this.saveDataDebounced();
      },
      getTransform: () => this.viewTransform,
      setTransform: (transform) => {
        this.viewTransform = transform;
        this.saveDataDebounced();
      },
      setBlockedEmbedHosts: (hosts) => {
        this.settings.blockedEmbedHosts = hosts;
        this.saveDataDebounced();
      },
      resolveFavicon: (host) => this.favicons.resolve(host),
      resolveShortcutIcon: (shortcut) => this.shortcutIcons.resolve(shortcut),
    };
    this.registerView(VIEW_TYPE_WEB_DESK, (leaf) => new WebDeskView(leaf, host));

    this.addRibbonIcon("layout-grid", "打开网页桌面", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-web-desk",
      name: "打开网页桌面",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "bookmark-url",
      name: "收藏 URL 到网页桌面",
      callback: () => {
        void this.activateView().then(() => {
          const view = this.getActiveView();
          if (view) {
            view.promptForUrlAtCenter();
          } else {
            new TextInputModal(this.app, {
              title: "收藏 URL 到网页桌面",
              placeholder: "https://example.com/article",
              submitLabel: "收藏",
              onSubmit: () => new Notice("请先打开网页桌面画布再收藏"),
            }).open();
          }
        });
      },
    });

    this.addCommand({
      id: "insert-web-desk",
      name: "插入网页收藏画布",
      editorCallback: (editor) => this.insertEmbedCanvas(editor),
    });

    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem((item) =>
          item
            .setTitle("插入网页收藏画布")
            .setIcon("layout-grid")
            .onClick(() => this.insertEmbedCanvas(editor)),
        );
      }),
    );

    this.addSettingTab(new WebDeskSettingTab(this.app, this));

    // 笔记内嵌画布：```web-desk 代码块（数据存块内，编辑写回，oneday 同款姿势）
    this.registerMarkdownCodeBlockProcessor("web-desk", (source, el, ctx) => {
      try {
        const embed = new DeskEmbed(
          el,
          source,
          this.app,
          ctx,
          this.settings,
          () => void this.saveSettings(),
          undefined,
          (host) => this.favicons.resolve(host),
          (shortcut) => this.shortcutIcons.resolve(shortcut),
        );
        ctx.addChild(embed);
        embed.render();
      } catch (error) {
        el.createEl("pre", { text: `web-desk 画布渲染失败：${getErrorMessage(error)}` });
      }
    });
  }

  onunload(): void {
    // 官方指引：不要在 onunload 里 detach 视图，否则用户重装/更新后工作区布局会丢。
  }

  private async loadDataInto(): Promise<void> {
    const data = (await this.loadData()) as WebDeskPluginData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.settings.blockedEmbedHosts = Array.isArray(data?.settings?.blockedEmbedHosts)
      ? data!.settings!.blockedEmbedHosts!.filter((entry): entry is string => typeof entry === "string")
      : [];
    this.groups = Array.isArray(data?.groups) ? data!.groups! : [];
    this.textBoxes = Array.isArray(data?.textboxes) ? data!.textboxes! : [];
    this.arrows = Array.isArray(data?.arrows) ? data!.arrows! : [];
    this.images = Array.isArray(data?.images) ? data!.images! : [];
    this.ratings = Array.isArray(data?.ratings) ? data!.ratings! : [];
    this.viewTransform = data?.view ?? { panX: 0, panY: 0, zoom: 1 };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.snapshot());
  }

  private snapshot(): WebDeskPluginData {
    return {
      settings: this.settings,
      groups: this.groups,
      textboxes: this.textBoxes,
      arrows: this.arrows,
      images: this.images,
      ratings: this.ratings,
      view: this.viewTransform,
    };
  }

  private saveDataDebounced(): void {
    if (this.saveDataTimer !== null) {
      window.clearTimeout(this.saveDataTimer);
    }
    this.saveDataTimer = window.setTimeout(() => {
      this.saveDataTimer = null;
      void this.saveData(this.snapshot());
    }, 500);
  }

  private insertEmbedCanvas(editor: Editor): void {
    const cursor = editor.getCursor();
    const line = editor.getLine(cursor.line);
    const prefix = line.trim() ? "\n" : "";
    editor.replaceSelection(`${prefix}${createEmptyEmbedBlock()}\n`);
  }

  private getActiveView(): WebDeskView | null {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_WEB_DESK)[0]?.view;
    return view instanceof WebDeskView ? view : null;
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_WEB_DESK);
    let leaf: WorkspaceLeaf;

    if (existing.length > 0) {
      leaf = existing[0];
      await workspace.revealLeaf(leaf);
      return;
    }

    leaf = workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_WEB_DESK, active: true });
    await workspace.revealLeaf(leaf);
  }

  refreshViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WEB_DESK)) {
      const view = leaf.view;
      if (view instanceof WebDeskView) {
        void view.refreshExternal();
      }
    }
  }
}
