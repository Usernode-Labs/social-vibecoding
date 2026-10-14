// #4439: an HTML spec's screens keep the stylesheets they are drawn with.
//
// Each before/after screen of an HTML spec is drawn in a frame with
// `sandbox=""` (an opaque origin of its own) whose document links the
// shell's stylesheets by URL (`frameDoc` in frontend/src/lib/spec-html.ts).
// That load is a cross-origin, cookieless request from an opaque origin, and
// it works only because nothing the platform sends stops it: no
// Cross-Origin-Resource-Policy: same-origin (helmet's default), no
// Cross-Origin-Embedder-Policy on the document, no site-wide
// Content-Security-Policy (a srcdoc frame inherits its parent's), and the
// stylesheets are served from the shell's own origin (frameDoc keeps only
// same-origin links). Break any of those and every spec screen falls back to
// browser-default HTML, with no error anywhere.
//
// Both halves below drive the REAL server: the Express app server.js
// assembles, every middleware and route in order, not listening until the
// test listens on it. A header added anywhere in that chain reaches them.
//
//   1. The header guard runs everywhere. It asks for the three stylesheets
//      at their plain and build-scoped (/b/<sha>/…) paths the way the frame
//      does, and checks the shell document's headers and links.
//   2. The browser test opens the real shell in headless Chromium, renders a
//      platform spec and a kit spec through the shell's own renderSpecHtml +
//      fitSpecFrames (window.UsernodeReact.specHtml) and reads a computed
//      style inside each sandboxed frame that only the stylesheet provides.
//      It is opt-in: it runs only when SPEC_FRAME_PLAYWRIGHT names a
//      Playwright module, or when the repository's own dependencies include
//      one. It does not reach for the worker image's global copy: the first
//      run inside the platform's unit-suite container failed all three of
//      its tests without naming them, and a browser test that cannot be
//      diagnosed there must not hold every proposal's merge gate. The
//      header guard above runs everywhere and is what protects the frames.
//
// Run with: node --test tests/spec-frame-styles.test.js
//
// test:changed: when server.js, src/services/static-cache.js, frontend/src/head.html (the headers and stylesheet links a spec frame depends on; scripts/test-changed.js)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS_PATHS = ['/usernode-native/v1/native.css', '/css/app.css', '/css/tailwind.css'];
// A build-scoped path for a build this process is not: the revalidate lane.
const OTHER_BUILD = 'b'.repeat(40);

// loadConfig() (module level in server.js) hard-exits when these are
// missing. Same preamble as tests/server-graceful-shutdown.test.js.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

const log = require('../src/services/logger');
for (const level of ['info', 'warn', 'error', 'debug']) log[level] = () => {};

// server.js's require graph schedules housekeeping timers without unref.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let app;
try {
  ({ app } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

function present(file) {
  return fs.existsSync(path.join(ROOT, 'public', file));
}

// The request a sandboxed frame makes for a <link rel="stylesheet">: no-cors,
// cross-site, from an opaque origin, without the shell's cookies.
function frameStyleRequest(url) {
  return fetch(url, {
    headers: {
      accept: 'text/css,*/*;q=0.1',
      'sec-fetch-dest': 'style',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-site': 'cross-site',
      origin: 'null',
    },
    redirect: 'manual',
  });
}

function assertLoadableFromOpaqueFrame(res, url, built) {
  if (built) {
    assert.equal(res.status, 200, `${url} answered ${res.status} to a sandboxed frame's stylesheet request`);
    assert.match(res.headers.get('content-type') || '', /^text\/css\b/, `${url} must be served as text/css`);
  }
  const corp = res.headers.get('cross-origin-resource-policy');
  assert.ok(!corp || corp.trim().toLowerCase() === 'cross-origin',
    `${url} carries Cross-Origin-Resource-Policy: ${corp}. A spec screen's frame has an opaque origin, `
    + 'so anything but cross-origin blocks this stylesheet there and every spec screen loses its styling (#4439). '
    + 'Exempt the shell stylesheets, or set cross-origin on them.');
}

test('the shell stylesheets load for a sandboxed, opaque-origin frame', async () => {
  for (const cssPath of CSS_PATHS) {
    // tailwind.css is built by `npm run build:css`; the test script's preflight
    // builds only the document. Unbuilt, its 404 still passes every global
    // header middleware, so the CORP rule is checked on it all the same.
    const built = present(cssPath.slice(1));
    for (const url of [`${base}${cssPath}`, `${base}/b/${OTHER_BUILD}${cssPath}`]) {
      const res = await frameStyleRequest(url);
      await res.arrayBuffer();
      assertLoadableFromOpaqueFrame(res, url, built);
    }
  }
});

test('the shell document sends no policy that would stop its spec frames styling', async () => {
  const res = await fetch(`${base}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  const html = await res.text();
  assert.equal(res.status, 200);
  const coep = res.headers.get('cross-origin-embedder-policy');
  assert.ok(!coep || /^unsafe-none\b/i.test(coep.trim()),
    `The shell document sends Cross-Origin-Embedder-Policy: ${coep}. Its spec frames' stylesheets carry no CORP, `
    + 'so they would be blocked and every spec screen would lose its styling (#4439).');
  // A srcdoc frame inherits its parent's policy, on top of its own. A
  // Report-Only policy cannot block anything, so only an enforcing one counts.
  const cspAdvice = 'Spec screens\' sandboxed srcdoc frames inherit it. If a CSP is added on purpose, it must allow '
    + 'the frame stylesheets (style-src for the shell origin, loaded from an opaque-origin srcdoc frame), and this '
    + 'test should be updated to assert that instead (the browser test below renders a spec under it) (#4439).';
  assert.equal(res.headers.get('content-security-policy'), null,
    `The shell document sends Content-Security-Policy: ${res.headers.get('content-security-policy')}. ${cspAdvice}`);
  assert.doesNotMatch(html, /<meta[^>]+http-equiv=["']?content-security-policy["'\s>]/i,
    `The shell document declares a Content-Security-Policy in a <meta>. ${cspAdvice}`);

  // frameDoc keeps only the stylesheet links on the document's own origin.
  const hrefs = [...html.matchAll(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => (m[0].match(/\bhref=["']([^"']+)["']/i) || [])[1])
    .filter(Boolean);
  for (const cssPath of CSS_PATHS) {
    const href = hrefs.find((h) => h === cssPath || /^\/b\/[^/]+\//.test(h) && h.endsWith(cssPath));
    assert.ok(href, `The shell document no longer links ${cssPath} from its own origin (links: ${hrefs.join(', ')}). `
      + 'Spec screens take their stylesheets from the document\'s same-origin links, so they would draw unstyled (#4439).');
  }
});

// ── The browser half ────────────────────────────────────────────────────────

function playwrightPath() {
  const candidates = [process.env.SPEC_FRAME_PLAYWRIGHT, 'playwright', 'playwright-core'];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try { return require.resolve(candidate); } catch { /* next */ }
  }
  return null;
}

async function launchChromium() {
  const pw = playwrightPath();
  if (!pw) return { skip: 'Playwright is not installed (set SPEC_FRAME_PLAYWRIGHT to a playwright module to run it)' };
  const { chromium } = require(pw);
  const options = { headless: true, args: ['--no-sandbox'] };
  if (process.env.SPEC_FRAME_CHROMIUM) options.executablePath = process.env.SPEC_FRAME_CHROMIUM;
  let firstError;
  for (const extra of options.executablePath ? [{}] : [{ channel: 'chromium' }, {}]) {
    try { return { browser: await chromium.launch({ ...options, ...extra }) }; } catch (err) { firstError ||= err; }
  }
  // The whole launch error, so a broken browser in the unit container is
  // visible in the run's output rather than a silent skip.
  const message = String((firstError && firstError.message) || firstError).replace(/\s+/g, ' ').trim().slice(0, 600);
  return { skip: `Chromium will not launch here: ${message}` };
}

// One screen whose markup carries a probe for each stylesheet. Each class is
// one only that stylesheet defines; the frames' own FRAME_CSS styles none of
// them.
function specSource(styles) {
  return `<article data-spec data-spec-styles="${styles}"><h1>Frame styles</h1>
<figure data-screens><ol data-changes><li data-change="1">A probe for each stylesheet</li></ol>
<template data-screen data-size="desktop">
  <div style="padding:40px">
    <button id="probe-app" class="dev-ws-place" type="button" data-change="1">Place</button>
    <div id="probe-tailwind" class="rounded-[20px]">Card</div>
    <div id="probe-native" class="un-swipe-action">Action</div>
  </div>
</template></figure></article>`;
}

async function renderAndRead(page, styles) {
  const before = new Set(page.frames());
  await page.evaluate(({ source, key }) => {
    document.getElementById('spec-frame-test')?.remove();
    const host = document.createElement('div');
    host.id = 'spec-frame-test';
    host.style.cssText = 'position:fixed;inset:0 auto auto 0;width:900px;z-index:2147483647;background:#fff';
    const doc = window.UsernodeReact.specHtml.render(source, { key });
    host.innerHTML = doc.html;
    document.body.appendChild(host);
    window.UsernodeReact.specHtml.fit(host);
  }, { source: specSource(styles), key: `frame-styles-${styles}` });

  const count = await page.locator('#spec-frame-test iframe[sandbox=""][srcdoc]').count();
  assert.ok(count >= 1, `renderSpecHtml + fitSpecFrames loaded no sandboxed frame for a ${styles} spec`);
  // Each frame's own document, once its stylesheets have loaded (or failed).
  let frames = [];
  for (let i = 0; i < 100 && frames.length < count; i += 1) {
    frames = page.frames().filter((f) => !before.has(f) && f.url() === 'about:srcdoc');
    if (frames.length < count) await page.waitForTimeout(50);
  }
  assert.equal(frames.length, count, `expected ${count} spec frames, found ${frames.length}`);
  const results = [];
  for (const frame of frames) {
    await frame.waitForLoadState('load');
    results.push(await frame.evaluate(() => {
      const css = (id) => getComputedStyle(document.getElementById(id));
      return {
        side: document.documentElement.getAttribute('data-side'),
        links: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => new URL(l.href).pathname),
        sheets: document.styleSheets.length,
        appHeight: css('probe-app').height,
        appDisplay: css('probe-app').display,
        tailwindRadius: css('probe-tailwind').borderTopLeftRadius,
        nativeMinWidth: css('probe-native').minWidth,
      };
    }));
  }
  return results;
}

test('a spec screen is drawn with its stylesheets inside the sandboxed frame', async (t) => {
  const { browser, skip } = await launchChromium();
  if (skip) { t.skip(skip); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.UsernodeReact && window.UsernodeReact.specHtml
      && window.AppView && typeof window.AppView._shotsViewerHtml === 'function', null, { timeout: 30000 });

    const unstyled = 'A computed style only the stylesheet provides is missing inside the spec frame: '
      + 'the sandboxed (opaque-origin) frame could not load it. A CORP/COEP header, a CSP on the shell, '
      + 'or a stylesheet moved to another host strips every spec screen (#4439).';

    const tailwindBuilt = present('css/tailwind.css');
    await t.test('platform spec: the shell\'s three stylesheets', async (st) => {
      if (!tailwindBuilt) st.diagnostic('public/css/tailwind.css is not built (npm run build:css): its computed-style check is skipped');
      const frames = await renderAndRead(page, 'platform');
      for (const f of frames) {
        assert.ok(f.links.some((p) => p.endsWith('/css/app.css')), `the ${f.side} frame links no app.css: ${f.links}`);
        // .dev-ws-place (app.css, a row of a project's places list, #4417) is a
        // 40px flex button; a bare button is neither.
        assert.equal(f.appHeight, '40px', `${unstyled} (app.css, ${f.side})`);
        assert.equal(f.appDisplay, 'flex', `${unstyled} (app.css, ${f.side})`);
        // .un-swipe-action (native.css) has min-width 80px; a bare div has auto.
        assert.equal(f.nativeMinWidth, '80px', `${unstyled} (native.css, ${f.side})`);
        if (tailwindBuilt) {
          assert.equal(f.tailwindRadius, '20px', `${unstyled} (tailwind.css, ${f.side})`);
        }
      }
    });

    await t.test('kit spec: the native UI kit alone', async () => {
      const frames = await renderAndRead(page, 'kit');
      for (const f of frames) {
        assert.equal(f.nativeMinWidth, '80px', `${unstyled} (native.css, ${f.side})`);
        // A kit screen gets the native kit only, never the shell's own sheets.
        assert.notEqual(f.appHeight, '40px', `a kit spec's ${f.side} frame was drawn with app.css`);
        assert.ok(f.links.every((p) => p.endsWith('/usernode-native/v1/native.css')), `kit frame links: ${f.links}`);
      }
    });
  } finally {
    await browser.close();
  }
});
