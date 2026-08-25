export type CanvasWheelIntent =
  | { kind: "pan"; x: number; y: number }
  | { kind: "zoom"; factor: number };

interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

const LINE_HEIGHT_PX = 16;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 2;

function pixelsPerDeltaUnit(deltaMode: number, viewportHeight: number): number {
  if (deltaMode === 1) return LINE_HEIGHT_PX;
  if (deltaMode === 2) return Math.max(1, viewportHeight);
  return 1;
}

/**
 * Convert browser wheel input into device-independent canvas navigation.
 * Chromium reports trackpad pinch as a ctrl-wheel gesture, while two-finger
 * movement and mouse wheels arrive as ordinary wheel deltas.
 */
export function canvasWheelIntent(input: WheelInput, viewportHeight: number): CanvasWheelIntent {
  const unit = pixelsPerDeltaUnit(input.deltaMode, viewportHeight);
  const deltaX = input.deltaX * unit;
  const deltaY = input.deltaY * unit;

  if (input.ctrlKey || input.metaKey) {
    const rawFactor = Math.exp(-deltaY * 0.0022);
    return {
      kind: "zoom",
      factor: Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, rawFactor)),
    };
  }

  return { kind: "pan", x: -deltaX, y: -deltaY };
}
