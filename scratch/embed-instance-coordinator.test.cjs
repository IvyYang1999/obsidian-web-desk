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

test("同一视图的新实例接管后拒绝旧实例写回", async () => {
  const { registerEmbedInstance, enqueueEmbedWrite } = loadTypeScript("src/embed-instance-coordinator.ts");
  const key = `leaf-a:file.md:2:${Date.now()}`;
  const writes = [];
  const first = registerEmbedInstance(key);
  assert.equal(await enqueueEmbedWrite(key, first.instanceId, async () => writes.push("first-current")), "written");
  const second = registerEmbedInstance(key);
  assert.equal(await enqueueEmbedWrite(key, first.instanceId, async () => writes.push("first-stale")), "stale");
  assert.equal(await enqueueEmbedWrite(key, second.instanceId, async () => writes.push("second-current")), "written");
  assert.deepEqual(writes, ["first-current", "second-current"]);
});

test("重建实例只消费一次同视图的画布状态交接", () => {
  const { registerEmbedInstance, publishEmbedHandoff } = loadTypeScript("src/embed-instance-coordinator.ts");
  const key = `leaf-b:file.md:2:${Date.now()}`;
  const first = registerEmbedInstance(key);
  const handoff = {
    zoom: 0.72,
    panX: 18,
    panY: 64,
    fullscreen: true,
    focused: true,
    pointerFocused: true,
    expiresAt: Date.now() + 2_000,
  };
  assert.equal(publishEmbedHandoff(key, first.instanceId, handoff), true);
  const second = registerEmbedInstance(key);
  assert.deepEqual(second.handoff, handoff);
  assert.equal(registerEmbedInstance(key).handoff, undefined);
});

test("不同 workspace leaf 的同一代码块互不抢占", async () => {
  const { registerEmbedInstance, enqueueEmbedWrite } = loadTypeScript("src/embed-instance-coordinator.ts");
  const suffix = `file.md:2:${Date.now()}`;
  const leftKey = `leaf-left:${suffix}`;
  const rightKey = `leaf-right:${suffix}`;
  const left = registerEmbedInstance(leftKey);
  const right = registerEmbedInstance(rightKey);
  const writes = [];
  assert.equal(await enqueueEmbedWrite(leftKey, left.instanceId, async () => writes.push("left")), "written");
  assert.equal(await enqueueEmbedWrite(rightKey, right.instanceId, async () => writes.push("right")), "written");
  assert.deepEqual(writes, ["left", "right"]);
});

test("新实例注册时立即停用同视图的旧交互面", () => {
  const { registerEmbedInstance } = loadTypeScript("src/embed-instance-coordinator.ts");
  const key = `leaf-c:file.md:2:${Date.now()}`;
  let superseded = 0;
  registerEmbedInstance(key, () => { superseded += 1; });
  assert.equal(superseded, 0);
  registerEmbedInstance(key, () => { superseded += 10; });
  assert.equal(superseded, 1);
});

test("接管瞬间读取的最新交互状态覆盖写回开始时的旧快照", () => {
  const { registerEmbedInstance, publishEmbedHandoff } = loadTypeScript("src/embed-instance-coordinator.ts");
  const key = `leaf-d:file.md:2:${Date.now()}`;
  const old = registerEmbedInstance(key, () => ({
    zoom: 0.9,
    panX: 30,
    panY: 40,
    fullscreen: true,
    focused: true,
    pointerFocused: true,
    selectedObjects: ["textbox:latest"],
    selectedGroupId: null,
    selectedArrowId: null,
    expiresAt: Date.now() + 2_000,
  }));
  publishEmbedHandoff(key, old.instanceId, {
    zoom: 0.7,
    panX: 10,
    panY: 20,
    fullscreen: true,
    focused: true,
    pointerFocused: true,
    selectedObjects: [],
    selectedGroupId: "stale-group",
    selectedArrowId: null,
    expiresAt: Date.now() + 2_000,
  });

  const replacement = registerEmbedInstance(key);
  assert.equal(replacement.handoff.zoom, 0.9);
  assert.deepEqual(replacement.handoff.selectedObjects, ["textbox:latest"]);
  assert.equal(replacement.handoff.selectedGroupId, null);
});
