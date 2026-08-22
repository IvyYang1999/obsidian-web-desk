const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const imageState = loadTypeScript("src/image-state.ts");
const embedState = loadTypeScript("src/embed-state.ts");
const clipboardState = loadTypeScript("src/clipboard-state.ts");
const canvasState = loadTypeScript("src/canvas-state.ts");
const embedWriteState = loadTypeScript("src/embed-write-state.ts");
const objectGroupState = loadTypeScript("src/object-group-state.ts");
const canvasPointer = loadTypeScript("src/canvas-pointer.ts");

test("分类分组框缩放时只保留自身虚线边缘", () => {
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.web-desk-group\.is-resizing::after\s*\{\s*content:\s*none;/);
  assert.match(css, /\.web-desk-embed:focus-visible:not\(\.is-pointer-focused\)::after/);
});

function pointerEvent(type, { x, y, pointerId = 1 }) {
  const event = new Event(type);
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: pointerId },
  });
  return event;
}

test("指针提交监听挂在稳定 document 上，元素失去捕获后仍能落盘", () => {
  const document = new EventTarget();
  const element = new EventTarget();
  element.ownerDocument = document;
  element.addClass = () => {};
  element.removeClass = () => {};
  element.setPointerCapture = () => {};
  element.releasePointerCapture = () => {};
  const deltas = [];
  const endings = [];

  canvasPointer.beginCanvasPointerSession({
    event: { clientX: 10, clientY: 20, pointerId: 7 },
    element,
    zoom: () => 2,
    onMove: (delta) => deltas.push(delta),
    onEnd: (moved) => endings.push(moved),
  });
  document.dispatchEvent(pointerEvent("pointermove", { x: 30, y: 50, pointerId: 7 }));
  document.dispatchEvent(pointerEvent("pointerup", { x: 30, y: 50, pointerId: 7 }));

  assert.deepEqual(deltas, [{ x: 10, y: 15 }]);
  assert.deepEqual(endings, [true]);
});

test("组合边界由成员几何实时推导，不保存第二份易漂移坐标", () => {
  assert.deepEqual(
    objectGroupState.objectGroupBounds([
      { key: "card:one", x: 20, y: 40, w: 120, h: 140 },
      { key: "image:two", x: 180, y: 10, w: 200, h: 100 },
    ]),
    { x: 20, y: 10, w: 360, h: 170 },
  );
});

test("整组拖动对所有成员施加同一画布位移", () => {
  assert.deepEqual(
    objectGroupState.translateObjectGroup([
      { key: "card:one", x: 20, y: 40, w: 120, h: 140 },
      { key: "textbox:two", x: 180, y: 10, w: 200, h: 100 },
    ], { x: 35, y: -12 }),
    [
      { key: "card:one", x: 55, y: 28, w: 120, h: 140 },
      { key: "textbox:two", x: 215, y: -2, w: 200, h: 100 },
    ],
  );
});

test("整组缩放同时改变相对位置与成员尺寸", () => {
  const result = objectGroupState.scaleObjectGroup([
    { key: "card:one", x: 20, y: 40, w: 120, h: 140, minW: 56, minH: 76 },
    { key: "textbox:two", x: 180, y: 10, w: 200, h: 100, minW: 140, minH: 60 },
  ], 2);
  assert.equal(result.scale, 2);
  assert.deepEqual(result.objects, [
    { key: "card:one", x: 20, y: 70, w: 240, h: 280, minW: 56, minH: 76 },
    { key: "textbox:two", x: 340, y: 10, w: 400, h: 200, minW: 140, minH: 60 },
  ]);
});

test("整组缩小时以最严格成员最小尺寸为统一下限", () => {
  const result = objectGroupState.scaleObjectGroup([
    { key: "image:one", x: 0, y: 0, w: 200, h: 100, minW: 80, minH: 40 },
    { key: "textbox:two", x: 240, y: 0, w: 200, h: 100, minW: 140, minH: 60 },
  ], 0.2);
  assert.equal(result.scale, 0.7);
  assert.equal(result.objects[0].w, 140);
  assert.equal(result.objects[1].w, 140);
});

test("横图插入画布时按默认边界等比例缩小", () => {
  assert.deepEqual(imageState.fitImageWithin(1200, 800), { w: 360, h: 240 });
});

test("竖图插入画布时按高度边界等比例缩小", () => {
  assert.deepEqual(imageState.fitImageWithin(800, 1200), { w: 173, h: 260 });
});

test("图片缩放保持宽高比并遵守最小宽度", () => {
  assert.deepEqual(imageState.resizeImageToWidth({ w: 300, h: 200 }, 30), {
    w: 80,
    h: 53,
  });
  assert.deepEqual(imageState.resizeImageToWidth({ w: 300, h: 200 }, 450), {
    w: 450,
    h: 300,
  });
});

test("图片附件名去除路径与非法字符", () => {
  assert.equal(
    imageState.sanitizeImageFileName("../my image?.PNG", "image/png"),
    "my-image-.PNG",
  );
});

test("图片附件路径冲突时生成新文件名而不覆盖", () => {
  const occupied = new Set(["附件/网页桌面/image.png"]);
  assert.equal(
    imageState.nextAvailableImagePath(
      "附件/网页桌面",
      "image.png",
      (candidate) => occupied.has(candidate),
    ),
    "附件/网页桌面/image 2.png",
  );
});

test("旧版内嵌画布数据在没有 images 字段时仍可读取", () => {
  assert.deepEqual(embedState.parseEmbedData('{"items":[]}'), {
    items: [],
    images: [],
    textboxes: [],
    groups: [],
    arrows: [],
    ratings: [],
    height: 420,
  });
});

test("文内画布往返保留逻辑组合与评分缩放", () => {
  const data = embedState.parseEmbedData(JSON.stringify({
    items: [{ url: "https://one.example", title: "one", x: 1, y: 2, objectGroup: "og1" }],
    ratings: [{ id: "r1", value: 4, x: 10, y: 20, scale: 1.5, objectGroup: "og1" }],
  }));
  assert.equal(data.items[0].objectGroup, "og1");
  assert.equal(data.ratings[0].scale, 1.5);
  assert.equal(data.ratings[0].objectGroup, "og1");
});

test("正文插入项生成可解析的空 web-desk 代码块", () => {
  const block = embedState.createEmptyEmbedBlock();
  assert.match(block, /^```web-desk\n/);
  assert.match(block, /\n```$/);
  const json = block.slice("```web-desk\n".length, -"\n```".length);
  assert.deepEqual(JSON.parse(json), {
    items: [],
    images: [],
    textboxes: [],
    groups: [],
    arrows: [],
    ratings: [],
    height: 420,
  });
});

test("文内画布高度限制在可操作范围并取整", () => {
  assert.equal(embedState.normalizeEmbedHeight(undefined), 420);
  assert.equal(embedState.normalizeEmbedHeight(100), 240);
  assert.equal(embedState.normalizeEmbedHeight(777.6), 778);
  assert.equal(embedState.normalizeEmbedHeight(3000), 1600);
});

test("旧文内文本框补默认颜色且新版分组箭头可往返", () => {
  const data = embedState.parseEmbedData(JSON.stringify({
    items: [],
    textboxes: [{ id: "t1", text: "旧备注", x: 1, y: 2, w: 100, h: 60 }],
    groups: [{ id: "g1", name: "资料", x: 0, y: 0, w: 300, h: 200, color: "#7aa2f7" }],
    arrows: [{ id: "a1", from: { kind: "group", ref: "g1" }, to: { kind: "point", ref: "400,100" }, label: "去这里", color: "" }],
  }));
  assert.equal(data.textboxes[0].color, "#7aa2f7");
  assert.equal(data.groups[0].name, "资料");
  assert.equal(data.arrows[0].label, "去这里");
});

test("共享画布协议把箭头端点裁到组件边缘", () => {
  const scene = {
    cards: [{ ref: "one", x: 0, y: 0, w: 100, h: 100 }],
    textboxes: [{ id: "note", text: "", x: 200, y: 0, w: 100, h: 100, color: "#fff" }],
    groups: [],
  };
  assert.deepEqual(
    canvasState.arrowLine(
      { kind: "card", ref: "one" },
      { kind: "textbox", ref: "note" },
      scene,
    ),
    { from: { x: 100, y: 50 }, to: { x: 200, y: 50 } },
  );
});

test("共享画布协议会清理指向已删除组件的悬空箭头", () => {
  const arrows = [
    { id: "keep", from: { kind: "card", ref: "one" }, to: { kind: "point", ref: "20,30" }, label: "", color: "" },
    { id: "drop", from: { kind: "card", ref: "gone" }, to: { kind: "point", ref: "20,30" }, label: "", color: "" },
  ];
  assert.deepEqual(
    canvasState.pruneDanglingArrows(arrows, {
      cards: [{ ref: "one", x: 0, y: 0, w: 100, h: 100 }],
      textboxes: [],
      groups: [],
    }).map((arrow) => arrow.id),
    ["keep"],
  );
});

test("共享分组规则按图标中心更新归属并支持重命名", () => {
  const items = [{ ref: "one", x: 20, y: 20, w: 100, h: 120, group: "" }];
  const groups = [{ id: "g1", name: "阅读", x: 0, y: 0, w: 200, h: 200, color: "#fff" }];
  assert.equal(canvasState.recomputeGroupMembership(items, groups), 1);
  assert.equal(items[0].group, "阅读");
  assert.equal(canvasState.renameGroupMembership(items, "阅读", "资料"), 1);
  assert.equal(items[0].group, "资料");
});

test("文内分组可用共享工厂围绕点击点创建紧凑尺寸", () => {
  assert.deepEqual(
    canvasState.createGroupBox({
      id: "g1",
      name: "资料",
      point: { x: 300, y: 220 },
      color: "#7aa2f7",
      width: 360,
      height: 240,
      centered: true,
    }),
    { id: "g1", name: "资料", x: 120, y: 100, w: 360, h: 240, color: "#7aa2f7" },
  );
});

test("文内画布连续写回会用上一次成功内容作为下一次定位标记", () => {
  const original = '{"items":[]}';
  const first = '{"items":[],"groups":[{"x":10,"y":20}]}';
  const second = '{"items":[],"groups":[{"x":30,"y":40}]}';

  const firstWrite = embedWriteState.replaceEmbedMarker(`before\n${original}\nafter`, original, first);
  assert.equal(firstWrite.replaced, true);
  assert.equal(firstWrite.marker, first);

  const secondWrite = embedWriteState.replaceEmbedMarker(firstWrite.content, firstWrite.marker, second);
  assert.equal(secondWrite.replaced, true);
  assert.match(secondWrite.content, /"x":30,"y":40/);
  assert.doesNotMatch(secondWrite.content, /"x":10,"y":20/);
});

test("空代码块定位标记不会把画布 JSON 插到笔记开头", () => {
  const content = "# 正文\n\n```web-desk\n```";
  const result = embedWriteState.replaceEmbedMarker(content, "", '{"items":[]}');
  assert.equal(result.replaced, false);
  assert.equal(result.alreadyCurrent, false);
  assert.equal(result.content, content);
});

test("内嵌画布新链接避开已有卡片、图片和文本框", () => {
  const desired = { x: 100, y: 100 };
  const data = {
    items: [{ url: "https://one.example", title: "one", x: 100, y: 100, size: 96 }],
    images: [{ id: "i1", path: "image.png", x: -28, y: -28, w: 96, h: 96 }],
    textboxes: [{ id: "t1", text: "note", x: 228, y: 100, w: 120, h: 100 }],
  };

  const placed = embedState.findAvailableEmbedItemPosition(data, desired);
  assert.notDeepEqual(placed, desired);
  assert.deepEqual(placed, { x: 228, y: 228 });
});

test("内嵌画布中心空闲时保留用户期望落点", () => {
  assert.deepEqual(
    embedState.findAvailableEmbedItemPosition(
      { items: [], images: [], textboxes: [] },
      { x: 100, y: 100 },
    ),
    { x: 100, y: 100 },
  );
});

test("内嵌画布连续评分组件不会完全重叠", () => {
  const data = {
    items: [],
    images: [],
    ratings: [{ id: "r1", value: 4, x: 100, y: 100 }],
  };
  assert.deepEqual(
    embedState.findAvailableEmbedRatingPosition(data, { x: 100, y: 100 }),
    { x: 340, y: 100 },
  );
});

test("粘贴一个或多个整行 URL 时全部进入链接导入", () => {
  assert.deepEqual(
    clipboardState.splitCanvasPaste("https://example.com\ncomponent.gallery"),
    { urls: ["https://example.com", "component.gallery"], text: "" },
  );
});

test("混合粘贴时 URL 行与普通文本无损分流", () => {
  assert.deepEqual(
    clipboardState.splitCanvasPaste("设计参考\nhttps://example.com\n后续再看"),
    { urls: ["https://example.com"], text: "设计参考\n后续再看" },
  );
});

test("句子里的 URL 保留在文本框而不是丢掉上下文", () => {
  assert.deepEqual(
    clipboardState.splitCanvasPaste("参考 https://example.com 的布局"),
    { urls: [], text: "参考 https://example.com 的布局" },
  );
});

test("单个普通单词按文本处理，不误判成裸域名", () => {
  assert.deepEqual(clipboardState.splitCanvasPaste("hello"), {
    urls: [],
    text: "hello",
  });
});

test("内嵌画布不把 Obsidian 正文编辑器祖先误判为画布内文本编辑", () => {
  const outerEditor = {};
  const target = { closest: () => outerEditor };
  const canvasBoundary = { contains: () => false };

  assert.equal(
    clipboardState.isEditablePasteTarget(target, canvasBoundary),
    false,
  );
});

test("内嵌画布文本框编辑态仍保留原生粘贴", () => {
  const innerTextEditor = {};
  const target = { closest: () => innerTextEditor };
  const canvasBoundary = { contains: (element) => element === innerTextEditor };

  assert.equal(
    clipboardState.isEditablePasteTarget(target, canvasBoundary),
    true,
  );
});

test("内嵌画布拥有 URL 事件目标时不受宿主 defaultPrevented 影响", () => {
  assert.equal(
    clipboardState.shouldClaimEmbeddedCanvasPaste({
      defaultPrevented: true,
      editableTarget: false,
      imageCount: 0,
      paste: { urls: ["https://example.com"], text: "" },
    }),
    true,
  );
});

test("内嵌画布文本框编辑态即使含 URL 也不劫持原生粘贴", () => {
  assert.equal(
    clipboardState.shouldClaimEmbeddedCanvasPaste({
      defaultPrevented: false,
      editableTarget: true,
      imageCount: 0,
      paste: { urls: ["https://example.com"], text: "" },
    }),
    false,
  );
});
