import { App, TFile } from "obsidian";
import { applyDeskPatch, DeskPatch } from "./layout-state";
import { BookmarkCard } from "./types";
import { normalizeCardRating } from "./card-properties-state";
import { processFrontmatterSerially } from "./frontmatter-write";
import {
  DEFAULT_PREVIEW_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  normalizeCardViewMode,
} from "./card-view-state";
import { normalizeCardStyle } from "./canvas-ui-state";

/** 图标容器宽度（含留白），自动排布网格用。 */
const GRID_STEP = 132;
const GRID_ORIGIN = 40;

export function readCard(file: TFile, app: App, defaultSize: number): BookmarkCard | null {
  if (file.extension !== "md") {
    return null;
  }

  const cache = app.metadataCache.getFileCache(file);
  const fm = (cache?.frontmatter ?? {}) as Record<string, unknown>;
  if (fm.desk_hidden === true) return null;

  const url = typeof fm.url === "string" ? fm.url : "";
  const targetPath = typeof fm.desk_file === "string" ? fm.desk_file : "";
  const target = targetPath ? app.vault.getAbstractFileByPath(targetPath) : null;
  const title = target instanceof TFile
    ? target.basename
    : typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : file.basename;
  const x = readNumber(fm.desk_x) ?? 0;
  const y = readNumber(fm.desk_y) ?? 0;
  const size = readNumber(fm.desk_size) ?? defaultSize;
  const group = typeof fm.desk_group === "string" ? fm.desk_group : "";
  const objectGroup = typeof fm.desk_object_group === "string" ? fm.desk_object_group : "";
  const viewMode = normalizeCardViewMode(fm.desk_view_mode);
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

/**
 * 给没有坐标的卡片规划落点：从 (0,0) 起按行优先找空闲网格格位。
 * 返回 path → 坐标；调用方负责写回 frontmatter。
 */
export function planAutoPositions(cards: BookmarkCard[]): Map<string, { x: number; y: number }> {
  const occupied = new Set<string>();

  for (const card of cards) {
    if (card.placed) {
      occupied.add(cellKey(card.x, card.y));
    }
  }

  const plan = new Map<string, { x: number; y: number }>();
  let col = 0;
  let row = 0;

  for (const card of cards) {
    if (card.placed) {
      continue;
    }
    while (occupied.has(`${col},${row}`)) {
      col += 1;
      if (col > 64) {
        col = 0;
        row += 1;
      }
    }
    const x = GRID_ORIGIN + col * GRID_STEP;
    const y = GRID_ORIGIN + row * GRID_STEP;
    occupied.add(`${col},${row}`);
    plan.set(card.path, { x, y });
    col += 1;
    if (col > 64) {
      col = 0;
      row += 1;
    }
  }

  return plan;
}

function cellKey(x: number, y: number): string {
  const col = Math.round((x - GRID_ORIGIN) / GRID_STEP);
  const row = Math.round((y - GRID_ORIGIN) / GRID_STEP);
  return `${col},${row}`;
}
