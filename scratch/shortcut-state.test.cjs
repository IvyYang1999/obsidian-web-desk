const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({ entryPoints: ["src/shortcut-state.ts"], bundle: true, format: "cjs", platform: "node", write: false });
const mod = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, require);
const {
  classifyLocalPath, shortcutDisplayName, localShortcutCandidates, shortcutRef, shortcutIconFileName,
  normalizeShortcutKind, isAbsoluteLocalPath, shortcutKindLabel,
} = mod.exports;

test("macOS .app 目录识别为应用，其它目录为文件夹，普通文件为文件", () => {
  assert.equal(classifyLocalPath("/Applications/Figma.app", true), "app");
  assert.equal(classifyLocalPath("/Applications/Figma.app/", true), "app");
  assert.equal(classifyLocalPath("/Users/me/Projects", true), "folder");
  assert.equal(classifyLocalPath("/Users/me/report.numbers", false), "file");
});

test("显示名：应用去掉 .app，文件保留扩展名", () => {
  assert.equal(shortcutDisplayName("/Applications/Figma.app", "app"), "Figma");
  assert.equal(shortcutDisplayName("/Users/me/Projects/", "folder"), "Projects");
  assert.equal(shortcutDisplayName("/Users/me/report.numbers", "file"), "report.numbers");
});

test("拖入候选：只收绝对路径，图片和 Markdown/PDF 交给已有流程，去重", () => {
  assert.deepEqual(
    localShortcutCandidates(["/Applications/Figma.app", "/Applications/Figma.app", "/tmp/a.png", "/notes/x.md", "relative/path", "https://example.com"]),
    ["/Applications/Figma.app"],
  );
  assert.equal(isAbsoluteLocalPath("C:\\Tools\\x.exe"), true);
});

test("引用与缓存文件名稳定且安全", () => {
  assert.equal(shortcutRef("/Applications/Figma.app"), "app:/Applications/Figma.app");
  const name = shortcutIconFileName({ path: "/Applications/Figma.app", name: "Figma" });
  assert.match(name, /^Figma-[a-z0-9]+\.png$/);
  assert.equal(shortcutIconFileName({ path: "/x", name: "a/b:c" }).startsWith("a-b-c-"), true);
});

test("种类归一化与标签", () => {
  assert.equal(normalizeShortcutKind("app"), "app");
  assert.equal(normalizeShortcutKind("bogus"), "file");
  assert.equal(shortcutKindLabel("folder"), "文件夹");
});

test("本机快捷方式在两种画布共享渲染、启动与拖入入口（parity 门禁）", () => {
  const fs = require("node:fs");
  const view = fs.readFileSync("src/view.ts", "utf8");
  const embed = fs.readFileSync("src/embed.ts", "utf8");
  for (const source of [view, embed]) {
    assert.match(source, /renderShortcutCardVisual\(/);
    assert.match(source, /launchLocalShortcutWithNotice\(/);
    assert.match(source, /revealLocalShortcut\(/);
    assert.match(source, /localShortcutCandidates\(localFilePathsFromDrop\(/);
    assert.match(source, /setTitle\("启动"\)/);
    assert.match(source, /setTitle\("在 Finder 中显示"\)/);
  }
  const main = fs.readFileSync("src/main.ts", "utf8");
  assert.match(main, /new ShortcutIconResolver\(/);
});
