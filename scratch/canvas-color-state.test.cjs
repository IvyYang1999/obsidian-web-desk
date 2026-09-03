const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/canvas-color-state.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const loaded = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(loaded, loaded.exports, require);

const { normalizeCanvasHexColor, canvasColorInputValue } = loaded.exports;

test("画布自定义色只接受可持久化的十六进制颜色", () => {
  assert.equal(normalizeCanvasHexColor("#12AbEf"), "#12abef");
  assert.equal(normalizeCanvasHexColor(" #abc "), "#aabbcc");
  assert.equal(normalizeCanvasHexColor("red"), null);
  assert.equal(normalizeCanvasHexColor("url(example)"), null);
});

test("系统取色器始终得到合法六位初始值", () => {
  assert.equal(canvasColorInputValue("#abc", "#123456"), "#aabbcc");
  assert.equal(canvasColorInputValue("invalid", "#123456"), "#123456");
});
