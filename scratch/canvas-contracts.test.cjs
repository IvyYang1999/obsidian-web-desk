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
const fileLinkState = loadTypeScript("src/file-link-state.ts");
const utilState = loadTypeScript("src/util.ts");
const cardViewState = loadTypeScript("src/card-view-state.ts");
const filePreviewState = loadTypeScript("src/file-preview-state.ts");

test("PDF 与 Markdown 文件共享图标、卡片、嵌入三态合同", () => {
  assert.equal(filePreviewState.canvasFileKind("资料/报告.pdf"), "pdf");
  assert.equal(filePreviewState.canvasFileKind("资料/笔记.MD"), "markdown");
  assert.equal(filePreviewState.canvasFileKind("附件/data.csv"), "other");
  assert.equal(filePreviewState.supportsCanvasFilePreview("资料/报告.pdf"), true);
  assert.equal(filePreviewState.supportsCanvasFilePreview("资料/笔记.md"), true);
  assert.deepEqual(filePreviewState.canvasFileViewModes("资料/报告.pdf"), ["icon", "preview", "embed"]);
});

test("两种画布共享文件渲染器、三态菜单与可返回的全屏阅读器", () => {
  for (const file of ["src/view.ts", "src/embed.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /renderFileCardVisual\(/, `${file} 应渲染文件三态`);
    assert.match(source, /openCanvasFilePreview\(/, `${file} 应打开共享全屏阅读器`);
    assert.match(source, /showCardModeMenu\(/, `${file} 应给文件展示三态菜单`);
  }
  const previewSource = fs.readFileSync("src/file-preview.ts", "utf8");
  assert.match(previewSource, /MarkdownRenderer\.render/);
  assert.match(previewSource, /web-desk-file-pdf-frame/);
  assert.match(previewSource, /返回画布/);
  assert.match(previewSource, /Escape/);
});

test("新建区域直接落在画布并进入原位命名，主画布与文内画布保持一致", () => {
  for (const file of ["src/view.ts", "src/embed.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    const createGroup = source.match(/private createGroupAt\([\s\S]*?\n  }\n\n  private /)?.[0] ?? "";
    assert.ok(createGroup, `${file} 应存在 createGroupAt`);
    assert.doesNotMatch(createGroup, /new TextInputModal/);
    assert.match(createGroup, /nextAvailableGroupName/);
    assert.match(createGroup, /editingGroupId\s*=\s*group\.id/);
    assert.match(source, /private editGroupName\(/);
  }
  const embedSource = fs.readFileSync("src/embed.ts", "utf8");
  const embedCreateGroup = embedSource.match(/private createGroupAt\([\s\S]*?\n  }\n\n  private /)?.[0] ?? "";
  assert.doesNotMatch(embedCreateGroup, /scheduleWrite\(\)/, "文内新分组不得在名称编辑结束前写入中间态");
});

test("新区域默认名称稳定且不会与已有名称冲突", () => {
  assert.equal(canvasState.nextAvailableGroupName([]), "新区域");
  assert.equal(canvasState.nextAvailableGroupName(["新区域"]), "新区域 2");
  assert.equal(
    canvasState.nextAvailableGroupName(["新区域", "新区域 2", "新区域 4"]),
    "新区域 3",
  );
});

test("区域与组合在两种画布使用不同且一致的动作名称", () => {
  for (const file of ["src/view.ts", "src/embed.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    assert.match(source, /label: "新建区域"/);
    assert.match(source, /label: "区域"/);
    assert.match(source, /setTitle\("组合所选元素"\)/);
    assert.doesNotMatch(source, /新建分组|重命名分组|设置分组外观|更多分组操作|删除分组|分组：/);
  }
});

test("Obsidian 内部拖拽优先解析 app 路径，并兼容 URL 与 WikiLink", () => {
  assert.deepEqual(
    fileLinkState.extractMarkdownLinkCandidates({
      html: '<a href="app://obsidian.md/%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.md">设计</a>',
      text: "obsidian://open?vault=main&file=%E9%A1%B9%E7%9B%AE%2F%E8%AE%BE%E8%AE%A1.md",
    }),
    ["项目/设计.md"],
  );
  assert.deepEqual(
    fileLinkState.extractMarkdownLinkCandidates({ text: "[[项目/设计|设计稿]]\n其它/记录.md" }),
    ["项目/设计", "其它/记录.md"],
  );
});

test("Finder 的 file URI 保留绝对路径并只接受当前 Vault 内 Markdown/PDF", () => {
  const vault = "/Users/test/Vaults/main";
  const uri = "file:///Users/test/Vaults/main/%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1.md";
  assert.deepEqual(fileLinkState.extractMarkdownLinkCandidates({ uriList: uri }), [
    "/Users/test/Vaults/main/项目/设计.md",
  ]);
  assert.equal(
    fileLinkState.vaultPathFromMarkdownCandidate("/Users/test/Vaults/main/项目/设计.md", vault),
    "项目/设计.md",
  );
  assert.deepEqual(
    fileLinkState.extractMarkdownLinkCandidates({
      uriList: "file:///Users/test/Vaults/main/%E9%99%84%E4%BB%B6/%E8%AE%BE%E8%AE%A1.pdf",
    }),
    ["/Users/test/Vaults/main/附件/设计.pdf"],
  );
  assert.equal(
    fileLinkState.vaultPathFromMarkdownCandidate("/Users/test/Vaults/main/附件/设计.pdf", vault),
    "附件/设计.pdf",
  );
  assert.equal(
    fileLinkState.vaultPathFromMarkdownCandidate("/Users/test/Desktop/设计.md", vault),
    null,
  );
  const encodedHash = "file:///Users/test/Vaults/main/%E9%A1%B9%E7%9B%AE/%E8%AE%BE%E8%AE%A1%23%E5%A4%8D%E7%9B%98.md";
  const [hashPath] = fileLinkState.extractMarkdownLinkCandidates({ uriList: encodedHash });
  assert.equal(hashPath, "/Users/test/Vaults/main/项目/设计#复盘.md");
  assert.equal(
    fileLinkState.vaultPathFromMarkdownCandidate(hashPath, vault),
    "项目/设计#复盘.md",
  );
});

test("本地文件 URI 永不进入网页 URL 路由", () => {
  assert.equal(utilState.isProbablyUrl("file:///Users/test/Vaults/main/项目/设计.md"), false);
  assert.equal(utilState.isProbablyUrl("obsidian://open?vault=main&file=项目/设计.md"), false);
  assert.equal(utilState.isProbablyUrl("component.gallery"), true);
  assert.equal(utilState.isProbablyUrl("https://example.com"), true);
});

test("文内画布能从所有 web-desk 块汇总真实 Markdown 双链", () => {
  const markdown = [
    "```web-desk",
    JSON.stringify({ items: [
      { path: "项目/设计.md" },
      { url: "https://example.com", bookmarkPath: "收藏夹/Example.md" },
    ] }),
    "```",
    "正文",
    "```web-desk",
    JSON.stringify({ items: [{ path: "项目/研究.md" }, { path: "项目/设计.md" }] }),
    "```",
  ].join("\n");
  assert.deepEqual(fileLinkState.extractEmbeddedMarkdownPaths(markdown), [
    "项目/设计.md",
    "收藏夹/Example.md",
    "项目/研究.md",
  ]);
});

test("文件卡片与网页卡片使用互不冲突的稳定引用", () => {
  assert.equal(embedState.embedItemRef({ url: "https://example.com" }), "https://example.com");
  assert.equal(embedState.embedItemRef({ url: "", path: "项目/设计.md" }), "file:项目/设计.md");
});

test("文件卡片同时接入真实双链、原生悬停源与两种画布", () => {
  const main = fs.readFileSync("src/main.ts", "utf8");
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const storage = fs.readFileSync("src/file-link-storage.ts", "utf8");
  assert.match(main, /registerHoverLinkSource\("web-desk"/);
  assert.match(view, /createMarkdownShortcut/);
  assert.match(view, /this\.layoutWrites\.set\(result\.file\.path/);
  assert.match(view, /workspace\.trigger\("hover-link"/);
  assert.match(embed, /markdownFilesFromDrop/);
  assert.match(embed, /web_desk_links/);
  assert.match(storage, /desk_file:/);
  assert.match(storage, /generateMarkdownLink/);
  const renderBody = view.match(/private render\(\): void \{([\s\S]*?)\n  \}\n\n  private renderIcon/);
  assert.ok(renderBody);
  assert.doesNotMatch(renderBody[1], /this\.render\(\)/);
});

test("两种画布把含 web-desk 块的文件卡片升级为可下钻画布引用", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const css = fs.readFileSync("styles.css", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /resolveCanvasReference/);
    assert.match(source, /引用其它画布…/);
    assert.match(source, /is-canvas-reference/);
    assert.match(source, /openCanvasReference/);
  }
  assert.match(embed, /class CanvasDrilldown/);
  assert.match(embed, /canEnterCanvasReference/);
  assert.match(css, /\.web-desk-drilldown-nav/);
  assert.match(css, /\.web-desk-canvas-reference-badge/);
});

test("文件卡片使用主题自适应的原生文档图标", () => {
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.web-desk-file-thumb\s*\{[^}]*background-color:\s*var\(--background-primary-alt\)/s);
  assert.match(css, /\.web-desk-file-icon svg\s*\{[^}]*stroke-width:\s*1\.6/s);
});

test("主画布和文内画布共享网页预览原语并提供模式切换", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const visual = fs.readFileSync("src/card-view.ts", "utf8");
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(view, /renderWebCardVisual/);
  assert.match(embed, /renderWebCardVisual/);
  assert.match(view, /显示为预览卡片/);
  assert.match(embed, /显示为预览卡片/);
  assert.match(visual, /data-view-mode/);
  assert.match(css, /\.web-desk-icon\.is-preview/);
  assert.match(css, /\.web-desk-icon:focus-visible \.web-desk-icon-thumb\s*\{[^}]*box-shadow:\s*0 0 0 2px var\(--interactive-accent\)/s);
  assert.equal(cardViewState.normalizeCardViewMode("preview"), "preview");
});

test("网页对象在两种画布共享三态工具栏、独立 Caption 与安全嵌入", () => {
  const main = fs.readFileSync("src/main.ts", "utf8");
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const visual = fs.readFileSync("src/card-view.ts", "utf8");
  const chrome = fs.readFileSync("src/canvas-chrome.ts", "utf8");
  const importer = fs.readFileSync("src/importer.ts", "utf8");
  const css = fs.readFileSync("styles.css", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /createCanvasObjectToolbar/);
    assert.match(source, /编辑 Caption/);
    assert.match(source, /实时嵌入/);
    assert.match(source, /assessRemoteEmbed/);
    assert.match(source, /rememberBlockedEmbedHost/);
  }
  assert.match(chrome, /web-desk-selection-toolbar/);
  assert.match(view, /this\.onViewObjectPointerDown\(event, card\.path, el\);/);
  assert.match(embed, /this\.onEmbedObjectPointerDown\(event, embedItemRef\(item\), el\);/);
  assert.match(main, /setBlockedEmbedHosts/);
  assert.match(visual, /sandbox:\s*"allow-scripts"/);
  assert.match(visual, /referrerpolicy:\s*"no-referrer"/);
  assert.match(visual, /web-desk-card-caption/);
  assert.match(importer, /localizeWebsitePreview/);
  assert.match(css, /\.web-desk-selection-toolbar/);
  assert.match(css, /\.web-desk-embed-card/);
  assert.match(css, /\.web-desk-card-caption/);
});

test("画布创建栏与对象工具栏共享紧凑桌面控件规格", () => {
  const styles = fs.readFileSync("styles.css", "utf8");
  assert.match(styles, /--wd-control-compact:\s*32px/);
  assert.match(styles, /\.web-desk-selection-tool\s*\{[^}]*min-width:\s*var\(--wd-control-compact\)[^}]*height:\s*var\(--wd-control-compact\)/s);
  assert.match(styles, /\.web-desk-create-tool\s*\{[^}]*width:\s*var\(--wd-control-compact\)[^}]*height:\s*var\(--wd-control-compact\)/s);
  assert.match(styles, /\.web-desk-create-tool svg\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s);
});

test("对象缩放手柄只在 hover、键盘聚焦或缩放会话中出现", () => {
  const styles = fs.readFileSync("styles.css", "utf8");
  assert.match(styles, /\.web-desk-group-resize,[\s\S]*?\.web-desk-icon-resize\s*\{[^}]*opacity:\s*0[^}]*transition:\s*opacity\s+var\(--wd-motion-fast\)/s);
  assert.match(styles, /\.web-desk-group:hover\s*>\s*\.web-desk-group-resize/);
  assert.match(styles, /\.web-desk-textbox:hover\s*>\s*\.web-desk-textbox-resize/);
  assert.match(styles, /\.web-desk-image:hover\s*>\s*\.web-desk-image-resize/);
  assert.match(styles, /\.web-desk-icon:hover\s*>\s*\.web-desk-icon-resize/);
  assert.match(styles, /\.web-desk-group-resize\.is-resizing[\s\S]*?opacity:\s*1/s);
  assert.match(styles, /\.web-desk-object-selection-resize\s*\{[^}]*opacity:\s*0/s);
  assert.match(styles, /\.web-desk-root:has\([^)]*\.is-selected:hover[^)]*\)[\s\S]*?\.web-desk-object-selection-resize/s);
  assert.doesNotMatch(styles, /\.web-desk-icon\.is-selected\s+\.web-desk-icon-resize/);
});

test("分组与文本框在两种画布共享可选容器外观", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const chrome = fs.readFileSync("src/canvas-chrome.ts", "utf8");
  const styles = fs.readFileSync("styles.css", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /applyCanvasContainerAppearance\(el, group\)/);
    assert.match(source, /applyCanvasContainerAppearance\(el, box\)/);
    assert.match(source, /appendCanvasContainerAppearanceMenuItems\(this\.app, menu, group/);
    assert.match(source, /appendCanvasContainerAppearanceMenuItems\(this\.app, menu, box/);
    assert.match(source, /showCanvasContainerAppearanceMenu\(this\.app, button, group/);
    assert.match(source, /showCanvasContainerAppearanceMenu\(this\.app, button, box/);
  }
  assert.match(chrome, /setTitle\("显示边框"\)[\s\S]*setChecked\(appearance\.showBorder\)/);
  assert.match(chrome, /setTitle\("显示底色"\)[\s\S]*setChecked\(appearance\.showFill\)/);
  assert.match(styles, /\.web-desk-group\s*\{[^}]*border:\s*2px dashed transparent[^}]*background:\s*transparent/s);
  assert.match(styles, /\.web-desk-textbox\s*\{[^}]*border:\s*2px dashed transparent[^}]*background:\s*transparent/s);
  assert.match(styles, /\.web-desk-group\.has-border\s*\{[^}]*--wd-container-color/s);
  assert.match(styles, /\.web-desk-textbox\.has-fill\s*\{[^}]*--wd-container-color/s);
});

test("两种画布的移动与缩放都接入共享吸附引擎和参考线层", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const css = fs.readFileSync("styles.css", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /createCanvasSnapSession/);
    assert.match(source, /createCanvasSnapGuideLayer/);
    assert.match(source, /\.move\(/);
    assert.match(source, /\.resize\(/);
  }
  assert.match(css, /\.web-desk-snap-guide\.is-vertical/);
  assert.match(css, /\.web-desk-snap-guide\.is-horizontal/);
});

test("文内画布往返保留卡片、嵌入与 Caption 字段且旧块仍为图标", () => {
  const oldData = embedState.parseEmbedData(JSON.stringify({
    items: [{ url: "https://example.com", title: "Example", x: 10, y: 20 }],
  }));
  assert.equal(oldData.items[0].viewMode, undefined);

  const previewData = embedState.parseEmbedData(JSON.stringify({
    items: [{
      url: "https://example.com",
      title: "Example",
      x: 10,
      y: 20,
      viewMode: "preview",
      previewWidth: 360,
      previewHeight: 260,
      previewImage: "https://example.com/cover.png",
    }],
  }));
  assert.equal(previewData.items[0].viewMode, "preview");
  assert.equal(previewData.items[0].previewWidth, 360);
  assert.equal(previewData.items[0].previewImage, "https://example.com/cover.png");

  const styledData = embedState.parseEmbedData(JSON.stringify({
    items: [{
      url: "https://example.com",
      title: "Example",
      x: 10,
      y: 20,
      viewMode: "preview",
      cardStyle: "compact",
    }],
  }));
  assert.equal(styledData.items[0].cardStyle, "compact");

  const embedData = embedState.parseEmbedData(JSON.stringify({
    items: [{
      url: "https://example.com",
      title: "Example",
      caption: "这是公开说明",
      note: "这是内部备注",
      x: 10,
      y: 20,
      viewMode: "embed",
      previewWidth: 640,
      previewHeight: 420,
    }],
  }));
  assert.equal(embedData.items[0].viewMode, "embed");
  assert.equal(embedData.items[0].caption, "这是公开说明");
  assert.equal(embedData.items[0].note, "这是内部备注");

  const linkedData = embedState.parseEmbedData(JSON.stringify({
    items: [{
      url: "https://example.com",
      bookmarkPath: "收藏夹/Example.md",
      title: "Example",
      x: 10,
      y: 20,
    }],
  }));
  assert.equal(linkedData.items[0].bookmarkPath, "收藏夹/Example.md");
});

test("两种画布共享完整 URL 收藏链路与网页文件动作", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const importer = fs.readFileSync("src/importer.ts", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /importUrlAsBookmark/);
    assert.match(source, /打开 Markdown/);
    assert.match(source, /移出画布/);
    assert.match(source, /删除收藏文件/);
  }
  assert.doesNotMatch(embed, /fetchBookmarkMeta/);
  assert.match(embed, /bookmarkPath/);
  assert.match(importer, /WeakMap<App, Map<string, Promise<ImportResult>>>/);
  assert.match(importer, /created: false/);
});

test("两种画布共享适应内容与空格拖动画布", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /private fitContent\(\): void/);
    assert.match(source, /spacePanning/);
    assert.match(source, /event\.code === "Space"/);
    assert.match(source, /isEditablePasteTarget\(event\.target/);
    assert.match(source, /setTitle\("全选"\)/);
    assert.match(source, /setTitle\("适应内容"\)/);
  }
});

test("文内画布使用同一实例进入全屏编辑并可由 Escape 退出", () => {
  const main = fs.readFileSync("src/main.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(embed, /private setFullscreen\(fullscreen: boolean\): void/);
  assert.match(embed, /this\.rootEl\.toggleClass\("is-fullscreen", fullscreen\)/);
  assert.match(embed, /extends MarkdownRenderChild/);
  assert.match(embed, /body\.appendChild\(this\.rootEl\)/);
  assert.match(embed, /this\.fullscreenPlaceholder\.replaceWith\(this\.rootEl\)/);
  assert.match(main, /ctx\.addChild\(embed\)/);
  assert.match(embed, /aria-pressed/);
  assert.match(embed, /event\.key === "Escape" && this\.isFullscreen/);
  assert.match(css, /\.web-desk-embed\.is-fullscreen\s*\{[^}]*position:\s*fixed\s*!important;[^}]*inset:\s*0;[^}]*height:\s*100vh\s*!important;/s);
  assert.match(css, /\.web-desk-embed\.is-fullscreen \.web-desk-embed-height-resize\s*\{[^}]*display:\s*none;/s);
});

test("两种画布共享非破坏性 Delete 语义并保护文字编辑", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /planCanvasObjectDeletion/);
    assert.match(source, /removeSelectedObjectsFromCanvas/);
    assert.match(source, /isEditablePasteTarget\(event\.target/);
    assert.match(source, /event\.key === "Delete" \|\| event\.key === "Backspace"/);
  }
  assert.doesNotMatch(view, /this\.confirmDeleteSelected\(\)/);
});

test("分类分组框缩放时只保留自身虚线边缘", () => {
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.web-desk-group\.is-resizing::after\s*\{\s*content:\s*none;/);
  assert.match(css, /\.web-desk-embed:focus-visible:not\(\.is-pointer-focused\)::after/);
});

test("文内画布包装层 hover 与 focus 不生成第二层圆角", () => {
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.cm-embed-block:has\(\.web-desk-embed-host\):hover/);
  assert.match(css, /\.cm-embed-block:has\(\.web-desk-embed-host\):focus-within/);
  assert.match(css, /border-radius:\s*0\s*!important/);
  assert.match(css, /box-shadow:\s*none\s*!important/);
});

test("真实图片的 contain 留白透明，不在圆角两侧生成白色耳朵", () => {
  const css = fs.readFileSync("styles.css", "utf8");
  assert.match(css, /\.web-desk-image-content\s*\{[^}]*object-fit:\s*contain;[^}]*background-color:\s*transparent;/s);
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

test("图标与图片缩放也统一使用稳定 document 指针会话", () => {
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  for (const [source, method] of [
    [view, "onIconResizePointerDown"],
    [view, "onImageResizePointerDown"],
    [embed, "onItemResizePointerDown"],
    [embed, "onImageResizePointerDown"],
  ]) {
    const start = source.indexOf(`private ${method}`);
    assert.notEqual(start, -1, `missing ${method}`);
    const next = source.indexOf("\n  private ", start + 10);
    const body = source.slice(start, next === -1 ? source.length : next);
    assert.match(body, /beginCanvasPointerSession\(/, `${method} bypasses shared pointer session`);
    assert.doesNotMatch(body, /addEventListener\("pointermove"/, `${method} keeps element-scoped move listeners`);
  }
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
  assert.equal(
    objectGroupState.translateObjectGroup([
      { key: "card:one", x: 20, y: 40, w: 120, h: 140 },
    ], { x: 0.34, y: 0.67 })[0].x,
    20.34,
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
  const minimum = imageState.resizeImageToWidth({ w: 300, h: 200 }, 30);
  assert.equal(minimum.w, 80);
  assert.ok(Math.abs(minimum.h - 160 / 3) < 1e-9);
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

test("网页名称、评分与备注属于卡片本身且两种画布共用属性编辑器", () => {
  const parsed = embedState.parseEmbedData(JSON.stringify({
    items: [{
      url: "https://one.example",
      title: "One",
      rating: 4,
      note: "稍后复盘",
      x: 1,
      y: 2,
    }],
  }));
  assert.equal(parsed.items[0].rating, 4);
  assert.equal(parsed.items[0].note, "稍后复盘");

  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  const webCard = fs.readFileSync("src/card-view.ts", "utf8");
  const fileCard = fs.readFileSync("src/file-preview.ts", "utf8");
  assert.match(view, /CardPropertiesModal/);
  assert.match(embed, /CardPropertiesModal/);
  assert.match(view, /renderWebCardVisual/);
  assert.match(embed, /renderWebCardVisual/);
  assert.match(view, /renderFileCardVisual/);
  assert.match(embed, /renderFileCardVisual/);
  assert.match(webCard, /renderCardPropertyIndicators/);
  assert.match(fileCard, /renderCardPropertyIndicators/);
  assert.doesNotMatch(view, /为此链接添加评分/);
  assert.doesNotMatch(embed, /为此链接添加评分/);
  const modals = fs.readFileSync("src/modals.ts", "utf8");
  assert.match(modals, /button\.type = "button"/);
  assert.match(modals, /save\.type = "submit"/);
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

test("旧文内文本框补默认颜色且新版外观、分组、箭头可往返", () => {
  const data = embedState.parseEmbedData(JSON.stringify({
    items: [],
    textboxes: [{ id: "t1", text: "旧备注", x: 1, y: 2, w: 100, h: 60, showFill: true }],
    groups: [{ id: "g1", name: "资料", x: 0, y: 0, w: 300, h: 200, color: "#7aa2f7", showBorder: true }],
    arrows: [{ id: "a1", from: { kind: "group", ref: "g1" }, to: { kind: "point", ref: "400,100" }, label: "去这里", color: "" }],
  }));
  assert.equal(data.textboxes[0].color, "#7aa2f7");
  assert.equal(data.textboxes[0].showFill, true);
  assert.equal(data.groups[0].name, "资料");
  assert.equal(data.groups[0].showBorder, true);
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

test("共享区域规则按所有元素中心更新归属并支持重命名", () => {
  const items = [
    { key: "card:one", x: 20, y: 20, w: 100, h: 120, group: "" },
    { key: "image:two", x: 260, y: 20, w: 100, h: 120, group: "阅读" },
    { key: "textbox:three", x: 40, y: 40, w: 80, h: 40, group: "" },
    { key: "rating:four", x: 60, y: 60, w: 100, h: 60, group: "" },
  ];
  const groups = [{ id: "g1", name: "阅读", x: 0, y: 0, w: 200, h: 200, color: "#fff" }];
  assert.equal(canvasState.recomputeGroupMembership(items, groups), 4);
  assert.equal(items[0].group, "阅读");
  assert.equal(items[1].group, "");
  assert.equal(items[2].group, "阅读");
  assert.equal(items[3].group, "阅读");
  assert.deepEqual(
    canvasState.areaMembers(items, groups, "阅读").map((item) => item.key),
    ["card:one", "textbox:three", "rating:four"],
  );
  assert.equal(canvasState.renameGroupMembership(items, "阅读", "资料"), 3);
  assert.deepEqual(items.map((item) => item.group), ["资料", "", "资料", "资料"]);
});

test("两种画布的区域都会携带全部成员且四类元素可持久化归属", () => {
  const types = fs.readFileSync("src/types.ts", "utf8");
  const embedState = fs.readFileSync("src/embed-state.ts", "utf8");
  assert.match(types, /interface TextBox[\s\S]*?group\?: string;[\s\S]*?objectGroup\?: string;/);
  assert.match(types, /interface CanvasImage[\s\S]*?group\?: string;[\s\S]*?objectGroup\?: string;/);
  assert.match(types, /interface Rating[\s\S]*?group\?: string;[\s\S]*?objectGroup\?: string;/);
  assert.match(embedState, /group\?: string;[\s\S]*?objectGroup\?: string;/);
  for (const file of ["src/view.ts", "src/embed.ts"]) {
    const source = fs.readFileSync(file, "utf8");
    const groupMove = source.match(/private onGroupPointerDown\([\s\S]*?\n  }\n\n  private /)?.[0] ?? "";
    assert.match(groupMove, /areaMembers\(/, `${file} 未读取区域成员`);
    assert.match(groupMove, /translateObjectGroup\(/, `${file} 未携带区域成员`);
    assert.match(groupMove, /recompute.*GroupMembership|persistMovedObjects\([^)]*, true\)/, `${file} 未在松手后重算归属`);
  }
  assert.match(fs.readFileSync("styles.css", "utf8"), /\.web-desk-group\.is-drop-target/);
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
  const candidate = { ...placed, w: 120, h: 140 };
  for (const rect of [
    { x: 100, y: 100, w: 120, h: 140 },
    { x: -28, y: -28, w: 96, h: 96 },
    { x: 228, y: 100, w: 120, h: 100 },
  ]) {
    const separated =
      candidate.x + candidate.w + 16 <= rect.x ||
      rect.x + rect.w + 16 <= candidate.x ||
      candidate.y + candidate.h + 16 <= rect.y ||
      rect.y + rect.h + 16 <= candidate.y;
    assert.equal(separated, true);
  }
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
