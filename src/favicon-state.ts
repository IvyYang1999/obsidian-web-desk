/** 网站图标来源与择优规则；不依赖 Obsidian，便于单测。 */

/** 低于此宽度的图标放到 96px 缩略图上已经明显发虚，直接改用首字母色块。 */
export const MIN_USABLE_FAVICON_SIZE = 24;
/** 第一个来源已达到此尺寸时不再尝试后备来源。 */
export const PREFERRED_FAVICON_SIZE = 64;
export const FAVICON_FOLDER = "网站图标";

export interface FaviconCandidate {
  url: string;
  source: "google" | "duckduckgo";
}

export interface FaviconSample {
  source: FaviconCandidate["source"];
  width: number;
  height: number;
  contentType: string;
  bytes: ArrayBuffer;
}

export function normalizeFaviconHost(input: string): string {
  const host = input.trim().toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9.-]+$/.test(host) ? host : "";
}

/** 按优先级列出图标来源：Google 能给到 128px，DuckDuckGo 常有 64px 的 ico 作后备。 */
export function faviconCandidates(host: string): FaviconCandidate[] {
  const normalized = normalizeFaviconHost(host);
  if (!normalized) return [];
  return [
    {
      source: "google",
      url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(normalized)}&sz=128`,
    },
    {
      source: "duckduckgo",
      url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalized)}.ico`,
    },
  ];
}

export function isImageContentType(contentType: unknown): boolean {
  return typeof contentType === "string" && /^image\//i.test(contentType.trim());
}

export function faviconExtension(contentType: string): string {
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "image/svg+xml") return "svg";
  return "ico";
}

export function faviconFileName(host: string, extension: string): string {
  const safe = normalizeFaviconHost(host).replace(/[^a-z0-9.-]+/g, "-");
  return `${safe}.${extension}`;
}

/** 已有样本是否足够好，可以省掉后续请求。 */
export function isPreferredFavicon(sample: FaviconSample | null): boolean {
  return Boolean(sample && Math.min(sample.width, sample.height) >= PREFERRED_FAVICON_SIZE);
}

/** 从多份样本里挑最大且可用的一份；全部太小则返回 null，让调用方走首字母。 */
export function pickBestFavicon(samples: readonly (FaviconSample | null)[]): FaviconSample | null {
  let best: FaviconSample | null = null;
  for (const sample of samples) {
    if (!sample) continue;
    const size = Math.min(sample.width, sample.height);
    if (size < MIN_USABLE_FAVICON_SIZE) continue;
    if (!best || size > Math.min(best.width, best.height)) best = sample;
  }
  return best;
}
