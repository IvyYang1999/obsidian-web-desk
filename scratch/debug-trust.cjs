const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const { chromium } = require('/Users/yytyyf/projects/oneday/node_modules/playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); });
(async () => {
  const PORT = await freePort();
  const PROFILE = '/tmp/obsidian-webdesk-smoke5';
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
    for (let i = 0; i < 60 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch {}
      await sleep(1000);
    }
    if (!browser) throw new Error('no CDP');
    const page = await (async () => {
      for (let i = 0; i < 60; i++) {
        for (const p of browser.contexts().flatMap((c) => c.pages())) {
          try { if (await p.evaluate(() => window.app && app.vault && app.vault.getName() === 'main' && app.workspace.layoutReady)) return p; } catch {}
        }
        await sleep(1000);
      }
      throw new Error('no vault page');
    })();
    await sleep(6000);
    const modalInfo = await page.evaluate(() => {
      const c = document.querySelector('.modal-container');
      if (!c) return null;
      const btns = [...c.querySelectorAll('button, .modal-cta, [class*=button]')].map((b) => ({
        tag: b.tagName, cls: b.className, text: (b.innerText || '').slice(0, 80),
      }));
      return { text: c.innerText.slice(0, 400), btns };
    });
    console.log('MODAL:', JSON.stringify(modalInfo, null, 2).slice(0, 1200));
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal-container button')].find((b) => b.innerText.includes('Trust author'));
      if (btn) { btn.click(); return btn.innerText.slice(0, 40); }
      return null;
    });
    console.log('dom clicked:', JSON.stringify(clicked));
    await sleep(4000);
    const probe = await page.evaluate(async () => {
      const out = {};
      out.pluginsKeys = Object.keys(app.plugins);
      out.enabledCount = app.plugins.enabledPlugins.size;
      out.webDeskLoaded = !!app.plugins.plugins['web-desk'];
      out.loadedAfterTrust = Object.keys(app.plugins.plugins).slice(0, 8);
      await new Promise((r) => setTimeout(r, 2000));
      out.loadedNowCount = Object.keys(app.plugins.plugins).length;
      return out;
    });
    console.log(JSON.stringify(probe, null, 2).slice(0, 1500));
    await browser.close();
  } finally {
    obsidian.kill('SIGTERM');
    setTimeout(() => { try { obsidian.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
