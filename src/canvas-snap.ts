export const CANVAS_GRID_SIZE = 24;
export const ALIGN_SNAP_THRESHOLD_PX = 6;
export const GRID_SNAP_THRESHOLD_PX = 4;
export const SNAP_RELEASE_THRESHOLD_PX = 10;

export interface SnapRect {
  key?: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapGuide {
  axis: "x" | "y";
  position: number;
  start: number;
  end: number;
}

export interface SnapResult {
  rect: SnapRect;
  guides: SnapGuide[];
}

export interface SnapAxes {
  x?: boolean;
  y?: boolean;
}

interface SnapOptions {
  gridSize?: number;
  alignThresholdPx?: number;
  gridThresholdPx?: number;
  releaseThresholdPx?: number;
}

type Axis = "x" | "y";
type Anchor = "start" | "center" | "end";

interface AxisLock {
  kind: "alignment" | "grid";
  source: Anchor;
  target: number;
}

interface AxisResolution {
  adjustment: number;
  lock: AxisLock | null;
}

export interface CanvasSnapSession {
  move(origin: SnapRect, delta: { x: number; y: number }, zoom: number): SnapResult;
  resize(origin: SnapRect, candidate: SnapRect, zoom: number, axes?: SnapAxes): SnapResult;
  clear(): void;
}

export function canvasGridBackground(
  panX: number,
  panY: number,
  zoom: number,
  gridSize = CANVAS_GRID_SIZE,
): { size: string; position: string } {
  const safeZoom = Math.max(0.01, zoom);
  const visualSize = gridSize * safeZoom;
  // The radial gradient dot is centered inside each tile. Offset half a tile
  // so its center, not its tile edge, represents canvas coordinate 24n.
  return {
    size: `${visualSize}px ${visualSize}px`,
    position: `${panX - visualSize / 2}px ${panY - visualSize / 2}px`,
  };
}

export function snapGuidesMatchingRect(rect: SnapRect, guides: SnapGuide[]): SnapGuide[] {
  return guides.filter((guide) => hasAnchorAt(rect, guide.axis, guide.position, 1.1));
}

/**
 * One pointer gesture owns one session. Alignment engages at a small screen-space
 * threshold and releases at a wider threshold, so the object tracks 1:1 without
 * chattering when the pointer hovers around a snap boundary.
 */
export function createCanvasSnapSession(
  targets: SnapRect[],
  options: SnapOptions = {},
): CanvasSnapSession {
  const gridSize = options.gridSize ?? CANVAS_GRID_SIZE;
  const alignThresholdPx = options.alignThresholdPx ?? ALIGN_SNAP_THRESHOLD_PX;
  const gridThresholdPx = options.gridThresholdPx ?? GRID_SNAP_THRESHOLD_PX;
  const releaseThresholdPx = options.releaseThresholdPx ?? SNAP_RELEASE_THRESHOLD_PX;
  let xLock: AxisLock | null = null;
  let yLock: AxisLock | null = null;

  const snap = (
    candidate: SnapRect,
    zoom: number,
    sourceAnchors: Record<Axis, Anchor[]>,
    gridAnchors: Record<Axis, Anchor>,
    axes: Required<SnapAxes>,
    resizing: boolean,
  ): SnapResult => {
    const safeZoom = Math.max(0.01, zoom);
    const x = axes.x
      ? resolveAxis(candidate, "x", sourceAnchors.x, gridAnchors.x, targets, xLock, {
        gridSize,
        alignThreshold: alignThresholdPx / safeZoom,
        gridThreshold: gridThresholdPx / safeZoom,
        releaseThreshold: releaseThresholdPx / safeZoom,
      })
      : { adjustment: 0, lock: null };
    const y = axes.y
      ? resolveAxis(candidate, "y", sourceAnchors.y, gridAnchors.y, targets, yLock, {
        gridSize,
        alignThreshold: alignThresholdPx / safeZoom,
        gridThreshold: gridThresholdPx / safeZoom,
        releaseThreshold: releaseThresholdPx / safeZoom,
      })
      : { adjustment: 0, lock: null };
    xLock = x.lock;
    yLock = y.lock;

    const rect = { ...candidate };
    if (resizing) rect.w = Math.max(1, candidate.w + x.adjustment);
    else rect.x = candidate.x + x.adjustment;
    if (resizing) rect.h = Math.max(1, candidate.h + y.adjustment);
    else rect.y = candidate.y + y.adjustment;

    return {
      rect: roundedRect(rect),
      guides: guidesFor(rect, targets, x.lock, y.lock),
    };
  };

  return {
    move(origin, delta, zoom) {
      return snap(
        { ...origin, x: origin.x + delta.x, y: origin.y + delta.y },
        zoom,
        { x: ["start", "center", "end"], y: ["start", "center", "end"] },
        { x: "start", y: "start" },
        { x: true, y: true },
        false,
      );
    },
    resize(origin, candidate, zoom, axes = {}) {
      return snap(
        { ...candidate, x: origin.x, y: origin.y },
        zoom,
        { x: ["end"], y: ["end"] },
        { x: "end", y: "end" },
        { x: axes.x !== false, y: axes.y !== false },
        true,
      );
    },
    clear() {
      xLock = null;
      yLock = null;
    },
  };
}

interface ResolveOptions {
  gridSize: number;
  alignThreshold: number;
  gridThreshold: number;
  releaseThreshold: number;
}

function resolveAxis(
  rect: SnapRect,
  axis: Axis,
  sources: Anchor[],
  gridAnchor: Anchor,
  targets: SnapRect[],
  current: AxisLock | null,
  options: ResolveOptions,
): AxisResolution {
  if (current?.kind === "alignment" && sources.includes(current.source)) {
    const adjustment = current.target - anchorValue(rect, axis, current.source);
    if (Math.abs(adjustment) <= options.releaseThreshold) {
      return { adjustment, lock: current };
    }
  }

  let best: { distance: number; adjustment: number; lock: AxisLock; semanticRank: number } | null = null;
  for (const source of sources) {
    const sourceValue = anchorValue(rect, axis, source);
    for (const target of targets) {
      for (const targetAnchor of ["start", "center", "end"] as const) {
        const targetValue = anchorValue(target, axis, targetAnchor);
        const adjustment = targetValue - sourceValue;
        const distance = Math.abs(adjustment);
        if (distance > options.alignThreshold) continue;
        const semanticRank = source === targetAnchor ? 0 : 1;
        if (!best || distance < best.distance || (distance === best.distance && semanticRank < best.semanticRank)) {
          best = {
            distance,
            adjustment,
            semanticRank,
            lock: { kind: "alignment", source, target: targetValue },
          };
        }
      }
    }
  }
  if (best) return { adjustment: best.adjustment, lock: best.lock };

  // Alignment is semantically stronger than the grid. A grid lock may use
  // hysteresis only after the alignment search has had a chance to take over.
  if (current?.kind === "grid" && sources.includes(current.source)) {
    const adjustment = current.target - anchorValue(rect, axis, current.source);
    if (Math.abs(adjustment) <= options.releaseThreshold) {
      return { adjustment, lock: current };
    }
  }

  if (options.gridSize > 0) {
    const sourceValue = anchorValue(rect, axis, gridAnchor);
    const target = Math.round(sourceValue / options.gridSize) * options.gridSize;
    const adjustment = target - sourceValue;
    if (Math.abs(adjustment) <= options.gridThreshold) {
      return { adjustment, lock: { kind: "grid", source: gridAnchor, target } };
    }
  }
  return { adjustment: 0, lock: null };
}

function guidesFor(
  rect: SnapRect,
  targets: SnapRect[],
  xLock: AxisLock | null,
  yLock: AxisLock | null,
): SnapGuide[] {
  const guides: SnapGuide[] = [];
  if (xLock?.kind === "alignment") {
    const aligned = targets.filter((target) => hasAnchorAt(target, "x", xLock.target));
    guides.push({
      axis: "x",
      position: xLock.target,
      start: Math.min(rect.y, ...aligned.map((target) => target.y)),
      end: Math.max(rect.y + rect.h, ...aligned.map((target) => target.y + target.h)),
    });
  }
  if (yLock?.kind === "alignment") {
    const aligned = targets.filter((target) => hasAnchorAt(target, "y", yLock.target));
    guides.push({
      axis: "y",
      position: yLock.target,
      start: Math.min(rect.x, ...aligned.map((target) => target.x)),
      end: Math.max(rect.x + rect.w, ...aligned.map((target) => target.x + target.w)),
    });
  }
  return guides;
}

function hasAnchorAt(rect: SnapRect, axis: Axis, position: number, tolerance = 0.01): boolean {
  return (["start", "center", "end"] as const).some(
    (anchor) => Math.abs(anchorValue(rect, axis, anchor) - position) <= tolerance,
  );
}

function anchorValue(rect: SnapRect, axis: Axis, anchor: Anchor): number {
  const start = axis === "x" ? rect.x : rect.y;
  const size = axis === "x" ? rect.w : rect.h;
  if (anchor === "start") return start;
  if (anchor === "center") return start + size / 2;
  return start + size;
}

function roundedRect(rect: SnapRect): SnapRect {
  return {
    ...(rect.key ? { key: rect.key } : {}),
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
  };
}

export interface CanvasSnapGuideLayer {
  show(guides: SnapGuide[], zoom: number): void;
  hide(): void;
  destroy(): void;
}

/** Two persistent guide nodes avoid allocation churn inside pointermove. */
export function createCanvasSnapGuideLayer(container: HTMLElement): CanvasSnapGuideLayer {
  const vertical = createGuideElement(container, "vertical");
  const horizontal = createGuideElement(container, "horizontal");

  const hide = (): void => {
    vertical.hidden = true;
    horizontal.hidden = true;
  };
  hide();

  return {
    show(guides, zoom) {
      const safeZoom = Math.max(0.01, zoom);
      const x = guides.find((guide) => guide.axis === "x");
      const y = guides.find((guide) => guide.axis === "y");
      if (x) {
        vertical.hidden = false;
        vertical.style.left = `${x.position}px`;
        vertical.style.top = `${x.start}px`;
        vertical.style.width = `${1 / safeZoom}px`;
        vertical.style.height = `${Math.max(1, x.end - x.start)}px`;
      } else vertical.hidden = true;
      if (y) {
        horizontal.hidden = false;
        horizontal.style.left = `${y.start}px`;
        horizontal.style.top = `${y.position}px`;
        horizontal.style.width = `${Math.max(1, y.end - y.start)}px`;
        horizontal.style.height = `${1 / safeZoom}px`;
      } else horizontal.hidden = true;
    },
    hide,
    destroy() {
      vertical.remove();
      horizontal.remove();
    },
  };
}

function createGuideElement(container: HTMLElement, direction: "vertical" | "horizontal"): HTMLElement {
  const element = container.ownerDocument.createElement("div");
  element.className = `web-desk-snap-guide is-${direction}`;
  element.setAttribute("aria-hidden", "true");
  container.appendChild(element);
  return element;
}
