// The glass look: the second value of the head's skin switch (the first is
// the brand look, tests/new-look.test.js). `window.Skin` keeps the choice on
// the device under 'homeroom:skin' and sets data-skin="glass" on <html>
// before first paint; `?skin=` pins a look for one load, for the capture
// runner; app.css draws the look from the attribute in light AND dark.
// Glass was the first of the nine looks of the one frame; this suite holds
// the Skin module, the hook and the Settings picker for all of them, and
// tests/frame-looks.test.js the stylesheet.
//
// Run with: node --test tests/glass-skin.test.js

'use strict';

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

// The Skin module's own source: from its assignment to the end of its IIFE
// (the same slice tests/new-look.test.js takes).
function skinModuleSrc() {
  const src = headSrc();
  const start = src.indexOf('window.Skin = (function () {');
  assert.ok(start > 0, 'head.html must assign window.Skin');
  const end = src.indexOf('}());', start);
  assert.ok(end > start, 'the Skin module is one IIFE');
  return src.slice(start, end + '}());'.length);
}

// Runs the module against a stub window/document. `stored` seeds storage,
// `search` is the page's query string, `broken` makes storage throw.
function runSkin({ stored = null, search = '', broken = false } = {}) {
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
    location: { search },
    addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
  };
  const document = {
    documentElement: {
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
    },
  };
  vm.runInNewContext(skinModuleSrc(), { window, document, URLSearchParams });
  return { Skin: window.Skin, store, attrs, listeners };
}

// ── The inline head module ───────────────────────────────────────────────

test('glass is stored and applied like brand', () => {
  const { Skin, store, attrs } = runSkin();
  Skin.set('glass');
  assert.equal(store.get('homeroom:skin'), 'glass');
  assert.equal(attrs.get('data-skin'), 'glass');
  assert.equal(Skin.get(), 'glass');
  Skin.set('standard');
  assert.equal(store.has('homeroom:skin'), false);
  assert.equal(attrs.has('data-skin'), false);
});

test('a stored glass is on <html> as soon as the module runs', () => {
  assert.equal(runSkin({ stored: 'glass' }).attrs.get('data-skin'), 'glass');
});

test('brand still works beside glass', () => {
  const { Skin, attrs } = runSkin({ stored: 'glass' });
  Skin.set('brand');
  assert.equal(attrs.get('data-skin'), 'brand');
  assert.equal(Skin.get(), 'brand');
});

test('?skin= pins the look for this load and stores nothing', () => {
  const r = runSkin({ stored: 'brand', search: '?skin=glass' });
  assert.equal(r.attrs.get('data-skin'), 'glass');
  assert.equal(r.Skin.get(), 'glass');
  assert.equal(r.store.get('homeroom:skin'), 'brand', 'the pin is for this load only');
  const off = runSkin({ stored: 'glass', search: '?skin=standard' });
  assert.equal(off.attrs.has('data-skin'), false, 'standard pins the standard look over a stored one');
  assert.equal(runSkin({ search: '?skin=neon' }).Skin.get(), 'standard', 'an unknown pin is ignored');
});

// ── The nine looks of the frame ──────────────────────────────────────────
//
// Glass was the first of the tour's nine looks over the one frame; the
// other eight are stored, applied and pinned the same way. `brand` (New
// look) is a look too, but not one of the frame's.

const FRAME_LOOKS = ['glass', 'brandkit', 'workbench', 'paper', 'pastel', 'mosaic', 'sunrise', 'today', 'playground'];

test('every frame look is stored, applied and pinned like glass', () => {
  for (const look of FRAME_LOOKS) {
    const { Skin, store, attrs } = runSkin();
    Skin.set(look);
    assert.equal(store.get('homeroom:skin'), look);
    assert.equal(attrs.get('data-skin'), look);
    assert.equal(runSkin({ stored: look }).attrs.get('data-skin'), look, `${look} is on <html> as the module runs`);
    assert.equal(runSkin({ search: `?skin=${look}` }).Skin.get(), look, `?skin=${look} pins it`);
  }
});

test('the head and the hook list the same looks, the frame\'s nine after brand', () => {
  const head = skinModuleSrc().match(/const SKINS = \[([^\]]*)\]/);
  assert.ok(head, 'the head module lists its looks');
  const listed = head[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(listed, ['brand', ...FRAME_LOOKS]);
  const mod = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  assert.deepEqual([...mod.FRAME_SKINS], FRAME_LOOKS);
  for (const look of FRAME_LOOKS) assert.equal(mod.isFrameSkin(look), true, look);
  assert.equal(mod.isFrameSkin('standard'), false);
  assert.equal(mod.isFrameSkin('brand'), false, 'New look draws the standard Home');
  globalThis.window = { Skin: { get: () => 'mosaic', onChange() {} } };
  try { assert.equal(mod.currentSkin(), 'mosaic'); } finally { delete globalThis.window; }
});

// ── The settings switch ──────────────────────────────────────────────────

test('Settings › Experimental carries the Glass look switch under New look', () => {
  const src = experimentalSrc();
  assert.match(src, /<SwitchRow id="glass-look-enabled">/);
  assert.ok(src.indexOf('id="new-look-enabled"') < src.indexOf('id="glass-look-enabled"'));
  assert.ok(src.indexOf('id="glass-look-enabled"') < src.indexOf('id="settings-local-agents-section"'));
  assert.match(src, /settings:experimental\.glassLook\.label/);
  assert.match(src, /settings:experimental\.glassLook\.description/);
});

// An admin's preview while the look is drawn screen by screen: the row
// ships hidden and settings.js lifts the class only for a REAL admin, from
// the same reading of App._realIsAdmin that shows "view as non-admin".
test('the Glass look row ships hidden, for the admin gate to lift', () => {
  const src = experimentalSrc();
  const row = src.match(/<div id="settings-glass-look-section"[^>]*>/);
  assert.ok(row, 'the glass switch has its own gated wrapper');
  assert.match(row[0], /className="hidden /);
  assert.ok(src.indexOf('settings-glass-look-section') < src.indexOf('id="glass-look-enabled"'), 'the wrapper holds the switch');
});

test('settings.js shows the Glass look row only to a real admin', () => {
  const src = settingsJs();
  const start = src.indexOf('_renderAdminSection() {');
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf('\n    },', start));
  assert.match(body, /getElementById\('settings-glass-look-section'\)/);
  assert.match(body, /App\._realIsAdmin/, 'the un-masked value, as the admin preview reads it');
  assert.match(body, /classList\.toggle\('hidden', !realAdmin\)/, 'hidden unless the viewer is really an admin');
});

test('settings.js saves and paints the glass switch through window.Skin', () => {
  const src = settingsJs();
  assert.match(src, /getElementById\('glass-look-enabled'\)/);
  assert.match(src, /window\.Skin\?\.set\?\.\(e\.target\.checked \? 'glass' : 'standard'\)/, 'the change is the save');
  assert.match(src, /window\.Skin\?\.get\?\.\(\) === 'glass'/, 'the pane paints the stored choice');
});

test('the glass switch copy is English source with descriptions', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  for (const key of ['experimental.glassLook.label', 'experimental.glassLook.description']) {
    assert.ok(en[key], `${key} exists`);
    assert.equal(typeof en[key].text, 'string');
    assert.ok(en[key].description.length > 20, `${key} says where it appears`);
  }
  assert.match(en['experimental.glassLook.description'].text, /Albert Sans/);
});

// The stylesheet's side (each look's block, tokens, typeface and rules) is
// held as a table over the nine in tests/frame-looks.test.js.

// ── useSkin(): the look, read by an island after it mounts ─────────────
//
// An island that draws a look must not read data-skin on its first render:
// the prerendered document is skin-agnostic, so a first render that
// differed would be a hydration mismatch (a console error, which fails
// proposal checks). The hook answers 'standard' until mounted, then the
// live value from window.Skin.

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

test('useSkin reads standard on the first render and currentSkin reads window.Skin', () => {
  const mod = loadTsx('frontend/src/lib/skin.ts');
  assert.equal(mod.currentSkin(), 'standard', 'no window.Skin in the test: the standard look');
  const html = renderToHtml(createElement(() => createElement('i', null, mod.useSkin())));
  assert.equal(html, '<i>standard</i>');
  globalThis.window = { Skin: { get: () => 'glass', onChange() {} } };
  try {
    assert.equal(mod.currentSkin(), 'glass');
    assert.equal(renderToHtml(createElement(() => createElement('i', null, mod.useSkin()))), '<i>standard</i>',
      'the first render stays standard even when the device has a look on');
  } finally {
    delete globalThis.window;
  }
});

test('useSkin subscribes through window.Skin.onChange after mount', () => {
  const src = read('frontend', 'src', 'lib', 'skin.ts');
  assert.match(src, /useEffect\(/);
  assert.match(src, /window\.Skin\?\.onChange\?\.\(/);
  assert.match(src, /useState<Skin>\('standard'\)/);
});
