export interface WebDeskCanvasBlock {
  source: string;
  index: number;
}

/**
 * 提取一篇 Markdown 里的 web-desk 数据块。引用只读取，不改写围栏本身；
 * 第一版由导航层选择第一个合法块，避免依赖易漂移的行号。
 */
export function extractWebDeskCanvasBlocks(markdown: string): WebDeskCanvasBlock[] {
  const blocks: WebDeskCanvasBlock[] = [];
  const pattern = /^```web-desk[^\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const source = match[1].trim();
    if (!isValidWebDeskCanvasSource(source)) continue;
    blocks.push({ source, index: blocks.length });
  }
  return blocks;
}

export function isValidWebDeskCanvasSource(source: string): boolean {
  try {
    const parsed = JSON.parse(source) as { items?: unknown } | null;
    return Boolean(parsed && Array.isArray(parsed.items));
  } catch {
    return false;
  }
}

export function canEnterCanvasReference(
  stack: readonly string[],
  targetPath: string,
): { allowed: true } | { allowed: false; reason: "empty" | "cycle" } {
  const target = targetPath.trim();
  if (!target) return { allowed: false, reason: "empty" };
  if (stack.includes(target)) return { allowed: false, reason: "cycle" };
  return { allowed: true };
}
