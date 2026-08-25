const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/card-properties-state.ts"],
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
  applyCardPropertiesToFrontmatter,
  normalizeCardProperties,
} = loaded.exports;

test("网页卡片属性统一规范名称、评分与备注", () => {
  assert.deepEqual(
    normalizeCardProperties({ title: "  新名称  ", rating: 4.7, note: "  稍后复盘  " }, "旧名称"),
    { title: "新名称", rating: 5, note: "稍后复盘" },
  );
  assert.deepEqual(
    normalizeCardProperties({ title: "", rating: -2, note: "" }, "旧名称"),
    { title: "旧名称", rating: 0, note: "" },
  );
});

test("总画布把网页属性写进所属 Markdown 且清空时删除可选字段", () => {
  const frontmatter = { url: "https://example.com", desk_x: 40 };
  applyCardPropertiesToFrontmatter(frontmatter, {
    title: "Example",
    rating: 4,
    note: "设计参考",
  });
  assert.deepEqual(frontmatter, {
    url: "https://example.com",
    desk_x: 40,
    title: "Example",
    desk_rating: 4,
    desk_note: "设计参考",
  });

  applyCardPropertiesToFrontmatter(frontmatter, {
    title: "Example 2",
    rating: 0,
    note: "",
  });
  assert.equal(frontmatter.title, "Example 2");
  assert.equal("desk_rating" in frontmatter, false);
  assert.equal("desk_note" in frontmatter, false);
  assert.equal(frontmatter.desk_x, 40);
});
