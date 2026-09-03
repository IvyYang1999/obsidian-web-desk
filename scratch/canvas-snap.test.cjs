const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const ts = require("typescript");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/canvas-snap.ts"],
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
  CANVAS_GRID_SIZE,
  canvasGridBackground,
  createCanvasSnapSession,
} = loaded.exports;

test("视觉网格跟随画布缩放和平移，并把圆点中心放在真实网格坐标", () => {
  assert.deepEqual(canvasGridBackground(10, -5, 2), {
    size: "48px 48px",
    position: "-14px -29px",
  });
});

test("移动对象在没有对齐目标时吸附到 24px 网格", () => {
  assert.equal(CANVAS_GRID_SIZE, 24);
  const session = createCanvasSnapSession([]);
  const result = session.move(
    { x: 11, y: 13, w: 100, h: 80 },
    { x: 10, y: 12 },
    1,
  );
  assert.deepEqual(result.rect, { x: 24, y: 24, w: 100, h: 80 });
  assert.deepEqual(result.guides, []);
});

test("移动对象优先吸附其它对象的边缘和中心并返回参考线", () => {
  const session = createCanvasSnapSession([
    { key: "peer", x: 200, y: 100, w: 100, h: 100 },
  ]);
  const result = session.move(
    { x: 40, y: 105, w: 100, h: 40 },
    { x: 57, y: 0 },
    1,
  );
  assert.deepEqual(result.rect, { x: 100, y: 100, w: 100, h: 40 });
  assert.deepEqual(result.guides.map((guide) => [guide.axis, guide.position]), [
    ["x", 200],
    ["y", 100],
  ]);
});

test("吸附阈值按屏幕像素换算，不随画布缩放改变手感", () => {
  const target = [{ key: "peer", x: 203, y: 300, w: 80, h: 80 }];
  const zoomedIn = createCanvasSnapSession(target).move(
    { x: 99, y: 40, w: 100, h: 50 },
    { x: 0, y: 0 },
    2,
  );
  assert.equal(zoomedIn.rect.x, 99);

  const zoomedOut = createCanvasSnapSession(target).move(
    { x: 93, y: 40, w: 100, h: 50 },
    { x: 0, y: 0 },
    0.5,
  );
  assert.equal(zoomedOut.rect.x, 103);
  assert.equal(zoomedOut.guides[0].position, 203);
});

test("已吸附轴使用更宽松的释放阈值，避免边界附近来回抖动", () => {
  const session = createCanvasSnapSession([
    { key: "peer", x: 205, y: 300, w: 80, h: 80 },
  ], { gridSize: 0 });
  assert.equal(session.move({ x: 100, y: 40, w: 100, h: 50 }, { x: 0, y: 0 }, 1).rect.x, 105);
  assert.equal(session.move({ x: 100, y: 40, w: 100, h: 50 }, { x: 9, y: 0 }, 1).rect.x, 105);
  assert.equal(session.move({ x: 100, y: 40, w: 100, h: 50 }, { x: 16, y: 0 }, 1).rect.x, 116);
});

test("对象对齐进入阈值后立即接管已有网格锁", () => {
  const session = createCanvasSnapSession([
    { key: "peer", x: 300, y: 300, w: 100, h: 100 },
  ]);
  assert.equal(session.move({ x: 191, y: 40, w: 100, h: 50 }, { x: 0, y: 0 }, 1).rect.x, 192);
  const aligned = session.move({ x: 191, y: 40, w: 100, h: 50 }, { x: 3, y: 0 }, 1);
  assert.equal(aligned.rect.x, 200);
  assert.equal(aligned.guides[0].position, 300);
});

test("手势中的 presentation geometry 保留小数，不在高倍缩放下跳步", () => {
  const session = createCanvasSnapSession([], { gridSize: 0 });
  const first = session.move({ x: 0, y: 0, w: 100, h: 80 }, { x: 0.34, y: 0.34 }, 3);
  const second = session.move({ x: 0, y: 0, w: 100, h: 80 }, { x: 0.67, y: 0.67 }, 3);
  assert.equal(first.rect.x, 0.34);
  assert.equal(second.rect.x, 0.67);
});

test("右下角缩放保持左上角固定，并把移动边缘吸附到目标", () => {
  const session = createCanvasSnapSession([
    { key: "peer", x: 200, y: 240, w: 80, h: 80 },
  ]);
  const result = session.resize(
    { x: 20, y: 20, w: 101, h: 91 },
    { x: 20, y: 20, w: 176, h: 217 },
    1,
  );
  assert.equal(result.rect.x, 20);
  assert.equal(result.rect.y, 20);
  assert.equal(result.rect.w, 180);
  assert.equal(result.rect.h, 220);
  assert.deepEqual(result.guides.map((guide) => [guide.axis, guide.position]), [
    ["x", 200],
    ["y", 240],
  ]);
});

test("所有显示吸附辅助线的指针会话都会在统一收尾时隐藏辅助线", () => {
  const violations = [];
  for (const file of ["src/view.ts", "src/embed.ts"]) {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const sessions = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node)
        && node.expression.getText(source) === "beginCanvasPointerSession"
        && node.arguments.length === 1
        && ts.isObjectLiteralExpression(node.arguments[0])
      ) sessions.push(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);

    const guideSessions = sessions.filter((session) => session.getText(source).includes("snapGuideLayer?.show"));
    assert.ok(guideSessions.length > 0, `${file} 应包含使用辅助线的拖拽或缩放会话`);
    for (const session of guideSessions) {
      const line = source.getLineAndCharacterOfPosition(session.getStart(source)).line + 1;
      const propertyText = (name) => session.properties.find(
        (property) => property.name?.getText(source) === name,
      )?.getText(source) ?? "";
      if (!/snapGuideLayer\?\.hide\(\)/.test(propertyText("onEnd"))) violations.push(`${file}:${line} onEnd`);
    }
  }
  assert.deepEqual(violations, []);

  const pointerSession = fs.readFileSync("src/canvas-pointer.ts", "utf8");
  assert.match(pointerSession, /addEventListener\("pointerup", finish, true\)/);
  assert.match(pointerSession, /addEventListener\("pointercancel", finish, true\)/);
  assert.match(pointerSession, /options\.onEnd\(moved\)/);
});

test("辅助线样式不覆盖 hidden 的即时隐藏语义", () => {
  const css = fs.readFileSync("styles.css", "utf8");
  const rule = css.match(/\.web-desk-snap-guide\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.doesNotMatch(rule, /display\s*:\s*block/);
});
