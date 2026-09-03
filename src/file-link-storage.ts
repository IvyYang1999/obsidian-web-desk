import { App, normalizePath, TFile } from "obsidian";
import { extractMarkdownLinkCandidates, vaultPathFromMarkdownCandidate } from "./file-link-state";
import { quoteYaml, safeName } from "./util";
import type { WebDeskSettings } from "./types";

export interface ShortcutResult {
  file: TFile;
  created: boolean;
}

export function markdownFilesFromDrop(
  app: App,
  data: DataTransfer | null,
  sourcePath: string,
): TFile[] {
  if (!data) return [];
  const candidates = candidatesFromDrop(data);
  const basePath = readVaultBasePath(app);
  const resolved: TFile[] = [];
  for (const candidate of candidates) {
    const vaultPath = vaultPathFromMarkdownCandidate(candidate, basePath);
    if (!vaultPath) continue;
    const exact = app.vault.getAbstractFileByPath(normalizePath(vaultPath));
    const file = exact instanceof TFile
      ? exact
      : /\.md$/i.test(vaultPath)
        ? app.metadataCache.getFirstLinkpathDest(vaultPath.replace(/\.md$/i, ""), sourcePath)
        : null;
    if (!(file instanceof TFile) || !["md", "pdf"].includes(file.extension.toLowerCase())) continue;
    if (!resolved.some((entry) => entry.path === file.path)) resolved.push(file);
  }
  return resolved;
}

/** Finder 拖入了本地 Markdown/PDF，但它不能解析为当前 Vault 文件时供 UI 给出明确提示。 */
export function hasLocalMarkdownFileDrop(data: DataTransfer | null): boolean {
  if (!data) return false;
  return candidatesFromDrop(data).some((candidate) =>
    (/^(?:\/|[a-z]:[\\/])/i.test(candidate) && /\.(?:md|pdf)$/i.test(candidate))
  );
}

export async function createMarkdownShortcut(
  app: App,
  settings: WebDeskSettings,
  target: TFile,
  point: { x: number; y: number },
): Promise<ShortcutResult> {
  const folder = normalizePath(settings.bookmarkFolder);
  await ensureFolder(app, folder);
  const existing = app.vault.getMarkdownFiles().find((file) => {
    if (!file.path.startsWith(`${folder}/`)) return false;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
    return fm?.desk_file === target.path;
  });
  if (existing) return { file: existing, created: false };

  const path = nextAvailablePath(app, folder, `【文件】${safeName(target.basename, 48)}`);
  const link = app.fileManager.generateMarkdownLink(target, path);
  const content = [
    "---",
    `title: ${quoteYaml(target.basename)}`,
    `type: ${quoteYaml("file")}`,
    `desk_file: ${quoteYaml(target.path)}`,
    `description: ${quoteYaml(target.parent?.path || "Vault 根目录")}`,
    `desk_x: ${Math.round(point.x - settings.defaultIconSize / 2)}`,
    `desk_y: ${Math.round(point.y - settings.defaultIconSize / 2)}`,
    `desk_size: ${settings.defaultIconSize}`,
    "tags: [web-desk-file]",
    "---",
    "",
    link,
    "",
  ].join("\n");
  return { file: await app.vault.create(path, content), created: true };
}

function readVaultBasePath(app: App): string {
  const adapter = app.vault.adapter as { basePath?: unknown };
  return typeof adapter.basePath === "string" ? adapter.basePath.replace(/\/$/, "") : "";
}

/** Finder / 系统拖入文件的绝对路径（Electron 暴露 file.path 或 webUtils）。 */
export function localFilePathsFromDrop(data: DataTransfer | null): string[] {
  if (!data) return [];
  const electron = (window as typeof window & {
    electron?: { webUtils?: { getPathForFile?: (file: File) => string } };
  }).electron;
  return Array.from(data.files ?? [])
    .map((file) =>
      (file as File & { path?: string }).path || electron?.webUtils?.getPathForFile?.(file) || "",
    )
    .filter(Boolean);
}

function candidatesFromDrop(data: DataTransfer): string[] {
  const filePaths = localFilePathsFromDrop(data);
  return extractMarkdownLinkCandidates({
    html: data.getData("text/html"),
    text: data.getData("text/plain") || data.getData("text"),
    uriList: data.getData("text/uri-list"),
    filePaths,
  });
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
