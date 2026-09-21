// Run with PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE pointing to installed tools.
// Uses real shipped CSS, kit animations and PlatformUI; no application/API writes.
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const root = new URL('../../', import.meta.url).pathname;
const out = process.env.OVERLAY_EVIDENCE_DIR || '/tmp/overlay-rendering-evidence';
mkdirSync(out, { recursive: true });
const { buildSync } = require(root + 'frontend/node_modules/esbuild');
const bridge = buildSync({ entryPoints: [root + 'frontend/src/lib/overlay-scrim-bridge.ts'], bundle: true, write: false, format: 'iife' }).outputFiles[0].text;
const legacy = readFileSync(root + 'frontend/src/lib/overlay-scrim.js', 'utf8').replace(/export /g, '');
const base = process.env.OVERLAY_BASE || 'afd1f61ac644bd158bb983c1fca1db632666cd44';
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
let checks = 0;
const results = [];
try {
 for (const theme of ['light', 'dark']) for (const width of [390, 1280]) {
  for (const kind of ['rail', 'dropdown', 'sheet', 'panel', 'modal']) {
   if (process.env.OVERLAY_CASE && `${theme}-${width}-${kind}` !== process.env.OVERLAY_CASE) continue;
   for (const version of ['base', 'head']) {
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('http://overlay.test/**', async route => {
     const p = new URL(route.request().url()).pathname;
     if (p !== '/') {
      const path = 'public' + p;
      const contentType = p.endsWith('.css') ? 'text/css' : 'text/javascript';
      const body = version === 'base' && ['public/css/app.css', 'public/js/platform-ui.js'].includes(path)
       ? execFileSync('git', ['show', `${base}:${path}`], { cwd: root }) : readFileSync(root + path);
      return route.fulfill({ contentType, body });
     }
     return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="${theme === 'dark' ? 'dark' : ''}"><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/usernode-native/v1/native.css"><link rel="stylesheet" href="/css/app.css"><link rel="stylesheet" href="/css/tailwind.css"><style>body{min-height:100vh;background:linear-gradient(120deg,${theme === 'light' ? '#edb393,#adb6d8 45%,#deca87' : '#412822,#282c42 45%,#403a25'})}main{padding:90px 20px;font-size:28px;color:#927b70}section{padding:32px}input{margin:20px 0}#improve-panel,#apps-switcher-sheet{padding:32px}</style></head><body><button id="opener">Open</button><main>Homeroom<br><br>Wallpapers and text remain behind bright glass.<br><br>Another row of background content.</main><script src="/usernode-native/v1/native.js"></script><script src="/js/platform-ui.js"></script></body></html>` });
    });
    await page.goto('http://overlay.test/');
    if (version === 'head') await page.addScriptTag({ content: bridge + '\n' + legacy + '\nwindow.attachOverlayScrim=attachOverlayScrim;' });
    const isLegacy = ['rail', 'dropdown'].includes(kind);
    await page.evaluate(({ kind, isLegacy, version }) => {
     const content = '<h2>Existing frosted surface</h2><input aria-label="First" value="Keep this input"><input aria-label="Second" value="Other input"><div style="height:140px"></div>';
     document.querySelector('#opener').focus();
     if (isLegacy) {
      const id = kind === 'rail' ? 'improve-panel' : 'apps-switcher-sheet';
      document.body.insertAdjacentHTML('beforeend', `<div id="${kind === 'rail' ? 'improve-overlay' : 'apps-switcher-overlay'}" class="fixed inset-0 z-40"></div><section id="${id}" class="fixed z-50 dc-lift dc-lift-panel ${kind === 'rail' ? 'improve-panel-transition' : 'app-context-transition'}">${content}</section><div class="overlay-scrim" aria-hidden="true"></div>`);
      window.surface = document.getElementById(id);
      window.backdrop = surface.previousElementSibling;
      window.openSurface = () => { surface.dataset.open = ''; backdrop.dataset.open = ''; };
      window.closeSurface = () => { delete surface.dataset.open; delete backdrop.dataset.open; };
      backdrop.onclick = closeSurface;
      if (version === 'head') window.detach = attachOverlayScrim(surface, backdrop, surface.nextElementSibling);
      surface.getBoundingClientRect();
      openSurface();
     } else {
      const contentEl = document.createElement('section'); contentEl.innerHTML = content;
      window.handle = PlatformUI[kind]({ contentEl, onDismiss: () => { window.dismissed = true; } });
      window.surface = handle.el;
      window.closeSurface = () => handle.dismiss();
     }
    }, { kind, isLegacy, version });
    await page.waitForTimeout(800);
    const bounds = await page.evaluate(() => { const s = getComputedStyle(surface); return { ...surface.getBoundingClientRect().toJSON(), outline: [s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor], transform: s.transform }; });
    await page.screenshot({ path: `${out}/${theme}-${width}-${kind}-${version}.png` });
    writeFileSync(`${out}/${theme}-${width}-${kind}-${version}.json`, JSON.stringify(bounds));
    if (version === 'head') {
     assert.equal(await page.evaluate(() => [...document.querySelectorAll('.overlay-scrim')].filter(e => getComputedStyle(e).visibility === 'visible').length), 1); checks++;
     assert.equal(await page.evaluate(() => getComputedStyle(surface).boxShadow.includes('1280px')), false); checks++;
     assert.equal(await page.evaluate(() => {
      const hit = document.elementFromPoint(2, 2);
      return hit?.classList.contains('un-backdrop') || hit?.id.endsWith('overlay');
     }), true, 'the original dismissal backdrop keeps its hit target'); checks++;
     if (kind === 'sheet') {
      const grabber = await page.locator('.un-sheet-grabber').boundingBox();
      await page.mouse.move(grabber.x + grabber.width / 2, grabber.y + grabber.height / 2);
      await page.mouse.down();
      await page.mouse.move(grabber.x + grabber.width / 2, grabber.y + grabber.height / 2 + 60, { steps: 6 });
      await page.waitForTimeout(180);
      const drag = await page.evaluate(() => ({
       presence: Number(surface.style.getPropertyValue('--un-presence')),
       dim: Number(getComputedStyle(surface.nextElementSibling).opacity),
      }));
      assert.ok(drag.presence > 0 && drag.presence < 1);
      assert.ok(Math.abs(drag.presence - drag.dim) < .001); checks++;
      await page.mouse.up();
      await page.waitForTimeout(800);
      assert.equal(await page.locator('.un-sheet').count(), 1, 'short drag springs back'); checks++;
     }
     // Motion work must stop when settled, even though the surface remains open.
     await page.evaluate(() => { window.reads = 0; const get = surface.getBoundingClientRect.bind(surface); surface.getBoundingClientRect = () => { reads++; return get(); }; });
     await page.waitForTimeout(120);
     assert.equal(await page.evaluate(() => reads), 0, 'no idle geometry polling'); checks++;
     const input = page.getByRole('textbox', { name: 'First', exact: true });
     await input.fill('Preserved state');
     await page.getByRole('textbox', { name: 'Second', exact: true }).focus();
     // Match layout-height changes without changing any keyboard policy.
     await page.setViewportSize({ width, height: 550 });
     await page.waitForTimeout(350);
     assert.equal(await input.inputValue(), 'Preserved state'); checks++;
     await page.setViewportSize({ width, height: 860 });
     await page.waitForTimeout(350);
     // Later opaque kit dialogs must cover the decoration, just as before.
     await page.evaluate(() => { window.alertResult = PlatformUI.alert('Nested alert'); });
     await page.waitForTimeout(400);
     assert.equal(await page.locator('.un-alert button').count() > 0, true);
     await page.locator('.un-alert button').last().click();
     await page.waitForTimeout(400); checks++;
     if (isLegacy) {
      await page.evaluate(() => closeSurface());
      await page.waitForTimeout(40);
      assert.equal(await page.evaluate(() => getComputedStyle(surface).visibility), 'visible'); checks++;
      await page.evaluate(() => openSurface());
      await page.waitForTimeout(250);
      assert.equal(await input.inputValue(), 'Preserved state'); checks++;
      await page.evaluate(() => closeSurface());
      await page.waitForTimeout(260);
      assert.equal(await page.evaluate(() => getComputedStyle(surface).visibility), 'hidden'); checks++;
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.overlay-scrim')).visibility), 'hidden'); checks++;
     } else {
      if (kind === 'sheet') await page.evaluate(() => closeSurface());
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(20);
      assert.equal(await page.locator('.overlay-scrim').count(), 1, 'paint survives until kit teardown'); checks++;
      await page.waitForTimeout(800);
      assert.equal(await page.locator('.overlay-scrim').count(), 0); checks++;
      assert.equal(await page.evaluate(() => dismissed), true); checks++;
      assert.equal(await page.evaluate(() => document.activeElement.id), kind === 'sheet' ? '' : 'opener'); checks++;
     }
    }
    assert.deepEqual(errors, []); checks++;
    results.push({ theme, width, kind, version });
    await page.close();
   }
  }
 }
} finally { await browser.close(); }
writeFileSync(`${out}/results.json`, JSON.stringify({ checks, cases: results }, null, 2));
console.log(JSON.stringify({ checks, cases: results.length, evidence: out }));
