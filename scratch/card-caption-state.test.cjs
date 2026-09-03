const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/card-caption-state.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const loaded = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(loaded, loaded.exports, require);

const { applyCardCaptionToFrontmatter, normalizeCardCaption } = loaded.exports;

test("Caption 与备注使用独立字段，清空只删除 Caption", () => {
  assert.equal(normalizeCardCaption("  公开说明  "), "公开说明");
  const fm = { desk_note: "内部备注" };
  applyCardCaptionToFrontmatter(fm, "公开说明");
  assert.deepEqual(fm, { desk_note: "内部备注", desk_caption: "公开说明" });
  applyCardCaptionToFrontmatter(fm, "   ");
  assert.deepEqual(fm, { desk_note: "内部备注" });
});
