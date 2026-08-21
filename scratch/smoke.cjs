// 网页桌面 V1 真机冒烟：CDP 附加隔离 Obsidian 实例（隔离 userdata，开真实 vault）
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => res(port)); }); });
const path = require('path');
const { chromium } = require(path.expandHome ? '' : '/Users/yytyyf/projects/oneday/node_modules/playwright');

const VAULT = '/Users/yytyyf/Vaults/main';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeout = 30000, label = 'condition') {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeout) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await sleep(400);
  }
  throw new Error(`timeout waiting for ${label} ${lastErr ? ': ' + lastErr.message : ''}`);
}

let PORT;
(async () => {
  PORT = await freePort();
  // 预填注册表，跳过首启 onboarding
  fs.rmSync('/tmp/obsidian-webdesk-smoke4', { recursive: true, force: true });
  fs.mkdirSync('/tmp/obsidian-webdesk-smoke4', { recursive: true });
  fs.copyFileSync(process.env.HOME + '/Library/Application Support/obsidian/obsidian.json', '/tmp/obsidian-webdesk-smoke4/obsidian.json');
  // 启动前清掉上次测试残留（收藏夹文件夹整体删除，Obsidian 会在导入时自建）
  fs.rmSync('/Users/yytyyf/Vaults/main/收藏夹', { recursive: true, force: true });
  for (const f of fs.readdirSync(process.env.HOME + '/Library/Application Support/obsidian')) {
    if (/^[0-9a-f]{16}\.json$/.test(f)) {
      fs.copyFileSync(process.env.HOME + '/Library/Application Support/obsidian/' + f, '/tmp/obsidian-webdesk-smoke4/' + f);
    }
  }

  const obsidian = spawn('/Applications/Obsidian.app/Contents/MacOS/Obsidian', [
    `--remote-debugging-port=${PORT}`,
    '--user-data-dir=/tmp/obsidian-webdesk-smoke4',
    VAULT,
  ], { stdio: 'ignore' });
  console.log('obsidian pid', obsidian.pid);

  try {
    const browser = await waitFor(async () => {
      try {
        const b = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
        return b;
      } catch { return null; }
    }, 45000, 'CDP endpoint');

    // 先拿 starter 页面，主动打开 vault
    const starter = await waitFor(async () => {
      const ctx = browser.contexts()[0];
      return ctx.pages().find((p) => p.url().startsWith('app://')) || null;
    }, 45000, 'starter window');
    console.log('starter url:', starter.url());
    try {
      await starter.evaluate((vaultPath) => { location.href = `obsidian://open?path=${encodeURIComponent(vaultPath)}`; }, VAULT);
    } catch (e) { console.log('navigate attempt:', e.message); }

    const page = await waitFor(async () => {
      const ctx = browser.contexts()[0];
      const pages = ctx.pages();
      for (const p of pages) {
        try {
          const name = await p.evaluate(() => (window.app && app.vault) ? app.vault.getName() : '');
          if (name === 'main') return p;
        } catch {}
      }
      return null;
    }, 60000, 'vault window');

    console.log('page url:', page.url());
    page.on('console', (m) => { const t = m.text(); if (t.length < 300) console.log('[console]', m.type(), t); });
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

    await page.waitForFunction(() => window.app && app.workspace && app.workspace.layoutReady, null, { timeout: 60000 });
    console.log('layout ready');

    // 隔离实例首开 vault 弹「信任」弹窗，受限模式不加载社区插件——DOM 原生 click 信任按钮（带轮询）
    const trusted = await (async () => {
      for (let i = 0; i < 20; i++) {
        const clicked = await page.evaluate(() => {
          const btn = [...document.querySelectorAll('.modal-container button')].find((b) => b.innerText.includes('Trust author'));
          if (btn) { btn.click(); return true; }
          return !!app.plugins.plugins['web-desk'];
        });
        if (clicked) return true;
        await sleep(1500);
      }
      return false;
    })();
    console.log('trusted/plugin-loaded:', trusted);
    await sleep(3000);

    const enabled = await page.evaluate(() => app.plugins.enabledPlugins.has('web-desk'));
    console.log('web-desk enabled in config:', enabled);
    await page.waitForFunction(() => !!app.plugins.plugins['web-desk'], null, { timeout: 30000 });
    console.log('web-desk loaded');

    await page.waitForFunction(() => !!app.commands.commands['web-desk:open-web-desk'], null, { timeout: 30000 });
    await page.evaluate(() => app.commands.executeCommandById('web-desk:open-web-desk'));
    let rootFound = false;
    for (let i = 0; i < 15 && !rootFound; i++) {
      await sleep(2000);
      try {
        rootFound = await page.evaluate(() => !!document.querySelector('.web-desk-root'));
        console.log(`poll ${i}: root=${rootFound} url=${page.url().slice(0, 60)}`);
      } catch (e) {
        console.log(`poll ${i}: page err ${e.message.slice(0, 60)}`);
      }
    }
    if (!rootFound) throw new Error('.web-desk-root never appeared');
    console.log('STEP1 view opened, root found');
    const hint = await page.locator('.web-desk-hint').isVisible();
    console.log('empty hint visible:', hint);

    // 通过命令弹框导入 example.com（走工具卡片 fallback 路由）——evaluate 方式填表提交
    await page.evaluate(() => app.commands.executeCommandById('web-desk:bookmark-url'));
    const modalReady = await (async () => {
      for (let i = 0; i < 15; i++) {
        const ok = await page.evaluate(() => {
          const modal = [...document.querySelectorAll('.modal-container .modal')].find((m) => m.innerText.includes('收藏 URL 到网页桌面'));
          return modal ? !!modal.querySelector('form input') : false;
        });
        if (ok) return true;
        await sleep(1000);
      }
      return false;
    })();
    if (!modalReady) throw new Error('import modal never appeared');
    await page.evaluate(() => {
      const modal = [...document.querySelectorAll('.modal-container .modal')].find((m) => m.innerText.includes('收藏 URL 到网页桌面'));
      const input = modal.querySelector('form input');
      input.value = 'https://example.com';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    // 索引期间 metadataCache 可能滞后，兜底直接读文件内容匹配
    const findExample = () => page.evaluate(async () => {
      for (const f of app.vault.getMarkdownFiles()) {
        if (!f.path.startsWith('收藏夹/')) continue;
        const url = app.metadataCache.getFileCache(f)?.frontmatter?.url || '';
        if (url.startsWith('https://example.com')) return f.path;
        const text = await app.vault.cachedRead(f);
        if (text.includes('https://example.com')) return f.path;
      }
      return null;
    });
    let filePath = null;
    for (let i = 0; i < 25 && !filePath; i++) {
      await sleep(2000);
      filePath = await findExample();
      if (!filePath) {
        const diag = await page.evaluate(() => ({
          modals: [...document.querySelectorAll('.modal-container .modal')].map((m) => m.innerText.slice(0, 40)),
          notices: [...document.querySelectorAll('.notice')].map((n) => n.innerText.slice(0, 100)),
          folderExists: !!app.vault.getAbstractFileByPath('收藏夹'),
        }));
        console.log(`wait ${i}:`, JSON.stringify(diag).slice(0, 400));
      }
    }
    if (!filePath) {
      const notices = await page.evaluate(() => [...document.querySelectorAll('.notice')].map((n) => n.innerText.slice(0, 80)));
      throw new Error('file not created; notices=' + JSON.stringify(notices));
    }
    console.log('STEP2 file created:', filePath);

    const iconReady = await (async () => {
      for (let i = 0; i < 15; i++) {
        if (await page.evaluate(() => document.querySelectorAll('.web-desk-icon').length > 0)) return true;
        await sleep(1500);
      }
      return false;
    })();
    if (!iconReady) throw new Error('icon never appeared');
    console.log('STEP3 icon on canvas');

    const readDesk = (fp) => page.evaluate(async (p) => {
      const f = app.vault.getAbstractFileByPath(p);
      const fm = app.metadataCache.getFileCache(f)?.frontmatter;
      if (fm) return fm;
      const text = await app.vault.cachedRead(f);
      const grab = (k) => { const m = text.match(new RegExp('^' + k + ':\\s*(.+)$', 'm')); return m ? m[1].trim().replace(/^"|"$/g, '') : undefined; };
      return { title: grab('title'), url: grab('url'), type: grab('type'), desk_x: Number(grab('desk_x')), desk_y: Number(grab('desk_y')) };
    }, fp);
    const fm1 = await readDesk(filePath);
    console.log('frontmatter after import:', JSON.stringify(fm1));

    // 拖拽测试：图标移 150,100
    const box = await page.evaluate((fp) => {
      const el = document.querySelector(`.web-desk-icon[data-path="${fp}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }, filePath);
    if (!box) throw new Error('no icon box for ' + filePath);
    // 合成 PointerEvent 拖拽（playwright 原生鼠标事件在此环境不可达）
    const dragResult = await page.evaluate((fp) => {
      const el = document.querySelector(`.web-desk-icon[data-path="${fp}"]`);
      if (!el) return { error: 'no el' };
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const mk = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
        clientX: x, clientY: y, button: 0, buttons: 1, isPrimary: true,
      }));
      mk('pointerdown', cx, cy);
      for (let i = 1; i <= 10; i++) {
        mk('pointermove', cx + 150 * i / 10, cy + 100 * i / 10);
      }
      mk('pointerup', cx + 150, cy + 100);
      return { styleAfter: el.getAttribute('style') };
    }, filePath);
    console.log('synthetic drag done:', JSON.stringify(dragResult));
    await sleep(600);
    const after = await page.evaluate((fp) => ({
      style: document.querySelector(`.web-desk-icon[data-path="${fp}"]`)?.getAttribute('style'),
      notices: [...document.querySelectorAll('.notice')].map((n) => n.innerText.slice(0, 100)),
    }), filePath);
    console.log('after drag:', JSON.stringify(after));
    await sleep(1500);
    const fm2 = await readDesk(filePath);
    console.log('frontmatter after drag:', JSON.stringify({ x: fm2.desk_x, y: fm2.desk_y }));
    const moved = typeof fm2.desk_x === 'number' && Math.abs(fm2.desk_x - fm1.desk_x) > 100;
    console.log('STEP4 drag persisted:', moved);

    // 工具条存在
    const toolbar = await page.evaluate(() => !!document.querySelector('.web-desk-toolbar'));
    console.log('STEP5 toolbar present:', toolbar);

    try { await page.screenshot({ path: '/Users/yytyyf/projects/obsidian-web-desk/scratch/smoke-1.png' }); } catch (e) { console.log('screenshot skipped:', e.message.slice(0, 50)); }

    // 清理：收藏夹内全部测试文件移入回收站
    await page.evaluate(async () => {
      for (const f of app.vault.getMarkdownFiles().filter((f) => f.path.startsWith('收藏夹/'))) {
        await app.vault.trash(f, false);
      }
    });
    await sleep(1200);
    const iconCount = await page.evaluate(() => document.querySelectorAll('.web-desk-icon').length);
    console.log('STEP6 cleanup, icon count after trash:', iconCount);

    await browser.close();
    console.log('ALL SMOKE CHECKS DONE');
  } finally {
    obsidian.kill('SIGTERM');
    setTimeout(() => { try { obsidian.kill('SIGKILL'); } catch {} }, 3000).unref();
  }
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
