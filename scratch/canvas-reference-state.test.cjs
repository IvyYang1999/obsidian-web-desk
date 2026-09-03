const assert = require("node:assert/strict");
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

const state = loadTypeScript("src/canvas-reference-state.ts");

test("只把合法 web-desk JSON 块识别为可下钻画布", () => {
  const markdown = [
    "正文",
    "```web-desk",
    JSON.stringify({ items: [], textboxes: [] }),
    "```",
    "```web-desk",
    "{ broken json",
    "```",
    "```web-desk title=第二层",
    JSON.stringify({ items: [{ path: "项目/子画布.md" }] }),
    "```",
  ].join("\n");
  assert.deepEqual(state.extractWebDeskCanvasBlocks(markdown), [
    { source: JSON.stringify({ items: [], textboxes: [] }), index: 0 },
    { source: JSON.stringify({ items: [{ path: "项目/子画布.md" }] }), index: 1 },
  ]);
});

test("下钻允许任意深度，但拒绝空目标与路径循环", () => {
  assert.deepEqual(state.canEnterCanvasReference(["A.md", "B.md"], "C.md"), { allowed: true });
  assert.deepEqual(state.canEnterCanvasReference(["A.md", "B.md"], "A.md"), {
    allowed: false,
    reason: "cycle",
  });
  assert.deepEqual(state.canEnterCanvasReference(["A.md"], "  "), {
    allowed: false,
    reason: "empty",
  });
});
