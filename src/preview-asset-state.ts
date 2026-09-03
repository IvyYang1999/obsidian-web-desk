const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export function previewAssetExtension(contentType: unknown, sourceUrl: string): string | null {
  const mime = typeof contentType === "string"
    ? contentType.split(";", 1)[0].trim().toLowerCase()
    : "";
  if (mime) return MIME_EXTENSIONS[mime] ?? null;
  try {
    const extension = new URL(sourceUrl).pathname.split(".").pop()?.toLowerCase() ?? "";
    return ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension)
      ? extension.replace("jpeg", "jpg")
      : null;
  } catch {
    return null;
  }
}

export function previewAssetName(pageUrl: string, extension: string): string {
  let host = "web";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  } catch {
    // Invalid page URLs retain the neutral prefix; the digest still keeps names stable.
  }
  return `${host || "web"}-${stableDigest(pageUrl)}.${extension}`;
}

export function isSafePreviewPageUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function stableDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
