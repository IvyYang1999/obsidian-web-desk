import { App, TFile } from "obsidian";
import { applyDeskPatch, DeskPatch } from "./layout-state";
import { BookmarkCard } from "./types";
import { normalizeCardRating } from "./card-properties-state";
import { processFrontmatterSerially } from "./frontmatter-write";
import {
  DEFAULT_PREVIEW_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  normalizeCardViewMode,
  type CardViewMode,
} from "./card-view-state";
import { normalizeShortcutKind } from "./shortcut-state";
import { normalizeCardStyle } from "./canvas-ui-state";

export function readCard(file: TFile, app: App, defaultSize: number): BookmarkCard | null {
  if (file.extension !== "md") {
    return null;
  }

  const cache = app.metadataCache.getFileCache(file);
  const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  if (fm.desk_hidden === true) return null;

  const url = typeof fm.url === "string" ? fm.url : "";
  const targetPath = typeof fm.desk_file === "string" ? fm.desk_file : "";
  const appPath = typeof fm.app_path === "string" ? fm.app_path.trim() : "";
  const appName = typeof fm.app_name === "string" ? fm.app_name.trim() : "";
  const appKind = normalizeShortcutKind(fm.type);
  const target = targetPath ? app.vault.getAbstractFileByPath(targetPath) : null;
  const title = target instanceof TFile
    ? target.basename
    : typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : file.basename;
  const x = readNumber(fm.desk_x) ?? 0;
  const y = readNumber(fm.desk_y) ?? 0;
  const size = readNumber(fm.desk_size) ?? defaultSize;
  const group = typeof fm.desk_group === "string" ? fm.desk_group : "";
  const objectGroup = typeof fm.desk_object_group === "string" ? fm.desk_object_group : "";
  // 本机快捷方式只有图标一种外观。
  const viewMode: CardViewMode = appPath ? "icon" : normalizeCardViewMode(fm.desk_view_mode);
  const cardStyle = normalizeCardStyle(fm.desk_card_style);
  const previewWidth = readNumber(fm.desk_preview_width) ?? DEFAULT_PREVIEW_WIDTH;
  const previewHeight = readNumber(fm.desk_preview_height) ?? DEFAULT_PREVIEW_HEIGHT;
  const cachedImage = cache?.embeds?.find((embed) => /^https?:\/\//i.test(embed.link))?.link ?? "";
  const previewImage = typeof fm.preview_image === "string" ? fm.preview_image : cachedImage;

  let host = "";
  if (url) {
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      host = "";
    }
  }

  return {
    path: file.path,
    targetPath,
    appPath,
    appName,
    appKind,
    title,
    url,
    host,
    type: typeof fm.type === "string" ? fm.type : "",
    description: typeof fm.description === "string" ? fm.description : "",
    previewImage,
    rating: normalizeCardRating(fm.desk_rating),
    note: typeof fm.desk_note === "string" ? fm.desk_note.trim() : "",
    caption: typeof fm.desk_caption === "string" ? fm.desk_caption.trim() : "",
    x,
    y,
    size,
    viewMode,
    cardStyle,
    previewWidth,
    previewHeight,
    group,
    objectGroup,
    placed: typeof fm.desk_x === "number" || typeof fm.desk_y === "number",
  };
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** 写布局字段到 md frontmatter；值为 null 表示删除该键。 */
export async function writeDeskFields(
  app: App,
  file: TFile,
  patch: DeskPatch,
): Promise<void> {
  await processFrontmatterSerially(app, file, (fm: Record<string, unknown>) => {
    applyDeskPatch(fm, patch);
  });
}

export { planAutoPositions, type AutoPlaceOptions } from "./auto-place";
