export interface EmbedAssessment {
  allowed: boolean;
  reason: "unknown" | "x-frame-options" | "frame-ancestors" | "invalid-url" | "remembered";
}

export function normalizeEmbeddableUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function assessEmbedHeaders(headers: Record<string, string>): EmbedAssessment {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).toLowerCase()]),
  );
  const frameOptions = normalized["x-frame-options"]?.trim();
  if (frameOptions && frameOptions !== "allowall") {
    return { allowed: false, reason: "x-frame-options" };
  }
  const csp = normalized["content-security-policy"] ?? "";
  const ancestors = csp.match(/(?:^|;)\s*frame-ancestors\s+([^;]+)/i)?.[1]?.trim();
  if (ancestors && !ancestors.split(/\s+/).some((entry) => entry === "*" || entry.startsWith("app:"))) {
    return { allowed: false, reason: "frame-ancestors" };
  }
  return { allowed: true, reason: "unknown" };
}

export function embedHost(value: unknown): string | null {
  const normalized = normalizeEmbeddableUrl(value);
  return normalized ? new URL(normalized).hostname.toLowerCase() : null;
}

export function rememberBlockedEmbedHost(
  current: readonly string[],
  url: string,
  limit = 100,
): string[] {
  const host = embedHost(url);
  const unique = current
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry, index, all) => entry && all.indexOf(entry) === index && entry !== host);
  if (host) unique.push(host);
  return unique.slice(-Math.max(1, limit));
}

export function isRememberedBlockedHost(current: readonly string[], url: string): boolean {
  const host = embedHost(url);
  return host !== null && current.some((entry) => entry.trim().toLowerCase() === host);
}
