import { App, PluginSettingTab, Setting } from "obsidian";
import type WebDeskPlugin from "./main";
import { SIZE_LARGE, SIZE_MEDIUM, SIZE_SMALL } from "./types";

export class WebDeskSettingTab extends PluginSettingTab {
  private readonly plugin: WebDeskPlugin;

  constructor(app: App, plugin: WebDeskPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("收藏夹文件夹")
      .setDesc("收藏的 md 文件存放位置（vault 内路径，如「收藏夹」）。画布 = 该文件夹的实时投影。")
      .addText((text) =>
        text
          .setPlaceholder("收藏夹")
          .setValue(this.plugin.settings.bookmarkFolder)
          .onChange(async (value) => {
            const folder = value.trim() || "收藏夹";
            this.plugin.settings.bookmarkFolder = folder;
            await this.plugin.saveSettings();
            this.plugin.refreshViews();
          }),
      );

    new Setting(containerEl)
      .setName("默认图标大小")
      .setDesc("新收藏图标的默认尺寸；单个图标可在右键菜单调整。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption(String(SIZE_SMALL), `小（${SIZE_SMALL}px）`)
          .addOption(String(SIZE_MEDIUM), `中（${SIZE_MEDIUM}px）`)
          .addOption(String(SIZE_LARGE), `大（${SIZE_LARGE}px）`)
          .setValue(String(this.plugin.settings.defaultIconSize))
          .onChange(async (value) => {
            const size = Number(value);
            if (Number.isFinite(size) && size >= 32 && size <= 320) {
              this.plugin.settings.defaultIconSize = size;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("画布图片附件文件夹")
      .setDesc("拖入或粘贴的图片会复制到这个 Vault 文件夹；移出画布不会删除附件原文件。")
      .addText((text) =>
        text
          .setPlaceholder("附件/网页桌面")
          .setValue(this.plugin.settings.imageFolder)
          .onChange(async (value) => {
            this.plugin.settings.imageFolder = value.trim() || "附件/网页桌面";
            await this.plugin.saveSettings();
          }),
      );
  }
}
