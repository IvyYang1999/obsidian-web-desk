const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const { chromium } = require('/Users/yytyyf/projects/oneday/node_modules/playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); });
(async () => {
  const PORT = await freePort();
  const PROFILE = '/tmp/obsidian-webdesk-embed';
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
    const page = await (async () => {
      for (let i = 0; i < 60; i++) {
        for (const p of browser.contexts().flatMap((c) => c.pages())) {
          try { if (await p.evaluate(() => window.app && app.vault && app.vault.getName() === 'main' && app.workspace.layoutReady)) return p; } catch {}
        }
        await sleep(1000);
      }
      throw new Error('no vault page');
    })();
    await sleep(5000);
    await page.evaluate(async () => {
      const old = app.vault.getAbstractFileByPath('webdesk-smoke-embed.md');
      if (old) await app.vault.trash(old, false);
      await app.plugins.enablePlugin('web-desk');
    });
    await sleep(2000);
    // 建带一条目的测试笔记（先绕过 fetch，验证渲染+写回链路）
    await page.evaluate(async () => {
      const content = ['# t', '', '```web-desk', JSON.stringify({ items: [{ url: 'https://example.com', title: 'Example', x: 40, y: 40 }] }, null, 1), '```', ''].join('\n');
      await app.vault.create('webdesk-smoke-embed.md', content);
      await app.workspace.openLinkText('webdesk-smoke-embed.md', '', false);
    });
    await sleep(4000);
    let step1 = await page.evaluate(() => ({
      embed: !!document.querySelector('.web-desk-embed'),
      icons: document.querySelectorAll('.web-desk-embed .web-desk-icon').length,
      notices: [...document.querySelectorAll('.notice')].map((n) => n.innerText.slice(0, 80)),
    }));
    console.log('render:', JSON.stringify(step1));

    // 直接调公共路径：合成 drop（uri-list）
    const r1 = await page.evaluate(() => {
      const embed = document.querySelector('.web-desk-embed');
      const r = embed.getBoundingClientRect();
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'https://example.org');
      dt.setData('text/plain', 'https://example.org');
      embed.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: r.x + 200, clientY: r.y + 200, dataTransfer: dt }));
      return { hasDt: true };
    });
    console.log('drop dispatched:', JSON.stringify(r1));
    await sleep(8000);
    const after = await page.evaluate(async () => {
      const f = app.vault.getAbstractFileByPath('webdesk-smoke-embed.md');
      return {
        text: (await app.vault.cachedRead(f)).slice(0, 400),
        icons: document.querySelectorAll('.web-desk-embed .web-desk-icon').length,
        notices: [...document.querySelectorAll('.notice')].map((n) => n.innerText.slice(0, 100)),
      };
    });
    console.log('after:', JSON.stringify(after, null, 1));
    await browser.close();
  } finally {
    obsidian.kill('SIGTERM');
    setTimeout(() => { try { obsidian.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
