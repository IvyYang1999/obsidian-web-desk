// 隔离实验：processFrontMatter 在「vault 索引中」是否静默丢写
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const { chromium } = require('/Users/yytyyf/projects/oneday/node_modules/playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); });
(async () => {
  const PORT = await freePort();
  const PROFILE = '/tmp/obsidian-webdesk-pfm';
  fs.rmSync(PROFILE, { recursive: true, force: true });
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.copyFileSync(process.env.HOME + '/Library/Application Support/obsidian/obsidian.json', PROFILE + '/obsidian.json');
  for (const f of fs.readdirSync(process.env.HOME + '/Library/Application Support/obsidian')) {
    if (/^[0-9a-f]{16}\.json$/.test(f)) fs.copyFileSync(process.env.HOME + '/Library/Application Support/obsidian/' + f, PROFILE + '/' + f);
  }
  const obsidian = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '/Users/yytyyf/Vaults/main',
  ], { stdio: 'ignore' });
  try {
    let browser = null;
    for (let i = 0; i < 60 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch {} await sleep(1000); }
    const page = await (async () => {
      for (let i = 0; i < 60; i++) {
        for (const p of browser.contexts().flatMap((c) => c.pages())) {
          try { if (await p.evaluate(() => window.app && app.vault && app.vault.getName() === 'main' && app.workspace.layoutReady)) return p; } catch {}
        }
        await sleep(1000);
      }
      throw new Error('no vault page');
    })();
    await sleep(3000);
    const result = await page.evaluate(async () => {
      const out = {};
      // 1) vault.create 带初始 frontmatter
      const old = app.vault.getAbstractFileByPath('webdesk-pfm-test.md');
      if (old) await app.vault.trash(old, false);
      const f = await app.vault.create('webdesk-pfm-test.md', '---\ntitle: t\nprobe: 1\n---\n\nhi\n');
      out.created = true;
      // 2) 立即 processFrontMatter 改值
      await app.fileManager.processFrontMatter(f, (fm) => { fm.probe = 42; });
      out.pfmResolved = true;
      await new Promise((r) => setTimeout(r, 500));
      out.diskAfterPfm = await app.vault.adapter.read('webdesk-pfm-test.md');
      // 3) 再用 vault.process 直改对照
      await app.vault.process(f, (c) => c.replace('probe: 42', 'probe: 99'));
      out.diskAfterProcess = (await app.vault.adapter.read('webdesk-pfm-test.md')).match(/^probe:.*$/m)?.[0];
      // 清理
      const f2 = app.vault.getAbstractFileByPath('webdesk-pfm-test.md');
      if (f2) await app.vault.trash(f2, false);
      return out;
    });
    console.log(JSON.stringify(result, null, 1));
    await browser.close();
  } finally {
    obsidian.kill('SIGTERM');
    setTimeout(() => { try { obsidian.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
