// A spec's before/after screens keep their styles, in a real browser.
//
// Run with PLAYWRIGHT_MODULE and BROWSER_EXECUTABLE pointing to installed
// tools; generated shell outputs are materialized first when missing:
//
//   PLAYWRIGHT_MODULE=/path/to/playwright-core \
//   BROWSER_EXECUTABLE=/path/to/chrome \
//   node tests/browser/spec-frame-styles.mjs
//
// Why: each screen of an HTML spec is drawn in a sandboxed frame
// (`sandbox=""`, an opaque origin) that links the site's stylesheets by URL
// (frameDoc in frontend/src/lib/spec-html.ts). Nothing guards that those
// loads keep working: a Cross-Origin-Resource-Policy header (what a
// security-headers middleware sends by default), a site-wide CSP the srcdoc
// frames would inherit, or a move of the stylesheets to another host would
// strip every spec screen to unstyled browser defaults, with no error shown
// anywhere. tests/spec-html-viewer.test.js pins frameDoc's source text; this
// run renders the frames and checks they came out styled.
//
// What it draws: a small express app mounting exactly the static chain
// server.js mounts (precompressed assets, the build-scoped handler, then
// express.static with the same setHeaders closure over
// src/services/static-cache.js — the shared header code, so a rule added
// there reaches the run), plus one route serving a test host document with
// the shell's three stylesheet links, the vendored DOMPurify and
// public/js/app-view.js. Into the host go two small specs rendered by the
// real browser half (renderSpecHtml + fitSpecFrames, bundled from
// frontend/src/lib/spec-html.ts): one platform-flavoured
// (data-spec-styles="platform", all three stylesheets) and one
// app-flavoured ("kit", the native UI kit only). Beside them, a plain
// sandbox="" iframe per spec carrying the same markup with no stylesheets.
//
// What it asserts:
//   - every stylesheet link inside every spec frame had its load settle
//     (link.sheet set, or the load refused fast — Chromium reports a sheet
//     object even for a CORP-blocked stylesheet, so the styled reads below
//     are what catch a strip, not this wait);
//   - inside each frame, a computed style only the stylesheet can produce
//     differs from the unstyled twin read in the same run (app.css pins
//     .dev-ws-ctab's height and weight; the generated stylesheet compiles
//     .text-zinc-500; native.css pins .un-action-btn's font size);
//   - the stylesheet set per frame is what frameDoc's filter promises:
//     all three links for the platform spec, native.css alone for the kit;
//   - on the wire, each stylesheet answers 200 with no
//     Cross-Origin-Resource-Policy that would block an opaque origin.
//
// Known limit, stated plainly: the run exercises the pipeline it can execute
// — the shared static-cache.js header code, the real static bytes, and the
// whole frameDoc/sandbox chain. A security-headers middleware bolted
// directly into server.js outside that shared code would not run in this
// test's server, and no test can execute code that does not exist yet; the
// wire assertion above names the contract such a change would break.
import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
const express = require('express');
const path = require('node:path');

const root = new URL('../../', import.meta.url).pathname;
const publicDir = path.join(root, 'public');

// ── 1. Prepare the artifacts: the generated shell outputs the host needs ──
// The document must exist before the CSS build scans it, so the order is
// shell then CSS — the same order the unit suite's preflight uses.
if (!existsSync(path.join(publicDir, 'index.html'))) {
  execFileSync('node', ['scripts/ensure-shell-artifacts.js', '--html-only'], { cwd: root, stdio: 'inherit' });
}
if (!existsSync(path.join(publicDir, 'css/tailwind.css'))
  || !readFileSync(path.join(publicDir, 'css/tailwind.css'), 'utf8').includes('.text-zinc-500')) {
  execFileSync('node', ['scripts/build-tailwind.js'], { cwd: root, stdio: 'inherit' });
}

// ── 2. Serve: the same static chain server.js mounts, plus the host route ─
const {
  shellAssetCacheControl,
  buildScopedAssetHandler,
  applyShellBuildHeader,
  applyShellDocumentHeaders,
} = require(path.join(root, 'src/services/static-cache.js'));
const { precompressedAssets } = require(path.join(root, 'src/middleware/precompressed-assets.js'));

// The three stylesheet links in the shell's own order (frontend/src/head.html),
// the vendored DOMPurify the prose sanitiser reads, and app-view.js for
// AppView._shotsViewerHtml, which renderSpecHtml builds the screens into.
const hostHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="icon" href="data:,">
<link rel="stylesheet" href="/usernode-native/v1/native.css">
<link rel="stylesheet" href="/css/app.css">
<link rel="stylesheet" href="/css/tailwind.css">
<style>html,body{margin:0;padding:0}#specs{width:1100px;padding:12px}</style>
</head><body><div id="specs"></div>
<script src="/vendor/purify-3.4.4.min.js"></script>
<script src="/js/app-view.js"></script>
</body></html>`;

const app = express();
app.get('/test-host', (_req, res) => res.type('html').send(hostHtml));
app.use(precompressedAssets(publicDir));
app.use(buildScopedAssetHandler(publicDir));
app.use(express.static(publicDir, {
  setHeaders(res, filePath) {
    const cc = shellAssetCacheControl(filePath);
    if (cc) res.setHeader('Cache-Control', cc);
    if (cc && path.basename(filePath) === 'index.html') {
      applyShellDocumentHeaders(res, filePath);
    } else if (cc) {
      applyShellBuildHeader(res);
    }
  },
}));
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const origin = `http://127.0.0.1:${server.address().port}`;

// ── 3. Bundle the browser half of the spec viewer ─────────────────────────
const { buildSync } = require(path.join(root, 'frontend/node_modules/esbuild'));
const specBundle = buildSync({
  entryPoints: [path.join(root, 'frontend/src/lib/spec-html.ts')],
  bundle: true, write: false, format: 'iife',
  define: { 'process.env.NODE_ENV': '"production"' },
}).outputFiles[0].text;

// ── 4. The two small specs: the same screen markup, two stylesheet sets ───
// The probes are classes the stylesheets already define; a class that moves
// fails the run and gets its markup updated, which is the tripwire intended.
// The data-spec-kind attribute rides through cleanScreenMarkup and names the
// frame's spec from inside it.
const SCREENS = {
  platform: `<article data-spec data-spec-styles="platform"><p>A small spec whose screens draw with the shell's own stylesheets.</p>
<figure data-screens><template data-screen data-size="phone"><button type="button" class="dev-ws-ctab" data-spec-kind="platform"><span class="dev-ws-ctab-text">Needs you</span></button><span class="text-zinc-500" data-spec-kind="platform">a muted line</span></template><figcaption>One screen</figcaption></figure></article>`,
  kit: `<article data-spec data-spec-styles="kit"><p>A small spec whose screens draw with the shared native kit.</p>
<figure data-screens><template data-screen data-size="phone"><button type="button" class="un-action-btn" data-spec-kind="kit">Action</button></template><figcaption>One screen</figcaption></figure></article>`,
};
// What to read inside each frame, and what the stylesheet must make true.
const PROBES = {
  platform: [
    { selector: '.dev-ws-ctab', property: 'height', styled: '40px' },
    { selector: '.dev-ws-ctab', property: 'fontWeight', styled: '600' },
    { selector: '.text-zinc-500', property: 'color', styled: null },
  ],
  kit: [
    { selector: '.un-action-btn', property: 'fontSize', styled: null },
  ],
};
const SHELL_LINKS = ['/usernode-native/v1/native.css', '/css/app.css', '/css/tailwind.css'];
const KIT_LINKS = ['/usernode-native/v1/native.css'];

// A parent page cannot read into a sandbox="" frame — that is the point of
// the sandbox — so every read inside a frame goes through the driver's frame
// handles. The twins (no stylesheets) are told apart by data-twin, the spec
// frames by the data-spec-kind their markup carries.
const frameInfo = (frame) => frame.evaluate(() => ({
  side: document.documentElement.getAttribute('data-side') || '',
  twin: document.documentElement.getAttribute('data-twin') || '',
  kinds: [...document.querySelectorAll('[data-spec-kind]')].map((el) => el.getAttribute('data-spec-kind')),
  links: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => new URL(l.href).pathname),
  loaded: [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => !!l.sheet),
  probes: Object.fromEntries([...document.querySelectorAll('[data-spec-kind]')].map((el) => {
    const s = getComputedStyle(el);
    return [`${el.getAttribute('data-spec-kind')} ${el.className.split(/\s+/)[0]}`,
      { height: s.height, fontWeight: s.fontWeight, color: s.color, fontSize: s.fontSize }];
  })),
}));

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE, headless: true, args: ['--no-sandbox'] });
let checks = 0;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/test-host`);
  // The run needs the viewer markup AppView._shotsViewerHtml builds; without
  // it a spec degrades to a plain list and no frames exist at all.
  assert.ok(await page.evaluate(() => !!(window.AppView && typeof window.AppView._shotsViewerHtml === 'function')),
    'AppView._shotsViewerHtml did not attach — public/js/app-view.js did not run in the host document');
  await page.addScriptTag({ content: specBundle });
  assert.ok(await page.evaluate(() => !!(window.UsernodeReact && window.UsernodeReact.specHtml)),
    'the bundled spec-html did not attach to window.UsernodeReact');

  // Render both specs through the real browser half and lay the frames out.
  await page.evaluate((specs) => {
    const host = document.getElementById('specs');
    for (const [kind, source] of Object.entries(specs)) {
      const rendered = window.UsernodeReact.specHtml.render(source, { key: `spec-${kind}` });
      const box = document.createElement('div');
      box.dataset.specViewer = kind;
      box.innerHTML = rendered.html;
      host.appendChild(box);
      window.UsernodeReact.specHtml.fit(box);
    }
  }, SCREENS);
  await page.waitForFunction(() => document.querySelectorAll('#specs [data-spec-frame] iframe[srcdoc]').length >= 4, null, { timeout: 15000 });

  // Twins first: plain sandbox="" frames with the same markup, no stylesheets.
  await page.evaluate((specs) => {
    const host = document.getElementById('specs');
    for (const [kind, source] of Object.entries(specs)) {
      const markup = new DOMParser().parseFromString(source, 'text/html').querySelector('template[data-screen]').innerHTML;
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.srcdoc = `<!doctype html><html data-twin="${kind}"><head><meta charset="utf-8"></head><body>${markup}</body></html>`;
      host.appendChild(frame);
    }
  }, SCREENS);

  // Every frame has settled before anything is read: find them all (the
  // driver's frame handles reach inside a sandbox="" frame; a parent page
  // cannot), and give each frame's stylesheet loads time to settle before
  // anything is computed. A missing stylesheet still shows up here; a blocked
  // one is caught by the styled reads and the wire assertion below.
  await page.waitForTimeout(300);
  const read = [];
  for (const frame of page.frames().filter((f) => f !== page.mainFrame())) {
    let info = null;
    try {
      info = await frameInfo(frame);
    } catch { continue; } // a frame still attaching
    const pending = info.links.filter((_l, i) => !info.loaded[i]);
    if (pending.length) {
      try {
        await frame.waitForFunction(() => {
          const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
          return links.length > 0 && links.every((l) => !!l.sheet);
        }, null, { timeout: 15000 });
        info = await frameInfo(frame);
      } catch {
        assert.fail(`a stylesheet never loaded inside the ${info.side || info.twin || 'spec'} frame (blocked, or the server refused it): ${pending.join(', ')}`);
      }
    }
    read.push(info);
  }
  const byTwin = (kind) => read.find((r) => r.twin === kind);
  const specFrames = read.filter((r) => !r.twin && r.side && r.kinds.length);
  assert.equal(specFrames.length, 4, `expected the two specs' before and after frames, saw ${JSON.stringify(read.map((r) => ({ side: r.side, twin: r.twin, links: r.links })))}`);
  checks++;

  for (const info of specFrames) {
    const kind = info.kinds[0];
    const want = kind === 'platform' ? SHELL_LINKS : KIT_LINKS;
    assert.deepEqual(info.links, want, `the ${kind} ${info.side} frame's stylesheet set`);
    checks++;
    if (info.side !== 'after') continue;
    const twin = byTwin(kind);
    assert.ok(twin, `an unstyled twin for the ${kind} spec was read`);
    for (const probe of PROBES[kind]) {
      const key = `${kind} ${probe.selector.split(/\s+/)[0].slice(1)}`;
      const got = info.probes[key] && info.probes[key][probe.property];
      const base = twin.probes[key] && twin.probes[key][probe.property];
      assert.ok(got != null, `the probe ${probe.selector} rendered inside the ${kind} frame`);
      if (probe.styled != null) {
        assert.equal(got, probe.styled, `${probe.selector} ${probe.property} in the ${kind} frame`);
        assert.notEqual(base, probe.styled, `the unstyled twin's ${probe.selector} ${probe.property} must differ from the styled value`);
      } else {
        assert.notEqual(got, base, `${probe.selector} ${probe.property} in the ${kind} frame differs from its unstyled twin`);
      }
      checks++;
    }
  }

  // ── The wire: what the server actually answers for each stylesheet ──────
  for (const link of [...new Set([...SHELL_LINKS, ...KIT_LINKS])]) {
    const res = await fetch(origin + link);
    assert.equal(res.status, 200, `${link} answers 200 from the static chain`);
    const corp = res.headers.get('cross-origin-resource-policy');
    assert.ok(corp == null || corp === 'cross-origin',
      `${link} must not send a Cross-Origin-Resource-Policy that blocks an opaque origin (got ${JSON.stringify(corp)}); a spec's sandboxed frames load the site's stylesheets by URL`);
    checks++;
  }

  assert.deepEqual(errors, [], 'no uncaught page error in the host document');
  checks++;
  console.log(JSON.stringify({ checks, origin, frames: specFrames.length }, null, 2));
} finally {
  await browser.close();
  server.close();
}