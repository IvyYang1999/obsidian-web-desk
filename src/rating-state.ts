import type { RatingLink } from "./types";

export type RatingLinkState = "standalone" | "linked" | "missing";

/** 评分组件的基础几何（scale = 1）；两种画布的碰撞、适应内容、找空位都以此为准。 */
export const RATING_WIDTH = 160;
export const RATING_HEIGHT = 56;

export function normalizeRatingValue(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.round(value)));
}

export function ratingLinkState(
  link: RatingLink | undefined,
  availableRefs: ReadonlySet<string>,
): RatingLinkState {
  if (!link) return "standalone";
  return availableRefs.has(link.ref) ? "linked" : "missing";
}
