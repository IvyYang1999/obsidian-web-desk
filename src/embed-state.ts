import type { CanvasImage, Rating } from "./types";

export interface EmbedItem {
  url: string;
  title: string;
  description?: string;
  x: number;
  y: number;
  size?: number;
}

export interface EmbedTextBox {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
}

export interface EmbedData {
  items: EmbedItem[];
  images: CanvasImage[];
  textboxes?: EmbedTextBox[];
  ratings?: Rating[];
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
  return findAvailableEmbedPosition(data, desired, size, size + 42, size + 32);
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
    ...data.items.map((item) => ({
      x: item.x,
      y: item.y,
      w: item.size ?? 96,
      h: (item.size ?? 96) + 42,
    })),
    ...data.images.map((image) => ({ x: image.x, y: image.y, w: image.w, h: image.h })),
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

export function parseEmbedData(source: string): EmbedData {
  const trimmed = source.trim();
  if (!trimmed) return { items: [], images: [] };
  try {
    const parsed = JSON.parse(trimmed) as Partial<EmbedData>;
    if (Array.isArray(parsed?.items)) {
      const data: EmbedData = {
        items: parsed.items,
        images: Array.isArray(parsed.images) ? parsed.images : [],
      };
      if (Array.isArray(parsed.textboxes)) data.textboxes = parsed.textboxes;
      if (Array.isArray(parsed.ratings)) data.ratings = parsed.ratings;
      return data;
    }
  } catch {
    // 坏数据保持可渲染；原文不会在没有用户编辑时被覆盖。
  }
  return { items: [], images: [] };
}

export function createEmptyEmbedBlock(): string {
  return [
    "```web-desk",
    JSON.stringify({ items: [], images: [], textboxes: [], ratings: [] }),
    "```",
  ].join("\n");
}
