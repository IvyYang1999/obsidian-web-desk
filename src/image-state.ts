import type { CanvasImage } from "./types";

export const DEFAULT_IMAGE_MAX_WIDTH = 360;
export const DEFAULT_IMAGE_MAX_HEIGHT = 260;
export const MIN_IMAGE_WIDTH = 80;
export const MAX_IMAGE_WIDTH = 2000;

export function fitImageWithin(
  sourceWidth: number,
  sourceHeight: number,
  maxWidth = DEFAULT_IMAGE_MAX_WIDTH,
  maxHeight = DEFAULT_IMAGE_MAX_HEIGHT,
): { w: number; h: number } {
  const width = positive(sourceWidth, 1);
  const height = positive(sourceHeight, 1);
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    w: Math.max(1, Math.round(width * scale)),
    h: Math.max(1, Math.round(height * scale)),
  };
}

export function resizeImageToWidth(
  image: Pick<CanvasImage, "w" | "h">,
  requestedWidth: number,
): { w: number; h: number } {
  const width = Math.min(MAX_IMAGE_WIDTH, Math.max(MIN_IMAGE_WIDTH, requestedWidth));
  const ratio = positive(image.w, 1) / positive(image.h, 1);
  return { w: width, h: Math.max(1, width / ratio) };
}

export function sanitizeImageFileName(rawName: string, mimeType: string): string {
  const leaf = rawName.split(/[\\/]/).pop()?.trim() ?? "";
  const fallbackExt = extensionForMime(mimeType);
  let safe = leaf || `image-${Date.now()}.${fallbackExt}`;
  safe = safe.replace(/^\.+/, "").replace(/\s+/g, "-").replace(/[:*?"<>|#[\]^]/g, "-");
  if (!safe) safe = `image-${Date.now()}.${fallbackExt}`;
  if (!/\.[a-z0-9]{2,8}$/i.test(safe)) safe += `.${fallbackExt}`;
  return safe;
}

export function nextAvailableImagePath(
  folder: string,
  fileName: string,
  exists: (candidate: string) => boolean,
): string {
  const cleanFolder = folder.replace(/^\/+|\/+$/g, "");
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : "";
  const join = (name: string): string => cleanFolder ? `${cleanFolder}/${name}` : name;
  let candidate = join(`${base}${ext}`);
  let suffix = 2;
  while (exists(candidate)) {
    candidate = join(`${base} ${suffix}${ext}`);
    suffix += 1;
  }
  return candidate;
}

function extensionForMime(mimeType: string): string {
  const known: Record<string, string> = {
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/svg+xml": "svg",
    "image/webp": "webp",
  };
  return known[mimeType.toLowerCase()] ?? "png";
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
