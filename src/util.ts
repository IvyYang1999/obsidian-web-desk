import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
};

export interface DesktopNodeApis {
  childProcess: typeof import("child_process");
  fs: typeof import("fs");
  os: typeof import("os");
  path: typeof import("path");
}

const LETTER_COLORS = ["#7aa2f7", "#9ece6a", "#e0af68", "#bb9af7", "#f7768e", "#7dcfff"];

export function createTurndownService(): TurndownService {
  const service = new TurndownService({
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    headingStyle: "atx",
  });
  service.use(gfm);
  return service;
}

export function normalizeInputUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https URL");
  }

  return parsed.toString();
}

export function isProbablyUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function safeName(input: string, maxLength = 60): string {
  const cleaned = (input || "")
    .replace(/[\\/:*?"<>|\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join("").trim() || "无标题";
}

export function cleanInlineText(input: string, maxLength = 120): string {
  const cleaned = (input || "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(cleaned).slice(0, maxLength).join("").trim();
}

export function quoteYaml(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function readJsonResponse(response: { json?: unknown; text: string }): any {
  if (response.json && typeof response.json === "object") {
    return response.json;
  }
  return JSON.parse(response.text);
}

export function collectTweetPhotoUrls(media: any): string[] {
  const urls = new Set<string>();

  for (const photo of media?.photos ?? []) {
    if (typeof photo?.url === "string" && photo.url) {
      urls.add(photo.url);
    }
  }

  for (const item of media?.all ?? []) {
    if (item?.type === "photo" && typeof item.url === "string" && item.url) {
      urls.add(item.url);
    }
  }

  return Array.from(urls);
}

export function toAbsoluteUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

export function absolutizeUrls(root: HTMLElement, baseUrl: string): void {
  root.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((anchor) => {
    const href = anchor.getAttribute("href");
    if (href) {
      anchor.setAttribute("href", toAbsoluteUrl(href, baseUrl));
    }
  });

  root.querySelectorAll<HTMLImageElement>("img[src]").forEach((image) => {
    const src = image.getAttribute("src");
    if (src) {
      image.setAttribute("src", toAbsoluteUrl(src, baseUrl));
    }
  });
}

export function getDesktopNodeApis(): DesktopNodeApis | null {
  const windowWithRequire = window as Window & { require?: NodeRequire };
  const nodeRequire =
    typeof windowWithRequire.require === "function"
      ? windowWithRequire.require
      : typeof require === "function"
        ? require
        : null;

  if (!nodeRequire) {
    return null;
  }

  return {
    childProcess: nodeRequire("child_process"),
    fs: nodeRequire("fs"),
    os: nodeRequire("os"),
    path: nodeRequire("path"),
  };
}

export function execFile(
  childProcess: typeof import("child_process"),
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(String(stderr || error.message || "执行失败").trim()));
          return;
        }
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
        });
      },
    );
  });
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function faviconUrl(host: string): string {
  return `https://icons.duckduckgo.com/ip3/${host}.ico`;
}

export function colorFromString(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return LETTER_COLORS[Math.abs(hash) % LETTER_COLORS.length];
}
