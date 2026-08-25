const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const { canvasWheelIntent } = loadTypeScript("src/canvas-wheel.ts");

test("无修饰触控板滚动转换为二维画布平移", () => {
  assert.deepEqual(
    canvasWheelIntent({ deltaX: 24, deltaY: -12, deltaMode: 0, ctrlKey: false, metaKey: false }, 600),
    { kind: "pan", x: -24, y: 12 },
  );
});

test("触控板捏合转换为有界的光标定点缩放", () => {
  const zoomIn = canvasWheelIntent(
    { deltaX: 0, deltaY: -80, deltaMode: 0, ctrlKey: true, metaKey: false },
    600,
  );
  const zoomOut = canvasWheelIntent(
    { deltaX: 0, deltaY: 80, deltaMode: 0, ctrlKey: true, metaKey: false },
    600,
  );
  assert.equal(zoomIn.kind, "zoom");
  assert.ok(zoomIn.factor > 1 && zoomIn.factor <= 2);
  assert.equal(zoomOut.kind, "zoom");
  assert.ok(zoomOut.factor < 1 && zoomOut.factor >= 0.5);
});

test("非像素滚轮按行和页面归一化，避免不同设备速度失控", () => {
  assert.deepEqual(
    canvasWheelIntent({ deltaX: 1, deltaY: 2, deltaMode: 1, ctrlKey: false, metaKey: false }, 600),
    { kind: "pan", x: -16, y: -32 },
  );
  assert.deepEqual(
    canvasWheelIntent({ deltaX: 0, deltaY: 1, deltaMode: 2, ctrlKey: false, metaKey: false }, 600),
    { kind: "pan", x: -0, y: -600 },
  );
});

test("总画布和文内画布共用手势解释器，文内不再放过普通 wheel", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  assert.match(view, /canvasWheelIntent\(event/);
  assert.match(embed, /canvasWheelIntent\(event/);
  assert.doesNotMatch(embed, /if \(!\(event\.ctrlKey \|\| event\.metaKey\)\) return/);
});
