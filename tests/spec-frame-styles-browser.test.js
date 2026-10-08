'use strict';

// #4439: an HTML spec's before/after screens are drawn in sandboxed frames
// (sandbox="", an opaque origin) that borrow the site's stylesheets by URL
// (frameDoc in frontend/src/lib/spec-html.ts). That works today only because
// nothing the site sends stops an opaque-origin document from loading
// /css/app.css, /css/tailwind.css and /usernode-native/v1/native.css: no
// Cross-Origin-Resource-Policy, no Cross-Origin-Embedder-Policy, no site-wide
// CSP on the shell, and the stylesheets on this same origin. A security-
// headers middleware with its defaults, a site-wide CSP (which a srcdoc frame
// inherits), or a move of the stylesheets to another host (the same-origin
// filter in frameDoc keeps only those) would strip every spec's screens to
// unstyled browser defaults — silently, with no test failing. It happened on
// a host other than Homeroom, where the same document and the same viewer
// code rendered unstyled.
//
// This suite renders real spec screens through a real Chromium and asserts,
// inside each frame, computed styles only the stylesheets can produce. The
// page is served by the server's real express app (`app` on server.js's
// test-only module.exports), so a middleware added ahead of the static
// handlers — and the static handlers themselves (src/services/static-cache.js)
// — are exercised exactly as a browser meets them. Every style is compared
// with the same markup drawn in a sibling frame with NO stylesheet, never
// with hard-coded values.
//
// It covers both kinds of spec: the platform's own (data-spec-styles="platform",
// all three stylesheets) and every other app's ("kit", native.css only), each
// with the plain stylesheet addresses a checkout serves and the build-scoped
// /b/<sha>/… addresses a deployed document serves (scripts/shell-stamp.js —
// the kit filter in frameDoc must see through that prefix).
//
// Needs Playwright with a Chromium it can launch. Skipped, with the reason,
// where they are not installed — the same way tests/bench-capture-run.test.js
// behaves.
//
// Run with: node --test tests/spec-frame-styles-browser.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const ROOT = path.join(__dirname, '..');
const requireFromRoot = createRequire(path.join(ROOT, 'package.json'));

// The shell's stylesheets. A checkout serves these at their plain paths; a
// deployed document names them build-scoped (buildScopedAssetUrl).
const STYLESHEETS = [
  '/usernode-native/v1/native.css',
  '/css/app.css',
  '/css/tailwind.css',
];

// What each probe asserts, and the one computed style only the stylesheet
// can produce. The baseline frame carries the same markup with no links, so
// "differs from baseline" means "a stylesheet reached the frame".
const PROBES = {
  // app.css styles .dev-ws-ctab with height: 40px; a bare button is shorter.
  app: { selector: '[data-probe="app"]', prop: 'height', sheet: 'app.css' },
  // A Tailwind utility only the compiled stylesheet defines.
  tailwind: { selector: '[data-probe="tailwind"]', prop: 'background-color', sheet: 'tailwind.css' },
  // native.css rounds .un-group with --un-radius-card (12px).
  kit: { selector: '[data-probe="kit"]', prop: 'border-top-left-radius', sheet: 'native.css' },
};

// Which probe must differ from the baseline for which kind of spec. A kit
// frame must NOT get the platform's own stylesheets — that is asserted by
// the app and tailwind probes staying AT the baseline there.
const EXPECTATIONS = {
  platform: { app: 'differs', tailwind: 'differs', kit: 'differs' },
  kit: { app: 'equals', tailwind: 'equals', kit: 'differs' },
};

// The probes' markup, as one spec screen carries it and the baseline frame
// repeats it. Shared by the page evaluate below through its argument.
const PROBE_MARKUP = '<div><button class="dev-ws-ctab" data-probe="app">Workshop</button>'
  + '<div class="bg-violet-500" data-probe="tailwind"></div>'
  + '<div class="un-group" data-probe="kit">Row</div></div>';

// A small HTML spec whose one screen carries the three probes. The changes
// list names the kind, so each rendered frame's title says which spec it is
// ("Before: Platform probes" / "After (planned): Platform probes").
function specSource(kind) {
  return `<article data-spec data-spec-styles="${kind}"><h1>Probes</h1>`
    + `<section data-spec-tab="user"><p>See it.</p>`
    + `<figure data-screens><ol data-changes><li data-change="1">${kind === 'platform' ? 'Platform' : 'Kit'} probes</li></ol>`
    + `<template data-screen><div data-change="1">${PROBE_MARKUP}</div></template></figure></section>`
    + `<section data-spec-tab="tech"><p>Build it.</p></section></article>`;
}

function playwrightPath() {
  for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core',
    '/opt/node-tools/node_modules/playwright',
    '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright']) {
    if (!candidate) continue;
    try { return requireFromRoot.resolve(candidate); } catch { /* next */ }
  }
  return null;
}

function buildViewerBundle() {
  // The browser half of the specs, bundled the way tests/browser/*.mjs
  // bundles its seams: real source, one IIFE, on a window key.
  const esbuildPath = path.join(ROOT, 'frontend/node_modules/esbuild');
  if (!fs.existsSync(esbuildPath)) return null;
  const { buildSync } = require(esbuildPath);
  const entry = 'import { renderSpecHtml, fitSpecFrames } from "./src/lib/spec-html";\n'
    + 'window.__specTest = { renderSpecHtml, fitSpecFrames };\n';
  return buildSync({
    stdin: { contents: entry, resolveDir: path.join(ROOT, 'frontend'), sourcefile: 'spec-test-entry.js', loader: 'js' },
    bundle: true,
    write: false,
    format: 'iife',
  }).outputFiles[0].text;
}

// ── Reading a sandboxed frame with scripts off ───────────────────────────
//
// The frames are opaque-origin and scriptless, so the page cannot reach into
// them. A CDP session can: the pierced DOM tree carries each srcdoc frame's
// content document, and the CSS domain answers computed styles for its nodes.

function collectFrames(node, out) {
  if (!node) return;
  if (node.nodeName === 'IFRAME') {
    const attrs = Array.isArray(node.attributes) ? node.attributes : [];
    const attr = (name) => {
      const at = attrs.indexOf(name);
      return at >= 0 && at + 1 < attrs.length ? attrs[at + 1] : null;
    };
    const docNode = node.contentDocument
      || (node.children || []).find((child) => child.nodeType === 9)
      || null;
    out.push({
      title: attr('title'),
      // The stylesheet links frameDoc wrote into this frame's srcdoc. Empty
      // means frameDoc filtered them all out — as a move to an asset host
      // would.
      links: [...((attr('data-srcdoc') || '').matchAll(/<link rel="stylesheet" href="([^"]*)">/g))].map((m) => m[1]),
      docNodeId: docNode ? docNode.nodeId : null,
    });
  }
  for (const child of node.children || []) collectFrames(child, out);
}

async function readFrames(cdp) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const frames = [];
  collectFrames(root, frames);
  for (const frame of frames) {
    frame.styles = {};
    if (!frame.docNodeId) continue;
    for (const [name, probe] of Object.entries(PROBES)) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: frame.docNodeId, selector: probe.selector });
      if (!nodeId) { frame.styles[name] = null; continue; }
      const computed = await cdp.send('CSS.getComputedStyleForNode', { nodeId });
      const hit = computed.computedStyle.find((p) => p.name === probe.prop);
      frame.styles[name] = hit ? hit.value : null;
    }
  }
  return frames;
}

function kindSatisfied(frames, kind) {
  const base = frames.find((f) => f.title === 'baseline');
  const specFrames = frames.filter((f) => f.title && f.title !== 'baseline');
  if (!base || specFrames.length < 2) return false;
  return specFrames.every((frame) => Object.entries(EXPECTATIONS[kind]).every(([probe, want]) => {
    const value = frame.styles[probe];
    const baseValue = base.styles[probe];
    if (value == null || baseValue == null) return false;
    return want === 'differs' ? value !== baseValue : value === baseValue;
  }));
}

test('spec screens stay styled through the real server: platform gets every stylesheet, kit gets only the kit', { timeout: 240000 }, async (t) => {
  // ── Prerequisites: Playwright with a Chromium it can launch ───────────
  const pw = playwrightPath();
  if (!pw) { t.skip('Playwright is not installed'); return; }
  let browser;
  try {
    browser = await require(pw).chromium.launch({
      executablePath: process.env.BROWSER_EXECUTABLE || undefined,
      headless: true,
      args: ['--no-sandbox'],
    });
  } catch (err) {
    t.skip(`Chromium will not launch here: ${String(err.message).split('\n')[0]}`);
    return;
  }
  t.after(() => browser.close());

  // ── Artifacts: the compiled stylesheets this test reads ───────────────
  // pretest only builds the HTML; the runtime preflight also compiles the
  // Tailwind stylesheet and is idempotent.
  const ensured = spawnSync(process.execPath, ['scripts/ensure-shell-artifacts.js', '--runtime'], { cwd: ROOT });
  assert.equal(ensured.status, 0, `the shell artifacts could not be built: ${ensured.stderr && ensured.stderr.toString()}`);
  const tailwindCss = fs.readFileSync(path.join(ROOT, 'public/css/tailwind.css'), 'utf8');
  assert.ok(tailwindCss.includes('.bg-violet-500'),
    'the Tailwind probe class is in the compiled stylesheet (a setup problem, not the regression)');

  // ── Server: the real app, the real middleware, no cookies ─────────────
  // server.js only boots when run as the entry point, so requiring it
  // exposes the app without starting anything. Timers registered at require
  // time are unref'd so they cannot hold the test process open.
  process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
  process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
  require('./platform-keys').setPlatformKeys();
  const origSetInterval = global.setInterval;
  const origSetTimeout = global.setTimeout;
  global.setInterval = (...a) => { const tick = origSetInterval(...a); if (tick && tick.unref) tick.unref(); return tick; };
  global.setTimeout = (...a) => { const tick = origSetTimeout(...a); if (tick && tick.unref) tick.unref(); return tick; };
  let app;
  try {
    ({ app } = require('../server'));
  } finally {
    global.setInterval = origSetInterval;
    global.setTimeout = origSetTimeout;
  }
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections && server.closeAllConnections();
    server.close(() => resolve());
  }));
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // The build-scoped addresses a deployed document serves. The sha need not
  // be this process's build: the handler answers either way, and what the
  // test exercises is the URL shape frameDoc must see through.
  const { buildScopedAssetUrl } = require('../scripts/shell-stamp');
  const TEST_SHA = 'a'.repeat(40);
  const scopedHrefs = Object.fromEntries(STYLESHEETS.map((p) => [p, new URL(buildScopedAssetUrl(p, TEST_SHA), origin).href]));

  // ── The page: the real document, its stylesheets, almost no scripts ───
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  const styleResponses = [];
  const failedRequests = [];
  page.on('response', (res) => {
    if (res.request().resourceType() === 'stylesheet') {
      styleResponses.push({ url: res.url(), status: res.status(), corp: res.headers()['cross-origin-resource-policy'] || null });
    }
  });
  page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), error: req.failure() && req.failure().errorText }));
  // Abort the shell's scripts so nothing boots or hydrates over the test's
  // nodes — EXCEPT the vendored DOMPurify (the prose sanitiser renderSpecHtml
  // needs) and app-view.js (the before/after viewer builder it renders the
  // screens with). Both load from the real server, like the stylesheets do.
  // Stylesheets and the document load normally, through every real
  // middleware and header the site sends. page.evaluate stays possible (it
  // is not subject to the page's CSP), so the harness keeps working even if
  // a site-wide CSP is one day added — which is exactly the change this test
  // exists to catch.
  await page.route('**/*', (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.endsWith('.js') && p !== '/vendor/purify-3.4.4.min.js' && p !== '/js/app-view.js') return route.abort();
    return route.continue();
  });
  const response = await page.goto(`${origin}/`, { waitUntil: 'load' });
  assert.equal(response.status(), 200, 'the shell document is served');
  const documentHeaders = response.headers();

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');

  const bundle = buildViewerBundle();
  if (!bundle) { t.skip('frontend/node_modules/esbuild is not installed, so the viewer bundle cannot be built'); return; }
  await page.evaluate(bundle);

  // ── Each variant: plain paths and build-scoped paths ──────────────────
  const failures = [];
  for (const variant of [{ name: 'plain paths', scoped: false }, { name: 'build-scoped paths', scoped: true }]) {
    if (variant.scoped) {
      // Byte for byte what a deployed document's head carries.
      await page.evaluate((hrefs) => {
        for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
          const pathname = new URL(link.href).pathname;
          if (hrefs[pathname]) link.setAttribute('href', hrefs[pathname]);
        }
      }, scopedHrefs);
    }

    for (const kind of ['platform', 'kit']) {
      // Render the spec and load its frames. The screen goes into a
      // 1280px-wide container so the desktop frame lays out at its real
      // size. The baseline — the same three probes in a sibling sandboxed
      // frame with the same content security policy and NO stylesheet — is
      // rendered once and reused for every comparison.
      await page.evaluate(({ source, probeMarkup, key }) => {
        const previous = document.getElementById('spec-test-stage');
        if (previous) previous.remove();
        // A key per variant: renderSpecHtml caches by key and source, and the
        // cached markup must be the one built from THIS variant's links.
        const doc = window.__specTest.renderSpecHtml(source, { key });
        const stage = document.createElement('div');
        stage.id = 'spec-test-stage';
        stage.style.width = '1280px';
        stage.innerHTML = doc.userHtml;
        document.body.appendChild(stage);
        window.__specTest.fitSpecFrames(stage);
        if (!document.getElementById('spec-test-baseline')) {
          const csp = `default-src 'none'; style-src 'unsafe-inline' ${location.origin}; img-src data: ${location.origin}; font-src data: ${location.origin}`;
          const base = document.createElement('iframe');
          base.id = 'spec-test-baseline';
          base.setAttribute('sandbox', '');
          base.setAttribute('referrerpolicy', 'no-referrer');
          base.title = 'baseline';
          base.srcdoc = `<!doctype html><html><head><meta charset="utf-8">`
            + `<meta http-equiv="Content-Security-Policy" content="${csp}"></head>`
            + `<body>${probeMarkup}</body></html>`;
          document.body.appendChild(base);
        }
      }, { source: specSource(kind), probeMarkup: PROBE_MARKUP, key: `spec-frame-styles-${variant.scoped ? 'scoped' : 'plain'}` });

      // Wait for the stylesheets to land inside the frames — up to 10
      // seconds — then assert on the last read either way.
      let frames = null;
      const deadline = Date.now() + 10000;
      for (;;) {
        frames = await readFrames(cdp);
        if (kindSatisfied(frames, kind) || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const detail = `\n  variant: ${variant.name}`
        + `\n  spec kind: ${kind}`
        + `\n  document headers: ${JSON.stringify({
          'cross-origin-resource-policy': documentHeaders['cross-origin-resource-policy'] || null,
          'cross-origin-embedder-policy': documentHeaders['cross-origin-embedder-policy'] || null,
          'content-security-policy': documentHeaders['content-security-policy'] || null,
        })}`
        + `\n  stylesheet responses: ${JSON.stringify(styleResponses)}`
        + `\n  failed requests: ${JSON.stringify(failedRequests)}`
        + `\n  frames: ${JSON.stringify(frames, null, 2)}`;

      const base = frames.find((f) => f.title === 'baseline');
      assert.ok(base, `the baseline frame is on the page (${variant.name})${detail}`);
      const specFrames = frames.filter((f) => f.title && f.title !== 'baseline');
      assert.ok(specFrames.length >= 2, `both sides of the screen rendered (${variant.name}, ${kind})${detail}`);
      for (const frame of specFrames) {
        for (const [probe, want] of Object.entries(EXPECTATIONS[kind])) {
          const probeSpec = PROBES[probe];
          const value = frame.styles[probe];
          const baseValue = base.styles[probe];
          assert.ok(value != null, `probe ${probe} found in the frame "${frame.title}" (${variant.name})${detail}`);
          if (want === 'differs') {
            assert.notEqual(value, baseValue,
              `${probeSpec.sheet} did not reach the frame "${frame.title}" (${variant.name}): `
              + `${probeSpec.prop} is ${value}, the unstyled baseline is ${baseValue}${detail}`);
          } else {
            assert.equal(value, baseValue,
              `the frame "${frame.title}" (${variant.name}) got ${probeSpec.sheet}, which a ${kind} spec's screens must not${detail}`);
          }
        }
      }
    }
  }
});
