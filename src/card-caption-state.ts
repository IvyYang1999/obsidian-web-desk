export function normalizeCardCaption(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function applyCardCaptionToFrontmatter(
  frontmatter: Record<string, unknown>,
  value: unknown,
): void {
  const caption = normalizeCardCaption(value);
  if (caption) frontmatter.desk_caption = caption;
  else delete frontmatter.desk_caption;
}
