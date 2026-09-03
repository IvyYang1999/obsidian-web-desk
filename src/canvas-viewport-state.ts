export type CanvasZoomBand = "near" | "mid" | "far";

/**
 * 语义缩放档位：缩小到一定程度后，说明、摘要、标题依次让位给图标本身，
 * 区域名则反向放大保持屏幕尺寸，让缩小视图真正可导航。
 */
export function canvasZoomBand(zoom: number): CanvasZoomBand {
  if (zoom < 0.45) return "far";
  if (zoom < 0.75) return "mid";
  return "near";
}

/** 把缩放档位和当前倍率写到画布根节点，供 CSS 做语义缩放。 */
export function applyCanvasZoomBand(root: HTMLElement, zoom: number): void {
  root.setAttribute("data-zoom-band", canvasZoomBand(zoom));
  root.style.setProperty("--wd-zoom", String(zoom));
}

export interface CanvasChromeInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CanvasSafeViewport extends CanvasChromeInsets {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

/** Screen-space area that remains unobstructed by persistent canvas chrome. */
export function canvasSafeViewport(width: number, height: number): CanvasSafeViewport {
  const compact = width <= 520;
  const insets: CanvasChromeInsets = compact
    ? { top: 16, right: 16, bottom: 116, left: 16 }
    : { top: 20, right: 20, bottom: 64, left: 64 };
  const safeWidth = Math.max(1, width - insets.left - insets.right);
  const safeHeight = Math.max(1, height - insets.top - insets.bottom);
  return {
    ...insets,
    width: safeWidth,
    height: safeHeight,
    centerX: insets.left + safeWidth / 2,
    centerY: insets.top + safeHeight / 2,
  };
}

export function fitCanvasBounds(
  viewportWidth: number,
  viewportHeight: number,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  minZoom: number,
  maxZoom: number,
): { zoom: number; panX: number; panY: number } {
  const viewport = canvasSafeViewport(viewportWidth, viewportHeight);
  const contentWidth = Math.max(1, bounds.maxX - bounds.minX);
  const contentHeight = Math.max(1, bounds.maxY - bounds.minY);
  const zoom = Math.min(
    maxZoom,
    Math.max(minZoom, Math.min(viewport.width / contentWidth, viewport.height / contentHeight)),
  );
  return {
    zoom,
    panX: viewport.left + (viewport.width - contentWidth * zoom) / 2 - bounds.minX * zoom,
    panY: viewport.top + (viewport.height - contentHeight * zoom) / 2 - bounds.minY * zoom,
  };
}
