import { GROUP_COLORS } from "./types";
import type { CanvasComponents, TextBox } from "./types";
import type { CardViewMode } from "./card-view-state";
import { cardPlacementFrame, normalizeCardViewMode } from "./card-view-state";
import type { CardStyle } from "./canvas-ui-state";

export interface EmbedItem {
  url: string;
  /** Vault 内 Markdown 路径；存在时该条目是文件卡片，url 保持空字符串。 */
  path?: string;
  /** 网页收藏对应的 Markdown；与 path（普通文件卡片）语义分离。 */
  bookmarkPath?: string;
  title: string;
  description?: string;
  previewImage?: string;
  rating?: number;
  note?: string;
  caption?: string;
  x: number;
  y: number;
  size?: number;
  viewMode?: CardViewMode;
  cardStyle?: CardStyle;
  previewWidth?: number;
  previewHeight?: number;
  group?: string;
  objectGroup?: string;
}

export function embedItemRef(item: Pick<EmbedItem, "url" | "path">): string {
  return item.path ? `file:${item.path}` : item.url;
}

export type EmbedTextBox = TextBox;

export interface EmbedData extends CanvasComponents {
  items: EmbedItem[];
  height: number;
}

export const DEFAULT_EMBED_HEIGHT = 420;
export const MIN_EMBED_HEIGHT = 240;
export const MAX_EMBED_HEIGHT = 1600;

export function normalizeEmbedHeight(value: unknown): number {
  const height = typeof value === "number" && Number.isFinite(value)
    ? Math.round(value)
    : DEFAULT_EMBED_HEIGHT;
  return Math.min(MAX_EMBED_HEIGHT, Math.max(MIN_EMBED_HEIGHT, height));
}

interface EmbedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function findAvailableEmbedItemPosition(
  data: EmbedData,
  desired: { x: number; y: number },
  size = 96,
): { x: number; y: number } {
  return findAvailableEmbedPosition(data, desired, size + 24, size + 44, size + 56);
}

export function findAvailableEmbedRatingPosition(
  data: EmbedData,
  desired: { x: number; y: number },
): { x: number; y: number } {
  return findAvailableEmbedPosition(data, desired, 208, 86, 240);
}

function findAvailableEmbedPosition(
  data: EmbedData,
  desired: { x: number; y: number },
  width: number,
  height: number,
  step: number,
): { x: number; y: number } {
  const occupied: EmbedRect[] = [
    ...data.items.map((item) => {
      const frame = cardPlacementFrame({
        ...item,
        size: item.size ?? 96,
        viewMode: normalizeCardViewMode(item.viewMode),
      });
      return { x: item.x, y: item.y, w: frame.w, h: frame.h };
    }),
    ...(data.images ?? []).map((image) => ({ x: image.x, y: image.y, w: image.w, h: image.h })),
    ...(data.textboxes ?? []).map((box) => ({ x: box.x, y: box.y, w: box.w, h: box.h })),
    ...(data.ratings ?? []).map((rating) => ({ x: rating.x, y: rating.y, w: 208, h: 86 })),
  ];
  const isFree = (x: number, y: number): boolean => {
    const candidate = { x, y, w: width, h: height };
    const margin = 16;
    return occupied.every((rect) =>
      candidate.x + candidate.w + margin <= rect.x ||
      rect.x + rect.w + margin <= candidate.x ||
      candidate.y + candidate.h + margin <= rect.y ||
      rect.y + rect.h + margin <= candidate.y
    );
  };

  if (isFree(desired.x, desired.y)) {
    return { x: Math.round(desired.x), y: Math.round(desired.y) };
  }

  // 从右侧开始顺时针扩圈：连续添加时优先留在当前可视区域，而不是向左上角逸出。
  for (let ring = 1; ring <= 16; ring += 1) {
    const offsets: Array<{ column: number; row: number }> = [];
    for (let row = 0; row <= ring; row += 1) offsets.push({ column: ring, row });
    for (let column = ring - 1; column >= -ring; column -= 1) {
      offsets.push({ column, row: ring });
    }
    for (let row = ring - 1; row >= -ring; row -= 1) {
      offsets.push({ column: -ring, row });
    }
    for (let column = -ring + 1; column <= ring; column += 1) {
      offsets.push({ column, row: -ring });
    }
    for (const offset of offsets) {
      const x = Math.round(desired.x + offset.column * step);
      const y = Math.round(desired.y + offset.row * step);
      if (isFree(x, y)) return { x, y };
    }
  }

  return { x: Math.round(desired.x), y: Math.round(desired.y) };
}

export function emptyEmbedData(): EmbedData {
  return {
    items: [],
    images: [],
    textboxes: [],
    groups: [],
    arrows: [],
    ratings: [],
    height: DEFAULT_EMBED_HEIGHT,
  };
}

export function parseEmbedData(source: string): EmbedData {
  const trimmed = source.trim();
  if (!trimmed) return emptyEmbedData();
  try {
    const parsed = JSON.parse(trimmed) as Partial<EmbedData>;
    if (Array.isArray(parsed?.items)) {
      const data: EmbedData = {
        items: parsed.items,
        images: Array.isArray(parsed.images) ? parsed.images : [],
        textboxes: Array.isArray(parsed.textboxes)
          ? parsed.textboxes.map((box, index) => ({
            ...box,
            color: typeof box.color === "string"
              ? box.color
              : GROUP_COLORS[index % GROUP_COLORS.length],
          }))
          : [],
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        arrows: Array.isArray(parsed.arrows) ? parsed.arrows : [],
        ratings: Array.isArray(parsed.ratings) ? parsed.ratings : [],
        height: normalizeEmbedHeight(parsed.height),
      };
      return data;
    }
  } catch {
    // 坏数据保持可渲染；原文不会在没有用户编辑时被覆盖。
  }
  return emptyEmbedData();
}

export function createEmptyEmbedBlock(): string {
  return [
    "```web-desk",
    JSON.stringify(emptyEmbedData()),
    "```",
  ].join("\n");
}
