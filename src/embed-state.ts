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
