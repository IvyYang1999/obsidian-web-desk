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

const { KeyedSerialTaskQueue } = loadTypeScript("src/serial-task-queue.ts");

test("同一文件的写入严格按入队顺序完成", async () => {
  const queue = new KeyedSerialTaskQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.enqueue("收藏夹/one.md", async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = queue.enqueue("收藏夹/one.md", async () => {
    events.push("second:start");
    events.push("second:end");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("不同文件的写入互不阻塞，失败也不会毒死后续队列", async () => {
  const queue = new KeyedSerialTaskQueue();
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const events = [];

  const slowA = queue.enqueue("a.md", async () => {
    events.push("a:start");
    await gateA;
    events.push("a:end");
  });
  await queue.enqueue("b.md", async () => events.push("b"));
  assert.deepEqual(events, ["a:start", "b"]);

  await assert.rejects(queue.enqueue("c.md", async () => { throw new Error("boom"); }), /boom/);
  await queue.enqueue("c.md", async () => events.push("c:recovered"));
  releaseA();
  await slowA;
  assert.deepEqual(events, ["a:start", "b", "c:recovered", "a:end"]);
});
