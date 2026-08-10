// Tests for the Light / Dark / System theme mode selector (#256).
//
// Static-assertion style (cf. tests/spec-sections.test.js,
// tests/app-conventions.test.js): read the shipped source files and assert
// the wiring is present, so the feature can't silently regress.
//
// Run with: node --test tests/theme-mode.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const read = (...p) => fs.readFileSync(path.join(PUBLIC, ...p), 'utf8');

// #1079 chunk B: public/js/theme.js is gone. The module is an INLINE
// head-blocking <script> in frontend/src/head.html now, which is also where
// the old duplicate three-line no-flash guard used to sit — the module ends by
// calling apply(), so it is the guard. It could not move into the React bundle
// with the rest of chunk B: that bundle is deferred, and deciding "is this page
// dark" after the document parses means a visible light-to-dark repaint on
// every load. The assertions below are unchanged; only their source is.
const themeSrc = () => fs.readFileSync(path.join(ROOT, 'frontend/src/head.html'), 'utf8');

// login.html / register.html dropped: they're redirect stubs into the
// SPA's hash routes now (fold-auth-pages-into-SPA) — the in-SPA auth
// screens live inside index.html, which stays themed.
//
// admin.html / dashboard.html / status.html dropped for the same reason by
// #860: the seven standalone admin pages are #admin console sections now,
// and those files are redirect stubs with no theme bootstrap of their own.
// index.html is the one document left that needs one.
const THEMED_PAGES = [
  'index.html',
];

// ── Theme module contract ────────────────────────────────────────────────

test('the inline head module exposes the Theme API', () => {
  const src = themeSrc();
  assert.match(src, /window\.Theme\s*=/, 'theme.js must assign window.Theme');
  for (const fn of ['get', 'set', 'apply', 'onChange']) {
    assert.match(src, new RegExp(`function ${fn}\\b`), `theme.js must define ${fn}()`);
  }
});

test('theme.js implements the localStorage.theme storage contract', () => {
  const src = themeSrc();
  // 'light' / 'dark' stored explicitly; system removes the key.
  assert.match(src, /setItem\(\s*KEY/, 'set() must persist the key for light/dark');
  assert.match(src, /removeItem\(\s*KEY/, 'set() must remove the key for system');
  assert.match(src, /try\s*\{/, 'localStorage access must be wrapped in try/catch');
});

test('theme.js defines the three modes', () => {
  const src = themeSrc();
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(src.includes(`'${mode}'`), `theme.js must reference the '${mode}' mode`);
  }
});

test('theme.js registers prefers-color-scheme and storage listeners', () => {
  const src = themeSrc();
  assert.match(
    src,
    /matchMedia\(\s*'\(prefers-color-scheme: dark\)'\s*\)\.addEventListener\(\s*'change'/,
    'theme.js must listen for OS colour-scheme changes',
  );
  assert.match(
    src,
    /addEventListener\(\s*'storage'/,
    'theme.js must listen for cross-tab storage changes',
  );
});

// ── Per-page includes + no-flash guard ───────────────────────────────────

for (const page of THEMED_PAGES) {
  test(`${page} carries the theme module inline, before any stylesheet`, () => {
    const src = read(page);
    assert.ok(!src.includes('src="/js/theme.js"'),
      `${page} must not load a second copy from a classic tag`);
    const themeAt = src.indexOf('window.Theme =');
    assert.ok(themeAt > 0, `${page} must inline the theme module in <head>`);
    // Head-blocking and ahead of the stylesheets: the class it puts on <html>
    // has to be there before the first style that reads it is applied.
    const cssAt = src.indexOf('<link rel="stylesheet"');
    assert.ok(cssAt > 0 && themeAt < cssAt,
      `${page}'s theme module must run before the first stylesheet link`);
  });

  test(`${page} carries the inline no-flash guard`, () => {
    const src = read(page);
    // The module IS the guard: it ends by calling apply(), inline in <head>.
    const themeAt = src.indexOf('window.Theme =');
    const applyAt = src.indexOf('apply();\n', themeAt);
    assert.ok(applyAt > themeAt,
      `${page}'s inline theme module must call apply() before first paint`);
    assert.ok(src.includes("const KEY = 'theme'"),
      `${page} must contain the localStorage 'theme' storage contract`);
  });
}

// ── Drawer control markup (index.html) ───────────────────────────────────

test('index.html has the theme drawer row inside the header menu panel', () => {
  const src = read('index.html');
  const panelIdx = src.indexOf('id="header-menu-panel"');
  const rowIdx = src.indexOf('id="drawer-row-theme"');
  assert.ok(panelIdx !== -1, 'header-menu-panel missing');
  assert.ok(rowIdx !== -1, 'drawer-row-theme missing');
  assert.ok(rowIdx > panelIdx, 'drawer-row-theme must live inside the header menu panel');
});

// The theme selector was the LAST row in the drawer until the header
// slim-down promoted it to the first thing in the menu body — above the
// build/kudos status pane and above every navigation row. Position is
// the whole point of that change, so pin it here: a later edit that
// appends a row above it (or drops the control back to the bottom)
// fails this rather than silently regressing the layout.
test('the theme control is the FIRST thing in the drawer body', () => {
  const src = read('index.html');
  const theme = src.indexOf('id="drawer-row-theme"');
  const scroller = src.indexOf('id="header-menu-rows"');
  const status = src.indexOf('id="drawer-status-pane"');
  const node = src.indexOf('id="drawer-row-node"');
  assert.ok(scroller !== -1, 'header-menu-rows scroller missing');
  assert.ok(status !== -1, 'drawer-status-pane missing');
  assert.ok(node !== -1, 'drawer-row-node missing');
  assert.ok(theme > scroller, 'the theme control lives inside the drawer scroller');
  assert.ok(theme < status, 'the theme control comes before the status pane');
  assert.ok(theme < node, 'the theme control comes before every navigation row');
});

test('index.html exposes the three data-theme-mode buttons', () => {
  const src = read('index.html');
  for (const mode of ['light', 'dark', 'system']) {
    assert.ok(
      src.includes(`data-theme-mode="${mode}"`),
      `index.html must have a data-theme-mode="${mode}" button`,
    );
  }
});

test('the three modes render as a labelled radiogroup of segments', () => {
  const src = read('index.html');
  const track = src.match(/<div id="drawer-theme-track"[^>]*>/);
  assert.ok(track, 'drawer-theme-track missing');
  assert.match(track[0], /role="radiogroup"/, 'the segmented track is a radiogroup');
  assert.match(track[0], /aria-label="Theme"/, 'the radiogroup is labelled');
  // Each segment is a radio, so a screen reader announces "2 of 3"
  // rather than three unrelated buttons.
  for (const mode of ['light', 'dark', 'system']) {
    const btn = src.match(new RegExp(`<button[^>]*data-theme-mode="${mode}"[^>]*>`));
    assert.ok(btn, `segment button for ${mode} missing`);
    assert.match(btn[0], /role="radio"/, `${mode} segment carries role=radio`);
    assert.match(btn[0], /class="theme-seg /, `${mode} segment carries the .theme-seg class`);
  }
});

test('the selection caret ships exactly once, inside the track', () => {
  const src = read('index.html');
  const carets = src.match(/id="drawer-theme-caret"/g) || [];
  assert.equal(carets.length, 1, 'exactly one #drawer-theme-caret');
  const track = src.indexOf('id="drawer-theme-track"');
  assert.ok(src.indexOf('id="drawer-theme-caret"') > track,
    'the caret lives inside the segmented track (it positions against it)');
});

// ── app.js wiring ────────────────────────────────────────────────────────

test('app.js HeaderMenu wires Theme.get / Theme.set', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert.match(src, /Theme\.get\(\)/, 'app.js must read Theme.get()');
  assert.match(src, /Theme\.set\(/, 'app.js must call Theme.set()');
  assert.match(src, /_renderThemeButtons/, 'app.js must define/use the _renderThemeButtons helper');
});

test('_renderThemeButtons drives the caret through the CSS custom property', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  const fn = src.slice(src.indexOf('    _renderThemeButtons()'));
  assert.ok(fn.length > 0, '_renderThemeButtons located');
  const body = fn.slice(0, 1200);
  assert.match(body, /setProperty\('--theme-caret-index'/,
    'the caret is positioned by writing --theme-caret-index on the track');
  assert.match(body, /theme-seg-active/,
    'the active segment is marked with a class, not inline utility toggles');
  // A pixel measurement would be read BEFORE PlatformUI.sheet resizes
  // the panel on touch, so it would be wrong exactly where the control
  // is widest. The percentage transform must stay.
  assert.ok(!/offsetLeft|getBoundingClientRect/.test(body),
    'caret position must not be measured in JS — CSS percentages handle both panel widths');
});

test('the caret is a CSS transform with a reduced-motion escape hatch', () => {
  const css = read('css', 'app.css');
  const block = css.slice(css.indexOf('#drawer-theme-caret {'));
  assert.ok(block.length > 0, '#drawer-theme-caret rule located');
  assert.match(block.slice(0, 400), /transform:\s*translateX\(calc\(var\(--theme-caret-index\)/,
    'the caret translates by --theme-caret-index');
  assert.match(block.slice(0, 400), /transition:\s*transform/,
    'the caret slides between segments');
  const rm = css.slice(css.indexOf('#drawer-theme-caret {'));
  assert.match(rm, /@media \(prefers-reduced-motion: reduce\)\s*\{\s*#drawer-theme-caret\s*\{\s*transition:\s*none/,
    'reduced-motion users get a jump, not a slide');
});

test('the theme button click handler does NOT close the drawer', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  // Isolate the theme-button click handler region and assert it sets the
  // mode without the HeaderMenu.close() that every navigation row uses.
  const setIdx = src.indexOf('Theme.set(');
  assert.ok(setIdx !== -1, 'Theme.set call not found');
  const window = src.slice(setIdx, setIdx + 200);
  assert.ok(
    !window.includes('HeaderMenu.close()'),
    'theme selection must keep the drawer open (no HeaderMenu.close())',
  );
});
