import type { App, TFile } from "obsidian";
import { KeyedSerialTaskQueue } from "./serial-task-queue";

const appQueues = new WeakMap<App, KeyedSerialTaskQueue>();

/**
 * processFrontMatter 是读-改-写；同一文件并发调用时，晚结束的旧读可能覆盖
 * 更新结果。所有插件内 frontmatter 写入因此按文件串行。
 */
export function processFrontmatterSerially(
  app: App,
  file: TFile,
  update: (frontmatter: Record<string, unknown>) => void,
): Promise<void> {
  let queue = appQueues.get(app);
  if (!queue) {
    queue = new KeyedSerialTaskQueue();
    appQueues.set(app, queue);
  }
  return queue.enqueue(file.path, () =>
    app.fileManager.processFrontMatter(file, update),
  );
}
