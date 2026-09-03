/** 本机快捷方式（应用 / 文件夹 / 文件）的纯逻辑；不依赖 Obsidian 与 Node。 */

export type LocalShortcutKind = "app" | "folder" | "file";

export interface LocalShortcut {
  path: string;
  name: string;
  kind: LocalShortcutKind;
}

const IMAGE_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|avif|svg|bmp|tiff?|heic)$/i;
const VAULT_DOCUMENT_EXTENSIONS = /\.(?:md|pdf)$/i;

export function isAbsoluteLocalPath(value: string): boolean {
  return /^(?:\/|[a-z]:[\\/])/i.test(value.trim());
}

export function isMacAppBundle(path: string): boolean {
  return /\.app\/?$/i.test(path.trim());
}

/** 目录信息由调用方（Node fs）给出；`.app` 在 macOS 上是目录，但语义是应用。 */
export function classifyLocalPath(path: string, isDirectory: boolean): LocalShortcutKind {
  if (isMacAppBundle(path)) return "app";
  return isDirectory ? "folder" : "file";
}

export function normalizeShortcutKind(value: unknown): LocalShortcutKind {
  return value === "app" || value === "folder" ? value : "file";
}

/** 显示名：应用去掉 `.app`，其余保留原文件名（含扩展名，便于区分同名文件）。 */
export function shortcutDisplayName(path: string, kind: LocalShortcutKind): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return kind === "app" ? base.replace(/\.app$/i, "") : base;
}

export function shortcutKindLabel(kind: LocalShortcutKind): string {
  return kind === "app" ? "应用" : kind === "folder" ? "文件夹" : "文件";
}

export function shortcutKindIcon(kind: LocalShortcutKind): string {
  return kind === "app" ? "app-window" : kind === "folder" ? "folder" : "file";
}

export function shortcutRef(path: string): string {
  return `app:${path}`;
}

/**
 * 从拖入的绝对路径里挑出应当变成本机快捷方式的那些：
 * 图片走图片导入，Vault 内的 Markdown/PDF 走文件卡片，其余全部允许。
 */
export function localShortcutCandidates(filePaths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of filePaths) {
    const path = raw.trim();
    if (!isAbsoluteLocalPath(path)) continue;
    if (IMAGE_EXTENSIONS.test(path) || VAULT_DOCUMENT_EXTENSIONS.test(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

/** 与预览图一致的稳定摘要，用作缓存文件名的一部分。 */
export function shortcutDigest(path: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function shortcutIconFileName(shortcut: Pick<LocalShortcut, "path" | "name">): string {
  const safe = shortcut.name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 48) || "shortcut";
  return `${safe}-${shortcutDigest(shortcut.path)}.png`;
}
