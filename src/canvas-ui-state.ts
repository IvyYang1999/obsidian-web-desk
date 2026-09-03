export type CardStyle = "visual" | "article" | "compact";

export interface CanvasContentCounts {
  cards: number;
  images: number;
  textboxes: number;
  groups: number;
  arrows: number;
  ratings: number;
  pending?: number;
}

export interface PendingWebCard {
  id: string;
  url: string;
  x: number;
  y: number;
  state: "loading" | "error";
  purpose?: "import" | "embed";
  title?: string;
  message?: string;
}

export function normalizeCardStyle(value: unknown): CardStyle {
  return value === "visual" || value === "compact" ? value : "article";
}

export function hasCanvasContent(counts: CanvasContentCounts): boolean {
  return Object.values(counts).some((count) => count > 0);
}
