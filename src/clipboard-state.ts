export interface CanvasPasteText {
  urls: string[];
  text: string;
}

export interface EmbeddedCanvasPasteClaim {
  defaultPrevented: boolean;
  editableTarget: boolean;
  imageCount: number;
  paste: CanvasPasteText;
}

/** 粘贴比拖拽更保守：单个英文词是文本，不应被补成 https://word。 */
export function isLikelyPastedUrl(rawLine: string): boolean {
  const line = rawLine.trim();
  if (!line || /\s/.test(line)) return false;
  if (
    !/^https?:\/\//i.test(line) &&
    !/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?(?:[/?#].*)?$/i.test(line)
  ) {
    return false;
  }
  try {
    const parsed = new URL(/^https?:\/\//i.test(line) ? line : `https://${line}`);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 只把“整行就是 URL”的内容当收藏；含说明文字的行原样保留为文本，避免丢字。
 * 多行混合时，URL 行导入收藏，其他非空行合并为一个文本框。
 */
export function splitCanvasPaste(
  rawText: string,
  isUrl: (line: string) => boolean = isLikelyPastedUrl,
): CanvasPasteText {
  const urls: string[] = [];
  const textLines: string[] = [];

  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (isUrl(line)) urls.push(line);
    else textLines.push(line);
  }

  return { urls, text: textLines.join("\n") };
}

export function isEditablePasteTarget(
  target: EventTarget | null,
  boundary?: Element,
): boolean {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  if (typeof candidate?.closest !== "function") return false;
  const editable = candidate.closest(
    'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]',
  );
  if (!editable) return false;

  // 内嵌画布本身位于 Obsidian 的 contenteditable 编辑器中；边界外的可编辑祖先
  // 不代表用户正在编辑画布里的文本。只有画布内部的文本编辑器才应保留原生粘贴。
  return boundary === undefined || editable === boundary || boundary.contains(editable);
}

/**
 * 内嵌画布已拥有事件目标时，以“画布内是否在编辑文字 + 是否有可识别内容”决定归属。
 * Obsidian/CodeMirror 可能先把事件标成 defaultPrevented；这不能否定画布对自身非编辑区域的所有权。
 */
export function shouldClaimEmbeddedCanvasPaste(input: EmbeddedCanvasPasteClaim): boolean {
  if (input.editableTarget) return false;
  return input.imageCount > 0 || input.paste.urls.length > 0 || input.paste.text.length > 0;
}
