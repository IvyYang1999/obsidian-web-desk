/**
 * 有限画布（“房间”）：画布不再是无边虚空，但墙是看不见的。
 *
 * 像 macOS 的文件夹图标视图——你看不到边界，只是滚到头就滚不动了，把图标往边缘拖，
 * 空间自己延展。房间尺寸完全由内容推导，扩张和收缩都自动发生，没有任何持久化字段。
 */

export interface RoomRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** 内容与墙之间的留白（画布坐标）。 */
export const ROOM_PADDING = 120;
/** 与点阵同一坐标系，墙落在网格线上。 */
const ROOM_GRID = 24;
/**
 * 空画布时的房间尺寸；不给最小值的话，新用户会看到一张巴掌大的纸。
 * 取 24 的整数倍，这样对半居中后墙仍然落在网格线上。
 */
export const ROOM_MIN_WIDTH = 54 * ROOM_GRID; // 1296
export const ROOM_MIN_HEIGHT = 32 * ROOM_GRID; // 768

/** 先把范围对齐到网格，再按网格步长对称补足到最小尺寸，保证 start 与 size 始终对齐。 */
function alignAndGrow(from: number, to: number, min: number): { start: number; size: number } {
  const start = Math.floor(from / ROOM_GRID) * ROOM_GRID;
  const size = Math.ceil(to / ROOM_GRID) * ROOM_GRID - start;
  if (size >= min) return { start, size };
  const extra = Math.ceil((min - size) / 2 / ROOM_GRID) * ROOM_GRID;
  return { start: start - extra, size: size + extra * 2 };
}

/**
 * 由内容包围盒推导房间。没有内容时给一张居中的空纸。
 * 房间只跟内容有关，与当前缩放无关，这样缩放时墙不会跟着呼吸。
 */
export function deriveRoom(bounds: ContentBounds | null, padding = ROOM_PADDING): RoomRect {
  if (!bounds || !Number.isFinite(bounds.minX)) {
    return { x: -ROOM_MIN_WIDTH / 2, y: -ROOM_MIN_HEIGHT / 2, w: ROOM_MIN_WIDTH, h: ROOM_MIN_HEIGHT };
  }
  const horizontal = alignAndGrow(bounds.minX - padding, bounds.maxX + padding, ROOM_MIN_WIDTH);
  const vertical = alignAndGrow(bounds.minY - padding, bounds.maxY + padding, ROOM_MIN_HEIGHT);
  return { x: horizontal.start, y: vertical.start, w: horizontal.size, h: vertical.size };
}

/** 手势中最多能把墙拉过头多少屏幕像素；松手后回弹。 */
export const MAX_OVERSCROLL = 96;

function clampAxis(
  pan: number,
  roomStart: number,
  roomSize: number,
  zoom: number,
  viewportSize: number,
): number {
  const screenStart = pan + roomStart * zoom;
  const screenSize = roomSize * zoom;
  let min: number;
  let max: number;
  if (screenSize >= viewportSize) {
    // 房间比视口大：墙贴到视口边缘就是尽头，再滚也不动。
    min = viewportSize - screenSize;
    max = 0;
  } else {
    // 房间比视口小：整个房间留在视口内。
    min = 0;
    max = viewportSize - screenSize;
  }
  const clamped = Math.min(max, Math.max(min, screenStart));
  return pan + (clamped - screenStart);
}

/** 硬边界：手势结束、缩放、适应内容之后都归到这里。 */
export function clampPanToRoom(
  pan: { x: number; y: number },
  zoom: number,
  room: RoomRect,
  viewport: Viewport,
): { x: number; y: number } {
  if (viewport.width <= 0 || viewport.height <= 0) return pan;
  return {
    x: clampAxis(pan.x, room.x, room.w, zoom, viewport.width),
    y: clampAxis(pan.y, room.y, room.h, zoom, viewport.height),
  };
}

/**
 * 超出边界的部分随距离渐近饱和，越拉越沉，永远拉不过 MAX_OVERSCROLL。
 * 这是 macOS 橡皮筋的手感：能拉一点，但拉不走。
 */
function dampen(overshoot: number, max: number): number {
  if (overshoot === 0) return 0;
  const magnitude = Math.abs(overshoot);
  return Math.sign(overshoot) * max * (1 - 1 / (1 + magnitude / max));
}

/** 手势进行中的位置：允许拉过墙，但有阻尼。松手后调用 clampPanToRoom 回弹。 */
export function elasticPanToRoom(
  pan: { x: number; y: number },
  zoom: number,
  room: RoomRect,
  viewport: Viewport,
  max = MAX_OVERSCROLL,
): { x: number; y: number } {
  if (viewport.width <= 0 || viewport.height <= 0) return pan;
  const hard = clampPanToRoom(pan, zoom, room, viewport);
  return {
    x: hard.x + dampen(pan.x - hard.x, max),
    y: hard.y + dampen(pan.y - hard.y, max),
  };
}

/** 缩放下限：让整张纸至少能被一眼看完，再往下缩就只是把纸推远，没有意义。 */
export function minZoomForRoom(room: RoomRect, viewport: Viewport, floor: number): number {
  if (viewport.width <= 0 || viewport.height <= 0) return floor;
  const fit = Math.min(viewport.width / Math.max(1, room.w), viewport.height / Math.max(1, room.h));
  return Math.max(floor, Math.min(1, fit * 0.75));
}
