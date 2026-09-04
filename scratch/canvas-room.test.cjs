const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({ entryPoints: ["src/canvas-room.ts"], bundle: true, format: "cjs", platform: "node", write: false });
const mod = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, require);
const { deriveRoom, clampPanToRoom, elasticPanToRoom, minZoomForRoom, MAX_OVERSCROLL, ROOM_MIN_WIDTH, ROOM_MIN_HEIGHT } = mod.exports;

const VIEW = { width: 1200, height: 800 };

test("空画布给一张居中的最小尺寸纸，而不是巴掌大或无限虚空", () => {
  const room = deriveRoom(null);
  assert.equal(room.w, ROOM_MIN_WIDTH);
  assert.equal(room.h, ROOM_MIN_HEIGHT);
  assert.equal(room.x + room.w / 2 + 0, 0, "水平居中于原点");
  assert.equal(room.y + room.h / 2 + 0, 0, "垂直居中于原点");
});

test("内容少时房间不缩到内容大小，仍保持最小可用面积", () => {
  const room = deriveRoom({ minX: 0, minY: 0, maxX: 120, maxY: 140 });
  // 为保持网格对齐，补足到最小尺寸时会向上取整到网格倍数，最多多出一格的两倍。
  assert.ok(room.w >= ROOM_MIN_WIDTH && room.w < ROOM_MIN_WIDTH + 48, `w=${room.w}`);
  assert.ok(room.h >= ROOM_MIN_HEIGHT && room.h < ROOM_MIN_HEIGHT + 48, `h=${room.h}`);
  assert.ok(room.x < 0 && room.y < 0, "从内容向两侧扩，内容不会被挤到墙角");
});

test("内容变大，墙跟着长出来并留一圈留白", () => {
  const room = deriveRoom({ minX: 0, minY: 0, maxX: 2000, maxY: 1500 });
  assert.ok(room.x <= -120, `左墙留白: ${room.x}`);
  assert.ok(room.x + room.w >= 2120, `右墙留白: ${room.x + room.w}`);
  assert.ok(room.y + room.h >= 1620, `下墙留白: ${room.y + room.h}`);
});

test("房间对齐 24px 网格，墙落在点阵线上", () => {
  const room = deriveRoom({ minX: 37, minY: 61, maxX: 2033, maxY: 1607 });
  for (const v of [room.x, room.y, room.w, room.h]) assert.ok(v % 24 === 0, `${v} 未对齐网格`);
});

test("房间比视口大时，墙贴到视口边缘就是尽头", () => {
  const room = deriveRoom({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 });
  // 想把左墙拖到视口中间，只能停在视口左缘
  const p = clampPanToRoom({ x: 600 - room.x, y: 0 }, 1, room, VIEW);
  assert.equal(Math.round(p.x + room.x), 0, "左墙贴视口左缘");
  // 想把右墙拖到视口中间，只能停在视口右缘
  const q = clampPanToRoom({ x: -(room.x + room.w) + 600, y: 0 }, 1, room, VIEW);
  assert.equal(Math.round(q.x + (room.x + room.w)), VIEW.width, "右墙贴视口右缘");
});

test("房间比视口小时整个房间留在视口里，不会被推出屏幕", () => {
  const room = deriveRoom(null);
  const p = clampPanToRoom({ x: 99999, y: -99999 }, 0.3, room, VIEW);
  const left = p.x + room.x * 0.3;
  const top = p.y + room.y * 0.3;
  assert.ok(left >= -0.001 && left <= VIEW.width - room.w * 0.3 + 0.001, `left ${left}`);
  assert.ok(top >= -0.001 && top <= VIEW.height - room.h * 0.3 + 0.001, `top ${top}`);
});

test("橡皮筋：能拉过墙一点，但越拉越沉且永远拉不过上限", () => {
  const room = deriveRoom({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 });
  const hard = clampPanToRoom({ x: 1e6, y: 0 }, 1, room, VIEW);
  const small = elasticPanToRoom({ x: hard.x + 40, y: 0 }, 1, room, VIEW);
  const large = elasticPanToRoom({ x: hard.x + 4000, y: 0 }, 1, room, VIEW);
  assert.ok(small.x - hard.x > 0 && small.x - hard.x < 40, "小幅超出被压缩但仍跟手");
  assert.ok(large.x - hard.x < MAX_OVERSCROLL, `再怎么拉也不过上限: ${large.x - hard.x}`);
  assert.ok(large.x - hard.x > small.x - hard.x, "拉得多确实走得多，只是越来越沉");
});

test("边界内的手势位置不受橡皮筋影响", () => {
  const room = deriveRoom({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 });
  const pan = { x: -500, y: -400 };
  assert.deepEqual(elasticPanToRoom(pan, 1, room, VIEW), pan);
});

test("范围内的平移原样保留，正常拖动不被干扰", () => {
  const room = deriveRoom({ minX: 0, minY: 0, maxX: 4000, maxY: 3000 });
  const pan = { x: -500, y: -400 };
  assert.deepEqual(clampPanToRoom(pan, 1, room, VIEW), pan);
});

test("视口尚未布局（0 尺寸）时不做约束，避免把视图钉死在原点", () => {
  const room = deriveRoom(null);
  const pan = { x: 123, y: 456 };
  assert.deepEqual(clampPanToRoom(pan, 1, room, { width: 0, height: 0 }), pan);
});

test("缩放下限保证整张纸能一眼看完，且不低于全局下限", () => {
  const big = deriveRoom({ minX: 0, minY: 0, maxX: 8000, maxY: 6000 });
  const z = minZoomForRoom(big, VIEW, 0.25);
  assert.ok(z >= 0.25, "不低于全局下限");
  assert.ok(z <= 1, "不会反过来强制放大");
  const small = deriveRoom(null);
  assert.ok(minZoomForRoom(small, VIEW, 0.25) >= 0.25);
});
