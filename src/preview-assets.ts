import { App, normalizePath, Platform, requestUrl, TFile } from "obsidian";
import { isSafePreviewPageUrl, previewAssetExtension, previewAssetName } from "./preview-asset-state";
import type { WebDeskSettings } from "./types";
import { REQUEST_HEADERS } from "./util";

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const CAPTURE_TIMEOUT_MS = 15_000;

export async function localizeWebsitePreview(
  app: App,
  settings: WebDeskSettings,
  pageUrl: string,
  remoteImage: string,
): Promise<string> {
  const folder = normalizePath(`${settings.imageFolder.trim() || "附件/网页桌面"}/网页预览`);
  await ensureFolder(app, folder);
  if (remoteImage) {
    try {
      return await downloadPreview(app, folder, pageUrl, remoteImage);
    } catch {
      // OG 图不可下载时继续使用本地网页截图，不让导入整体失败。
    }
  }
  if (Platform.isDesktopApp) {
    try {
      return await capturePreview(app, folder, pageUrl);
    } catch {
      // 当前 Electron 不暴露安全的离屏窗口时，保留远程图或视觉 fallback。
    }
  }
  return remoteImage;
}

export function previewImageSource(app: App, value: string | undefined): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  const file = app.vault.getAbstractFileByPath(normalizePath(value));
  return file instanceof TFile ? app.vault.getResourcePath(file) : "";
}

async function downloadPreview(
  app: App,
  folder: string,
  pageUrl: string,
  remoteImage: string,
): Promise<string> {
  const response = await requestUrl({
    url: remoteImage,
    method: "GET",
    headers: REQUEST_HEADERS,
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  const extension = previewAssetExtension(response.headers?.["content-type"], remoteImage);
  if (!extension) throw new Error("不是受支持的预览图片");
  if (response.arrayBuffer.byteLength > MAX_PREVIEW_BYTES) throw new Error("预览图片过大");
  const path = normalizePath(`${folder}/${previewAssetName(pageUrl, extension)}`);
  if (!app.vault.getAbstractFileByPath(path)) await app.vault.createBinary(path, response.arrayBuffer);
  return path;
}

async function capturePreview(app: App, folder: string, pageUrl: string): Promise<string> {
  if (!isSafePreviewPageUrl(pageUrl)) throw new Error("网页截图只允许 HTTPS");
  const BrowserWindow = electronBrowserWindow();
  if (!BrowserWindow) throw new Error("当前环境不支持离屏网页截图");
  const path = normalizePath(`${folder}/${previewAssetName(pageUrl, "png")}`);
  if (app.vault.getAbstractFileByPath(path)) return path;
  const browser = new BrowserWindow({
    show: false,
    width: 1200,
    height: 750,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: `web-desk-preview-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
  const previewSession = browser.webContents.session;
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.setDevicePermissionHandler?.(() => false);
  let blockedInsecureNavigation = false;
  const rejectInsecureNavigation = (event: NavigationEvent, targetUrl: string): void => {
    if (isSafePreviewPageUrl(targetUrl)) return;
    blockedInsecureNavigation = true;
    event.preventDefault();
  };
  browser.webContents.on?.("will-redirect", rejectInsecureNavigation);
  browser.webContents.on?.("will-navigate", rejectInsecureNavigation);
  try {
    browser.webContents.setWindowOpenHandler?.(() => ({ action: "deny" }));
    await withTimeout(browser.loadURL(pageUrl, { userAgent: REQUEST_HEADERS["User-Agent"] }), CAPTURE_TIMEOUT_MS);
    if (blockedInsecureNavigation || !isSafePreviewPageUrl(browser.webContents.getURL())) {
      throw new Error("网页截图拒绝了非 HTTPS 跳转");
    }
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    const image = await browser.webContents.capturePage();
    const bytes = image.toPNG();
    if (!bytes?.byteLength || bytes.byteLength > MAX_PREVIEW_BYTES) throw new Error("网页截图无效或过大");
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    await app.vault.createBinary(path, copy.buffer);
    return path;
  } finally {
    browser.webContents.off?.("will-redirect", rejectInsecureNavigation);
    browser.webContents.off?.("will-navigate", rejectInsecureNavigation);
    if (!browser.isDestroyed()) browser.close();
  }
}

type NavigationEvent = { preventDefault(): void };

type HiddenSession = {
  setPermissionRequestHandler(handler: (
    contents: unknown,
    permission: string,
    callback: (granted: boolean) => void,
  ) => void): void;
  setPermissionCheckHandler(handler: (
    contents: unknown,
    permission: string,
    requestingOrigin: string,
    details: unknown,
  ) => boolean): void;
  setDevicePermissionHandler?: (handler: (details: unknown) => boolean) => void;
};

type HiddenBrowserWindow = {
  loadURL(url: string, options?: { userAgent?: string }): Promise<void>;
  isDestroyed(): boolean;
  close(): void;
  webContents: {
    session: HiddenSession;
    setWindowOpenHandler?: (handler: () => { action: "deny" }) => void;
    getURL(): string;
    on?: (event: "will-redirect" | "will-navigate", handler: (event: NavigationEvent, url: string) => void) => void;
    off?: (event: "will-redirect" | "will-navigate", handler: (event: NavigationEvent, url: string) => void) => void;
    capturePage(): Promise<{ toPNG(): Uint8Array }>;
  };
};

type HiddenBrowserWindowConstructor = new (options: Record<string, unknown>) => HiddenBrowserWindow;

function electronBrowserWindow(): HiddenBrowserWindowConstructor | null {
  const nodeRequire = (window as Window & { require?: NodeRequire }).require;
  if (typeof nodeRequire !== "function") return null;
  try {
    const electron = nodeRequire("electron") as { remote?: { BrowserWindow?: HiddenBrowserWindowConstructor } };
    if (electron.remote?.BrowserWindow) return electron.remote.BrowserWindow;
  } catch {
    // Newer Electron builds may expose @electron/remote separately.
  }
  try {
    return (nodeRequire("@electron/remote") as { BrowserWindow?: HiddenBrowserWindowConstructor }).BrowserWindow ?? null;
  } catch {
    return null;
  }
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => window.setTimeout(() => reject(new Error("网页截图超时")), timeoutMs)),
  ]);
}
