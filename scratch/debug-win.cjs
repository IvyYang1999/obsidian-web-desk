const { spawn } = require('child_process');
const path = require('path');
const { chromium } = require('/Users/yytyyf/projects/oneday/node_modules/playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const obsidian = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [
    '--remote-debugging-port=9333',
    '--user-data-dir=/tmp/obsidian-webdesk-smoke2',
    '/Users/yytyyf/Vaults/main',
  ], { stdio: 'ignore' });
  try {
    let browser = null;
    for (let i = 0; i < 40 && !browser; i++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9333'); } catch {}
      await sleep(1000);
    }
    if (!browser) throw new Error('no CDP');
    for (let round = 0; round < 8; round++) {
      const pages = browser.contexts().flatMap((c) => c.pages());
      for (const p of pages) {
        let title = '', name = '';
        try { title = await p.title(); } catch {}
        try { name = await p.evaluate(() => window.app && app.vault ? app.vault.getName() : 'no-app'); } catch (e) { name = 'err:' + e.message.slice(0, 40); }
        console.log(`[${round}] ${p.url().slice(0, 80)} | title=${title} | vault=${name}`);
      }
      console.log('---');
      await sleep(4000);
    }
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) await pages[0].screenshot({ path: '/Users/yytyyf/projects/obsidian-web-desk/scratch/debug-1.png' });
    await browser.close();
  } finally {
    obsidian.kill('SIGTERM');
    setTimeout(() => { try { obsidian.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
})().catch((e) => { console.error('DEBUG FAILED:', e.message); process.exit(1); });
