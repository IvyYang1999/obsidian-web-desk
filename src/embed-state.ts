import type { CanvasImage } from "./types";

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
  const occupied: EmbedRect[] = [
    ...data.items.map((item) => ({
      x: item.x,
      y: item.y,
      w: item.size ?? 96,
      h: (item.size ?? 96) + 42,
    })),
    ...data.images.map((image) => ({ x: image.x, y: image.y, w: image.w, h: image.h })),
    ...(data.textboxes ?? []).map((box) => ({ x: box.x, y: box.y, w: box.w, h: box.h })),
  ];
  const step = size + 32;
  const isFree = (x: number, y: number): boolean => {
    const candidate = { x, y, w: size, h: size + 42 };
    const margin = 16;
    return occupied.every((rect) =>
      candidate.x + candidate.w + margin <= rect.x ||
      rect.x + rect.w + margin <= candidate.x ||
      candidate.y + candidate.h + margin <= rect.y ||
      rect.y + rect.h + margin <= candidate.y
    );
  };

  for (let ring = 0; ring <= 16; ring += 1) {
    for (let row = -ring; row <= ring; row += 1) {
      for (let column = -ring; column <= ring; column += 1) {
        if (ring > 0 && Math.max(Math.abs(column), Math.abs(row)) !== ring) continue;
        const x = Math.round(desired.x + column * step);
        const y = Math.round(desired.y + row * step);
        if (isFree(x, y)) return { x, y };
      }
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
    JSON.stringify({ items: [], images: [], textboxes: [] }),
    "```",
  ].join("\n");
}
