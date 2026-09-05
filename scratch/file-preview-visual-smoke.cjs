const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { chromium } = require("/Users/yytyyf/projects/oneday/node_modules/playwright");

const REPO = "/Users/yytyyf/projects/obsidian-web-desk";
const PROFILE = "/tmp/webdesk-file-preview-profile";
const VAULT = "/tmp/webdesk-file-preview-vault";
const MAIN_SCREENSHOT = "/tmp/webdesk-file-preview-main.png";
const EMBED_SCREENSHOT = "/tmp/webdesk-file-preview-embed.png";
const FULLSCREEN_SCREENSHOT = "/tmp/webdesk-file-preview-fullscreen.png";
const PDF_FULLSCREEN_SCREENSHOT = "/tmp/webdesk-file-preview-pdf-fullscreen.png";
const PDF_CANVAS_SCREENSHOT = "/tmp/webdesk-file-preview-pdf-canvas.png";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(fn, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await sleep(350);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function minimalPdf(text) {
  const escaped = text.replace(/[()\\]/g, "\\$&");
  const firstStream = `0.18 0.42 0.82 rg 72 610 468 92 re f 1 1 1 rg BT /F1 34 Tf 96 644 Td (${escaped} - page 1) Tj ET`;
  const secondStream = `0.46 0.32 0.78 rg 72 610 468 92 re f 1 1 1 rg BT /F1 34 Tf 96 644 Td (${escaped} - page 2) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(firstStream)} >>\nstream\n${firstStream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${Buffer.byteLength(secondStream)} >>\nstream\n${secondStream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return output;
}

function prepareFixture() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(VAULT, { recursive: true, force: true });
  const pluginDir = path.join(VAULT, ".obsidian/plugins/web-desk");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(path.join(VAULT, "收藏夹"), { recursive: true });
  for (const filename of ["main.js", "manifest.json", "styles.css"]) {
    fs.copyFileSync(path.join(REPO, filename), path.join(pluginDir, filename));
  }
  fs.writeFileSync(path.join(VAULT, ".obsidian/community-plugins.json"), JSON.stringify(["naviboard"]));
  fs.writeFileSync(path.join(VAULT, ".obsidian/app.json"), JSON.stringify({ livePreview: true }));

  fs.writeFileSync(path.join(VAULT, "Reading note.md"), [
    "# Reading note",
    "",
    "> This Markdown is rendered inside the canvas.",
    "",
    "## Scroll proof",
    "",
    ...Array.from({ length: 24 }, (_, index) => `${index + 1}. A deliberately long reading line for embedded scrolling.`),
  ].join("\n"));
  fs.writeFileSync(path.join(VAULT, "Reading sample.pdf"), minimalPdf("Scrollable PDF canvas preview"));

  const wrappers = [
    { name: "Markdown preview", target: "Reading note.md", x: 80, y: 90, mode: "preview", w: 360, h: 280 },
    { name: "PDF reader", target: "Reading sample.pdf", x: 500, y: 90, mode: "embed", w: 420, h: 320 },
  ];
  for (const item of wrappers) {
    fs.writeFileSync(path.join(VAULT, `收藏夹/${item.name}.md`), [
      "---",
      `title: ${item.name}`,
      "type: file",
      `desk_file: ${item.target}`,
      `desk_x: ${item.x}`,
      `desk_y: ${item.y}`,
      "desk_size: 96",
      `desk_view_mode: ${item.mode}`,
      `desk_preview_width: ${item.w}`,
      `desk_preview_height: ${item.h}`,
      "desk_placed: true",
      "---",
      "",
      `[[${item.target}]]`,
    ].join("\n"));
  }

  fs.writeFileSync(path.join(VAULT, "Embedded file readers.md"), [
    "# Embedded file readers",
    "",
    "```web-desk",
    JSON.stringify({
      height: 620,
      items: [
        { url: "", path: "Reading note.md", title: "Markdown reader", x: 60, y: 70, size: 96, viewMode: "embed", previewWidth: 420, previewHeight: 320 },
        { url: "", path: "Reading sample.pdf", title: "PDF preview", x: 540, y: 70, size: 96, viewMode: "preview", previewWidth: 380, previewHeight: 300 },
        { url: "", path: "Reading sample.pdf", title: "PDF icon", x: 980, y: 90, size: 96, viewMode: "icon" },
      ],
    }),
    "```",
    "",
  ].join("\n"));

  fs.mkdirSync(PROFILE, { recursive: true });
  const sourceRegistry = path.join(process.env.HOME, "Library/Application Support/obsidian/obsidian.json");
  let registry = { vaults: {} };
  if (fs.existsSync(sourceRegistry)) {
    try { registry = JSON.parse(fs.readFileSync(sourceRegistry, "utf8")); } catch {}
  }
  registry.vaults = { webdeskpreview: { path: VAULT, ts: Date.now(), open: true } };
  fs.writeFileSync(path.join(PROFILE, "obsidian.json"), JSON.stringify(registry));
}

async function openFilePreviewFromSelection(page, canvas, cardSelector) {
  const card = canvas.locator(cardSelector);
  await card.click({ position: { x: 18, y: 18 } });
  await canvas.getByRole("button", { name: "全屏预览", exact: true }).click();
  await page.waitForSelector(".web-desk-file-fullscreen");
  const back = page.getByRole("button", { name: "返回画布", exact: true });
  await back.waitFor({ state: "visible" });
  return { card, back };
}

(async () => {
  prepareFixture();
  const port = await freePort();
  const obsidian = spawn("/Applications/Obsidian.app/Contents/MacOS/Obsidian", [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    VAULT,
  ], { stdio: "ignore" });

  try {
    const browser = await waitFor(async () => {
      try { return await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { return null; }
    }, 45_000, "Obsidian CDP");
    const page = await waitFor(async () => {
      for (const candidate of browser.contexts()[0]?.pages() ?? []) {
        try {
          if (await candidate.evaluate(() => window.app?.vault?.getName?.() === "webdesk-file-preview-vault")) return candidate;
        } catch {}
      }
      return null;
    }, 60_000, "temporary vault window");
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") runtimeErrors.push(message.text()); });

    await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await page.evaluate(() => Boolean(app.plugins.plugins["naviboard"]))) break;
      await page.evaluate(() => {
        const trust = [...document.querySelectorAll(".modal-container button")]
          .find((button) => /Trust author|信任作者/.test(button.textContent ?? ""));
        trust?.click();
      });
      await sleep(500);
    }
    if (!await page.evaluate(() => Boolean(app.plugins.plugins["naviboard"]))) {
      await page.evaluate(() => app.plugins.enablePluginAndSave("naviboard"));
    }
    await page.waitForFunction(() => Boolean(app.plugins.plugins["naviboard"]), null, { timeout: 30_000 });

    await page.evaluate(() => app.commands.executeCommandById("naviboard:open-web-desk"));
    const main = page.locator(".web-desk-root:visible").last();
    await main.locator('.web-desk-icon[data-path="收藏夹/Markdown preview.md"]').waitFor({ state: "visible", timeout: 30_000 });
    await main.getByRole("button", { name: "适应", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.web-desk-root .web-desk-file-markdown')?.textContent?.includes("Scroll proof"));
    const mainPdf = main.locator('.web-desk-icon[data-path="收藏夹/PDF reader.md"]');
    await mainPdf.locator('.pdfViewer .page[data-loaded="true"]').waitFor({ state: "attached", timeout: 30_000 });
    await mainPdf.locator(".canvasWrapper canvas").waitFor({ state: "attached", timeout: 30_000 });
    await sleep(450);
    const mainState = await main.evaluate((root) => ({
      markdownCards: root.querySelectorAll('.web-desk-icon[data-view-mode="preview"] .web-desk-file-markdown').length,
      pdfReaders: root.querySelectorAll('.web-desk-icon[data-view-mode="embed"] .web-desk-file-pdf-frame.is-native .pdfViewer .page[data-loaded="true"]').length,
      pdfCanvases: root.querySelectorAll('.web-desk-icon[data-view-mode="embed"] .web-desk-file-pdf-frame canvas').length,
    }));
    if (mainState.markdownCards !== 1 || mainState.pdfReaders < 1 || mainState.pdfCanvases < 1) {
      throw new Error(`main file preview modes failed: ${JSON.stringify({ mainState, runtimeErrors })}`);
    }
    await page.screenshot({ path: MAIN_SCREENSHOT });

    const mainFullscreen = await openFilePreviewFromSelection(page, main, '.web-desk-icon[data-path="收藏夹/Markdown preview.md"]');
    const fullscreenFocus = await page.evaluate(() => {
      const overlay = document.querySelector(".web-desk-file-fullscreen");
      return {
        activeLabel: document.activeElement?.getAttribute("aria-label") ?? "",
        activeInside: Boolean(overlay?.contains(document.activeElement)),
        backgroundInert: [...document.body.children]
          .filter((element) => element !== overlay)
          .every((element) => element.inert),
      };
    });
    await page.keyboard.press("Shift+Tab");
    const previewTabStayedInside = await page.evaluate(() =>
      Boolean(document.querySelector(".web-desk-file-fullscreen")?.contains(document.activeElement)));
    if (
      fullscreenFocus.activeLabel !== "返回画布" ||
      !fullscreenFocus.activeInside ||
      !fullscreenFocus.backgroundInert ||
      !previewTabStayedInside
    ) {
      throw new Error(`file preview focus boundary failed: ${JSON.stringify({ fullscreenFocus, previewTabStayedInside })}`);
    }
    const fullscreenScroll = page.locator(".web-desk-file-fullscreen .web-desk-file-markdown");
    const scrollState = await fullscreenScroll.evaluate((element) => {
      element.scrollTop = 220;
      return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    if (scrollState.scrollTop <= 0 || scrollState.scrollHeight <= scrollState.clientHeight) {
      throw new Error(`fullscreen Markdown did not scroll: ${JSON.stringify(scrollState)}`);
    }
    await page.screenshot({ path: FULLSCREEN_SCREENSHOT });
    await mainFullscreen.back.click();
    await page.waitForFunction(() => !document.querySelector(".web-desk-file-fullscreen"));
    const previewFocusRestored = await page.evaluate(() => ({
      label: document.activeElement?.getAttribute("aria-label") ?? "",
      insideCanvas: Boolean(document.querySelector(".web-desk-root")?.contains(document.activeElement)),
    }));
    if (previewFocusRestored.label !== "全屏预览" || !previewFocusRestored.insideCanvas) {
      throw new Error(`file preview focus did not return to its origin: ${JSON.stringify(previewFocusRestored)}`);
    }
    await mainPdf.waitFor({ state: "visible" });

    await page.evaluate(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded file readers.md");
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "preview" } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    const embed = page.locator(".web-desk-embed:visible").last();
    await embed.locator('.web-desk-icon[data-card-ref="file:Reading note.md"] .web-desk-file-markdown').waitFor({ state: "visible", timeout: 30_000 });
    await embed.locator('.web-desk-icon[data-card-ref="file:Reading sample.pdf"] .pdfViewer .page[data-loaded="true"]').first().waitFor({ state: "attached", timeout: 30_000 });
    await embed.locator('.web-desk-icon[data-card-ref="file:Reading sample.pdf"] .canvasWrapper canvas').first().waitFor({ state: "attached", timeout: 30_000 });
    await sleep(450);
    await embed.getByRole("button", { name: "适应", exact: true }).click();
    const embedMarkdown = embed.locator('.web-desk-icon[data-card-ref="file:Reading note.md"] .web-desk-file-markdown');
    const embedScrollState = await embedMarkdown.evaluate((element) => {
      element.scrollTop = 180;
      return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
    });
    const embedState = await embed.evaluate((root) => ({
      markdownReaders: root.querySelectorAll('.web-desk-icon[data-card-ref="file:Reading note.md"][data-view-mode="embed"] .web-desk-file-markdown').length,
      pdfCards: root.querySelectorAll('.web-desk-icon[data-card-ref="file:Reading sample.pdf"][data-view-mode="preview"] .pdfViewer .page[data-loaded="true"]').length,
      pdfIcons: root.querySelectorAll('.web-desk-icon[data-card-ref="file:Reading sample.pdf"][data-view-mode="icon"] .web-desk-file-badge').length,
    }));
    if (embedScrollState.scrollTop <= 0 || embedScrollState.scrollHeight <= embedScrollState.clientHeight) {
      throw new Error(`embedded Markdown did not scroll: ${JSON.stringify(embedScrollState)}`);
    }
    if (embedState.markdownReaders !== 1 || embedState.pdfCards < 1 || embedState.pdfIcons !== 1) {
      throw new Error(`embedded file preview modes failed: ${JSON.stringify(embedState)}`);
    }
    await page.screenshot({ path: EMBED_SCREENSHOT });

    await embed.locator(".web-desk-fullscreen-btn").click();
    await page.waitForSelector(".web-desk-embed.is-fullscreen");
    const embedFullscreen = await openFilePreviewFromSelection(page, embed, '.web-desk-icon[data-card-ref="file:Reading sample.pdf"][data-view-mode="preview"]');
    const fullscreenPdfContainer = page.locator(".web-desk-file-fullscreen .web-desk-file-pdf-frame .pdf-viewer-container");
    await page.locator('.web-desk-file-fullscreen .pdfViewer .page[data-loaded="true"]').waitFor({ state: "attached", timeout: 30_000 });
    const fullscreenPdfCanvas = page.locator(".web-desk-file-fullscreen .canvasWrapper canvas").first();
    await fullscreenPdfCanvas.waitFor({ state: "attached", timeout: 30_000 });
    await sleep(450);
    const pdfCanvasData = await fullscreenPdfCanvas.evaluate((canvas) => canvas.toDataURL("image/png"));
    fs.writeFileSync(PDF_CANVAS_SCREENSHOT, Buffer.from(pdfCanvasData.split(",", 2)[1], "base64"));
    const fullscreenPdf = await fullscreenPdfContainer.evaluate((container) => ({
      width: container.getBoundingClientRect().width,
      height: container.getBoundingClientRect().height,
      pages: container.querySelectorAll('.pdfViewer .page[data-loaded="true"]').length,
      pageTotal: Number(container.closest(".pdf-embed")?.querySelector(".pdf-page-input")?.max ?? 0),
      scrollTop: (() => { container.scrollTop = 20; return container.scrollTop; })(),
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    }));
    if (fullscreenPdf.pages < 1 || fullscreenPdf.pageTotal !== 2 || fullscreenPdf.width < 600 || fullscreenPdf.height < 400 || fullscreenPdf.scrollTop <= 0 || fullscreenPdf.scrollHeight <= fullscreenPdf.clientHeight) {
      throw new Error(`fullscreen PDF reader failed: ${JSON.stringify(fullscreenPdf)}`);
    }
    await page.screenshot({ path: PDF_FULLSCREEN_SCREENSHOT });
    await embedFullscreen.back.click();
    await page.waitForFunction(() => !document.querySelector(".web-desk-file-fullscreen"));
    const nestedPreviewFocusRestored = await page.evaluate(() => ({
      label: document.activeElement?.getAttribute("aria-label") ?? "",
      insideFullscreenCanvas: Boolean(document.querySelector(".web-desk-embed.is-fullscreen")?.contains(document.activeElement)),
      fullscreenCanvasPresent: Boolean(document.querySelector(".web-desk-embed.is-fullscreen")),
    }));
    if (
      nestedPreviewFocusRestored.label !== "全屏预览" ||
      !nestedPreviewFocusRestored.insideFullscreenCanvas ||
      !nestedPreviewFocusRestored.fullscreenCanvasPresent
    ) {
      throw new Error(`nested file preview did not restore its fullscreen parent: ${JSON.stringify(nestedPreviewFocusRestored)}`);
    }
    await embed.locator(".web-desk-fullscreen-btn").click();
    await page.waitForFunction(() => !document.querySelector(".web-desk-embed.is-fullscreen"));

    const fatalErrors = runtimeErrors.filter((message) =>
      !/favicon|ERR_NAME_NOT_RESOLVED|Failed to load resource/i.test(message),
    );
    if (fatalErrors.length) throw new Error(`runtime errors: ${JSON.stringify(fatalErrors)}`);
    console.log(JSON.stringify({
      mainState,
      scrollState,
      embedState,
      embedScrollState,
      fullscreenPdf,
      fullscreenFocus,
      previewTabStayedInside,
      previewFocusRestored,
      nestedPreviewFocusRestored,
      screenshots: [MAIN_SCREENSHOT, EMBED_SCREENSHOT, FULLSCREEN_SCREENSHOT, PDF_FULLSCREEN_SCREENSHOT, PDF_CANVAS_SCREENSHOT],
    }));
    await browser.close();
  } finally {
    obsidian.kill("SIGTERM");
    setTimeout(() => { try { obsidian.kill("SIGKILL"); } catch {} }, 3000).unref();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
