import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { TextInputModal } from "./modals";
import { WebDeskSettingTab } from "./settings";
import {
  CanvasTransform,
  DEFAULT_SETTINGS,
  GroupBox,
  VIEW_TYPE_WEB_DESK,
  WebDeskSettings,
} from "./types";
import { WebDeskHost, WebDeskView } from "./view";

interface WebDeskPluginData {
  settings?: Partial<WebDeskSettings>;
  groups?: GroupBox[];
  view?: CanvasTransform;
}

export default class WebDeskPlugin extends Plugin {
  settings: WebDeskSettings = { ...DEFAULT_SETTINGS };
  private groups: GroupBox[] = [];
  private viewTransform: CanvasTransform = { panX: 0, panY: 0, zoom: 1 };
  private saveDataTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadDataInto();

    const host: WebDeskHost = {
      getSettings: () => this.settings,
      getGroups: () => this.groups,
      setGroups: (groups) => {
        this.groups = groups;
        this.saveDataDebounced();
      },
      getTransform: () => this.viewTransform,
      setTransform: (transform) => {
        this.viewTransform = transform;
        this.saveDataDebounced();
      },
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

    this.addSettingTab(new WebDeskSettingTab(this.app, this));
  }

  onunload(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_WEB_DESK)) {
      leaf.detach();
    }
  }

  private async loadDataInto(): Promise<void> {
    const data = (await this.loadData()) as WebDeskPluginData | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(data?.settings ?? {}) };
    this.groups = Array.isArray(data?.groups) ? data!.groups! : [];
    this.viewTransform = data?.view ?? { panX: 0, panY: 0, zoom: 1 };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.snapshot());
  }

  private snapshot(): WebDeskPluginData {
    return {
      settings: this.settings,
      groups: this.groups,
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
