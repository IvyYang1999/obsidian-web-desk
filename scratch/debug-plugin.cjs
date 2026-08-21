const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); });
const { chromium } = require('/Users/yytyyf/projects/oneday/node_modules/playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let PORT;
(async () => {
  PORT = await freePort();
  // 预填注册表，跳过首启 onboarding
  fs.rmSync('/tmp/obsidian-webdesk-smoke4', { recursive: true, force: true });
  fs.mkdirSync('/tmp/obsidian-webdesk-smoke4', { recursive: true });
  fs.copyFileSync(process.env.HOME + '/Library/Application Support/obsidian/obsidian.json', '/tmp/obsidian-webdesk-smoke4/obsidian.json');
  for (const f of fs.readdirSync(process.env.HOME + '/Library/Application Support/obsidian')) {
    if (/^[0-9a-f]{16}\.json$/.test(f)) {
      fs.copyFileSync(process.env.HOME + '/Library/Application Support/obsidian/' + f, '/tmp/obsidian-webdesk-smoke4/' + f);
    }
  }

  const obsidian = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/obsidian-webdesk-smoke4',
    '/Users/yytyyf/Vaults/main',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  obsidian.stdout.on('data', (d) => console.log('[out]', String(d).slice(0, 200)));
  obsidian.stderr.on('data', (d) => console.log('[err]', String(d).slice(0, 200)));
  obsidian.on('exit', (code) => console.log('[exit]', code));
  try {
    let browser = null;
    for (let i = 0; i < 40 && !browser; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); } catch {}
      await sleep(1000);
    }
    const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('index.html'));
    page.on('console', (m) => console.log('[console]', m.type(), m.text().slice(0, 300)));
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
    await page.waitForFunction(() => window.app && app.workspace && app.workspace.layoutReady, null, { timeout: 60000 });
    await sleep(8000);
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1200));
    console.log('BODY TEXT:\n' + bodyText);
    const info = await page.evaluate(() => ({
      enabled: app.plugins.enabledPlugins.has('web-desk'),
      loaded: Object.keys(app.plugins.plugins),
      manifests: Object.keys(app.plugins.manifests).filter((k) => k.includes('web')),
    }));
    console.log(JSON.stringify(info, null, 2));
    await browser.close();
  } finally {
    obsidian.kill('SIGTERM');
    setTimeout(() => { try { obsidian.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
