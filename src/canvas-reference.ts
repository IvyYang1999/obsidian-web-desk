import { App, TFile } from "obsidian";
import { extractWebDeskCanvasBlocks } from "./canvas-reference-state";

export interface ResolvedCanvasReference {
  file: TFile;
  source: string;
}

/** 读取目标笔记的第一个合法 web-desk 块；缺失或坏块都按非画布处理。 */
export async function resolveCanvasReference(
  app: App,
  targetPath: string,
): Promise<ResolvedCanvasReference | null> {
  const target = app.vault.getAbstractFileByPath(targetPath);
  if (!(target instanceof TFile) || target.extension.toLowerCase() !== "md") return null;
  const markdown = await app.vault.cachedRead(target);
  const [block] = extractWebDeskCanvasBlocks(markdown);
  return block ? { file: target, source: block.source } : null;
}
