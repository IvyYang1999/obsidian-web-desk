const { spawn } = require('child_process');
const { chromium } = require('/Users/yytyyf/projects/oneday/node_modules/playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const obsidian = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [
    '--remote-debugging-port=9334',
    '--user-data-dir=/tmp/obsidian-webdesk-smoke3',
    '/Users/yytyyf/Vaults/main',
  ], { stdio: 'ignore' });
  try {
    let browser = null;
    for (let i = 0; i < 40 && !browser; i++) {
      try { browser = await chromium.connectOverCDP('http://127.0.0.1:9334'); } catch {}
      await sleep(1000);
    }
    await sleep(6000);
    const page = browser.contexts().flatMap((c) => c.pages())[0];
    console.log(await page.evaluate(() => document.body.innerText.slice(0, 600)));
    await browser.close();
  } finally {
    obsidian.kill('SIGTERM');
    setTimeout(() => { try { obsidian.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
