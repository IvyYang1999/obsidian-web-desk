const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

function loadTypeScript(entryPoint) {
  const built = buildSync({
    entryPoints: [entryPoint],
    bundle: true,
    format: "cjs",
    platform: "node",
    write: false,
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(
    loaded,
    loaded.exports,
    require,
  );
  return loaded.exports;
}

const imageState = loadTypeScript("src/image-state.ts");
const embedState = loadTypeScript("src/embed-state.ts");
const clipboardState = loadTypeScript("src/clipboard-state.ts");

test("横图插入画布时按默认边界等比例缩小", () => {
  assert.deepEqual(imageState.fitImageWithin(1200, 800), { w: 360, h: 240 });
});

test("竖图插入画布时按高度边界等比例缩小", () => {
  assert.deepEqual(imageState.fitImageWithin(800, 1200), { w: 173, h: 260 });
});

test("图片缩放保持宽高比并遵守最小宽度", () => {
  assert.deepEqual(imageState.resizeImageToWidth({ w: 300, h: 200 }, 30), {
    w: 80,
    h: 53,
  });
  assert.deepEqual(imageState.resizeImageToWidth({ w: 300, h: 200 }, 450), {
    w: 450,
    h: 300,
  });
});

test("图片附件名去除路径与非法字符", () => {
  assert.equal(
    imageState.sanitizeImageFileName("../my image?.PNG", "image/png"),
    "my-image-.PNG",
  );
});

test("图片附件路径冲突时生成新文件名而不覆盖", () => {
  const occupied = new Set(["附件/网页桌面/image.png"]);
  assert.equal(
    imageState.nextAvailableImagePath(
      "附件/网页桌面",
      "image.png",
      (candidate) => occupied.has(candidate),
    ),
    "附件/网页桌面/image 2.png",
  );
});

test("旧版内嵌画布数据在没有 images 字段时仍可读取", () => {
  assert.deepEqual(embedState.parseEmbedData('{"items":[]}'), {
    items: [],
    images: [],
  });
});

test("正文插入项生成可解析的空 web-desk 代码块", () => {
  const block = embedState.createEmptyEmbedBlock();
  assert.match(block, /^```web-desk\n/);
  assert.match(block, /\n```$/);
  const json = block.slice("```web-desk\n".length, -"\n```".length);
  assert.deepEqual(JSON.parse(json), { items: [], images: [], textboxes: [] });
});

test("内嵌画布新链接避开已有卡片、图片和文本框", () => {
  const desired = { x: 100, y: 100 };
  const data = {
    items: [{ url: "https://one.example", title: "one", x: 100, y: 100, size: 96 }],
    images: [{ id: "i1", path: "image.png", x: -28, y: -28, w: 96, h: 96 }],
    textboxes: [{ id: "t1", text: "note", x: 228, y: 100, w: 120, h: 100 }],
  };

  const placed = embedState.findAvailableEmbedItemPosition(data, desired);
  assert.notDeepEqual(placed, desired);
  assert.deepEqual(placed, { x: -28, y: 100 });
});

test("内嵌画布中心空闲时保留用户期望落点", () => {
  assert.deepEqual(
    embedState.findAvailableEmbedItemPosition(
      { items: [], images: [], textboxes: [] },
      { x: 100, y: 100 },
    ),
    { x: 100, y: 100 },
  );
});

test("粘贴一个或多个整行 URL 时全部进入链接导入", () => {
  assert.deepEqual(
    clipboardState.splitCanvasPaste("https://example.com\ncomponent.gallery"),
    { urls: ["https://example.com", "component.gallery"], text: "" },
  );
});

test("混合粘贴时 URL 行与普通文本无损分流", () => {
  assert.deepEqual(
    clipboardState.splitCanvasPaste("设计参考\nhttps://example.com\n后续再看"),
    { urls: ["https://example.com"], text: "设计参考\n后续再看" },
  );
});

test("句子里的 URL 保留在文本框而不是丢掉上下文", () => {
  assert.deepEqual(
    clipboardState.splitCanvasPaste("参考 https://example.com 的布局"),
    { urls: [], text: "参考 https://example.com 的布局" },
  );
});

test("单个普通单词按文本处理，不误判成裸域名", () => {
  assert.deepEqual(clipboardState.splitCanvasPaste("hello"), {
    urls: [],
    text: "hello",
  });
});

test("内嵌画布不把 Obsidian 正文编辑器祖先误判为画布内文本编辑", () => {
  const outerEditor = {};
  const target = { closest: () => outerEditor };
  const canvasBoundary = { contains: () => false };

  assert.equal(
    clipboardState.isEditablePasteTarget(target, canvasBoundary),
    false,
  );
});

test("内嵌画布文本框编辑态仍保留原生粘贴", () => {
  const innerTextEditor = {};
  const target = { closest: () => innerTextEditor };
  const canvasBoundary = { contains: (element) => element === innerTextEditor };

  assert.equal(
    clipboardState.isEditablePasteTarget(target, canvasBoundary),
    true,
  );
});

test("内嵌画布拥有 URL 事件目标时不受宿主 defaultPrevented 影响", () => {
  assert.equal(
    clipboardState.shouldClaimEmbeddedCanvasPaste({
      defaultPrevented: true,
      editableTarget: false,
      imageCount: 0,
      paste: { urls: ["https://example.com"], text: "" },
    }),
    true,
  );
});

test("内嵌画布文本框编辑态即使含 URL 也不劫持原生粘贴", () => {
  assert.equal(
    clipboardState.shouldClaimEmbeddedCanvasPaste({
      defaultPrevented: false,
      editableTarget: true,
      imageCount: 0,
      paste: { urls: ["https://example.com"], text: "" },
    }),
    false,
  );
});
