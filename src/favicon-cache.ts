import { App, normalizePath, requestUrl, TFile } from "obsidian";
import {
  FAVICON_FOLDER,
  faviconCandidates,
  faviconExtension,
  faviconFileName,
  isImageContentType,
  isPreferredFavicon,
  normalizeFaviconHost,
  pickBestFavicon,
  type FaviconSample,
} from "./favicon-state";
import { REQUEST_HEADERS } from "./util";

const MAX_FAVICON_BYTES = 512 * 1024;
const FAVICON_EXTENSIONS = ["png", "ico", "jpg", "webp", "gif", "svg"];

export type FaviconResolve = (host: string) => Promise<string | null>;

/**
 * 网站图标解析：先查 Vault 缓存，再按来源优先级抓取，挑最大的一份落盘。
 * 同一会话内每个域名只请求一次；失败结果也记住，避免画布刷新时反复打网络。
 */
export class FaviconResolver {
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(
    private readonly app: App,
    private readonly getImageFolder: () => string,
  ) {}

  resolve: FaviconResolve = (host) => {
    const normalized = normalizeFaviconHost(host);
    if (!normalized) return Promise.resolve(null);
    let task = this.pending.get(normalized);
    if (!task) {
      task = this.lookup(normalized).catch(() => null);
      this.pending.set(normalized, task);
    }
    return task;
  };

  /** 域名对应的缓存文件被删除或图标源变化时，允许下次重新抓取。 */
  forget(host: string): void {
    this.pending.delete(normalizeFaviconHost(host));
  }

  private folder(): string {
    return normalizePath(`${this.getImageFolder().trim() || "附件/网页桌面"}/${FAVICON_FOLDER}`);
  }

  private cachedFile(host: string): TFile | null {
    const folder = this.folder();
    for (const extension of FAVICON_EXTENSIONS) {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${faviconFileName(host, extension)}`));
      if (file instanceof TFile) return file;
    }
    return null;
  }

  private async lookup(host: string): Promise<string | null> {
    const cached = this.cachedFile(host);
    if (cached) return this.app.vault.getResourcePath(cached);

    const samples: Array<FaviconSample | null> = [];
    for (const candidate of faviconCandidates(host)) {
      const sample = await this.fetchSample(candidate.url, candidate.source);
      samples.push(sample);
      if (isPreferredFavicon(sample)) break;
    }
    const best = pickBestFavicon(samples);
    if (!best) return null;

    try {
      const folder = this.folder();
      await ensureFolder(this.app, folder);
      const path = normalizePath(`${folder}/${faviconFileName(host, faviconExtension(best.contentType))}`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      const file = existing instanceof TFile ? existing : await this.app.vault.createBinary(path, best.bytes);
      return this.app.vault.getResourcePath(file);
    } catch {
      // 落盘失败（只读 Vault、同步冲突）时退回内存 data URL，本次会话依然清晰。
      return dataUrl(best.contentType, best.bytes);
    }
  }

  private async fetchSample(url: string, source: FaviconSample["source"]): Promise<FaviconSample | null> {
    try {
      const response = await requestUrl({ url, method: "GET", headers: REQUEST_HEADERS, throw: false });
      if (response.status < 200 || response.status >= 300) return null;
      const contentType = response.headers?.["content-type"] ?? "";
      if (!isImageContentType(contentType)) return null;
      const bytes = response.arrayBuffer;
      if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_FAVICON_BYTES) return null;
      const size = await measureImage(contentType, bytes);
      if (!size) return null;
      return { source, width: size.width, height: size.height, contentType, bytes };
    } catch {
      return null;
    }
  }
}

function dataUrl(contentType: string, bytes: ArrayBuffer): string {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let index = 0; index < view.length; index += 1) binary += String.fromCharCode(view[index]);
  return `data:${contentType.split(";", 1)[0].trim()};base64,${btoa(binary)}`;
}

function measureImage(contentType: string, bytes: ArrayBuffer): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([bytes], { type: contentType.split(";", 1)[0].trim() }));
    const image = new Image();
    const finish = (value: { width: number; height: number } | null): void => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    image.onload = () => finish(image.naturalWidth > 0 ? { width: image.naturalWidth, height: image.naturalHeight } : null);
    image.onerror = () => finish(null);
    image.src = url;
  });
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}
