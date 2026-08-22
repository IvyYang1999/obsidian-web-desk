const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/layout-state.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const moduleUnderTest = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(
  moduleUnderTest,
  moduleUnderTest.exports,
  require,
);

const { applyDeskPatch, applyRecentLayoutWrite } = moduleUnderTest.exports;

test("局部布局更新保留未传入的 frontmatter 字段", () => {
  const fm = {
    desk_x: 40,
    desk_y: 50,
    desk_size: 96,
    desk_group: "收件箱",
  };

  applyDeskPatch(fm, { group: "稍后阅读" });

  assert.deepEqual(fm, {
    desk_x: 40,
    desk_y: 50,
    desk_size: 96,
    desk_group: "稍后阅读",
  });
});

test("null 只删除显式指定的布局字段", () => {
  const fm = {
    desk_x: 40,
    desk_y: 50,
    desk_size: 96,
    desk_group: "稍后阅读",
  };

  applyDeskPatch(fm, { group: null });

  assert.deepEqual(fm, {
    desk_x: 40,
    desk_y: 50,
    desk_size: 96,
  });
});

test("近期本地布局写回同时恢复坐标和已放置状态", () => {
  const card = { x: 172, y: 40, size: 96, placed: false };
  const result = applyRecentLayoutWrite(
    card,
    { x: 380, y: 140, size: 144, at: 10_000 },
    10_500,
  );

  assert.equal(result, "applied");
  assert.deepEqual(card, { x: 380, y: 140, size: 144, placed: true });
});

test("过期的本地布局写回不覆盖权威坐标", () => {
  const card = { x: 172, y: 40, size: 96, placed: true };
  const result = applyRecentLayoutWrite(
    card,
    { x: 380, y: 140, at: 1_000 },
    12_000,
  );

  assert.equal(result, "expired");
  assert.deepEqual(card, { x: 172, y: 40, size: 96, placed: true });
});
