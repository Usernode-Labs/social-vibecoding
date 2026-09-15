// The app menu's "Add to Home Screen" row (#1508).
//
// Per-app home-screen install has three parts: the manifest and the page
// (tests/app-install-manifest.test.js, tests/app-install-route.test.js), the
// server mount that puts them in front of the SPA catch-all, and this row,
// which is the only way a person finds the page. Pinned here:
//
//  - the row renders only while an app is current, and even then ships
//    hidden with a constant className: the prerender has no app, so the
//    first client render matches it, and whether the device has a home
//    screen at all is read in an effect and applied through the classList
//    seam, never a rendered class;
//  - it points at /app/<slug>/install, and how it opens follows the host:
//    the native bridge's openExternal, a new window from a standalone
//    shell, the anchor itself everywhere else;
//  - server.js mounts the routes after authMiddleware and before the
//    catch-all, and dapp.json declares the check that renders the page.
//
// Run with: node --test tests/app-install-sheet-row.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const SERVER = read('server.js');

const ui = loadTsx('tests/fixtures/app-context-sheet-api.ts');
const initialImprove = { ...ui.improveStore.get() };
const renderSheet = (patch) => {
  ui.improveStore.set({ ...initialImprove, ...patch });
  try {
    return renderToHtml(createElement(ui.AppsSwitcherSheet));
  } finally {
    ui.improveStore.set(initialImprove);
  }
};

// ── What renders ────────────────────────────────────────────────────

test('with no app current there is no row, which is what the prerender ships', () => {
  const html = renderSheet({ slug: null });
  assert.doesNotMatch(html, /app-context-add-to-home/);
  assert.doesNotMatch(html, /Add to Home Screen/);
  assert.doesNotMatch(html, /This app/);
  // The platform rows are untouched by its absence.
  assert.match(html, /id="switcher-row-home"/);
});

test('with an app current the row is there, hidden, pointing at its install page', () => {
  const html = renderSheet({ slug: 'recipe-box' });
  const at = html.indexOf('id="app-context-add-to-home"');
  assert.ok(at !== -1, 'the row is rendered');
  // The wrapper (label + row) ships hidden; the effect reveals it on a phone.
  const before = html.slice(html.lastIndexOf('<div class="hidden">', at), at);
  assert.ok(before.length > 0 && before.length < 400, 'the row sits inside a hidden wrapper');
  assert.match(before, /This app/, 'under its own group label');
  const row = html.slice(at, html.indexOf('</a>', at));
  assert.match(row, /href="\/app\/recipe-box\/install"/);
  assert.match(row, /Add to Home Screen/);
  assert.doesNotMatch(row, /target=/, 'no new window until the host says so');
  // It leads the list: about the app the chip names, before the platform's
  // places.
  assert.ok(at < html.indexOf('id="switcher-row-home"'));
  // And the slug is escaped on its way into the path.
  const odd = renderSheet({ slug: 'a b' });
  assert.match(odd, /href="\/app\/a%20b\/install"/);
});

// ── How it decides, and how it opens ────────────────────────────────

test('the row is a phone thing, read from the device in an effect', () => {
  const component = SHEET.slice(SHEET.indexOf('function AddToHomeScreenRow('), SHEET.indexOf('function AppTile('));
  assert.match(component, /useState<InstallHost>\('none'\)/, 'first render: nothing offered');
  assert.match(component, /useEffect\(\(\) => \{\s*setHost\(detectInstallHost\(\)\);\s*\}, \[\]\)/,
    'the device is sampled after mount, never during render');
  assert.match(component, /useHiddenClass\(wrapRef, host === 'none'\)/,
    'and applied through the classList seam');
  assert.match(component, /<div ref=\{wrapRef\} className="hidden">/,
    'over a constant className');
  const detect = SHEET.slice(SHEET.indexOf('function detectInstallHost('), SHEET.indexOf('function AddToHomeScreenRow('));
  assert.match(detect, /isNativeApp\(\)/, 'the native app counts as a phone');
  assert.match(detect, /detectMobileOs\(navigator\.userAgent, navigator\.maxTouchPoints \|\| 0\)/,
    'the same OS test the install banner uses, iPad included');
  assert.match(detect, /isStandalone\(\)/);
});

test('native opens through the bridge, standalone in a new window, a browser in place', () => {
  const component = SHEET.slice(SHEET.indexOf('function AddToHomeScreenRow('), SHEET.indexOf('function AppTile('));
  // Native: the webview cannot leave for the system browser on its own.
  assert.match(component, /if \(host !== 'native'\) return;/);
  assert.match(component, /bridge\.openExternal!\(url\)/);
  assert.match(component, /window\.open\(url, '_blank', 'noopener'\)/, 'with window.open as the fallback');
  assert.match(component, /new URL\(href, window\.location\.origin\)\.href/, 'handing the bridge an absolute URL');
  // Standalone: the shell has no share sheet, so the page gets a window of its own.
  assert.match(component, /target=\{host === 'standalone' \? '_blank' : undefined\}/);
  // Modified clicks stay the browser's, like every other row.
  assert.match(component, /NavLink\?\.isNativeClick\?\.\(e\)\) return;/);
  assert.match(component, /AppContext\.dismissForNav\(\)/, 'the sheet closes on the way out');
});

test('MenuRow adds rel="noopener" whenever it opens a new window', () => {
  const menuRow = SHEET.slice(SHEET.indexOf('function MenuRow('), SHEET.indexOf('function detectInstallHost('));
  assert.match(menuRow, /target=\{target\}/);
  assert.match(menuRow, /rel=\{target \? 'noopener' : undefined\}/);
  assert.match(menuRow, /target\?: '_blank';/, 'and nothing but a new window');
});

test('the environment helpers are shared with the install banner, not copied', () => {
  const banner = read('frontend/src/features/mobile-install/install-banner.tsx');
  assert.match(banner, /import \{ isNativeApp, isStandalone \} from '\.\/environment';/);
  assert.doesNotMatch(banner, /function isStandalone\(/);
  assert.doesNotMatch(banner, /function isNativeApp\(/);
  assert.match(SHEET, /import \{ isNativeApp, isStandalone \} from '\.\.\/mobile-install\/environment';/);

  const env = loadTsx('frontend/src/features/mobile-install/environment.ts');
  const saved = globalThis.window;
  try {
    globalThis.window = { matchMedia: () => ({ matches: false }), navigator: {} };
    assert.equal(env.isStandalone(), false);
    assert.equal(env.isNativeApp(), false);
    globalThis.window.navigator.standalone = true;
    assert.equal(env.isStandalone(), true, 'iOS Safari reports it on navigator');
    globalThis.window = { matchMedia: () => ({ matches: true }), navigator: {}, usernode: { isNative: true } };
    assert.equal(env.isStandalone(), true);
    assert.equal(env.isNativeApp(), true);
    globalThis.window = { matchMedia: () => { throw new Error('no media'); }, navigator: {}, usernode: { isNative: 'yes' } };
    assert.equal(env.isStandalone(), false, 'a throwing matchMedia is not standalone');
    assert.equal(env.isNativeApp(), false, 'only a real true counts');
  } finally {
    if (saved === undefined) delete globalThis.window;
    else globalThis.window = saved;
  }
});

test('the label carries no em dash', () => {
  const component = SHEET.slice(SHEET.indexOf('function AddToHomeScreenRow('), SHEET.indexOf('function AppTile('));
  const code = component.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /—/);
});

// ── The server side the row depends on ──────────────────────────────

test('server.js mounts the install routes after authMiddleware and before the SPA catch-all', () => {
  assert.match(SERVER, /const \{ appInstallRoutes \} = require\('\.\/src\/routes\/app-install'\);/);
  const mount = SERVER.indexOf('app.use(appInstallRoutes(config));');
  assert.ok(mount !== -1, 'the routes are mounted');
  assert.ok(SERVER.indexOf('app.use(authMiddleware(config));') < mount, 'req.user has to be resolved first');
  assert.ok(mount < SERVER.indexOf("app.get('*', (req, res)"), 'or the catch-all serves index.html for the page');
});

test('dapp.json declares the check that renders the install page', () => {
  const dapp = JSON.parse(read('dapp.json'));
  const hit = dapp.tests.find((t) => t.path === '/app/staging-demo-admins/install');
  assert.ok(hit, 'a declared check opens the seeded app\'s install page');
  assert.equal(hit.expectSelector, '#app-install');
});
