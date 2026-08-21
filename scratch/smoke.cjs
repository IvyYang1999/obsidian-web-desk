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
  // 启动前只清 example.com 测试残留（收藏夹里可能有用户真实收藏，别碰）
  const bmDir = '/Users/yytyyf/Vaults/main/收藏夹';
  if (fs.existsSync(bmDir)) {
    for (const f of fs.readdirSync(bmDir)) {
      if (!f.endsWith('.md')) continue;
      const full = bmDir + '/' + f;
      if (fs.readFileSync(full, 'utf8').includes('https://example.com')) fs.unlinkSync(full);
    }
  }
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
    const consoleBuf = [];
    page.on('console', (m) => {
      const t = m.text();
      if (t.length < 400) console.log('[console]', m.type(), t);
      if (m.type() === 'error' || m.type() === 'warning') consoleBuf.push(t.slice(0, 300));
    });
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

    await page.waitForFunction(() => window.app && app.workspace && app.workspace.layoutReady, null, { timeout: 60000 });
    console.log('layout ready');
    // 修改监听：定位拖拽后的「神秘回写者」
    await page.evaluate(() => {
      window.__wdModLog = [];
      app.vault.on('modify', (f) => {
        const entry = { t: Date.now(), path: f.path };
        window.__wdModLog.push(entry);
        console.warn('[watch-modify]', f.path);
      });
      app.metadataCache.on('changed', (f) => console.warn('[watch-changed]', f.path));
    });

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
    // 可见性断言：图标矩形必须与视口相交（V1 曾全部渲染在屏幕外而 DOM 仍在，漏检）
    const vis = await page.evaluate((fp) => {
      const root = document.querySelector('.web-desk-root').getBoundingClientRect();
      const el = document.querySelector(`.web-desk-icon[data-path="${fp}"]`);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, rootW: root.width, rootH: root.height,
               visible: r.right > root.left && r.x < root.right && r.bottom > root.top && r.y < root.bottom };
    }, filePath);
    console.log('STEP3b icon rect:', JSON.stringify(vis));
    if (!vis || !vis.visible) throw new Error('icon attached but NOT visible in viewport');

    // STEP3c: 文本框与箭头（公共 API，同渲染管线）
    const comps = await page.evaluate(async (fp) => {
      const view = app.workspace.getLeavesOfType('web-desk-view')[0].view;
      const tb = view.addTextBox(620, 260, '冒烟测试文本框');
      const arrow = view.addArrow({ kind: 'card', ref: fp }, { kind: 'textbox', ref: tb.id });
      await new Promise((r) => setTimeout(r, 300));
      const out = {
        tbEl: !!document.querySelector(`.web-desk-textbox[data-tb-id="${tb.id}"]`),
        arrowPath: !!document.querySelector('.web-desk-arrow'),
        arrowHit: !!document.querySelector('.web-desk-arrow-hit'),
        arrowId: arrow.id,
        tbId: tb.id,
      };
      // 清理（不留脏数据）
      view.removeArrow(arrow.id);
      view.removeTextBox(tb.id);
      out.tbGone = !document.querySelector(`.web-desk-textbox[data-tb-id="${tb.id}"]`);
      return out;
    }, filePath);
    console.log('STEP3c textbox+arrow:', JSON.stringify(comps));
    if (!comps.tbEl || !comps.arrowPath || !comps.arrowHit || !comps.tbGone) throw new Error('textbox/arrow assertion failed');

    // STEP3c2: 文本框真的能拖动（缺 position:absolute 时 left/top 不生效，V2 真机翻车点）
    const tbMove = await page.evaluate(async () => {
      const view = app.workspace.getLeavesOfType('web-desk-view')[0].view;
      const tb = view.addTextBox(520, 380, '拖动测试');
      await new Promise((r) => setTimeout(r, 200));
      const el = document.querySelector(`.web-desk-textbox[data-tb-id="${tb.id}"]`);
      const before = el.getAttribute('style');
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const mk = (type, x, y) => el.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse',
        clientX: x, clientY: y, button: 0, buttons: 1, isPrimary: true,
      }));
      mk('pointerdown', cx, cy);
      for (let i = 1; i <= 8; i++) mk('pointermove', cx + 120 * i / 8, cy + 60 * i / 8);
      mk('pointerup', cx + 120, cy + 60);
      await new Promise((res) => setTimeout(res, 900)); // 防抖500ms+写盘
      const after = el.getAttribute('style');
      const boxes = view.host.getTextBoxes();
      const saved = boxes.find((b) => b.id === tb.id);
      const out = { before, after, savedX: saved ? saved.x : null, moved: after !== before && saved && saved.x === 640 };
      view.removeTextBox(tb.id);
      return out;
    });
    console.log('STEP3c2 textbox draggable:', JSON.stringify(tbMove));
    if (!tbMove.moved) throw new Error('textbox drag failed: ' + JSON.stringify(tbMove));

    // STEP3d: 嵌入画布——建测试笔记，阅读模式渲染，合成 drop 导入，断言写回 md
    const embedPath = await page.evaluate(async () => {
      const content = ['# 嵌入画布冒烟', '', '```web-desk', JSON.stringify({ items: [] }), '```', ''].join('\n');
      const old = app.vault.getAbstractFileByPath('webdesk-smoke-embed.md');
      if (old) await app.vault.trash(old, false);
      const f = await app.vault.create('webdesk-smoke-embed.md', content);
      return f.path;
    });
    await page.evaluate(async (path) => {
      await app.workspace.openLinkText(path, '', false);
    }, embedPath);
    const embedReady = await (async () => {
      for (let i = 0; i < 15; i++) {
        if (await page.evaluate(() => document.querySelectorAll('.web-desk-embed').length > 0)) return true;
        await sleep(1000);
      }
      return false;
    })();
    if (!embedReady) throw new Error('embed canvas never rendered');
    console.log('STEP3d-1 embed canvas rendered');

    const dropResult = await page.evaluate(async () => {
      const embed = document.querySelector('.web-desk-embed');
      const r = embed.getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      const dt = new DataTransfer();
      dt.setData('text/uri-list', 'https://example.com');
      embed.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: cx, clientY: cy, dataTransfer: dt }));
      // 等写回（防抖500ms+processing）
      for (let i = 0; i < 15; i++) {
        await new Promise((res) => setTimeout(res, 1000));
        const f = app.vault.getAbstractFileByPath('webdesk-smoke-embed.md');
        const text = await app.vault.cachedRead(f);
        if (text.includes('https://example.com')) {
          return { written: true, iconShown: !!document.querySelector('.web-desk-embed .web-desk-icon'), text };
        }
      }
      const f = app.vault.getAbstractFileByPath('webdesk-smoke-embed.md');
      return { written: false, text: await app.vault.cachedRead(f) };
    });
    console.log('STEP3d-2 drop writeback:', dropResult.written, 'iconShown:', dropResult.iconShown);
    if (dropResult.written && !dropResult.iconShown) {
      // 写回触发重渲染，图标应出现（重查一次）
      await sleep(1500);
      const shown = await page.evaluate(() => !!document.querySelector('.web-desk-embed .web-desk-icon'));
      console.log('STEP3d-3 icon after rerender:', shown);
    }
    if (!dropResult.written) throw new Error('embed drop was not written back. block=' + dropResult.text.slice(0, 200));
    // 清理测试笔记
    await page.evaluate(async (path) => {
      const f = app.vault.getAbstractFileByPath(path);
      if (f) await app.vault.trash(f, false);
    }, embedPath);
    console.log('STEP3d-4 embed test cleaned');

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
    // 时间线探针：drag 后多个时刻读磁盘，看 380 是否落盘/何时回退
    for (const delay of [150, 500, 1200, 2500]) {
      await sleep(delay === 150 ? 150 : delay - 150);
      const probe = await page.evaluate(async (fp) => {
        const text = await app.vault.adapter.read(fp);
        const m = text.match(/^desk_x:\s*(\d+)/m);
        return m ? m[1] : 'none';
      }, filePath);
      console.log(`t+${delay}ms disk desk_x:`, probe);
    }
    await sleep(600);
    const after = await page.evaluate((fp) => ({
      style: document.querySelector(`.web-desk-icon[data-path="${fp}"]`)?.getAttribute('style'),
      notices: [...document.querySelectorAll('.notice')].map((n) => n.innerText.slice(0, 100)),
    }), filePath);
    console.log('after drag:', JSON.stringify(after));
    await sleep(1500);
    let fm2 = await readDesk(filePath);
    if (fm2.desk_x === fm1.desk_x) {
      // cache 可能滞后：等一拍再读
      await sleep(2500);
      fm2 = await readDesk(filePath);
      if (fm2.desk_x === fm1.desk_x) {
        const disk = await page.evaluate(async (fp) => {
          const f = app.vault.getAbstractFileByPath(fp);
          const text = await app.vault.adapter.read(f.path);
          const m = text.match(/^desk_x:\s*(\d+)$/m);
          return m ? Number(m[1]) : null;
        }, filePath);
        console.log('disk desk_x:', disk);
        if (disk !== null) fm2 = { ...fm2, desk_x: disk };
      }
    }
    console.log('frontmatter after drag:', JSON.stringify({ x: fm2.desk_x, y: fm2.desk_y }));
    const moved = typeof fm2.desk_x === 'number' && Math.abs(fm2.desk_x - fm1.desk_x) > 100;
    console.log('STEP4 drag persisted:', moved);
    if (!moved) {
      const modlog = await page.evaluate(() => window.__wdModLog.filter((e) => e.path.startsWith('收藏夹/')));
      console.log('MODIFY LOG (收藏夹):', JSON.stringify(modlog, null, 1));
    }
    if (!moved) console.log('CONSOLE ERRORS SO FAR:', JSON.stringify(consoleBuf, null, 1).slice(0, 2000));

    // 工具条存在
    const toolbar = await page.evaluate(() => !!document.querySelector('.web-desk-toolbar'));
    console.log('STEP5 toolbar present:', toolbar);

    try { await page.screenshot({ path: '/Users/yytyyf/projects/obsidian-web-desk/scratch/smoke-1.png' }); } catch (e) { console.log('screenshot skipped:', e.message.slice(0, 50)); }

    // 清理：只移除本次测试文件（example.com）
    await page.evaluate(async (fp) => {
      const f = app.vault.getAbstractFileByPath(fp);
      if (f) await app.vault.trash(f, false);
    }, filePath);
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
