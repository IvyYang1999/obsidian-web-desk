import { App, normalizePath, TFile } from "obsidian";
import { fitImageWithin, nextAvailableImagePath, sanitizeImageFileName } from "./image-state";
import type { CanvasImage } from "./types";

export function imageFilesFrom(list: FileList | readonly File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((file) => file.type.toLowerCase().startsWith("image/"));
}

export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  const direct = imageFilesFrom(data?.files);
  if (direct.length > 0) return direct;
  return Array.from(data?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.toLowerCase().startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}

export async function storeImageFile(
  app: App,
  folder: string,
  file: File,
  point: { x: number; y: number },
): Promise<CanvasImage> {
  if (!file.type.toLowerCase().startsWith("image/")) {
    throw new Error("只支持图片文件");
  }
  const dimensions = await readImageDimensions(file);
  const size = fitImageWithin(dimensions.width, dimensions.height);
  const normalizedFolder = normalizePath(folder.trim() || "附件/网页桌面");
  await ensureFolder(app, normalizedFolder);
  const fileName = sanitizeImageFileName(file.name, file.type);
  const path = normalizePath(
    nextAvailableImagePath(normalizedFolder, fileName, (candidate) =>
      app.vault.getAbstractFileByPath(normalizePath(candidate)) !== null,
    ),
  );
  const saved = await app.vault.createBinary(path, await file.arrayBuffer());
  return {
    id: `i${Date.now().toString(36)}${Math.floor(Math.random() * 10_000)}`,
    path: saved.path,
    x: Math.round(point.x - size.w / 2),
    y: Math.round(point.y - size.h / 2),
    w: size.w,
    h: size.h,
  };
}

export function imageResourceUrl(app: App, path: string): string {
  const file = app.vault.getAbstractFileByPath(path);
  return file instanceof TFile ? app.vault.getResourcePath(file) : "";
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
  }
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } else {
        reject(new Error("无法读取图片尺寸"));
      }
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    image.src = url;
  });
}
