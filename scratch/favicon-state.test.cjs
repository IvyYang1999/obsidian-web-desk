const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({ entryPoints: ["src/favicon-state.ts"], bundle: true, format: "cjs", platform: "node", write: false });
const mod = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(mod, mod.exports, require);
const {
  faviconCandidates, pickBestFavicon, isPreferredFavicon, faviconFileName, faviconExtension,
  isImageContentType, normalizeFaviconHost,
} = mod.exports;

const sample = (source, size, contentType = "image/png") => ({ source, width: size, height: size, contentType, bytes: new ArrayBuffer(8) });

test("域名归一化：去 www、转小写、拒绝非法字符", () => {
  assert.equal(normalizeFaviconHost("WWW.Figma.com"), "figma.com");
  assert.equal(normalizeFaviconHost("evil host/../x"), "");
  assert.equal(faviconCandidates("bad host").length, 0);
});

test("来源顺序：Google 128px 优先，DuckDuckGo 作后备", () => {
  const candidates = faviconCandidates("figma.com");
  assert.equal(candidates[0].source, "google");
  assert.match(candidates[0].url, /sz=128/);
  assert.equal(candidates[1].source, "duckduckgo");
});

test("择优：取最大的一份，全部小于 24px 时返回 null 让首字母接管", () => {
  assert.equal(pickBestFavicon([sample("google", 18), sample("duckduckgo", 16)]), null);
  assert.equal(pickBestFavicon([sample("google", 32), sample("duckduckgo", 64)]).source, "duckduckgo");
  assert.equal(pickBestFavicon([null, sample("duckduckgo", 48)]).source, "duckduckgo");
});

test("首个来源已达 64px 时视为足够，不再请求后备", () => {
  assert.equal(isPreferredFavicon(sample("google", 128)), true);
  assert.equal(isPreferredFavicon(sample("google", 32)), false);
  assert.equal(isPreferredFavicon(null), false);
});

test("缓存文件名与扩展名稳定", () => {
  assert.equal(faviconFileName("www.Figma.com", "png"), "figma.com.png");
  assert.equal(faviconExtension("image/x-icon"), "ico");
  assert.equal(faviconExtension("image/png; charset=binary"), "png");
  assert.equal(isImageContentType("image/vnd.microsoft.icon"), true);
  assert.equal(isImageContentType("text/html"), false);
});
