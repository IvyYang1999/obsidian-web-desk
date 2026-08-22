import type { RatingLink } from "./types";

export type RatingLinkState = "standalone" | "linked" | "missing";

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
