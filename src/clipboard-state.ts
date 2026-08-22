export interface CanvasPasteText {
  urls: string[];
  text: string;
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

export function isEditablePasteTarget(target: EventTarget | null): boolean {
  const candidate = target as { closest?: (selector: string) => Element | null } | null;
  if (typeof candidate?.closest !== "function") return false;
  return Boolean(
    candidate.closest(
      'input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]',
    ),
  );
}
