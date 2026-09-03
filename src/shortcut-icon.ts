import { App, normalizePath, Platform, TFile } from "obsidian";
import { execFile, getDesktopNodeApis } from "./util";
import { shortcutIconFileName, type LocalShortcut } from "./shortcut-state";

export const SHORTCUT_ICON_FOLDER = "应用图标";
const ICON_SIZE = 256;
const EXTRACT_TIMEOUT_MS = 8_000;

export type ShortcutIconResolve = (shortcut: LocalShortcut) => Promise<string | null>;

/**
 * macOS 用 NSWorkspace 取任意路径的系统图标（应用、文件夹、文件都有），渲染成 256px PNG。
 * 不依赖 Quick Look（qlmanage 在无头环境会挂）也不解析 icns / Assets.car。
 */
const JXA_ICON_SCRIPT = `
ObjC.import("AppKit"); ObjC.import("Foundation");
function run(argv) {
  const path = argv[0], out = argv[1], size = Number(argv[2]) || 256;
  const image = $.NSWorkspace.sharedWorkspace.iconForFile(path);
  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(null, size, size, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
  image.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1.0);
  $.NSGraphicsContext.restoreGraphicsState;
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  return png.writeToFileAtomically(out, true) ? "ok" : "fail";
}`;

/** 本机快捷方式图标：先查 Vault 缓存，再调系统取图标落盘；同一路径一次会话只提取一次。 */
export class ShortcutIconResolver {
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(
    private readonly app: App,
    private readonly getImageFolder: () => string,
  ) {}

  resolve: ShortcutIconResolve = (shortcut) => {
    let task = this.pending.get(shortcut.path);
    if (!task) {
      task = this.lookup(shortcut).catch(() => null);
      this.pending.set(shortcut.path, task);
    }
    return task;
  };

  forget(path: string): void {
    this.pending.delete(path);
  }

  private folder(): string {
    return normalizePath(`${this.getImageFolder().trim() || "附件/网页桌面"}/${SHORTCUT_ICON_FOLDER}`);
  }

  private async lookup(shortcut: LocalShortcut): Promise<string | null> {
    const path = normalizePath(`${this.folder()}/${shortcutIconFileName(shortcut)}`);
    const cached = this.app.vault.getAbstractFileByPath(path);
    if (cached instanceof TFile) return this.app.vault.getResourcePath(cached);

    const bytes = await extractSystemIcon(shortcut.path);
    if (!bytes) return null;
    await ensureFolder(this.app, this.folder());
    const existing = this.app.vault.getAbstractFileByPath(path);
    const file = existing instanceof TFile ? existing : await this.app.vault.createBinary(path, bytes);
    return this.app.vault.getResourcePath(file);
  }
}

async function extractSystemIcon(targetPath: string): Promise<ArrayBuffer | null> {
  if (!Platform.isDesktopApp || !Platform.isMacOS) return null;
  const apis = getDesktopNodeApis();
  if (!apis) return null;
  if (!apis.fs.existsSync(targetPath)) return null;
  const tmp = apis.path.join(apis.os.tmpdir(), `web-desk-icon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.png`);
  try {
    await execFile(
      apis.childProcess,
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", JXA_ICON_SCRIPT, targetPath, tmp, String(ICON_SIZE)],
      EXTRACT_TIMEOUT_MS,
    );
    if (!apis.fs.existsSync(tmp)) return null;
    const buffer = apis.fs.readFileSync(tmp);
    if (buffer.byteLength < 100) return null;
    return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  } catch {
    return null;
  } finally {
    try { apis.fs.unlinkSync(tmp); } catch { /* 临时文件可能未生成 */ }
  }
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}
