export function normalizeCanvasHexColor(value: string): string | null {
  const trimmed = value.trim();
  const short = /^#([0-9a-f]{3})$/i.exec(trimmed);
  if (short) {
    return `#${[...short[1]].map((part) => part + part).join("")}`.toLowerCase();
  }
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function canvasColorInputValue(value: string, fallback: string): string {
  return normalizeCanvasHexColor(value) ?? normalizeCanvasHexColor(fallback) ?? "#7aa2f7";
}
