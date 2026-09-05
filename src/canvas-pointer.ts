import type { CanvasPoint } from "./canvas-state";

interface CanvasPointerSessionOptions {
  event: PointerEvent;
  element: HTMLElement;
  zoom: () => number;
  thresholdPx?: number;
  resizing?: boolean;
  /** 当前画布平移量；给了它，会话就会把画布自身的移动从位移里扣掉，对象始终跟着指针。 */
  pan?: () => CanvasPoint;
  /** 每次收到原生 pointermove 时上报指针屏幕坐标，供边缘平移判断。 */
  onPointerMove?: (client: CanvasPoint) => void;
  onMove: (delta: CanvasPoint) => void;
  onEnd: (moved: boolean) => void;
}

export interface CanvasPointerSessionHandle {
  /** 用最后一次指针位置重算位移并派发 onMove；画布自己滚动后靠它让对象继续跟手。 */
  replay: () => void;
}

/** 分组和文本框共用的指针会话：统一缩放换算、阈值、取消与 resize 状态清理。 */
export function beginCanvasPointerSession(options: CanvasPointerSessionOptions): CanvasPointerSessionHandle {
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
  const startPan = options.pan?.() ?? { x: 0, y: 0 };
  let latest = { x: event.clientX, y: event.clientY };
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
    latest = { x: moveEvent.clientX, y: moveEvent.clientY };
    const delta = deltaFor(latest);
    if (!moved && Math.hypot(delta.x, delta.y) * zoomNow() < threshold) return;
    moved = true;
    options.onMove(delta);
    options.onPointerMove?.(latest);
  };

  const zoomNow = (): number => Math.max(0.01, options.zoom());
  /** 扣掉画布自身的平移，位移才是「指针在画布坐标系里走了多远」。 */
  const deltaFor = (client: CanvasPoint): CanvasPoint => {
    const zoom = zoomNow();
    const pan = options.pan?.() ?? { x: 0, y: 0 };
    return {
      x: (client.x - start.x - (pan.x - startPan.x)) / zoom,
      y: (client.y - start.y - (pan.y - startPan.y)) / zoom,
    };
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

  return {
    replay: () => {
      if (finished || !moved) return;
      options.onMove(deltaFor(latest));
    },
  };
}
