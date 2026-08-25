import type { CardProperties } from "./types";

export function normalizeCardRating(value: unknown): number {
  const numeric = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() ? Number(value) : 0;
  return Number.isFinite(numeric) ? Math.min(5, Math.max(0, Math.round(numeric))) : 0;
}

export function normalizeCardProperties(
  value: Partial<CardProperties>,
  fallbackTitle: string,
): CardProperties {
  const title = typeof value.title === "string" && value.title.trim()
    ? value.title.trim()
    : fallbackTitle.trim();
  return {
    title: title || "无标题",
    rating: normalizeCardRating(value.rating),
    note: typeof value.note === "string" ? value.note.trim() : "",
  };
}

export function applyCardPropertiesToFrontmatter(
  frontmatter: Record<string, unknown>,
  properties: CardProperties,
): void {
  frontmatter.title = properties.title;
  if (properties.rating > 0) frontmatter.desk_rating = normalizeCardRating(properties.rating);
  else delete frontmatter.desk_rating;
  if (properties.note) frontmatter.desk_note = properties.note;
  else delete frontmatter.desk_note;
}
