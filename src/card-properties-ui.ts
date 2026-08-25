import { setIcon } from "obsidian";
import { normalizeCardRating } from "./card-properties-state";

export function renderCardPropertyIndicators(
  thumb: HTMLElement,
  ratingValue: unknown,
  noteValue: unknown,
): void {
  const rating = normalizeCardRating(ratingValue);
  const note = typeof noteValue === "string" ? noteValue.trim() : "";
  if (rating > 0) {
    thumb.createDiv({
      cls: "web-desk-card-rating-badge",
      text: `${rating}★`,
      attr: { "aria-label": `${rating} 星` },
    });
  }
  if (note) {
    const noteBadge = thumb.createDiv({
      cls: "web-desk-card-note-badge",
      attr: { title: note, "aria-label": `备注：${note}` },
    });
    setIcon(noteBadge, "message-square-text");
  }
}

export function cardAccessibleLabel(
  title: string,
  target: string,
  ratingValue: unknown,
  noteValue: unknown,
): string {
  const rating = normalizeCardRating(ratingValue);
  const note = typeof noteValue === "string" ? noteValue.trim() : "";
  return [title, rating > 0 ? `评分：${rating}/5` : "", note ? `备注：${note}` : "", target]
    .filter(Boolean)
    .join("\n");
}
