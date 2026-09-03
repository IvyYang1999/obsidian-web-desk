import type { CardViewMode } from "./card-view-state";

export type CanvasFileKind = "markdown" | "pdf" | "other";

export function canvasFileKind(path: string): CanvasFileKind {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "md") return "markdown";
  if (extension === "pdf") return "pdf";
  return "other";
}

export function supportsCanvasFilePreview(path: string): boolean {
  return canvasFileKind(path) !== "other";
}

export function canvasFileViewModes(path: string): CardViewMode[] {
  return supportsCanvasFilePreview(path) ? ["icon", "preview", "embed"] : ["icon"];
}

export function canvasFileKindLabel(path: string): string {
  const kind = canvasFileKind(path);
  return kind === "pdf" ? "PDF" : kind === "markdown" ? "Markdown" : "文件";
}
