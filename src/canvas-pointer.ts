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
  const document = element.ownerDocument;
  const start = { x: event.clientX, y: event.clientY };
  const threshold = options.thresholdPx ?? 4;
  const activeButtonMask = event.button === 0
    ? 1
    : event.button === 1
      ? 4
      : event.button === 2
        ? 2
        : event.button >= 3
          ? 2 ** event.button
          : event.buttons;
  let moved = false;
  let finished = false;
  if (options.resizing) element.addClass("is-resizing");
  try { element.setPointerCapture(event.pointerId); } catch {}

  const onMove = (moveEvent: PointerEvent): void => {
    if (moveEvent.pointerId !== event.pointerId) return;
    // Electron can emit a final hover-like pointermove (buttons=0) before the
    // matching pointerup. It is a release boundary, not a new drag sample.
    // Commit the last valid geometry so the stray screen coordinate cannot
    // move an object again or leave snap guides active.
    if (
      moveEvent.pointerType !== "touch" &&
      activeButtonMask > 0 &&
      (moveEvent.buttons & activeButtonMask) === 0
    ) {
      finish(moveEvent);
      return;
    }
    const zoom = Math.max(0.01, options.zoom());
    const delta = {
      x: (moveEvent.clientX - start.x) / zoom,
      y: (moveEvent.clientY - start.y) / zoom,
    };
    if (!moved && Math.hypot(delta.x, delta.y) * zoom < threshold) return;
    moved = true;
    options.onMove(delta);
  };
  const finish = (endEvent: PointerEvent): void => {
    if (endEvent.pointerId !== event.pointerId) return;
    if (finished) return;
    finished = true;
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", finish, true);
    document.removeEventListener("pointercancel", finish, true);
    try { element.releasePointerCapture(event.pointerId); } catch {}
    if (options.resizing) element.removeClass("is-resizing");
    options.onEnd(moved);
  };

  // Capture on the document, not the dragged element. Obsidian can rebuild a
  // Markdown processor between pointerdown and pointerup; an element-scoped
  // listener then misses the commit boundary and the visual move later rolls
  // back. The document remains stable even when the element is detached.
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerup", finish, true);
  document.addEventListener("pointercancel", finish, true);
}
