import { Notice, Platform } from "obsidian";
import { execFile, getDesktopNodeApis, getErrorMessage } from "./util";
import type { LocalShortcut } from "./shortcut-state";

interface ElectronShell {
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

function electronShell(): ElectronShell | null {
  const nodeRequire = (window as Window & { require?: NodeRequire }).require;
  if (typeof nodeRequire !== "function") return null;
  try {
    return (nodeRequire("electron") as { shell?: ElectronShell }).shell ?? null;
  } catch {
    return null;
  }
}

/**
 * 启动本机快捷方式：路径存在就交给系统打开（应用即启动，文件夹开 Finder，文件用默认程序）；
 * 应用路径在另一台机器上不同时，退回按名字 `open -a`。
 */
export async function launchLocalShortcut(shortcut: LocalShortcut): Promise<void> {
  const apis = getDesktopNodeApis();
  const shell = electronShell();
  if (!Platform.isDesktopApp || !apis || !shell) {
    throw new Error("移动端无法启动本机应用");
  }
  if (apis.fs.existsSync(shortcut.path)) {
    const error = await shell.openPath(shortcut.path);
    if (error) throw new Error(error);
    return;
  }
  if (shortcut.kind === "app" && shortcut.name && Platform.isMacOS) {
    await execFile(apis.childProcess, "/usr/bin/open", ["-a", shortcut.name], 10_000);
    return;
  }
  throw new Error(`路径不存在：${shortcut.path}`);
}

export async function launchLocalShortcutWithNotice(shortcut: LocalShortcut): Promise<void> {
  try {
    await launchLocalShortcut(shortcut);
  } catch (error) {
    new Notice(`无法启动 ${shortcut.name}：${getErrorMessage(error)}`, 6000);
  }
}

export function revealLocalShortcut(shortcut: LocalShortcut): void {
  const shell = electronShell();
  const apis = getDesktopNodeApis();
  if (!shell || !apis || !apis.fs.existsSync(shortcut.path)) {
    new Notice(`路径不存在：${shortcut.path}`, 5000);
    return;
  }
  shell.showItemInFolder(shortcut.path);
}

export function localShortcutExists(path: string): boolean {
  const apis = getDesktopNodeApis();
  return Boolean(apis?.fs.existsSync(path));
}
