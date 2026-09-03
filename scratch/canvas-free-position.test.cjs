const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

function load(entry) {
  const built = buildSync({ entryPoints: [entry], bundle: true, format: "cjs", platform: "node", write: false });
  const mod = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, require);
  return mod.exports;
}

const { findFreePosition } = load("src/canvas-free-position.ts");
const { planAutoPositions } = load("src/auto-place.ts");

const overlaps = (a, b, margin = 0) => !(
  a.x + a.w + margin <= b.x || b.x + b.w + margin <= a.x ||
  a.y + a.h + margin <= b.y || b.y + b.h + margin <= a.y
);

test("期望落点空闲时原样返回（按网格对齐）", () => {
  const pos = findFreePosition([], { x: 101, y: 59 }, { w: 120, h: 140 }, { step: 132, grid: 24 });
  assert.deepEqual(pos, { x: 96, y: 48 });
});

test("被大矩形（预览卡）占住时会避开整块矩形，而不是只避开左上角格子", () => {
  const preview = { x: 172, y: 40, w: 300, h: 220 };
  const pos = findFreePosition([preview], { x: 172, y: 40 }, { w: 120, h: 140 }, { step: 132 });
  assert.equal(overlaps({ ...pos, w: 120, h: 140 }, preview, 16), false);
});

test("扩圈优先向右再向下，连续添加不会逸出到左上角", () => {
  const first = { x: 400, y: 300, w: 120, h: 140 };
  const pos = findFreePosition([first], { x: 400, y: 300 }, { w: 120, h: 140 }, { step: 132 });
  assert.ok(pos.x > first.x && pos.y === first.y, JSON.stringify(pos));
});

const card = (path, overrides = {}) => ({
  path, targetPath: "", title: path, url: `https://${path}/`, host: path, type: "", description: "",
  previewImage: "", rating: 0, note: "", caption: "", x: 0, y: 0, size: 96, viewMode: "icon",
  cardStyle: "article", previewWidth: 320, previewHeight: 240, group: "", objectGroup: "", placed: false,
  ...overrides,
});

test("自动排布避开预览卡、区域和其它对象，并以视口中心为起点", () => {
  const cards = [
    card("preview.md", { placed: true, x: 200, y: 72, viewMode: "preview", previewWidth: 300, previewHeight: 220 }),
    card("icon.md", { placed: true, x: 64, y: 88 }),
    card("new-a.md"),
    card("new-b.md"),
  ];
  const group = { x: 40, y: 40, w: 800, h: 300 };
  const plan = planAutoPositions(cards, { occupied: [group], origin: { x: 500, y: 500 } });
  assert.equal(plan.size, 2);
  const rects = [
    { x: 200, y: 72, w: 300, h: 220 },
    { x: 64, y: 88, w: 120, h: 140 },
    group,
  ];
  const placed = [...plan.values()].map((p) => ({ ...p, w: 120, h: 140 }));
  for (const rect of placed) {
    for (const other of rects) assert.equal(overlaps(rect, other, 16), false, `overlaps ${JSON.stringify(rect)} vs ${JSON.stringify(other)}`);
  }
  assert.equal(overlaps(placed[0], placed[1], 16), false, "两张新卡片之间也不能重叠");
  const a = plan.get("new-a.md");
  assert.ok(Math.abs(a.x + 60 - 500) <= 24 && Math.abs(a.y + 70 - 500) <= 24, `第一张落在视口中心附近: ${JSON.stringify(a)}`);
});

test("已放置的卡片不进入排布计划", () => {
  const plan = planAutoPositions([card("done.md", { placed: true, x: 10, y: 10 })]);
  assert.equal(plan.size, 0);
});
