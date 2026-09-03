const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/canvas-viewport-state.ts"],
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

const { canvasSafeViewport, fitCanvasBounds } = loaded.exports;

test("宽画布为左侧创建栏和右下缩放栏保留安全区", () => {
  assert.deepEqual(canvasSafeViewport(1000, 700), {
    top: 20,
    right: 20,
    bottom: 64,
    left: 64,
    width: 916,
    height: 616,
    centerX: 522,
    centerY: 328,
  });
});

test("窄画布把内容中心抬离底部两排 chrome", () => {
  const viewport = canvasSafeViewport(400, 500);
  assert.deepEqual(viewport, {
    top: 16,
    right: 16,
    bottom: 116,
    left: 16,
    width: 368,
    height: 368,
    centerX: 200,
    centerY: 200,
  });
});

test("适应内容围绕安全区而不是整个宿主居中", () => {
  const fitted = fitCanvasBounds(
    400,
    500,
    { minX: 0, minY: 0, maxX: 200, maxY: 200 },
    0.25,
    1.25,
  );
  assert.deepEqual(fitted, { zoom: 1.25, panX: 75, panY: 75 });
});
