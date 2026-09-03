import { App, normalizePath, TFile } from "obsidian";
import { getDesktopNodeApis, quoteYaml, safeName } from "./util";
import type { WebDeskSettings } from "./types";
import {
  classifyLocalPath,
  shortcutDisplayName,
  shortcutKindLabel,
  type LocalShortcut,
} from "./shortcut-state";

export interface ShortcutImportResult {
  file: TFile;
  shortcut: LocalShortcut;
  created: boolean;
}

/** 用 Node fs 判断目录与存在性，得到快捷方式的种类与显示名。 */
export function describeLocalShortcut(path: string): LocalShortcut {
  const apis = getDesktopNodeApis();
  let isDirectory = false;
  try {
    isDirectory = Boolean(apis?.fs.statSync(path).isDirectory());
  } catch {
    isDirectory = false;
  }
  const kind = classifyLocalPath(path, isDirectory);
  return { path, kind, name: shortcutDisplayName(path, kind) };
}

/**
 * 本机快捷方式 = 收藏夹里一个 Markdown：`app_path` 是身份，`app_name` 供跨机器按名启动。
 * 同一路径只创建一次，重复拖入返回已有文件。
 */
export async function createLocalShortcutNote(
  app: App,
  settings: WebDeskSettings,
  shortcut: LocalShortcut,
  point: { x: number; y: number },
): Promise<ShortcutImportResult> {
  const folder = normalizePath(settings.bookmarkFolder);
  await ensureFolder(app, folder);
  const existing = app.vault.getMarkdownFiles().find((file) => {
    if (!file.path.startsWith(`${folder}/`)) return false;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    return fm?.app_path === shortcut.path;
  });
  if (existing) return { file: existing, shortcut, created: false };

  const path = nextAvailablePath(app, folder, `【${shortcutKindLabel(shortcut.kind)}】${safeName(shortcut.name, 48)}`);
  const parent = shortcut.path.replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -1).join("/") || "/";
  const content = [
    "---",
    `title: ${quoteYaml(shortcut.name)}`,
    `type: ${quoteYaml(shortcut.kind)}`,
    `app_name: ${quoteYaml(shortcut.name)}`,
    `app_path: ${quoteYaml(shortcut.path)}`,
    `source_label: ${quoteYaml(`本机${shortcutKindLabel(shortcut.kind)}`)}`,
    `description: ${quoteYaml(parent)}`,
    `desk_x: ${Math.round(point.x - settings.defaultIconSize / 2)}`,
    `desk_y: ${Math.round(point.y - settings.defaultIconSize / 2)}`,
    `desk_size: ${settings.defaultIconSize}`,
    "tags: [web-desk-shortcut]",
    "---",
    "",
    `# ${shortcut.name}`,
    "",
    `本机${shortcutKindLabel(shortcut.kind)}快捷方式：\`${shortcut.path}\``,
    "",
    "在网页桌面上双击图标即可启动；换一台机器时若路径不同，会按名称启动。",
    "",
  ].join("\n");
  return { file: await app.vault.create(path, content), shortcut, created: true };
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) await app.vault.createFolder(current);
    else if (existing instanceof TFile) throw new Error(`${current} 是文件，无法创建收藏夹目录`);
  }
}

function nextAvailablePath(app: App, folder: string, baseName: string): string {
  let suffix = 1;
  let path = normalizePath(`${folder}/${baseName}.md`);
  while (app.vault.getAbstractFileByPath(path)) {
    suffix += 1;
    path = normalizePath(`${folder}/${baseName} ${suffix}.md`);
  }
  return path;
}
