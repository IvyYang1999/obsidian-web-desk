const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({ entryPoints: ["src/canvas-edge-pan.ts"], bundle: true, format: "cjs", platform: "node", write: false });
const mod = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, require);
const { edgePanVelocity, EDGE_BAND, EDGE_MAX_SPEED } = mod.exports;

const RECT = { left: 0, top: 0, width: 1000, height: 700 };

test("指针在中间时不平移", () => {
  assert.deepEqual(edgePanVelocity({ x: 500, y: 350 }, RECT), { x: 0, y: 0 });
});

test("贴右边缘时画布往左推，贴左边缘时往右推", () => {
  const right = edgePanVelocity({ x: RECT.width - 2, y: 350 }, RECT);
  const left = edgePanVelocity({ x: 2, y: 350 }, RECT);
  assert.ok(right.x < 0, "看右边的内容要把画布往左推");
  assert.ok(left.x > 0, "看左边的内容要把画布往右推");
  assert.equal(right.y, 0);
});

test("越深入边缘带越快，且不超过上限", () => {
  const shallow = edgePanVelocity({ x: RECT.width - EDGE_BAND + 4, y: 350 }, RECT);
  const deep = edgePanVelocity({ x: RECT.width - 1, y: 350 }, RECT);
  assert.ok(Math.abs(deep.x) > Math.abs(shallow.x), "越靠边越快");
  assert.ok(Math.abs(deep.x) <= EDGE_MAX_SPEED, "不超过上限");
});

test("指针跑到容器外按满速，快速甩动不会忽快忽慢", () => {
  const outside = edgePanVelocity({ x: -200, y: 350 }, RECT);
  assert.equal(Math.round(outside.x), EDGE_MAX_SPEED);
});

test("两个方向可以同时触发，斜着拖会斜着滚", () => {
  const corner = edgePanVelocity({ x: 2, y: 2 }, RECT);
  assert.ok(corner.x > 0 && corner.y > 0);
});

test("容器太小时不启用，否则整个画布都是边缘带", () => {
  assert.deepEqual(edgePanVelocity({ x: 5, y: 5 }, { left: 0, top: 0, width: 100, height: 60 }), { x: 0, y: 0 });
});
