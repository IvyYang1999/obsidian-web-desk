import type { CanvasPoint } from "./canvas-state";

interface CanvasPointerSessionOptions {
  event: PointerEvent;
  element: HTMLElement;
  zoom: () => number;
  thresholdPx?: number;
  resizing?: boolean;
  onMove: (delta: CanvasPoint) => void;
  onEnd: (moved: boolean) => void;
}

/** 分组和文本框共用的指针会话：统一缩放换算、阈值、取消与 resize 状态清理。 */
export function beginCanvasPointerSession(options: CanvasPointerSessionOptions): void {
  const { event, element } = options;
  const start = { x: event.clientX, y: event.clientY };
  const threshold = options.thresholdPx ?? 4;
  let moved = false;
  if (options.resizing) element.addClass("is-resizing");
  try { element.setPointerCapture(event.pointerId); } catch {}

  const onMove = (moveEvent: PointerEvent): void => {
    const zoom = Math.max(0.01, options.zoom());
    const delta = {
      x: (moveEvent.clientX - start.x) / zoom,
      y: (moveEvent.clientY - start.y) / zoom,
    };
    if (!moved && Math.hypot(delta.x, delta.y) * zoom < threshold) return;
    moved = true;
    options.onMove(delta);
  };
  const finish = (): void => {
    element.removeEventListener("pointermove", onMove);
    element.removeEventListener("pointerup", finish);
    element.removeEventListener("pointercancel", finish);
    if (options.resizing) element.removeClass("is-resizing");
    options.onEnd(moved);
  };

  element.addEventListener("pointermove", onMove);
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
}
