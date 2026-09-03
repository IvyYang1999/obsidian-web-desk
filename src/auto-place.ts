import type { BookmarkCard } from "./types";
import { cardPlacementFrame } from "./card-view-state";
import { findFreePosition, type FreeRect } from "./canvas-free-position";

/** 图标容器宽度（含留白），自动排布扩圈步长。 */
const GRID_STEP = 132;
const GRID_ORIGIN = 40;
/** 与画布点阵一致：自动落点对齐 24px，视觉上和手动吸附的对象排在同一网格。 */
const GRID_SNAP = 24;

export interface AutoPlaceOptions {
  /** 已放置卡片之外的其它对象（区域、图片、文本框、评分）矩形，新卡片同样要避开。 */
  occupied?: readonly FreeRect[];
  /** 期望落点中心；缺省时从画布原点附近排起。 */
  origin?: { x: number; y: number };
}

/**
 * 给没有坐标的卡片规划落点：以期望中心（通常是当前视口中心）为起点，
 * 按真实矩形避开所有已有对象后扩圈搜索。返回 path → 坐标；调用方负责写回 frontmatter。
 */
export function planAutoPositions(
  cards: BookmarkCard[],
  options: AutoPlaceOptions = {},
): Map<string, { x: number; y: number }> {
  const occupied: FreeRect[] = [...(options.occupied ?? [])];
  for (const card of cards) {
    if (!card.placed) continue;
    const frame = cardPlacementFrame(card);
    occupied.push({ x: card.x, y: card.y, w: frame.w, h: frame.h });
  }

  const plan = new Map<string, { x: number; y: number }>();
  for (const card of cards) {
    if (card.placed) continue;
    const frame = cardPlacementFrame(card);
    const desired = options.origin
      ? { x: options.origin.x - frame.w / 2, y: options.origin.y - frame.h / 2 }
      : { x: GRID_ORIGIN, y: GRID_ORIGIN };
    const position = findFreePosition(occupied, desired, frame, { step: GRID_STEP, grid: GRID_SNAP, maxRing: 24 });
    occupied.push({ x: position.x, y: position.y, w: frame.w, h: frame.h });
    plan.set(card.path, position);
  }
  return plan;
}
