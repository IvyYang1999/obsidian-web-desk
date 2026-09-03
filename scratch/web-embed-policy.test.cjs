const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSync } = require("esbuild");

const built = buildSync({
  entryPoints: ["src/web-embed-policy.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  write: false,
});
const loaded = { exports: {} };
new Function("module", "exports", "require", built.outputFiles[0].text)(loaded, loaded.exports, require);

const { assessEmbedHeaders, normalizeEmbeddableUrl, rememberBlockedEmbedHost } = loaded.exports;

test("实时嵌入只接受 HTTPS", () => {
  assert.equal(normalizeEmbeddableUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(normalizeEmbeddableUrl("http://example.com"), null);
  assert.equal(normalizeEmbeddableUrl("javascript:alert(1)"), null);
});

test("X-Frame-Options 与 CSP frame-ancestors 会阻止嵌入", () => {
  assert.deepEqual(assessEmbedHeaders({ "x-frame-options": "DENY" }), { allowed: false, reason: "x-frame-options" });
  assert.deepEqual(assessEmbedHeaders({ "X-Frame-Options": "SAMEORIGIN" }), { allowed: false, reason: "x-frame-options" });
  assert.deepEqual(
    assessEmbedHeaders({ "content-security-policy": "default-src 'self'; frame-ancestors 'none'" }),
    { allowed: false, reason: "frame-ancestors" },
  );
  assert.deepEqual(assessEmbedHeaders({}), { allowed: true, reason: "unknown" });
});

test("被阻止站点按 hostname 去重记忆且有上限", () => {
  const hosts = rememberBlockedEmbedHost(["old.example"], "https://WWW.Example.com/a", 2);
  assert.deepEqual(hosts, ["old.example", "www.example.com"]);
  assert.deepEqual(rememberBlockedEmbedHost(hosts, "https://www.example.com/b", 2), hosts);
  assert.deepEqual(rememberBlockedEmbedHost(hosts, "https://new.example/c", 2), ["www.example.com", "new.example"]);
});
