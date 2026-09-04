/**
 * 有限画布（“房间”）：画布不再是无边虚空，而是一张会自己长大的纸。
 *
 * 房间尺寸完全由内容推导——内容包围盒外扩一圈留白即是墙，所以扩张和收缩都自动发生，
 * 用户得到的是“有边界感”而不是“要管边界”，也不需要任何持久化字段。
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

/** 越过墙还能再推一点点，滚动到头有“顶住”的手感而不是硬停。 */
export function roomSlack(viewport: Viewport): number {
  return Math.min(72, Math.max(24, Math.min(viewport.width, viewport.height) * 0.08));
}

function clampAxis(
  pan: number,
  roomStart: number,
  roomSize: number,
  zoom: number,
  viewportSize: number,
  slack: number,
): number {
  const screenStart = pan + roomStart * zoom;
  const screenSize = roomSize * zoom;
  let min: number;
  let max: number;
  if (screenSize >= viewportSize) {
    // 房间比视口大：墙不能被拖进视口内侧，否则会看到纸外的空白。
    min = viewportSize - screenSize - slack;
    max = slack;
  } else {
    // 房间比视口小：整张纸留在视口里，允许在其中自由摆放。
    min = -slack;
    max = viewportSize - screenSize + slack;
  }
  const clamped = Math.min(max, Math.max(min, screenStart));
  return pan + (clamped - screenStart);
}

/** 把平移量约束在房间可见范围内；缩放、拖拽平移、滚轮平移之后都要过这一道。 */
export function clampPanToRoom(
  pan: { x: number; y: number },
  zoom: number,
  room: RoomRect,
  viewport: Viewport,
): { x: number; y: number } {
  if (viewport.width <= 0 || viewport.height <= 0) return pan;
  const slack = roomSlack(viewport);
  return {
    x: clampAxis(pan.x, room.x, room.w, zoom, viewport.width, slack),
    y: clampAxis(pan.y, room.y, room.h, zoom, viewport.height, slack),
  };
}

/** 缩放下限：让整张纸至少能被一眼看完，再往下缩就只是把纸推远，没有意义。 */
export function minZoomForRoom(room: RoomRect, viewport: Viewport, floor: number): number {
  if (viewport.width <= 0 || viewport.height <= 0) return floor;
  const fit = Math.min(viewport.width / Math.max(1, room.w), viewport.height / Math.max(1, room.h));
  return Math.max(floor, Math.min(1, fit * 0.75));
}
