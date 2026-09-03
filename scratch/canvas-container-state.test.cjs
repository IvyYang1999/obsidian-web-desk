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

const appearance = loadTypeScript("src/canvas-container-state.ts");

test("旧分组和文本框缺少外观字段时默认无边框无底色", () => {
  assert.deepEqual(appearance.canvasContainerAppearance({ color: "#7aa2f7" }), {
    showBorder: false,
    showFill: false,
  });
});

test("外观开关只保存显式开启项，关闭后恢复干净 JSON", () => {
  const target = { color: "#7aa2f7" };
  assert.equal(appearance.toggleCanvasContainerAppearance(target, "showBorder"), true);
  assert.equal(target.showBorder, true);
  assert.equal(appearance.toggleCanvasContainerAppearance(target, "showFill"), true);
  assert.equal(target.showFill, true);
  assert.equal(appearance.toggleCanvasContainerAppearance(target, "showBorder"), false);
  assert.equal("showBorder" in target, false);
  assert.equal(appearance.toggleCanvasContainerAppearance(target, "showFill"), false);
  assert.deepEqual(target, { color: "#7aa2f7" });
});
