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

test("画布隐藏状态可持久化并可由重新导入显式清除", () => {
  const fm = { desk_x: 40, desk_y: 50 };
  applyDeskPatch(fm, { hidden: true });
  assert.equal(fm.desk_hidden, true);
  applyDeskPatch(fm, { hidden: null });
  assert.equal("desk_hidden" in fm, false);
});

test("逻辑组合使用独立 frontmatter 字段，不覆盖分类分组", () => {
  const fm = { desk_group: "阅读", desk_object_group: "old" };
  applyDeskPatch(fm, { objectGroup: "og-new" });
  assert.deepEqual(fm, { desk_group: "阅读", desk_object_group: "og-new" });
  applyDeskPatch(fm, { objectGroup: null });
  assert.deepEqual(fm, { desk_group: "阅读" });
});

test("预览展示模式和宽高属于布局字段，局部写入不覆盖图标尺寸", () => {
  const fm = { desk_size: 96, desk_x: 40, desk_y: 50 };
  applyDeskPatch(fm, {
    viewMode: "preview",
    cardStyle: "compact",
    previewWidth: 360,
    previewHeight: 260,
  });
  assert.deepEqual(fm, {
    desk_size: 96,
    desk_x: 40,
    desk_y: 50,
    desk_view_mode: "preview",
    desk_card_style: "compact",
    desk_preview_width: 360,
    desk_preview_height: 260,
  });
  applyDeskPatch(fm, { viewMode: null });
  assert.equal("desk_view_mode" in fm, false);
  assert.equal(fm.desk_size, 96);
  assert.equal(fm.desk_preview_width, 360);
  assert.equal(fm.desk_card_style, "compact");
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

test("metadataCache 滞后时近期写回保住区域与逻辑组合归属", () => {
  const card = { x: 10, y: 20, size: 96, placed: true, group: "旧区域", objectGroup: "old" };
  applyRecentLayoutWrite(card, {
    x: 10,
    y: 20,
    group: "新区域",
    objectGroup: "og-new",
    at: 1_000,
  }, 1_100);
  assert.equal(card.group, "新区域");
  assert.equal(card.objectGroup, "og-new");
});

test("metadataCache 滞后时近期写回保住预览展示模式与宽高", () => {
  const card = {
    x: 10,
    y: 20,
    size: 96,
    placed: true,
    viewMode: "icon",
    cardStyle: "article",
    previewWidth: 320,
    previewHeight: 240,
  };
  applyRecentLayoutWrite(card, {
    x: -90,
    y: -30,
    viewMode: "preview",
    cardStyle: "visual",
    previewWidth: 420,
    previewHeight: 300,
    at: 1_000,
  }, 1_100);
  assert.deepEqual(card, {
    x: -90,
    y: -30,
    size: 96,
    placed: true,
    viewMode: "preview",
    cardStyle: "visual",
    previewWidth: 420,
    previewHeight: 300,
  });
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
