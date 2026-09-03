const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

function loadTypeScript(entryPoint) {
  const built = buildSync({
    entryPoints: [entryPoint], bundle: true, format: "cjs", platform: "node", write: false,
  });
  const loaded = { exports: {} };
  new Function("module", "exports", "require", built.outputFiles[0].text)(loaded, loaded.exports, require);
  return loaded.exports;
}

test("多选删除计划按对象类型稳定拆分且忽略失效引用", () => {
  const { planCanvasObjectDeletion } = loadTypeScript("src/canvas-delete.ts");
  const objects = [
    { key: "收藏夹/A.md", kind: "card", id: "收藏夹/A.md" },
    { key: "image:i1", kind: "image", id: "i1" },
    { key: "textbox:t1", kind: "textbox", id: "t1" },
    { key: "rating:r1", kind: "rating", id: "r1" },
    { key: "group:g1", kind: "group", id: "g1" },
    { key: "arrow:a1", kind: "arrow", id: "a1" },
  ];
  assert.deepEqual(
    planCanvasObjectDeletion(objects, new Set(["收藏夹/A.md", "textbox:t1", "group:g1", "arrow:a1", "missing"])),
    {
      cardIds: ["收藏夹/A.md"],
      imageIds: [],
      textBoxIds: ["t1"],
      ratingIds: [],
      groupIds: ["g1"],
      arrowIds: ["a1"],
    },
  );
});

test("框选只命中真正穿过选框的箭头线段", () => {
  const { arrowIntersectsRect } = loadTypeScript("src/canvas-state.ts");
  const scene = { cards: [], textboxes: [], groups: [] };
  const crossing = { id: "a1", from: { kind: "point", ref: "0,0" }, to: { kind: "point", ref: "100,100" }, label: "", color: "" };
  const outside = { id: "a2", from: { kind: "point", ref: "0,100" }, to: { kind: "point", ref: "30,100" }, label: "", color: "" };
  assert.equal(arrowIntersectsRect(crossing, scene, { x: 45, y: 45, w: 10, h: 10 }), true);
  assert.equal(arrowIntersectsRect(outside, scene, { x: 45, y: 45, w: 10, h: 10 }), false);
});
