/** 画布上的轴对齐矩形；两种画布找空位时共用。 */
export interface FreeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FindFreePositionOptions {
  /** 每圈扩散的步长（画布像素）。 */
  step: number;
  /** 候选与已有对象之间的最小间距。 */
  margin?: number;
  /** 最多向外扩多少圈；超过后原样返回期望落点。 */
  maxRing?: number;
  /** 落点对齐到的网格；0 表示不对齐。 */
  grid?: number;
}

/**
 * 从期望落点出发，按“右 → 下 → 左 → 上”顺时针扩圈，找到第一个不与任何已有矩形重叠的位置。
 * 连续添加时优先留在当前可视区域，而不是向左上角逸出。
 */
export function findFreePosition(
  occupied: readonly FreeRect[],
  desired: { x: number; y: number },
  size: { w: number; h: number },
  options: FindFreePositionOptions,
): { x: number; y: number } {
  const margin = options.margin ?? 16;
  const maxRing = options.maxRing ?? 16;
  const grid = options.grid ?? 0;
  const align = (value: number): number => (grid > 0 ? Math.round(value / grid) * grid : Math.round(value));
  const origin = { x: align(desired.x), y: align(desired.y) };

  const isFree = (x: number, y: number): boolean => occupied.every((rect) =>
    x + size.w + margin <= rect.x ||
    rect.x + rect.w + margin <= x ||
    y + size.h + margin <= rect.y ||
    rect.y + rect.h + margin <= y,
  );

  if (isFree(origin.x, origin.y)) return origin;

  for (let ring = 1; ring <= maxRing; ring += 1) {
    for (const offset of ringOffsets(ring)) {
      const x = align(origin.x + offset.column * options.step);
      const y = align(origin.y + offset.row * options.step);
      if (isFree(x, y)) return { x, y };
    }
  }
  return origin;
}

function ringOffsets(ring: number): Array<{ column: number; row: number }> {
  const offsets: Array<{ column: number; row: number }> = [];
  for (let row = 0; row <= ring; row += 1) offsets.push({ column: ring, row });
  for (let column = ring - 1; column >= -ring; column -= 1) offsets.push({ column, row: ring });
  for (let row = ring - 1; row >= -ring; row -= 1) offsets.push({ column: -ring, row });
  for (let column = -ring + 1; column <= ring; column += 1) offsets.push({ column, row: -ring });
  return offsets;
}
