import { requestUrl } from "obsidian";
import { REQUEST_HEADERS } from "./util";
import {
  assessEmbedHeaders,
  isRememberedBlockedHost,
  normalizeEmbeddableUrl,
  type EmbedAssessment,
} from "./web-embed-policy";

export async function assessRemoteEmbed(
  rawUrl: string,
  blockedHosts: readonly string[],
): Promise<EmbedAssessment> {
  const url = normalizeEmbeddableUrl(rawUrl);
  if (!url) return { allowed: false, reason: "invalid-url" };
  if (isRememberedBlockedHost(blockedHosts, url)) {
    return { allowed: false, reason: "remembered" };
  }
  try {
    const response = await requestUrl({
      url,
      method: "HEAD",
      headers: REQUEST_HEADERS,
      throw: false,
    });
    return assessEmbedHeaders(response.headers ?? {});
  } catch {
    // 无法预检不代表无法在 iframe 打开；保留尝试机会，并在嵌入底栏提供降级入口。
    return { allowed: true, reason: "unknown" };
  }
}
