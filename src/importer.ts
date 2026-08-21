import { Readability } from "@mozilla/readability";
import { App, Notice, Platform, TFile, normalizePath, requestUrl } from "obsidian";
import { WebDeskSettings } from "./types";
import {
  REQUEST_HEADERS,
  absolutizeUrls,
  cleanInlineText,
  collectTweetPhotoUrls,
  createTurndownService,
  execFile,
  formatLocalDate,
  getDesktopNodeApis,
  getErrorMessage,
  hostMatches,
  quoteYaml,
  readJsonResponse,
  safeName,
  toAbsoluteUrl,
} from "./util";

const CLIPII_PATH = "/usr/local/bin/clipii";
const CLIPII_TIMEOUT_MS = 120_000;

type RouteId = "twitter" | "weixin" | "xiaohongshu" | "article";

interface Route {
  id: RouteId;
  label: string;
}

interface PageMeta {
  siteName: string;
  description: string;
  image: string;
}

interface ExtractedContent {
  /** md 类型标记：twitter/weixin/xiaohongshu/article/tool/link。 */
  type: string;
  sourceLabel: string;
  title: string;
  author: string;
  body: string;
  description: string;
  warning?: string;
}

export interface ImportOptions {
  x?: number;
  y?: number;
  size?: number;
}

export interface ImportResult {
  file: TFile;
  warning?: string;
}

export async function importUrlAsBookmark(
  app: App,
  settings: WebDeskSettings,
  rawUrl: string,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const url = normalizeUrlOrThrow(rawUrl);
  const route = classifyUrl(url);
  const extracted = await extract(app, url, route);
  const file = await writeBookmarkNote(app, settings, url, extracted, options);

  if (extracted.warning) {
    new Notice(extracted.warning, 6000);
  }

  return { file, warning: extracted.warning };
}

function normalizeUrlOrThrow(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("仅支持 http/https URL");
  }
  return parsed.toString();
}

function classifyUrl(url: string): Route {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");

  if (hostMatches(host, ["x.com", "twitter.com"])) {
    return { id: "twitter", label: "推文" };
  }
  if (hostMatches(host, ["mp.weixin.qq.com", "weixin.qq.com"])) {
    return { id: "weixin", label: "微信" };
  }
  if (hostMatches(host, ["xiaohongshu.com", "xhslink.com"])) {
    return { id: "xiaohongshu", label: "小红书" };
  }
  return { id: "article", label: "文章" };
}

async function extract(app: App, url: string, route: Route): Promise<ExtractedContent> {
  if (route.id === "twitter") {
    return extractTweet(url);
  }
  if (route.id === "weixin" || route.id === "xiaohongshu") {
    return extractViaClipiiOrCard(url, route);
  }
  return extractArticleOrToolCard(url);
}

/** 推特/X：fxtwitter 开放 API，拿正文+作者+图。 */
async function extractTweet(url: string): Promise<ExtractedContent> {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/([^/]+)\/status(?:es)?\/(\d+)/);
  if (!match) {
    throw new Error("无法识别推文作者或状态 ID");
  }

  const [, user, tweetId] = match;
  const apiUrl = `https://api.fxtwitter.com/${encodeURIComponent(user)}/status/${tweetId}`;
  const response = await requestUrl({
    url: apiUrl,
    method: "GET",
    headers: REQUEST_HEADERS,
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`fxtwitter 请求失败：HTTP ${response.status}`);
  }

  const data = readJsonResponse(response);
  const tweet = data.tweet ?? {};
  const text = String(tweet.text ?? "").trim();
  const author = String(tweet.author?.name ?? user).trim();
  const photoUrls = collectTweetPhotoUrls(tweet.media);
  const bodyParts: string[] = [];

  if (text) {
    bodyParts.push(text);
  }
  if (photoUrls.length > 0) {
    bodyParts.push(photoUrls.map((photoUrl) => `![](${photoUrl})`).join("\n"));
  }

  const body = bodyParts.join("\n\n").trim();
  if (!body) {
    throw new Error("fxtwitter 未返回正文或图片");
  }

  const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? "推文";
  return {
    type: "twitter",
    sourceLabel: "推文",
    title: safeName(firstLine, 40),
    author,
    body,
    description: cleanInlineText(firstLine, 120),
  };
}

/** 微信/小红书：桌面端且装了 clipii CLI 则真浏览器抓取，否则存链接卡片。 */
async function extractViaClipiiOrCard(url: string, route: Route): Promise<ExtractedContent> {
  const node = Platform.isDesktopApp ? getDesktopNodeApis() : null;
  if (!node || !node.fs.existsSync(CLIPII_PATH)) {
    return createLinkCard(
      url,
      route,
      Platform.isDesktopApp ? "本机未装 clipii，已仅存链接卡片" : "移动端不支持 clipii，已仅存链接卡片",
    );
  }

  const tmpDir = node.fs.mkdtempSync(node.path.join(node.os.tmpdir(), "webdesk-clipii-"));
  try {
    const result = await execFile(
      node.childProcess,
      CLIPII_PATH,
      ["item", "create", "--url", url, "--library", tmpDir],
      CLIPII_TIMEOUT_MS,
    );
    const data = JSON.parse(result.stdout || "{}");
    if (!data.ok) {
      const message = data.error?.message || "clipii 转换失败";
      throw new Error(message);
    }

    const entity = data.data?.result?.entity ?? {};
    const title = String(entity.title ?? "").trim() || "无标题";
    const absolutePath = typeof entity.absolutePath === "string" ? entity.absolutePath : "";
    let body = "";

    if (absolutePath && node.fs.existsSync(absolutePath)) {
      body = stripFrontmatter(node.fs.readFileSync(absolutePath, "utf8"));
    }
    if (!body.trim()) {
      body = String(entity.content ?? "");
    }
    if (!body.trim()) {
      throw new Error("clipii 未返回正文");
    }

    return {
      type: route.id === "weixin" ? "weixin" : "xiaohongshu",
      sourceLabel: route.label,
      title: safeName(title),
      author: "",
      body: body.trim(),
      description: "",
    };
  } catch (error) {
    return createLinkCard(url, route, `clipii 抓取失败（${getErrorMessage(error)}），已仅存链接卡片`);
  } finally {
    node.fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 通用路由：Readability 抽正文转 md；
 * 抽不到（网站/工具/SPA）→ 用 og/meta 提炼成卡片式 md；
 * 抓取本身失败 → 链接卡片兜底（保证丢进来的链接一定有图标）。
 */
async function extractArticleOrToolCard(url: string): Promise<ExtractedContent> {
  let html = "";
  try {
    const response = await requestUrl({ url, method: "GET", headers: REQUEST_HEADERS });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}`);
    }
    html = response.text.trim();
  } catch (error) {
    return createLinkCard(
      url,
      { id: "article", label: "文章" },
      `网页抓取失败（${getErrorMessage(error)}），已仅存链接卡片`,
    );
  }

  if (!html) {
    return createLinkCard(url, { id: "article", label: "文章" }, "网页内容为空，已仅存链接卡片");
  }

  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  const meta = readPageMeta(document, url);
  const host = new URL(url).hostname.replace(/^www\./, "");

  try {
    const article = new Readability(document).parse();
    const content = (article?.content ?? "").trim();
    const tooShort = content.replace(/<[^>]+>/g, "").trim().length < 200;

    if (content && !tooShort) {
      const articleContent = article?.content ?? content;
      const contentDocument = parser.parseFromString(articleContent, "text/html");
      absolutizeUrls(contentDocument.body, url);
      const markdown = createTurndownService().turndown(contentDocument.body.innerHTML).trim();

      if (markdown) {
        const articleTitle = article?.title ?? "";
        return {
          type: "article",
          sourceLabel: "文章",
          title: safeName(articleTitle || document.title || meta.siteName || "无标题"),
          author: cleanInlineText(article?.byline ?? "", 120),
          body: markdown,
          description: meta.description,
        };
      }
    }
  } catch {
    // Readability 失败 → 走工具卡片
  }

  return buildToolCard(url, host, meta, document);
}

/** 网站/工具型：og:title / og:description / og:image 提炼卡片。 */
function buildToolCard(
  url: string,
  host: string,
  meta: PageMeta,
  document: Document,
): ExtractedContent {
  const title = safeName(meta.siteName || document.title || host);
  const lines: string[] = [];

  lines.push(`> ${meta.description || "（未提取到网站简介）"}`);
  lines.push("");
  if (meta.image) {
    lines.push(`![](${meta.image})`);
    lines.push("");
  }
  lines.push(`- 域名：\`${host}\``);
  lines.push(`- [打开网页](${url})`);

  return {
    type: "tool",
    sourceLabel: "网站·工具",
    title,
    author: host,
    body: lines.join("\n"),
    description: meta.description,
  };
}

function createLinkCard(url: string, route: Route, warning: string): ExtractedContent {
  const host = new URL(url).hostname.replace(/^www\./, "");
  return {
    type: "link",
    sourceLabel: `${route.label}·待处理`,
    title: `${host} 链接待处理`,
    author: "",
    body: ["> 抓取失败，仅存链接。可稍后重新导入。", "", `[${url}](${url})`].join("\n"),
    description: "",
    warning,
  };
}

function readPageMeta(document: Document, baseUrl: string): PageMeta {
  const metaContent = (selector: string): string => {
    const el = document.querySelector<HTMLMetaElement>(selector);
    return el?.content ? cleanInlineText(el.content, 300) : "";
  };

  let siteName = metaContent('meta[property="og:title"]') || document.title || "";
  const ogSiteName = metaContent('meta[property="og:site_name"]');
  if (ogSiteName) {
    siteName = ogSiteName;
  }

  const description =
    metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]');

  const rawImage = metaContent('meta[property="og:image"]');
  const image = rawImage ? toAbsoluteUrl(rawImage, baseUrl) : "";

  return { siteName: cleanInlineText(siteName, 120), description, image };
}

async function writeBookmarkNote(
  app: App,
  settings: WebDeskSettings,
  url: string,
  extracted: ExtractedContent,
  options: ImportOptions,
): Promise<TFile> {
  const folder = normalizePath(settings.bookmarkFolder);
  await ensureFolder(app, folder);

  const clipped = formatLocalDate(new Date());
  const title = safeName(extracted.title);
  const baseName = `${clipped}【${extracted.sourceLabel}】${title}`;
  const filePath = getAvailablePath(app, folder, baseName);
  const body = extracted.body.trim() || "（未提取到内容）";

  const frontmatter: string[] = [
    "---",
    `title: ${quoteYaml(title)}`,
    `url: ${quoteYaml(url)}`,
    `type: ${quoteYaml(extracted.type)}`,
    `source_label: ${quoteYaml(extracted.sourceLabel)}`,
    `author: ${quoteYaml(extracted.author)}`,
  ];
  if (extracted.description) {
    frontmatter.push(`description: ${quoteYaml(extracted.description)}`);
  }
  frontmatter.push(`clipped: ${clipped}`);
  frontmatter.push("tags: [bookmark]");
  if (typeof options.x === "number" && typeof options.y === "number") {
    frontmatter.push(`desk_x: ${Math.round(options.x)}`);
    frontmatter.push(`desk_y: ${Math.round(options.y)}`);
  }
  if (typeof options.size === "number") {
    frontmatter.push(`desk_size: ${Math.round(options.size)}`);
  }
  frontmatter.push("---", "");

  const content = [...frontmatter, body].join("\n");
  return app.vault.create(filePath, content);
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const parts = folderPath.split("/");
  let current = "";

  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(current);
    if (!existing) {
      await app.vault.createFolder(current);
      continue;
    }
    if (existing instanceof TFile) {
      throw new Error(`路径 ${current} 已被同名文件占用，无法创建收藏夹文件夹`);
    }
  }
}

function getAvailablePath(app: App, folder: string, baseName: string): string {
  let candidate = normalizePath(`${folder}/${baseName}.md`);
  let index = 2;

  while (app.vault.getAbstractFileByPath(candidate)) {
    candidate = normalizePath(`${folder}/${baseName} ${index}.md`);
    index += 1;
  }

  return candidate;
}

function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) {
    return markdown;
  }
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (!match) {
    return markdown;
  }
  return markdown.slice(match[0].length).replace(/^\s+/, "");
}
