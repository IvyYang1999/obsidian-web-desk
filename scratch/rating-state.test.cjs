const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/rating-state.ts"],
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

const { normalizeRatingValue, ratingLinkState } = moduleUnderTest.exports;

test("评分限制为 0 到 5 的整数", () => {
  assert.equal(normalizeRatingValue(-2), 0);
  assert.equal(normalizeRatingValue(3.6), 4);
  assert.equal(normalizeRatingValue(9), 5);
  assert.equal(normalizeRatingValue(Number.NaN), 0);
});

test("独立、已绑定与原链接缺失三种状态可机械区分", () => {
  const links = new Set(["收藏夹/one.md"]);
  assert.equal(ratingLinkState(undefined, links), "standalone");
  assert.equal(
    ratingLinkState({ ref: "收藏夹/one.md", title: "One", url: "https://one.example" }, links),
    "linked",
  );
  assert.equal(
    ratingLinkState({ ref: "收藏夹/gone.md", title: "Gone", url: "https://gone.example" }, links),
    "missing",
  );
});
