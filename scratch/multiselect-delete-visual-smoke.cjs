const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { chromium } = require("/Users/yytyyf/projects/oneday/node_modules/playwright");

const REPO = "/Users/yytyyf/projects/obsidian-web-desk";
const PROFILE = `/tmp/webdesk-delete-profile-${process.pid}`;
const VAULT = `/tmp/webdesk-delete-vault-${process.pid}`;
const MAIN_SCREENSHOT = "/tmp/webdesk-delete-main-selected.png";
const EMBED_SCREENSHOT = "/tmp/webdesk-delete-embed-selected.png";
const AREA_DROP_PROBE = process.env.WEB_DESK_AREA_DROP_PROBE === "1";
const AREA_NEW_PROBE = process.env.WEB_DESK_AREA_NEW_PROBE === "1";
const AREA_NEW_FIT_PROBE = process.env.WEB_DESK_AREA_NEW_FIT_PROBE === "1";
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
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await fn();
      if (result) return result;
    } catch {}
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function fixtureData(cardRef) {
  return {
    groups: [{ id: "g1", name: "删除测试区域", x: 80, y: 70, w: 700, h: 500, color: "#7aa2f7" }],
    items: cardRef ? [{
      url: "https://example.invalid/",
      bookmarkPath: cardRef,
      title: "删除测试卡片",
      x: 140,
      y: 160,
      size: 96,
      group: "删除测试区域",
    }] : undefined,
    images: [{ id: "i1", path: "附件/pixel.png", x: 560, y: 160, w: 120, h: 100, group: "删除测试区域" }],
    textboxes: [{ id: "t1", text: "删除测试文本", x: 350, y: 160, w: 170, h: 100, color: "#bb9af7", group: "删除测试区域" }],
    ratings: [{ id: "r1", value: 4, x: 350, y: 350, scale: 1, group: "删除测试区域" }],
    arrows: [{
      id: "a1",
      from: { kind: "card", ref: cardRef ? "https://example.invalid/" : "收藏夹/Delete Sample.md" },
      to: { kind: "textbox", ref: "t1" },
      label: "删除测试箭头",
      color: "",
    }],
  };
}

function prepareFixture() {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.rmSync(VAULT, { recursive: true, force: true });
  const pluginDir = path.join(VAULT, ".obsidian/plugins/web-desk");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(path.join(VAULT, "收藏夹"), { recursive: true });
  fs.mkdirSync(path.join(VAULT, "附件"), { recursive: true });
  for (const filename of ["main.js", "manifest.json", "styles.css"]) {
    fs.copyFileSync(path.join(REPO, filename), path.join(pluginDir, filename));
  }
  fs.writeFileSync(path.join(VAULT, ".obsidian/community-plugins.json"), JSON.stringify(["web-desk"]));
  fs.writeFileSync(path.join(VAULT, ".obsidian/app.json"), JSON.stringify({ livePreview: true }));
  fs.writeFileSync(path.join(pluginDir, "data.json"), JSON.stringify(AREA_NEW_PROBE ? {
    settings: { bookmarkFolder: "收藏夹", imageFolder: "附件", defaultIconSize: 96, blockedEmbedHosts: [] },
    groups: [], textboxes: [], arrows: [], images: [], ratings: [],
    view: { panX: 0, panY: 0, zoom: 1 },
  } : {
    settings: { bookmarkFolder: "收藏夹", imageFolder: "附件", defaultIconSize: 96, blockedEmbedHosts: [] },
    ...fixtureData(),
    view: { panX: 0, panY: 0, zoom: 1 },
  }));
  fs.writeFileSync(path.join(VAULT, "附件/pixel.png"), Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ));
  fs.writeFileSync(path.join(VAULT, "收藏夹/Delete Sample.md"), [
    "---",
    "title: Delete Sample",
    "url: https://example.invalid/",
    "type: link",
    `desk_x: ${AREA_DROP_PROBE ? 820 : 140}`,
    "desk_y: 160",
    "desk_size: 96",
    ...(AREA_DROP_PROBE || AREA_NEW_PROBE ? [] : ["desk_group: 删除测试区域"]),
    "desk_placed: true",
    "---",
    "",
    "# Delete Sample",
  ].join("\n"));
  const embedded = fixtureData("收藏夹/Delete Sample.md");
  fs.writeFileSync(path.join(VAULT, "Embedded delete.md"), [
    "# Embedded delete",
    "",
    "```web-desk",
    JSON.stringify({ height: 620, ...embedded }),
    "```",
    "",
  ].join("\n"));

  fs.mkdirSync(PROFILE, { recursive: true });
  const sourceRegistry = path.join(process.env.HOME, "Library/Application Support/obsidian/obsidian.json");
  let registry = { vaults: {} };
  if (fs.existsSync(sourceRegistry)) {
    try { registry = JSON.parse(fs.readFileSync(sourceRegistry, "utf8")); } catch {}
  }
  registry.vaults = {};
  registry.vaults.webdeskdelete = { path: VAULT, ts: Date.now(), open: true };
  fs.writeFileSync(path.join(PROFILE, "obsidian.json"), JSON.stringify(registry));
}

async function marqueeAll(page, root, reverse = false) {
  const bounds = await root.evaluate((element) => {
    const rootRect = element.getBoundingClientRect();
    const group = element.querySelector(".web-desk-group")?.getBoundingClientRect();
    if (!group) return null;
    return {
      x1: Math.max(rootRect.left + 8, group.left - 14),
      y1: Math.max(rootRect.top + 8, group.top - 14),
      x2: Math.min(rootRect.right - 8, group.right + 14),
      y2: Math.min(rootRect.bottom - 8, group.bottom + 14),
    };
  });
  if (!bounds) throw new Error("missing region geometry for marquee");
  const start = reverse ? { x: bounds.x2, y: bounds.y2 } : { x: bounds.x1, y: bounds.y1 };
  const end = reverse ? { x: bounds.x1, y: bounds.y1 } : { x: bounds.x2, y: bounds.y2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
  await sleep(200);
}

async function selectionState(root) {
  return root.evaluate((element) => ({
    cards: element.querySelectorAll(".web-desk-icon.is-selected").length,
    images: element.querySelectorAll(".web-desk-image.is-selected").length,
    textboxes: element.querySelectorAll(".web-desk-textbox.is-selected").length,
    ratings: element.querySelectorAll(".web-desk-rating.is-selected").length,
    groups: element.querySelectorAll(".web-desk-group.is-selected").length,
    arrows: element.querySelectorAll(".web-desk-arrow.is-selected").length,
  }));
}

function assertAllSelected(state, surface) {
  for (const [kind, count] of Object.entries(state)) {
    if (count !== 1) throw new Error(`${surface} marquee missed ${kind}: ${JSON.stringify(state)}`);
  }
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
          if (await candidate.evaluate(() => window.app?.vault?.getName?.().startsWith("webdesk-delete-vault-"))) return candidate;
        } catch {}
      }
      return null;
    }, 60_000, "temporary vault window");
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
        runtimeErrors.push(message.text());
      }
    });
    await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await page.evaluate(() => Boolean(app.plugins.plugins["web-desk"]))) break;
      await page.evaluate(() => {
        const trust = [...document.querySelectorAll(".modal-container button")]
          .find((button) => /Trust author|信任作者/.test(button.textContent ?? ""));
        trust?.click();
      });
      await sleep(500);
    }
    if (!await page.evaluate(() => Boolean(app.plugins.plugins["web-desk"]))) {
      await page.evaluate(() => app.plugins.enablePluginAndSave("web-desk"));
    }
    await page.waitForFunction(() => Boolean(app.plugins.plugins["web-desk"]), null, { timeout: 30_000 });

    await page.evaluate(() => app.commands.executeCommandById("web-desk:open-web-desk"));
    const main = page.locator(".web-desk-root:visible").last();
    await main.locator(".web-desk-icon").waitFor({ state: "visible", timeout: 30_000 });
    if (!AREA_NEW_PROBE || AREA_NEW_FIT_PROBE) {
      await main.locator(".web-desk-toolbar .web-desk-tool-btn", [aria-label="适应内容"]).click();
    }
    if (process.env.WEB_DESK_AREA_PROBE === "1") {
      const area = main.locator(".web-desk-group").first();
      const card = main.locator(".web-desk-icon").first();
      const areaBefore = await area.boundingBox();
      const cardBefore = await card.boundingBox();
      if (!areaBefore || !cardBefore) throw new Error("missing initial area probe geometry");
      await page.mouse.move(areaBefore.x + 36, areaBefore.y + areaBefore.height - 36);
      await page.mouse.down();
      await page.mouse.move(areaBefore.x + 96, areaBefore.y + areaBefore.height + 4, { steps: 8 });
      await page.mouse.up();
      await sleep(300);
      const areaAfter = await area.boundingBox();
      const cardAfter = await card.boundingBox();
      if (!areaAfter || !cardAfter) throw new Error("area probe lost geometry");
      const areaDelta = { x: areaAfter.x - areaBefore.x, y: areaAfter.y - areaBefore.y };
      const cardDelta = { x: cardAfter.x - cardBefore.x, y: cardAfter.y - cardBefore.y };
      if (Math.abs(cardDelta.x - areaDelta.x) > 3 || Math.abs(cardDelta.y - areaDelta.y) > 3) {
        throw new Error(`initial area did not carry card: ${JSON.stringify({ areaDelta, cardDelta })}`);
      }
      console.log(JSON.stringify({ initialAreaCarry: true, areaDelta, cardDelta }));
      await browser.close();
      return;
    }
    if (AREA_DROP_PROBE) {
      const area = main.locator(".web-desk-group").first();
      const card = main.locator(".web-desk-icon").first();
      const areaBeforeDrop = await area.boundingBox();
      const cardBeforeDrop = await card.boundingBox();
      if (!areaBeforeDrop || !cardBeforeDrop) throw new Error("missing drop probe geometry");
      await page.mouse.move(cardBeforeDrop.x + cardBeforeDrop.width / 2, cardBeforeDrop.y + cardBeforeDrop.height / 2);
      await page.mouse.down();
      await page.mouse.move(areaBeforeDrop.x + areaBeforeDrop.width / 2, areaBeforeDrop.y + areaBeforeDrop.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(async () => {
        const file = app.vault.getAbstractFileByPath("收藏夹/Delete Sample.md");
        return file && /desk_group:\s*删除测试区域/.test(await app.vault.read(file));
      });
      const areaBefore = await area.boundingBox();
      const cardBefore = await card.boundingBox();
      if (!areaBefore || !cardBefore) throw new Error("drop probe rerender lost geometry");
      await page.mouse.move(areaBefore.x + 36, areaBefore.y + areaBefore.height - 36);
      await page.mouse.down();
      await page.mouse.move(areaBefore.x + 96, areaBefore.y + areaBefore.height + 4, { steps: 8 });
      await page.mouse.up();
      await sleep(300);
      const areaAfter = await area.boundingBox();
      const cardAfter = await card.boundingBox();
      if (!areaAfter || !cardAfter) throw new Error("drop probe lost geometry");
      const areaDelta = { x: areaAfter.x - areaBefore.x, y: areaAfter.y - areaBefore.y };
      const cardDelta = { x: cardAfter.x - cardBefore.x, y: cardAfter.y - cardBefore.y };
      if (Math.abs(cardDelta.x - areaDelta.x) > 3 || Math.abs(cardDelta.y - areaDelta.y) > 3) {
        throw new Error(`dropped card was not carried: ${JSON.stringify({ areaDelta, cardDelta })}`);
      }
      console.log(JSON.stringify({ droppedAreaCarry: true, areaDelta, cardDelta }));
      await browser.close();
      return;
    }
    if (AREA_NEW_PROBE) {
      const card = main.locator(".web-desk-icon").first();
      await main.getByRole("button", { name: "新建区域", exact: true }).click();
      const nameEditor = main.locator('.web-desk-group-header[contenteditable="plaintext-only"]').last();
      await nameEditor.waitFor({ state: "visible", timeout: 10_000 });
      await nameEditor.fill("新建区域探针");
      await page.keyboard.press("Enter");
      const area = main.getByRole("group", { name: "区域：新建区域探针", exact: true });
      await area.waitFor({ state: "visible", timeout: 10_000 });
      const areaBeforeDrop = await area.boundingBox();
      const cardBeforeDrop = await card.boundingBox();
      if (!areaBeforeDrop || !cardBeforeDrop) throw new Error("missing new-area probe geometry");
      await page.mouse.move(cardBeforeDrop.x + cardBeforeDrop.width / 2, cardBeforeDrop.y + cardBeforeDrop.height / 2);
      await page.mouse.down();
      await page.mouse.move(areaBeforeDrop.x + areaBeforeDrop.width / 2, areaBeforeDrop.y + areaBeforeDrop.height / 2, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(async () => {
        const file = app.vault.getAbstractFileByPath("收藏夹/Delete Sample.md");
        return file && /desk_group:\s*新建区域探针/.test(await app.vault.read(file));
      });
      const areaBefore = await area.boundingBox();
      const cardBefore = await card.boundingBox();
      if (!areaBefore || !cardBefore) throw new Error("new-area probe rerender lost geometry");
      const moveStart = { x: areaBefore.x + 60, y: areaBefore.y + 60 };
      const moveHit = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        return { tag: element?.tagName ?? "", className: element?.getAttribute("class") ?? "" };
      }, moveStart);
      await page.mouse.move(moveStart.x, moveStart.y);
      await page.mouse.down();
      await page.mouse.move(moveStart.x + 60, moveStart.y + 40, { steps: 6 });
      await page.mouse.up();
      await sleep(300);
      const areaAfter = await area.boundingBox();
      const cardAfter = await card.boundingBox();
      if (!areaAfter || !cardAfter) throw new Error("new-area probe lost geometry");
      const areaDelta = { x: areaAfter.x - areaBefore.x, y: areaAfter.y - areaBefore.y };
      const cardDelta = { x: cardAfter.x - cardBefore.x, y: cardAfter.y - cardBefore.y };
      if (areaDelta.x < 20 || areaDelta.y < 12 ||
        Math.abs(cardDelta.x - areaDelta.x) > 3 || Math.abs(cardDelta.y - areaDelta.y) > 3) {
        throw new Error(`new area did not carry dropped card: ${JSON.stringify({ areaDelta, cardDelta, areaBefore, cardBefore, moveStart, moveHit })}`);
      }
      console.log(JSON.stringify({ newAreaCarry: true, areaDelta, cardDelta }));
      await browser.close();
      return;
    }
    await marqueeAll(page, main);
    const mainSelected = await selectionState(main);
    assertAllSelected(mainSelected, "main");
    await page.screenshot({ path: MAIN_SCREENSHOT });
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => !document.querySelector(".web-desk-root .web-desk-icon, .web-desk-root .web-desk-image, .web-desk-root .web-desk-textbox, .web-desk-root .web-desk-rating, .web-desk-root .web-desk-group, .web-desk-root .web-desk-arrow"));
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("收藏夹/Delete Sample.md");
      return file && /^desk_hidden:\s*true\s*$/m.test(await app.vault.read(file));
    });

    await page.evaluate(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded delete.md");
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "preview" } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    const embed = page.locator(".web-desk-embed:visible").last();
    await embed.locator(".web-desk-icon").waitFor({ state: "visible", timeout: 30_000 });
    await embed.locator(".web-desk-toolbar .web-desk-tool-btn", [aria-label="适应内容"]).click();
    await marqueeAll(page, embed, true);
    const embedSelected = await selectionState(embed);
    assertAllSelected(embedSelected, "embed");
    await page.screenshot({ path: EMBED_SCREENSHOT });
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => {
      const roots = [...document.querySelectorAll(".web-desk-embed")]
        .filter((element) => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
      const root = roots.at(-1);
      return Boolean(root) && !root.querySelector(".web-desk-icon, .web-desk-image, .web-desk-textbox, .web-desk-rating, .web-desk-group, .web-desk-arrow");
    });
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded delete.md");
      const source = await app.vault.read(file);
      const match = source.match(/```web-desk\n([\s\S]*?)\n```/);
      if (!match) return false;
      const data = JSON.parse(match[1]);
      return ["items", "images", "textboxes", "ratings", "groups", "arrows"]
        .every((key) => Array.isArray(data[key]) && data[key].length === 0);
    });

    const preservation = await page.evaluate(() => ({
      card: Boolean(app.vault.getAbstractFileByPath("收藏夹/Delete Sample.md")),
      image: Boolean(app.vault.getAbstractFileByPath("附件/pixel.png")),
    }));
    if (!preservation.card || !preservation.image) throw new Error(`source files were deleted: ${JSON.stringify(preservation)}`);
    if (runtimeErrors.length > 0) throw new Error(`runtime errors: ${JSON.stringify(runtimeErrors)}`);
    const enabled = JSON.parse(fs.readFileSync(path.join(VAULT, ".obsidian/community-plugins.json"), "utf8"));
    console.log(JSON.stringify({
      mainSelected,
      embedSelected,
      preservation,
      pluginOccurrences: enabled.filter((id) => id === "web-desk").length,
      screenshots: [MAIN_SCREENSHOT, EMBED_SCREENSHOT],
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
