const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const { buildSync } = require("esbuild");

function loadTypeScript(entryPoint) {
  const built = buildSync({
    entryPoints: [entryPoint], bundle: true, format: "cjs", platform: "node", write: false,
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(loaded, loaded.exports, require);
  return loaded.exports;
}

test("网页卡片模板兼容旧数据并只接受三种稳定值", () => {
  const state = loadTypeScript("src/canvas-ui-state.ts");
  assert.equal(state.normalizeCardStyle(undefined), "article");
  assert.equal(state.normalizeCardStyle("visual"), "visual");
  assert.equal(state.normalizeCardStyle("article"), "article");
  assert.equal(state.normalizeCardStyle("compact"), "compact");
  assert.equal(state.normalizeCardStyle("future-style"), "article");
});

test("空状态统计覆盖两种画布的所有可见组件", () => {
  const state = loadTypeScript("src/canvas-ui-state.ts");
  const empty = { cards: 0, images: 0, textboxes: 0, groups: 0, arrows: 0, ratings: 0, pending: 0 };
  assert.equal(state.hasCanvasContent(empty), false);
  for (const key of Object.keys(empty)) {
    assert.equal(state.hasCanvasContent({ ...empty, [key]: 1 }), true, `${key} 应隐藏空状态`);
  }
});

test("主画布与文内画布共享对象工具栏、创建栏和原位状态原语", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /createCanvasObjectToolbar/);
    assert.match(source, /createCanvasCreateRail/);
    assert.match(source, /renderPendingWebCard/);
    assert.match(source, /hasCanvasContent/);
    assert.match(source, /canvasSafeViewport/);
    assert.match(source, /fitCanvasBounds/);
    assert.match(source, /label: "箭头"/);
    assert.match(source, /showArrowMoreMenu/);
  }
});

test("三种覆盖层共享同一个可逆焦点边界", () => {
  const preview = fs.readFileSync("src/file-preview.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  assert.match(preview, /new CanvasFocusBoundary\(overlay, body, back\)/);
  assert.equal((embed.match(/new CanvasFocusBoundary\(/g) ?? []).length, 2);
});
