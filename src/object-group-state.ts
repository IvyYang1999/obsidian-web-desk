export interface GroupObjectRect {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export interface GroupBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function objectGroupBounds(objects: GroupObjectRect[]): GroupBounds | null {
  if (objects.length === 0) return null;
  const left = Math.min(...objects.map((object) => object.x));
  const top = Math.min(...objects.map((object) => object.y));
  const right = Math.max(...objects.map((object) => object.x + object.w));
  const bottom = Math.max(...objects.map((object) => object.y + object.h));
  return {
    x: Math.round(left),
    y: Math.round(top),
    w: Math.round(right - left),
    h: Math.round(bottom - top),
  };
}

export function translateObjectGroup(
  objects: GroupObjectRect[],
  delta: { x: number; y: number },
): GroupObjectRect[] {
  return objects.map((object) => ({
    ...object,
    x: Math.round(object.x + delta.x),
    y: Math.round(object.y + delta.y),
  }));
}

export function scaleObjectGroup(
  objects: GroupObjectRect[],
  requestedScale: number,
): { scale: number; objects: GroupObjectRect[] } {
  const bounds = objectGroupBounds(objects);
  if (!bounds) return { scale: 1, objects: [] };

  let minScale = 0.05;
  let maxScale = Number.POSITIVE_INFINITY;
  for (const object of objects) {
    if (object.minW !== undefined && object.w > 0) minScale = Math.max(minScale, object.minW / object.w);
    if (object.minH !== undefined && object.h > 0) minScale = Math.max(minScale, object.minH / object.h);
    if (object.maxW !== undefined && object.w > 0) maxScale = Math.min(maxScale, object.maxW / object.w);
    if (object.maxH !== undefined && object.h > 0) maxScale = Math.min(maxScale, object.maxH / object.h);
  }
  const scale = Math.min(maxScale, Math.max(minScale, requestedScale));
  return {
    scale,
    objects: objects.map((object) => ({
      ...object,
      x: Math.round(bounds.x + (object.x - bounds.x) * scale),
      y: Math.round(bounds.y + (object.y - bounds.y) * scale),
      w: Math.round(object.w * scale),
      h: Math.round(object.h * scale),
    })),
  };
}

export function objectKey(kind: "card" | "image" | "textbox" | "rating", id: string): string {
  return `${kind}:${id}`;
}

export function splitObjectKey(key: string): { kind: "card" | "image" | "textbox" | "rating"; id: string } | null {
  const separator = key.indexOf(":");
  if (separator < 1) return null;
  const kind = key.slice(0, separator);
  if (kind !== "card" && kind !== "image" && kind !== "textbox" && kind !== "rating") return null;
  return { kind, id: key.slice(separator + 1) };
}
