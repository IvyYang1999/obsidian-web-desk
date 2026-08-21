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
