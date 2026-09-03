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

function fakeSurface() {
  const listeners = new Map();
  const document = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
  };
  return {
    document,
    listeners,
    element: {
      ownerDocument: document,
      addClass() {},
      removeClass() {},
      setPointerCapture() {},
      releasePointerCapture() {},
    },
  };
}

test("鼠标按钮已释放的 pointermove 只收口，不覆盖最后有效坐标", () => {
  const { beginCanvasPointerSession } = loadTypeScript("src/canvas-pointer.ts");
  const surface = fakeSurface();
  const moves = [];
  const endings = [];
  beginCanvasPointerSession({
    event: { pointerId: 7, pointerType: "mouse", button: 0, buttons: 1, clientX: 10, clientY: 20 },
    element: surface.element,
    zoom: () => 1,
    onMove: (delta) => moves.push(delta),
    onEnd: (moved) => endings.push(moved),
  });

  surface.listeners.get("pointermove")({
    pointerId: 7, pointerType: "mouse", buttons: 1, clientX: 30, clientY: 40,
  });
  surface.listeners.get("pointermove")({
    pointerId: 7, pointerType: "mouse", buttons: 0, clientX: 400, clientY: 500,
  });

  assert.deepEqual(moves, [{ x: 20, y: 20 }]);
  assert.deepEqual(endings, [true]);
  assert.equal(surface.listeners.has("pointermove"), false);
  assert.equal(surface.listeners.has("pointerup"), false);
});
