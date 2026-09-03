const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/preview-asset-state.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const loaded = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(loaded, loaded.exports, require);

const { isSafePreviewPageUrl, previewAssetExtension, previewAssetName } = loaded.exports;

test("预览资源只接受常见图片类型并生成稳定无隐私文件名", () => {
  assert.equal(previewAssetExtension("image/jpeg", "https://cdn.example/a"), "jpg");
  assert.equal(previewAssetExtension("image/png", "https://cdn.example/a.bin"), "png");
  assert.equal(previewAssetExtension("text/html", "https://example.com"), null);
  assert.match(previewAssetName("https://example.com/article?id=secret", "png"), /^example-com-[a-z0-9]+\.png$/);
  assert.doesNotMatch(previewAssetName("https://example.com/article?id=secret", "png"), /secret|article/);
});

test("离屏截图入口与重定向目标只接受 HTTPS", () => {
  assert.equal(isSafePreviewPageUrl("https://example.com/page"), true);
  assert.equal(isSafePreviewPageUrl("http://example.com/page"), false);
  assert.equal(isSafePreviewPageUrl("file:///tmp/private.html"), false);
  assert.equal(isSafePreviewPageUrl("javascript:alert(1)"), false);
  assert.equal(isSafePreviewPageUrl("not a url"), false);
});

test("离屏截图显式拒绝权限、新窗口与非 HTTPS 导航", () => {
  const source = require("node:fs").readFileSync("src/preview-assets.ts", "utf8");
  assert.match(source, /setPermissionRequestHandler\([\s\S]*callback\(false\)/);
  assert.match(source, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(source, /setDevicePermissionHandler\?\.\(\(\) => false\)/);
  assert.match(source, /setWindowOpenHandler\?\.\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(source, /webContents\.on\?\.\("will-redirect", rejectInsecureNavigation\)/);
  assert.match(source, /webContents\.on\?\.\("will-navigate", rejectInsecureNavigation\)/);
  assert.match(source, /blockedInsecureNavigation \|\| !isSafePreviewPageUrl\(browser\.webContents\.getURL\(\)\)/);
});
