export type CardViewMode = "icon" | "preview" | "embed";

export const DEFAULT_PREVIEW_WIDTH = 320;
export const DEFAULT_PREVIEW_HEIGHT = 240;
export const MIN_PREVIEW_WIDTH = 220;
export const MIN_PREVIEW_HEIGHT = 160;
export const MAX_PREVIEW_WIDTH = 720;
export const MAX_PREVIEW_HEIGHT = 640;

export interface CardPlacement {
  x: number;
  y: number;
  size: number;
  viewMode?: CardViewMode;
  previewWidth?: number;
  previewHeight?: number;
}

export function normalizeCardViewMode(value: unknown): CardViewMode {
  return value === "preview" || value === "embed" ? value : "icon";
}

export function cardPlacementFrame(
  placement: Pick<CardPlacement, "size" | "viewMode" | "previewWidth" | "previewHeight">,
): { w: number; h: number } {
  if (normalizeCardViewMode(placement.viewMode) !== "icon") {
    return {
      w: clampNumber(placement.previewWidth, DEFAULT_PREVIEW_WIDTH, MIN_PREVIEW_WIDTH, MAX_PREVIEW_WIDTH),
      h: clampNumber(placement.previewHeight, DEFAULT_PREVIEW_HEIGHT, MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT),
    };
  }
  const size = clampNumber(placement.size, 96, 32, 320);
  return { w: size + 24, h: size + 44 };
}

export function switchCardViewMode<T extends CardPlacement>(
  placement: T,
  viewMode: CardViewMode,
): T {
  const current = cardPlacementFrame(placement);
  const next = cardPlacementFrame({ ...placement, viewMode });
  return {
    ...placement,
    x: Math.round(placement.x + (current.w - next.w) / 2),
    y: Math.round(placement.y + (current.h - next.h) / 2),
    viewMode,
  };
}

export function resizeCardPlacement<T extends CardPlacement>(
  placement: T,
  delta: { x: number; y: number },
): T {
  if (normalizeCardViewMode(placement.viewMode) !== "icon") {
    const frame = cardPlacementFrame(placement);
    return {
      ...placement,
      previewWidth: clampNumber(frame.w + delta.x, frame.w, MIN_PREVIEW_WIDTH, MAX_PREVIEW_WIDTH),
      previewHeight: clampNumber(frame.h + delta.y, frame.h, MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT),
    };
  }
  const sizeDelta = Math.abs(delta.x) >= Math.abs(delta.y) ? delta.x : delta.y;
  return {
    ...placement,
    size: clampNumber(placement.size + sizeDelta, placement.size, 32, 320),
  };
}

export function scaleCardPlacement<T extends CardPlacement>(
  placement: T,
  scale: number,
  originFrame = cardPlacementFrame(placement),
): T {
  if (normalizeCardViewMode(placement.viewMode) !== "icon") {
    return {
      ...placement,
      previewWidth: clampNumber(originFrame.w * scale, originFrame.w, MIN_PREVIEW_WIDTH, MAX_PREVIEW_WIDTH),
      previewHeight: clampNumber(originFrame.h * scale, originFrame.h, MIN_PREVIEW_HEIGHT, MAX_PREVIEW_HEIGHT),
    };
  }
  return {
    ...placement,
    size: clampNumber((originFrame.w - 24) * scale, placement.size, 32, 320),
  };
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, number));
}
