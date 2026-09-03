const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { chromium } = require("/Users/yytyyf/projects/oneday/node_modules/playwright");

const REPO = "/Users/yytyyf/projects/obsidian-web-desk";
const PROFILE = "/tmp/webdesk-parity-profile";
const VAULT = "/tmp/webdesk-parity-vault";
const MAIN_SCREENSHOT = "/tmp/webdesk-parity-main.png";
const EMBED_SCREENSHOT = "/tmp/webdesk-parity-embed.png";
const INLINE_GROUP_SCREENSHOT = "/tmp/webdesk-parity-inline-group.png";
const CLEAN_SCREENSHOT = "/tmp/webdesk-parity-clean.png";
const DRILLDOWN_SCREENSHOT = "/tmp/webdesk-parity-drilldown.png";
const NARROW_SCREENSHOT = "/tmp/webdesk-parity-narrow.png";
const DARK_NARROW_SCREENSHOT = "/tmp/webdesk-parity-dark-narrow.png";
const COLOR_PICKER_SCREENSHOT = "/tmp/webdesk-color-picker-light.png";
const COLOR_PICKER_DARK_SCREENSHOT = "/tmp/webdesk-color-picker-dark.png";
const AREA_DROP_SCREENSHOT = "/tmp/webdesk-area-drop.png";
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
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${label}`);
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
  fs.writeFileSync(
    path.join(VAULT, ".obsidian/community-plugins.json"),
    JSON.stringify(["web-desk"]),
  );
  fs.writeFileSync(path.join(VAULT, ".obsidian/app.json"), JSON.stringify({ livePreview: true }));
  fs.writeFileSync(
    path.join(VAULT, "收藏夹/Parity Sample.md"),
    [
      "---",
      "title: Parity Sample",
      "url: https://example.invalid/",
      "type: link",
      "desk_x: 96",
      "desk_y: 96",
      "desk_size: 96",
      "desk_placed: true",
      "---",
      "",
      "# Parity Sample",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(VAULT, "收藏夹/Canvas shortcut.md"),
    [
      "---",
      "title: Child canvas",
      "type: file",
      "desk_file: Child canvas.md",
      "desk_x: 280",
      "desk_y: 96",
      "desk_size: 96",
      "desk_placed: true",
      "---",
      "",
      "[[Child canvas]]",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(VAULT, "Grandchild canvas.md"),
    [
      "# Grandchild canvas",
      "",
      "```web-desk",
      JSON.stringify({
        height: 420,
        groups: [],
        items: [{
          url: "",
          path: "Embedded parity.md",
          title: "Back to parent (cycle)",
          x: 96,
          y: 96,
          size: 96,
        }],
      }),
      "```",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(VAULT, "Child canvas.md"),
    [
      "# Child canvas",
      "",
      "```web-desk",
      JSON.stringify({
        height: 420,
        groups: [],
        items: [{
          url: "",
          path: "Grandchild canvas.md",
          title: "Grandchild canvas",
          x: 96,
          y: 96,
          size: 96,
        }],
      }),
      "```",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(VAULT, "Embedded parity.md"),
    [
      "# Embedded parity",
      "",
      "```web-desk",
      JSON.stringify({
        height: 520,
        groups: [{
          id: "g-ui",
          name: "UI",
          x: 300,
          y: 72,
          w: 360,
          h: 240,
          color: "#7aa2f7",
        }],
        items: [
          {
            url: "https://example.invalid/",
            bookmarkPath: "收藏夹/Parity Sample.md",
            title: "Parity Sample",
            description: "Shared canvas capability fixture",
            x: 96,
            y: 96,
            size: 96,
          },
          {
            url: "",
            path: "Child canvas.md",
            title: "Child canvas",
            x: 720,
            y: 96,
            size: 96,
          },
        ],
        textboxes: [{
          id: "tb-area",
          text: "拖进区域",
          x: 72,
          y: 320,
          w: 180,
          h: 80,
          color: "#bb9af7",
        }],
      }),
      "```",
      "",
    ].join("\n"),
  );

  fs.mkdirSync(PROFILE, { recursive: true });
  const sourceRegistry = path.join(
    process.env.HOME,
    "Library/Application Support/obsidian/obsidian.json",
  );
  let registry = { vaults: {} };
  if (fs.existsSync(sourceRegistry)) {
    try {
      registry = JSON.parse(fs.readFileSync(sourceRegistry, "utf8"));
    } catch {}
  }
  registry.vaults = {};
  registry.vaults.webdeskparity = { path: VAULT, ts: Date.now(), open: true };
  fs.writeFileSync(path.join(PROFILE, "obsidian.json"), JSON.stringify(registry));
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
      try {
        return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      } catch {
        return null;
      }
    }, 45_000, "Obsidian CDP");
    const page = await waitFor(async () => {
      for (const candidate of browser.contexts()[0]?.pages() ?? []) {
        try {
          if (await candidate.evaluate(() => window.app?.vault?.getName?.() === "webdesk-parity-vault")) {
            return candidate;
          }
        } catch {}
      }
      return null;
    }, 60_000, "temporary vault window");
    const runtimeErrors = [];
    page.on("pageerror", (error) => runtimeErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") runtimeErrors.push(message.text());
    });

    await page.waitForFunction(() => window.app?.workspace?.layoutReady, null, { timeout: 60_000 });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await page.evaluate(() => Boolean(app.plugins.plugins["web-desk"]))) break;
      await page.evaluate(() => {
        const trust = [...document.querySelectorAll(".modal-container button")]
          .find((button) => /Trust author|信任作者/.test(button.textContent ?? ""));
        trust?.click();
      });
      await sleep(750);
    }
    if (!await page.evaluate(() => Boolean(app.plugins.plugins["web-desk"]))) {
      await page.evaluate(() => app.plugins.enablePluginAndSave("web-desk"));
    }
    await page.waitForFunction(() => Boolean(app.plugins.plugins["web-desk"]), null, { timeout: 30_000 });

    await page.evaluate(() => app.commands.executeCommandById("web-desk:open-web-desk"));
    await page.waitForSelector(".web-desk-root .web-desk-icon", { timeout: 30_000 });
    const main = page.locator(".web-desk-root:visible").last();
    const mainFit = await main.locator(".web-desk-toolbar .web-desk-tool-btn").allTextContents();
    await main.locator(".web-desk-toolbar .web-desk-tool-btn", { hasText: "适应" }).click();
    const mainGroupCountBefore = await main.locator(".web-desk-group").count();
    await main.getByRole("button", { name: "新建区域", exact: true }).click();
    const mainInlineGroupName = main.locator('.web-desk-group-header[contenteditable="plaintext-only"]').last();
    await mainInlineGroupName.waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "区域名称");
    await page.screenshot({ path: INLINE_GROUP_SCREENSHOT });
    const mainInlineCreateState = await page.evaluate(() => ({
      modalCount: document.querySelectorAll(".modal-container").length,
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? "",
      groupCount: document.querySelectorAll(".web-desk-root .web-desk-group").length,
    }));
    if (
      mainInlineCreateState.modalCount !== 0 ||
      mainInlineCreateState.groupCount !== mainGroupCountBefore + 1
    ) {
      throw new Error(`main inline group creation failed: ${JSON.stringify({ mainGroupCountBefore, mainInlineCreateState })}`);
    }
    await page.keyboard.type("主画布分组");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector('.web-desk-root .web-desk-group-header[contenteditable]'));
    if (!await main.locator(".web-desk-group-header", { hasText: "主画布分组" }).count()) {
      throw new Error("main inline group name did not commit");
    }
    const mainArea = main.getByRole("group", { name: "区域：主画布分组", exact: true });
    const mainAreaBox = await mainArea.boundingBox();
    const mainAreaCard = main.locator('.web-desk-icon[data-path="收藏夹/Parity Sample.md"]');
    const mainCardBeforeDrop = await mainAreaCard.boundingBox();
    if (!mainAreaBox || !mainCardBeforeDrop) throw new Error("missing main area membership fixture geometry");
    await page.mouse.move(mainCardBeforeDrop.x + mainCardBeforeDrop.width / 2, mainCardBeforeDrop.y + mainCardBeforeDrop.height / 2);
    await page.mouse.down();
    await page.mouse.move(mainAreaBox.x + mainAreaBox.width / 2, mainAreaBox.y + mainAreaBox.height / 2, { steps: 8 });
    const mainDropTargetVisible = await mainArea.evaluate((element) => element.classList.contains("is-drop-target"));
    if (!mainDropTargetVisible) throw new Error("main area did not show a drop target");
    await page.mouse.up();
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("收藏夹/Parity Sample.md");
      return file && /desk_group:\s*主画布分组/.test(await app.vault.read(file));
    });
    if (process.env.WEB_DESK_AREA_DELAY_MS) {
      await sleep(Number(process.env.WEB_DESK_AREA_DELAY_MS));
    }
    const mainAreaBeforeMove = await mainArea.boundingBox();
    const mainCardBeforeAreaMove = await mainAreaCard.boundingBox();
    if (!mainAreaBeforeMove || !mainCardBeforeAreaMove) throw new Error("main area rerender lost geometry");
    const mainAreaMoveStart = await mainArea.evaluate((area) => {
      const rect = area.getBoundingClientRect();
      const maxX = Math.min(rect.width - 36, window.innerWidth - rect.left - 80);
      const maxY = Math.min(rect.height - 36, window.innerHeight - rect.top - 80);
      for (let y = 36; y <= maxY; y += 28) {
        for (let x = 36; x <= maxX; x += 28) {
          const hit = document.elementFromPoint(rect.left + x, rect.top + y);
          if (
            hit?.closest(".web-desk-group") === area &&
            !hit.closest(".web-desk-icon, .web-desk-image, .web-desk-textbox, .web-desk-rating, .web-desk-group-resize, .web-desk-selection-toolbar")
          ) return { x: rect.left + x, y: rect.top + y };
        }
      }
      return null;
    });
    if (!mainAreaMoveStart) throw new Error("no visible blank point inside main area");
    const mainAreaMoveHit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return { tag: element?.tagName ?? "", className: element?.getAttribute("class") ?? "" };
    }, mainAreaMoveStart);
    await page.mouse.move(mainAreaMoveStart.x, mainAreaMoveStart.y);
    await page.mouse.down();
    await page.mouse.move(mainAreaMoveStart.x + 60, mainAreaMoveStart.y + 40, { steps: 6 });
    await page.mouse.up();
    await mainAreaCard.waitFor({ state: "visible", timeout: 10_000 });
    const mainAreaAfterMove = await mainArea.boundingBox();
    const mainCardAfterAreaMove = await mainAreaCard.boundingBox();
    if (
      !mainAreaAfterMove ||
      !mainCardAfterAreaMove ||
      mainAreaAfterMove.x - mainAreaBeforeMove.x < 20 ||
      mainAreaAfterMove.y - mainAreaBeforeMove.y < 12 ||
      Math.abs(
        (mainCardAfterAreaMove.x - mainCardBeforeAreaMove.x) -
        (mainAreaAfterMove.x - mainAreaBeforeMove.x)
      ) > 3 ||
      Math.abs(
        (mainCardAfterAreaMove.y - mainCardBeforeAreaMove.y) -
        (mainAreaAfterMove.y - mainAreaBeforeMove.y)
      ) > 3
    ) {
      const persisted = await page.evaluate(async () => {
        const file = app.vault.getAbstractFileByPath("收藏夹/Parity Sample.md");
        return file ? await app.vault.read(file) : "missing";
      });
      throw new Error(`main area did not carry its card: ${JSON.stringify({ mainAreaBeforeMove, mainAreaAfterMove, mainCardBeforeAreaMove, mainCardAfterAreaMove, mainAreaMoveStart, mainAreaMoveHit, persisted })}`);
    }
    const mainAreaBehavior = {
      dropTargetVisible: mainDropTargetVisible,
      persistedMembership: true,
      carriedDelta: {
        x: Math.round(mainAreaAfterMove.x - mainAreaBeforeMove.x),
        y: Math.round(mainAreaAfterMove.y - mainAreaBeforeMove.y),
      },
    };
    await mainArea.focus();
    await page.keyboard.press("Delete");
    await page.waitForFunction((expected) => document.querySelectorAll(".web-desk-root .web-desk-group").length === expected, mainGroupCountBefore);
    await sleep(500);
    const mainCanvasReference = main.locator('.web-desk-icon[data-path="收藏夹/Canvas shortcut.md"].is-canvas-reference');
    await mainCanvasReference.waitFor({ state: "visible", timeout: 10_000 });
    await mainCanvasReference.dblclick();
    await main.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelectorAll(".web-desk-root .web-desk-drilldown-crumb").length === 2);
    const mainDrilldownCrumbs = await page.locator(".web-desk-root .web-desk-drilldown-crumb").allTextContents();
    await page.locator(".web-desk-root .web-desk-drilldown-back").click();
    await page.waitForFunction(() => !document.querySelector(".web-desk-root .web-desk-drilldown"));
    const mainSample = main.locator('.web-desk-icon[data-path="收藏夹/Parity Sample.md"]');
    await mainSample.click({ position: { x: 12, y: 12 } });
    await main.locator(".web-desk-selection-toolbar").waitFor({ state: "visible" });
    const compactChrome = await main.evaluate((root) => {
      const rect = (selector) => {
        const element = root.querySelector(selector);
        const box = element?.getBoundingClientRect();
        return box ? { width: box.width, height: box.height } : null;
      };
      return {
        createTool: rect(".web-desk-create-tool"),
        createIcon: rect(".web-desk-create-tool svg"),
        selectionTool: rect(".web-desk-selection-tool"),
        selectionToolbar: rect(".web-desk-selection-toolbar"),
        zoomTool: rect(".web-desk-tool-btn"),
      };
    });
    if (
      compactChrome.createTool?.width > 32.5 ||
      compactChrome.createTool?.height > 32.5 ||
      compactChrome.createIcon?.width > 16.5 ||
      compactChrome.createIcon?.height > 16.5 ||
      compactChrome.selectionTool?.height > 32.5 ||
      compactChrome.selectionToolbar?.height > 40.5 ||
      compactChrome.zoomTool?.height > 32.5
    ) {
      throw new Error(`canvas chrome was expanded by host styles: ${JSON.stringify(compactChrome)}`);
    }
    const hoverTool = main.locator(".web-desk-selection-tool").last();
    await page.mouse.move(20, 20);
    await sleep(180);
    const beforeHover = await hoverTool.boundingBox();
    if (!beforeHover) throw new Error("missing toolbar action for hover verification");
    await page.mouse.move(beforeHover.x + beforeHover.width / 2, beforeHover.y + beforeHover.height / 2);
    await sleep(150);
    const currentHoverTool = main.locator(".web-desk-selection-tool").last();
    const afterHover = await currentHoverTool.boundingBox();
    const hoverChrome = await currentHoverTool.evaluate((button) => ({
      backgroundColor: getComputedStyle(button).backgroundColor,
      color: getComputedStyle(button).color,
    }));
    if (
      !afterHover ||
      Math.abs(beforeHover.width - afterHover.width) > 0.5 ||
      Math.abs(beforeHover.height - afterHover.height) > 0.5
    ) {
      throw new Error(`toolbar hover changed layout: ${JSON.stringify({ beforeHover, afterHover })}`);
    }
    await page.screenshot({ path: MAIN_SCREENSHOT });
    await page.setViewportSize({ width: 760, height: 700 });
    await sleep(220);
    const narrowChrome = await main.evaluate((root) => {
      const rootRect = root.getBoundingClientRect();
      const toolbar = root.querySelector(".web-desk-selection-toolbar");
      const toolbarRect = toolbar?.getBoundingClientRect();
      return {
        rootWidth: rootRect.width,
        compact: toolbar?.classList.contains("is-compact") ?? false,
        toolbarLeft: toolbarRect?.left ?? -1,
        toolbarRight: toolbarRect?.right ?? -1,
        rootLeft: rootRect.left,
        rootRight: rootRect.right,
      };
    });
    await page.screenshot({ path: NARROW_SCREENSHOT });
    if (
      narrowChrome.rootWidth <= 520 &&
      (!narrowChrome.compact || narrowChrome.toolbarLeft < narrowChrome.rootLeft + 7 || narrowChrome.toolbarRight > narrowChrome.rootRight - 7)
    ) {
      throw new Error(`narrow selection toolbar escaped safe bounds: ${JSON.stringify(narrowChrome)}`);
    }
    await page.evaluate(() => {
      document.body.classList.remove("theme-light");
      document.body.classList.add("theme-dark");
    });
    await sleep(180);
    await page.screenshot({ path: DARK_NARROW_SCREENSHOT });
    const darkNarrowState = await main.evaluate((root) => {
      const style = getComputedStyle(root);
      const toolbar = root.querySelector(".web-desk-selection-toolbar");
      const toolbarStyle = toolbar ? getComputedStyle(toolbar) : null;
      return {
        rootBackground: style.backgroundColor,
        toolbarBackground: toolbarStyle?.backgroundColor ?? "",
        toolbarColor: toolbarStyle?.color ?? "",
      };
    });
    await page.evaluate(() => {
      document.body.classList.remove("theme-dark");
      document.body.classList.add("theme-light");
    });
    await page.setViewportSize({ width: 1024, height: 800 });
    await sleep(220);
    await page.keyboard.press("Delete");
    await mainSample.waitFor({ state: "detached" });
    const mainDeleteState = await page.evaluate(async () => {
      const file = app.vault.getAbstractFileByPath("收藏夹/Parity Sample.md");
      return {
        preservedFile: Boolean(file),
        hiddenPersisted: file ? /^desk_hidden:\s*true\s*$/m.test(await app.vault.read(file)) : false,
        confirmationOpen: Boolean(document.querySelector(".modal-container")),
      };
    });
    if (!mainDeleteState.preservedFile || !mainDeleteState.hiddenPersisted || mainDeleteState.confirmationOpen) {
      throw new Error(`main Delete was not immediate and non-destructive: ${JSON.stringify(mainDeleteState)}`);
    }

    await page.evaluate(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded parity.md");
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
      await leaf.setViewState({ type: "markdown", state: { file: file.path, mode: "preview" } });
      app.workspace.setActiveLeaf(leaf, { focus: true });
    });
    await page.waitForSelector(".web-desk-embed:visible .web-desk-icon", { timeout: 30_000 });
    const embed = page.locator(".web-desk-embed:visible").last();
    const embedFit = await embed.locator(".web-desk-toolbar .web-desk-tool-btn").allTextContents();
    await embed.locator(".web-desk-toolbar .web-desk-tool-btn", { hasText: "适应" }).click();
    await embed.getByRole("button", { name: "全屏", exact: true }).click();
    await page.waitForSelector(".web-desk-embed.is-fullscreen");
    const fullscreenFocus = await page.evaluate(() => {
      const root = document.querySelector(".web-desk-embed.is-fullscreen");
      return {
        activeLabel: document.activeElement?.getAttribute("aria-label") ?? "",
        activeInside: Boolean(root?.contains(document.activeElement)),
        backgroundInert: [...document.body.children]
          .filter((element) => element !== root)
          .every((element) => element.inert),
      };
    });
    for (let index = 0; index < 20; index += 1) await page.keyboard.press("Tab");
    const fullscreenTabStayedInside = await page.evaluate(() =>
      Boolean(document.querySelector(".web-desk-embed.is-fullscreen")?.contains(document.activeElement)));
    if (
      fullscreenFocus.activeLabel !== "退出全屏" ||
      !fullscreenFocus.activeInside ||
      !fullscreenFocus.backgroundInert ||
      !fullscreenTabStayedInside
    ) {
      throw new Error(`fullscreen focus boundary failed: ${JSON.stringify({ fullscreenFocus, fullscreenTabStayedInside })}`);
    }
    const fullscreenRect = await page.evaluate(() => {
      const root = document.querySelector(".web-desk-embed.is-fullscreen");
      const rect = root.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      };
    });
    if (
      Math.abs(fullscreenRect.x) > 1 ||
      Math.abs(fullscreenRect.y) > 1 ||
      Math.abs(fullscreenRect.width - fullscreenRect.viewportWidth) > 2 ||
      Math.abs(fullscreenRect.height - fullscreenRect.viewportHeight) > 2
    ) {
      throw new Error(`fullscreen canvas does not cover viewport: ${JSON.stringify(fullscreenRect)}`);
    }
    const fullscreenWebCard = page.locator('.web-desk-embed.is-fullscreen > .web-desk-canvas .web-desk-icon[data-card-ref="https://example.invalid/"]');
    await fullscreenWebCard.click({ position: { x: 18, y: 18 } });
    const editProperties = page.getByRole("button", { name: "编辑名称、评分与备注", exact: true });
    await editProperties.click();
    const propertiesModal = page.locator(".modal-container .web-desk-card-properties");
    await propertiesModal.waitFor({ state: "visible", timeout: 10_000 });
    const propertyTitle = propertiesModal.locator('input[type="text"]');
    await propertyTitle.fill("Parity Sample modal focus");
    await page.keyboard.press("Tab");
    const modalFocusState = await page.evaluate(() => ({
      activeInsideModal: Boolean(document.querySelector(".modal-container")?.contains(document.activeElement)),
      fullscreenStillPresent: Boolean(document.querySelector(".web-desk-embed.is-fullscreen")),
    }));
    if (!modalFocusState.activeInsideModal || !modalFocusState.fullscreenStillPresent) {
      throw new Error(`Obsidian modal lost focus above fullscreen canvas: ${JSON.stringify(modalFocusState)}`);
    }
    await page.keyboard.press("Escape");
    await propertiesModal.waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "编辑名称、评分与备注");
    const modalFocusRestored = await page.evaluate(() =>
      Boolean(document.querySelector(".web-desk-embed.is-fullscreen")?.contains(document.activeElement)));
    if (!modalFocusRestored) throw new Error("modal focus did not return to the fullscreen canvas trigger");

    const fullscreenSurface = page.locator(".web-desk-embed.is-fullscreen");
    const area = fullscreenSurface.getByRole("group", { name: "区域：UI", exact: true });
    const areaText = fullscreenSurface.locator('.web-desk-textbox[data-tb-id="tb-area"]');
    const areaBox = await area.boundingBox();
    const textBeforeDrop = await areaText.boundingBox();
    if (!areaBox || !textBeforeDrop) throw new Error("missing area membership fixture geometry");
    const dropX = areaBox.x + areaBox.width / 2;
    const dropY = areaBox.y + areaBox.height / 2;
    await page.mouse.move(textBeforeDrop.x + textBeforeDrop.width / 2, textBeforeDrop.y + textBeforeDrop.height / 2);
    await page.mouse.down();
    await page.mouse.move(dropX, dropY, { steps: 8 });
    const dropTargetVisible = await area.evaluate((element) => element.classList.contains("is-drop-target"));
    if (!dropTargetVisible) throw new Error("area did not show a drop target while an element entered it");
    await page.screenshot({ path: AREA_DROP_SCREENSHOT });
    await page.mouse.up();
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded parity.md");
      if (!file) return false;
      const source = await app.vault.read(file);
      const match = source.match(/```web-desk\n([\s\S]*?)\n```/);
      if (!match) return false;
      const data = JSON.parse(match[1]);
      return data.textboxes?.find((box) => box.id === "tb-area")?.group === "UI";
    });
    await page.waitForFunction(() => document.querySelectorAll(".web-desk-embed.is-fullscreen").length === 1);
    await area.waitFor({ state: "visible", timeout: 10_000 });
    await areaText.waitFor({ state: "visible", timeout: 10_000 });
    const areaAfterDrop = await area.boundingBox();
    const textBeforeAreaMove = await areaText.boundingBox();
    if (!areaAfterDrop || !textBeforeAreaMove) {
      throw new Error(`area fixture rerender lost geometry: ${JSON.stringify({ areaAfterDrop, textBeforeAreaMove })}`);
    }
    const areaMoveStart = await area.evaluate((areaElement) => {
      const rect = areaElement.getBoundingClientRect();
      const maxX = Math.min(rect.width - 36, window.innerWidth - rect.left - 80);
      const maxY = Math.min(rect.height - 36, window.innerHeight - rect.top - 80);
      for (let y = 36; y <= maxY; y += 28) {
        for (let x = 36; x <= maxX; x += 28) {
          const hit = document.elementFromPoint(rect.left + x, rect.top + y);
          if (
            hit?.closest(".web-desk-group") === areaElement &&
            !hit.closest(".web-desk-icon, .web-desk-image, .web-desk-textbox, .web-desk-rating, .web-desk-group-resize, .web-desk-selection-toolbar")
          ) return { x: rect.left + x, y: rect.top + y };
        }
      }
      return null;
    });
    if (!areaMoveStart) {
      const embeddedSource = await page.evaluate(async () => {
        const file = app.vault.getAbstractFileByPath("Embedded parity.md");
        return file ? await app.vault.read(file) : "missing";
      });
      throw new Error(`no visible blank point inside embedded area: ${JSON.stringify({ areaBox, textBeforeDrop, areaAfterDrop, textBeforeAreaMove, embeddedSource })}`);
    }
    await page.mouse.move(areaMoveStart.x, areaMoveStart.y);
    await page.mouse.down();
    await page.mouse.move(areaMoveStart.x + 60, areaMoveStart.y + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelectorAll(".web-desk-embed.is-fullscreen").length === 1);
    await area.waitFor({ state: "visible", timeout: 10_000 });
    await areaText.waitFor({ state: "visible", timeout: 10_000 });
    const areaAfterMove = await area.boundingBox();
    const textAfterAreaMove = await areaText.boundingBox();
    if (
      !areaAfterMove ||
      !textAfterAreaMove ||
      areaAfterMove.x - areaAfterDrop.x < 20 ||
      areaAfterMove.y - areaAfterDrop.y < 12 ||
      Math.abs(
        (textAfterAreaMove.x - textBeforeAreaMove.x) -
        (areaAfterMove.x - areaAfterDrop.x)
      ) > 3 ||
      Math.abs(
        (textAfterAreaMove.y - textBeforeAreaMove.y) -
        (areaAfterMove.y - areaAfterDrop.y)
      ) > 3
    ) {
      const embeddedSource = await page.evaluate(async () => {
        const file = app.vault.getAbstractFileByPath("Embedded parity.md");
        return file ? await app.vault.read(file) : "missing";
      });
      const fullscreenCount = await page.locator(".web-desk-embed.is-fullscreen").count();
      throw new Error(`area did not carry its member: ${JSON.stringify({ areaBox, textBeforeDrop, areaAfterDrop, areaAfterMove, textBeforeAreaMove, textAfterAreaMove, areaMoveStart, fullscreenCount, embeddedSource })}`);
    }
    const areaBehavior = {
      dropTargetVisible,
      persistedMembership: true,
      carriedDelta: {
        x: Math.round(areaAfterMove.x - areaAfterDrop.x),
        y: Math.round(areaAfterMove.y - areaAfterDrop.y),
      },
    };
    await areaText.click({ position: { x: 18, y: 18 } });
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => !document.querySelector('.web-desk-embed.is-fullscreen [data-tb-id="tb-area"]'));
    const embedGroupCountBefore = await page.locator(".web-desk-embed.is-fullscreen .web-desk-group").count();
    await embed.getByRole("button", { name: "新建区域", exact: true }).click();
    const embedInlineGroupName = page.locator('.web-desk-embed.is-fullscreen .web-desk-group-header[contenteditable="plaintext-only"]').last();
    await embedInlineGroupName.waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: INLINE_GROUP_SCREENSHOT });
    const embedInlineCreateState = await page.evaluate(() => ({
      modalCount: document.querySelectorAll(".modal-container").length,
      activeLabel: document.activeElement?.getAttribute("aria-label") ?? "",
      groupCount: document.querySelectorAll(".web-desk-embed.is-fullscreen .web-desk-group").length,
    }));
    if (
      embedInlineCreateState.modalCount !== 0 ||
      embedInlineCreateState.activeLabel !== "区域名称" ||
      embedInlineCreateState.groupCount !== embedGroupCountBefore + 1
    ) {
      throw new Error(`embedded inline group creation failed: ${JSON.stringify({ embedGroupCountBefore, embedInlineCreateState })}`);
    }
    await page.keyboard.type("文内分组");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector('.web-desk-embed.is-fullscreen .web-desk-group-header[contenteditable]'));
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded parity.md");
      return file && /"name"\s*:\s*"文内分组"/.test(await app.vault.read(file));
    });
    const createdEmbedGroup = page.locator(".web-desk-embed.is-fullscreen .web-desk-group", { hasText: "文内分组" });
    const createdGroupBeforeDrag = await waitFor(
      () => createdEmbedGroup.boundingBox(),
      10_000,
      "new embedded group after code-block rerender",
    );
    if (!createdGroupBeforeDrag) throw new Error("missing newly created embedded group geometry");
    await page.mouse.move(createdGroupBeforeDrag.x + 64, createdGroupBeforeDrag.y + 64);
    await page.mouse.down();
    await page.mouse.move(createdGroupBeforeDrag.x + 96, createdGroupBeforeDrag.y + 88, { steps: 5 });
    await page.mouse.up();
    await sleep(220);
    const createdGroupAfterDrag = await createdEmbedGroup.boundingBox();
    if (
      !createdGroupAfterDrag ||
      createdGroupAfterDrag.x - createdGroupBeforeDrag.x < 20 ||
      createdGroupAfterDrag.y - createdGroupBeforeDrag.y < 12
    ) {
      throw new Error(`new embedded group did not remain draggable: ${JSON.stringify({ createdGroupBeforeDrag, createdGroupAfterDrag })}`);
    }
    const group = page.locator(".web-desk-embed.is-fullscreen .web-desk-group").first();
    const groupHandle = group.locator(".web-desk-group-resize");
    const cleanGroupStyle = await group.evaluate((element) => ({
      borderColor: getComputedStyle(element).borderTopColor,
      backgroundColor: getComputedStyle(element).backgroundColor,
    }));
    const handleAtRest = Number(await groupHandle.evaluate((handle) => getComputedStyle(handle).opacity));
    await page.screenshot({ path: CLEAN_SCREENSHOT });
    const groupRect = await group.boundingBox();
    if (!groupRect) throw new Error("missing group geometry for resize handle verification");
    await page.mouse.move(groupRect.x + 24, groupRect.y + 24);
    await sleep(180);
    const handleOnHover = Number(await groupHandle.evaluate((handle) => getComputedStyle(handle).opacity));
    await page.screenshot({ path: EMBED_SCREENSHOT });
    await page.mouse.move(900, 48);
    await sleep(180);
    const handleAfterLeave = Number(await groupHandle.evaluate((handle) => getComputedStyle(handle).opacity));
    if (handleAtRest !== 0 || handleOnHover !== 1 || handleAfterLeave !== 0) {
      throw new Error(`resize handle visibility states failed: ${JSON.stringify({ handleAtRest, handleOnHover, handleAfterLeave })}`);
    }
    if (cleanGroupStyle.borderColor !== "rgba(0, 0, 0, 0)" || cleanGroupStyle.backgroundColor !== "rgba(0, 0, 0, 0)") {
      throw new Error(`legacy group did not default to clean appearance: ${JSON.stringify(cleanGroupStyle)}`);
    }
    await group.click({ position: { x: 48, y: 48 } });
    await page.getByRole("button", { name: "设置区域外观", exact: true }).click();
    await sleep(300);
    const appearanceMenuDebug = await page.evaluate(() => [...document.querySelectorAll("body *")]
      .filter((element) => (element.textContent ?? "").includes("显示底色"))
      .slice(-8)
      .map((element) => ({ className: element.className, text: element.textContent })));
    if (appearanceMenuDebug.length === 0) {
      throw new Error(`appearance menu did not render: ${JSON.stringify({ runtimeErrors, appearanceMenuDebug })}`);
    }
    const menuLayerDebug = await page.locator(".menu-item", { hasText: "显示底色" }).evaluate((item) => {
      const rect = item.getBoundingClientRect();
      const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      const menu = item.closest(".menu");
      return {
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        menuZ: menu ? getComputedStyle(menu).zIndex : null,
        menuPosition: menu ? getComputedStyle(menu).position : null,
        parentClass: menu?.parentElement?.className ?? null,
        topClass: top?.className ?? null,
      };
    });
    if (!String(menuLayerDebug.topClass).includes("menu-item")) {
      throw new Error(`appearance menu is behind canvas: ${JSON.stringify(menuLayerDebug)}`);
    }
    await page.locator(".menu-item", { hasText: "显示底色" }).click();
    await page.waitForSelector(".web-desk-embed.is-fullscreen .web-desk-group.has-fill");
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded parity.md");
      return file && /\"showFill\"\s*:\s*true/.test(await app.vault.read(file));
    });
    const fillEnabled = true;
    await page.getByRole("group", { name: "区域：UI", exact: true }).click({ position: { x: 48, y: 48 } });
    await page.getByRole("button", { name: "设置区域外观", exact: true }).click();
    await page.locator(".menu-item", { hasText: "更换颜色" }).click();
    const colorPicker = page.locator(".modal-container .web-desk-color-picker");
    await colorPicker.waitFor({ state: "visible", timeout: 10_000 });
    const colorPickerState = await colorPicker.evaluate((picker) => ({
      swatches: picker.querySelectorAll(".web-desk-color-swatch").length,
      selected: picker.querySelectorAll(".web-desk-color-swatch.is-selected").length,
      nativePicker: picker.querySelectorAll('input[type="color"]').length,
      hexInput: picker.querySelectorAll(".web-desk-custom-color-hex").length,
    }));
    if (
      colorPickerState.swatches !== 7 ||
      colorPickerState.selected !== 1 ||
      colorPickerState.nativePicker !== 1 ||
      colorPickerState.hexInput !== 1
    ) {
      throw new Error(`color picker controls incomplete: ${JSON.stringify(colorPickerState)}`);
    }
    await page.screenshot({ path: COLOR_PICKER_SCREENSHOT });
    await colorPicker.getByRole("button", { name: "玫红色", exact: true }).click();
    await colorPicker.waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded parity.md");
      return file && /"color"\s*:\s*"#f7768e"/.test(await app.vault.read(file));
    });
    const presetColorPersisted = true;

    await page.getByRole("group", { name: "区域：UI", exact: true }).click({ position: { x: 48, y: 48 } });
    await page.getByRole("button", { name: "设置区域外观", exact: true }).click();
    await page.locator(".menu-item", { hasText: "更换颜色" }).click();
    await colorPicker.waitFor({ state: "visible", timeout: 10_000 });
    await page.evaluate(() => {
      document.body.classList.remove("theme-light");
      document.body.classList.add("theme-dark");
    });
    await sleep(180);
    await page.screenshot({ path: COLOR_PICKER_DARK_SCREENSHOT });
    await page.evaluate(() => {
      document.body.classList.remove("theme-dark");
      document.body.classList.add("theme-light");
    });
    const hexInput = colorPicker.locator(".web-desk-custom-color-hex");
    await hexInput.fill("#123456");
    await colorPicker.getByRole("button", { name: "应用", exact: true }).click();
    await colorPicker.waitFor({ state: "detached", timeout: 10_000 });
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded parity.md");
      return file && /"color"\s*:\s*"#123456"/.test(await app.vault.read(file));
    });
    const customColorPersisted = true;

    await page.getByRole("group", { name: "区域：UI", exact: true }).click({ position: { x: 48, y: 48 } });
    await page.getByRole("button", { name: "设置区域外观", exact: true }).click();
    await page.locator(".menu-item", { hasText: "显示底色" }).click();
    await page.waitForFunction(() => !document.querySelector(".web-desk-embed.is-fullscreen .web-desk-group.has-fill"));
    await page.waitForFunction(async () => {
      const file = app.vault.getAbstractFileByPath("Embedded parity.md");
      return file && !/\"showFill\"\s*:/.test(await app.vault.read(file));
    });
    const fillDisabledCleanly = true;
    await sleep(750);
    await page.waitForFunction(() => document.querySelectorAll(".web-desk-embed.is-fullscreen").length === 1);
    const canvasReference = page.locator(".web-desk-embed.is-fullscreen > .web-desk-canvas .web-desk-icon.is-canvas-reference").first();
    await canvasReference.waitFor({ state: "visible", timeout: 10_000 });
    await canvasReference.dblclick();
    await page.waitForSelector(".web-desk-embed.is-fullscreen > .web-desk-drilldown");
    await sleep(220);
    await page.screenshot({ path: DRILLDOWN_SCREENSHOT });
    const firstLevelCrumbs = await page.locator(".web-desk-drilldown-crumb").allTextContents();
    const grandchildReference = page.locator(".web-desk-drilldown-content .web-desk-icon.is-canvas-reference").first();
    await grandchildReference.waitFor({ state: "visible", timeout: 10_000 });
    await grandchildReference.dblclick();
    await page.waitForFunction(() => document.querySelectorAll(".web-desk-drilldown-crumb").length === 3);
    const secondLevelCrumbs = await page.locator(".web-desk-drilldown-crumb").allTextContents();
    const cycleReference = page.locator(".web-desk-drilldown-content .web-desk-icon.is-canvas-reference").first();
    await cycleReference.waitFor({ state: "visible", timeout: 10_000 });
    await cycleReference.dblclick();
    await page.waitForFunction(() => [...document.querySelectorAll(".notice")]
      .some((notice) => (notice.textContent ?? "").includes("循环引用")));
    const cycleStoppedAtDepth = await page.locator(".web-desk-drilldown-crumb").count();
    await sleep(220);
    await page.locator(".web-desk-drilldown-crumb").first().click();
    await page.waitForFunction(() => !document.querySelector(".web-desk-drilldown"));
    if (
      firstLevelCrumbs.join(" > ") !== "Embedded parity > Child canvas" ||
      secondLevelCrumbs.join(" > ") !== "Embedded parity > Child canvas > Grandchild canvas" ||
      cycleStoppedAtDepth !== 3
    ) {
      throw new Error(`canvas drilldown navigation failed: ${JSON.stringify({ firstLevelCrumbs, secondLevelCrumbs, cycleStoppedAtDepth })}`);
    }
    await embed.getByRole("button", { name: "新建文本框" }).click();
    await page.waitForSelector(".web-desk-embed.is-fullscreen .web-desk-textbox", { timeout: 10_000 });
    const fullscreenAfterWrite = await page.locator(".web-desk-embed.is-fullscreen").count();
    await page.mouse.click(900, 680);
    await sleep(180);
    const cleanTextBoxStyle = await page.locator(".web-desk-embed.is-fullscreen .web-desk-textbox").evaluate((element) => ({
      borderColor: getComputedStyle(element).borderTopColor,
      backgroundColor: getComputedStyle(element).backgroundColor,
    }));
    if (cleanTextBoxStyle.borderColor !== "rgba(0, 0, 0, 0)" || cleanTextBoxStyle.backgroundColor !== "rgba(0, 0, 0, 0)") {
      throw new Error(`new textbox did not default to clean appearance: ${JSON.stringify(cleanTextBoxStyle)}`);
    }
    await page.locator(".web-desk-embed.is-fullscreen .web-desk-textbox-text").dblclick();
    await page.keyboard.press("Backspace");
    const editableBackspaceState = await page.evaluate(() => ({
      textBoxCount: document.querySelectorAll(".web-desk-embed.is-fullscreen .web-desk-textbox").length,
      editing: Boolean(document.querySelector('.web-desk-embed.is-fullscreen .web-desk-textbox-text[contenteditable]')),
    }));
    if (editableBackspaceState.textBoxCount !== 1 || !editableBackspaceState.editing) {
      throw new Error(`Backspace escaped text editing: ${JSON.stringify(editableBackspaceState)}`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector('.web-desk-embed.is-fullscreen .web-desk-textbox-text[contenteditable]'));
    await sleep(750);
    await page.locator(".web-desk-embed.is-fullscreen .web-desk-textbox").click({ position: { x: 16, y: 16 } });
    await page.keyboard.press("Delete");
    await page.waitForFunction(() => !document.querySelector(".web-desk-embed.is-fullscreen .web-desk-textbox"));
    const embedDeleteState = await page.evaluate(() => ({
      textBoxCount: document.querySelectorAll(".web-desk-embed.is-fullscreen .web-desk-textbox").length,
      sourceBookmarkPreserved: Boolean(app.vault.getAbstractFileByPath("收藏夹/Parity Sample.md")),
    }));
    if (embedDeleteState.textBoxCount !== 0 || !embedDeleteState.sourceBookmarkPreserved) {
      throw new Error(`embedded Delete failed: ${JSON.stringify(embedDeleteState)}`);
    }
    await page.getByRole("button", { name: "退出全屏", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".web-desk-embed.is-fullscreen"));
    const restoredHeight = await page.locator(".web-desk-embed:visible").last().evaluate((root) => root.getBoundingClientRect().height);

    if (!mainFit.includes("适应") || !embedFit.includes("适应")) {
      throw new Error("missing shared fit toolbar action");
    }
    if (fullscreenAfterWrite !== 1 || Math.abs(restoredHeight - 520) > 2) {
      throw new Error(`fullscreen state handoff or height restore failed: ${JSON.stringify({ fullscreenAfterWrite, restoredHeight })}`);
    }
    const enabled = JSON.parse(fs.readFileSync(path.join(VAULT, ".obsidian/community-plugins.json"), "utf8"));
    console.log(JSON.stringify({
      mainFit,
      mainAreaBehavior,
      compactChrome,
      hoverChrome,
      embedFit,
      fullscreenRect,
      fullscreenFocus,
      fullscreenTabStayedInside,
      modalFocusState,
      modalFocusRestored,
      narrowChrome,
      darkNarrowState,
      fullscreenAfterWrite,
      cleanContainerStyles: { group: cleanGroupStyle, textbox: cleanTextBoxStyle },
      appearanceWriteback: { fillEnabled, fillDisabledCleanly },
      colorPicker: { colorPickerState, presetColorPersisted, customColorPersisted },
      areaBehavior,
      canvasDrilldown: { firstLevelCrumbs, secondLevelCrumbs, cycleStoppedAtDepth },
      mainDrilldownCrumbs,
      resizeHandleVisibility: { handleAtRest, handleOnHover, handleAfterLeave },
      mainDeleteState,
      editableBackspaceState,
      embedDeleteState,
      restoredHeight,
      pluginOccurrences: enabled.filter((id) => id === "web-desk").length,
      screenshots: [MAIN_SCREENSHOT, NARROW_SCREENSHOT, DARK_NARROW_SCREENSHOT, COLOR_PICKER_SCREENSHOT, COLOR_PICKER_DARK_SCREENSHOT, AREA_DROP_SCREENSHOT, INLINE_GROUP_SCREENSHOT, CLEAN_SCREENSHOT, EMBED_SCREENSHOT, DRILLDOWN_SCREENSHOT],
    }));
    await browser.close();
  } finally {
    obsidian.kill("SIGTERM");
    setTimeout(() => {
      try { obsidian.kill("SIGKILL"); } catch {}
    }, 3000).unref();
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
