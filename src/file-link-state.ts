export interface MarkdownDropText {
  html?: string;
  text?: string;
  uriList?: string;
  filePaths?: string[];
}

/** 从 Obsidian/系统拖拽的多种载荷中提取候选 Markdown 路径；是否存在由调用方查 Vault。 */
export function extractMarkdownLinkCandidates(payload: MarkdownDropText): string[] {
  const candidates: string[] = [];
  const push = (value: string): void => {
    const normalized = decodePath(value);
    if (!normalized || candidates.includes(normalized)) return;
    candidates.push(normalized);
  };

  for (const match of (payload.html ?? "").matchAll(/href=["']app:\/\/obsidian\.md\/([^"']+)["']/gi)) {
    push(match[1].split(/[?#]/, 1)[0]);
  }

  const combined = [payload.text ?? "", payload.uriList ?? ""].filter(Boolean).join("\n");
  for (const match of combined.matchAll(/obsidian:\/\/open\?[^\s<>"']+/gi)) {
    try {
      const url = new URL(match[0]);
      const file = url.searchParams.get("file") || url.searchParams.get("path");
      if (file) push(file);
    } catch {
      // 非法 URL 继续尝试 WikiLink / 原始路径。
    }
  }
  for (const match of combined.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    push(match[1]);
  }
  for (const match of combined.matchAll(/\[[^\]]*\]\(([^)]+?\.md)(?:#[^)]*)?\)/gi)) {
    push(match[1]);
  }
  for (const line of combined.split(/\r?\n/)) {
    const raw = line.trim().replace(/^file:\/\//i, "");
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) continue;
    if (/\.md$/i.test(raw) && !/[<>\[\]()]/.test(raw)) push(raw);
  }
  for (const filePath of payload.filePaths ?? []) push(filePath);
  return candidates;
}

/** 汇总一篇笔记内所有 web-desk 块的文件引用，用于物化 frontmatter 双链。 */
export function extractEmbeddedMarkdownPaths(markdown: string): string[] {
  const paths: string[] = [];
  for (const match of markdown.matchAll(/```web-desk[^\n]*\r?\n([\s\S]*?)\r?\n```/g)) {
    try {
      const parsed = JSON.parse(match[1]) as { items?: Array<{ path?: unknown }> };
      for (const item of parsed.items ?? []) {
        if (typeof item.path !== "string" || !item.path.trim()) continue;
        const path = item.path.trim();
        if (!paths.includes(path)) paths.push(path);
      }
    } catch {
      // 坏块不参与双链同步，也不改写原文。
    }
  }
  return paths;
}

function decodePath(value: string): string {
  const stripped = value.trim().replace(/^\/+/, "");
  if (!stripped) return "";
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}
