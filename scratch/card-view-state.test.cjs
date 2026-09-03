const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/card-view-state.ts"],
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

const {
  DEFAULT_PREVIEW_HEIGHT,
  DEFAULT_PREVIEW_WIDTH,
  cardPlacementFrame,
  normalizeCardViewMode,
  resizeCardPlacement,
  scaleCardPlacement,
  switchCardViewMode,
} = loaded.exports;

test("旧卡片和非法值默认保持图标模式", () => {
  assert.equal(normalizeCardViewMode(undefined), "icon");
  assert.equal(normalizeCardViewMode("live"), "icon");
  assert.equal(normalizeCardViewMode("preview"), "preview");
  assert.equal(normalizeCardViewMode("embed"), "embed");
});

test("实时嵌入与卡片共享自由尺寸且模式切换保持中心", () => {
  const card = { x: 40, y: 60, size: 96, viewMode: "preview", previewWidth: 360, previewHeight: 240 };
  const embedded = switchCardViewMode(card, "embed");
  assert.deepEqual(cardPlacementFrame(embedded), { w: 360, h: 240 });
  assert.deepEqual({ x: embedded.x, y: embedded.y }, { x: 40, y: 60 });

  const resized = resizeCardPlacement(embedded, { x: 40, y: 20 });
  assert.equal(resized.previewWidth, 400);
  assert.equal(resized.previewHeight, 260);
});

test("图标与预览使用独立尺寸并能围绕中心无损切换", () => {
  const icon = { x: 100, y: 80, size: 96, viewMode: "icon" };
  assert.deepEqual(cardPlacementFrame(icon), { w: 120, h: 140 });

  const preview = switchCardViewMode(icon, "preview");
  assert.deepEqual(cardPlacementFrame(preview), {
    w: DEFAULT_PREVIEW_WIDTH,
    h: DEFAULT_PREVIEW_HEIGHT,
  });
  assert.deepEqual(
    {
      x: preview.x + DEFAULT_PREVIEW_WIDTH / 2,
      y: preview.y + DEFAULT_PREVIEW_HEIGHT / 2,
    },
    { x: 160, y: 150 },
  );

  const restored = switchCardViewMode(preview, "icon");
  assert.deepEqual(restored, {
    ...preview,
    x: 100,
    y: 80,
    viewMode: "icon",
  });
  assert.equal(restored.size, 96);
});

test("预览自由缩放宽高，图标仍保持等比尺寸", () => {
  const preview = resizeCardPlacement(
    { x: 0, y: 0, size: 96, viewMode: "preview", previewWidth: 320, previewHeight: 240 },
    { x: -200, y: 120 },
  );
  assert.equal(preview.previewWidth, 220);
  assert.equal(preview.previewHeight, 360);

  const icon = resizeCardPlacement(
    { x: 0, y: 0, size: 96, viewMode: "icon" },
    { x: 40, y: 10 },
  );
  assert.equal(icon.size, 136);

  const continuous = resizeCardPlacement(
    { x: 0, y: 0, size: 96, viewMode: "preview", previewWidth: 320, previewHeight: 240 },
    { x: 0.34, y: 0.67 },
  );
  assert.equal(continuous.previewWidth, 320.34);
  assert.equal(continuous.previewHeight, 240.67);
});

test("逻辑 Group 缩放会按当前展示模式更新对应尺寸", () => {
  const preview = scaleCardPlacement(
    { x: 0, y: 0, size: 96, viewMode: "preview", previewWidth: 320, previewHeight: 240 },
    1.5,
  );
  assert.equal(preview.previewWidth, 480);
  assert.equal(preview.previewHeight, 360);

  const icon = scaleCardPlacement({ x: 0, y: 0, size: 96, viewMode: "icon" }, 0.5);
  assert.equal(icon.size, 48);

  const alreadyMutated = { ...preview, previewWidth: 610, previewHeight: 470 };
  const stable = scaleCardPlacement(alreadyMutated, 1.25, { w: 320, h: 240 });
  assert.equal(stable.previewWidth, 400);
  assert.equal(stable.previewHeight, 300);
});
