// Tests for the new look, an experiment (Settings › Experimental, off by
// default): the head's window.Skin keeps the choice on the device and sets
// data-skin="brand" on <html> before first paint; app.css draws the look
// from that attribute in light mode only.
//
// Static-assertion style (cf. tests/accessibility-prefs.test.js), plus one
// run of the head module itself against a stub window, so the storage
// contract is pinned by behaviour rather than by spelling.
//
// Run with: node --test tests/new-look.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const headSrc = () => read('frontend', 'src', 'head.html');
const settingsJs = () => read('frontend', 'src', 'features', 'settings', 'settings.js');
const experimentalSrc = () => read('frontend', 'src', 'features', 'settings', 'sections', 'experimental.tsx');

// The Skin module's own source: from its assignment to the end of its IIFE.
function skinModuleSrc() {
  const src = headSrc();
  const start = src.indexOf('window.Skin = (function () {');
  assert.ok(start > 0, 'head.html must assign window.Skin');
  const end = src.indexOf('}());', start);
  assert.ok(end > start, 'the Skin module is one IIFE');
  return src.slice(start, end + '}());'.length);
}

// Runs the module against a stub window/document. `stored` seeds storage;
// `broken` makes every storage call throw, as a locked-down browser does.
function runSkin({ stored = null, broken = false } = {}) {
  const store = new Map(stored === null ? [] : [['homeroom:skin', stored]]);
  const attrs = new Map();
  const listeners = [];
  const localStorage = {
    getItem(k) { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (broken) throw new Error('blocked'); store.set(k, String(v)); },
    removeItem(k) { if (broken) throw new Error('blocked'); store.delete(k); },
  };
  const window = {
    localStorage,
    addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
  };
  const document = {
    documentElement: {
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
    },
  };
  vm.runInNewContext(skinModuleSrc(), { window, document });
  return { Skin: window.Skin, store, attrs, listeners };
}

// ── The inline head module ───────────────────────────────────────────────

test('the new look is off by default', () => {
  const { Skin, attrs } = runSkin();
  assert.equal(Skin.get(), 'standard');
  assert.equal(attrs.has('data-skin'), false, 'no stored choice: no data-skin on <html>');
});

test('a stored choice is on <html> as soon as the module runs', () => {
  const { Skin, attrs } = runSkin({ stored: 'brand' });
  assert.equal(Skin.get(), 'brand');
  assert.equal(attrs.get('data-skin'), 'brand');
});

test('set() stores the new look and removes the key for the standard one', () => {
  const { Skin, store, attrs } = runSkin();
  let heard = 0;
  Skin.onChange(() => { heard += 1; });
  Skin.set('brand');
  assert.equal(store.get('homeroom:skin'), 'brand');
  assert.equal(attrs.get('data-skin'), 'brand');
  Skin.set('standard');
  assert.equal(store.has('homeroom:skin'), false, 'the standard look is the absence of the key');
  assert.equal(attrs.has('data-skin'), false);
  assert.equal(heard, 2, 'every set() tells its listeners');
});

test('unknown values and blocked storage read as the standard look', () => {
  assert.equal(runSkin({ stored: 'neon' }).Skin.get(), 'standard');
  const blocked = runSkin({ broken: true });
  assert.equal(blocked.Skin.get(), 'standard');
  assert.doesNotThrow(() => blocked.Skin.set('brand'), 'a blocked write never throws');
  assert.equal(blocked.attrs.get('data-skin'), undefined,
    'a choice that could not be stored is not shown as stored');
});

test('another tab changing the key re-applies it here', () => {
  const { Skin, store, attrs, listeners } = runSkin();
  assert.equal(listeners.length, 1, 'the module listens for storage events');
  store.set('homeroom:skin', 'brand');
  listeners[0]({ key: 'homeroom:skin' });
  assert.equal(attrs.get('data-skin'), 'brand');
  assert.equal(Skin.get(), 'brand');
});

test('the Skin module runs before the first stylesheet', () => {
  const src = headSrc();
  const skinAt = src.indexOf('window.Skin =');
  const cssAt = src.indexOf('<link rel="stylesheet"');
  assert.ok(cssAt > 0 && skinAt > 0 && skinAt < cssAt,
    'window.Skin must apply before any stylesheet reads data-skin');
});

// ── The settings switch ──────────────────────────────────────────────────

test('Settings › Experimental carries the New look switch, last of the switches', () => {
  const src = experimentalSrc();
  assert.match(src, /<SwitchRow id="new-look-enabled">/);
  assert.ok(src.indexOf('id="review-flow-enabled"') < src.indexOf('id="new-look-enabled"'));
  assert.ok(src.indexOf('id="new-look-enabled"') < src.indexOf('id="settings-local-agents-section"'));
  assert.match(src, /settings:experimental\.newLook\.label/);
  assert.match(src, /settings:experimental\.newLook\.description/);
});

test('settings.js saves and paints the switch through window.Skin', () => {
  const src = settingsJs();
  assert.match(src, /getElementById\('new-look-enabled'\)/);
  assert.match(src, /window\.Skin\?\.set\?\.\(e\.target\.checked \? 'brand' : 'standard'\)/,
    'the change is the save');
  assert.match(src, /window\.Skin\?\.get\?\.\(\) === 'brand'/, 'the pane paints the stored choice');
  assert.match(src, /window\.Skin\?\.onChange\?\.\(/, 'a change in another tab re-paints the switch');
});

test('the switch copy is English source with descriptions', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  for (const key of ['experimental.newLook.label', 'experimental.newLook.description']) {
    assert.ok(en[key], `${key} exists`);
    assert.ok(en[key].text.trim(), `${key} has text`);
    assert.ok(en[key].description.trim(), `${key} has a description`);
  }
});

// ── The app.css rules ────────────────────────────────────────────────────

// The new look's block: from its heading to the end of the sheet.
function lookBlock() {
  const css = read('public', 'css', 'app.css');
  const at = css.indexOf('/* ── THE NEW LOOK, AN EXPERIMENT');
  assert.ok(at > 0, 'app.css carries the new look block');
  return css.slice(at);
}

test('every rule of the new look is scoped to the flag, in light mode only', () => {
  const block = lookBlock().replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = block.split('}').map((r) => r.trim()).filter(Boolean);
  let selectors = 0;
  for (const rule of rules) {
    const head = rule.slice(0, rule.indexOf('{')).trim();
    if (!head || head === '@font-face') continue;
    for (const sel of head.split(',').map((s) => s.trim())) {
      selectors += 1;
      assert.ok(
        sel.startsWith('html[data-skin="brand"]:not(.dark):not([data-app-tone="dark"])'),
        `"${sel}" must start from the flag, outside dark mode and dark apps`,
      );
    }
  }
  assert.ok(selectors > 10, 'the block is read whole');
});

test('the block lives last and redeclares none of the counted wallpaper tokens', () => {
  const css = read('public', 'css', 'app.css');
  const block = lookBlock();
  assert.ok(css.trimEnd().endsWith(block.trimEnd()), 'appended at the very end of app.css');
  for (const token of ['--home-washes:', '--home-wallpaper:', '--dc-sheet-fill:', '--dc-frost:']) {
    assert.ok(!block.includes(token), `${token} is counted elsewhere and must not be redeclared here`);
  }
});

test('Geist loads from our own origin by an absolute path, and only for the new look', () => {
  const block = lookBlock();
  assert.match(block, /@font-face\s*\{[^}]*font-family:\s*'Geist'[^}]*url\('\/fonts\/geist\/Geist-Variable\.woff2'\)/,
    'the face points at the self-hosted file by an absolute, same-origin path');
  const css = read('public', 'css', 'app.css');
  const before = css.slice(0, css.indexOf('/* ── THE NEW LOOK, AN EXPERIMENT'));
  assert.ok(!/Geist/.test(before), 'nothing outside the new look names Geist');
});

test('/fonts/ is a public static prefix, like /vendor/', () => {
  const auth = read('src', 'middleware', 'auth.js');
  const m = auth.match(/const PUBLIC_PATHS = \[([\s\S]*?)\];/);
  assert.ok(m && /'\/fonts\/'/.test(m[1]), 'signed-out screens fetch the font too');
});

// ── The typeface ─────────────────────────────────────────────────────────

test('Geist is served from our own origin with its licence beside it', () => {
  const dir = path.join(ROOT, 'public', 'fonts', 'geist');
  assert.ok(fs.statSync(path.join(dir, 'Geist-Variable.woff2')).size > 10_000, 'the font file is committed');
  assert.match(read('public', 'fonts', 'geist', 'LICENSE.txt'), /SIL Open Font License/,
    'the OFL travels with the font');
});
