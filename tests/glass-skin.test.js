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

// The picker is an admin's preview while the looks are drawn screen by
// screen: one select under New look, shipped hidden, which settings.js
// shows only to a REAL admin (the same reading of App._realIsAdmin that
// shows "view as non-admin").

const LOOK_NAMES = {
  glass: 'Glass', brandkit: 'Brand kit', workbench: 'Workbench', paper: 'Paper', pastel: 'Pastel',
  mosaic: 'Mosaic', sunrise: 'Sunrise', today: 'Today', playground: 'Playground',
};

test('Settings › Experimental offers the nine looks in one menu, shipped hidden under New look', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/settings/sections/experimental.tsx', 'ExperimentalSection', {});
  const section = html.match(/<div id="settings-look-section" class="([^"]*)">([\s\S]*?)<\/select>/);
  assert.ok(section, 'the menu has its own gated wrapper');
  assert.match(section[1], /^hidden /, 'hidden until the admin gate lifts it');
  assert.match(section[2], /<label[^>]*for="settings-look"[^>]*>Look<\/label>/);
  const options = [...section[2].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options, [['', 'Standard'], ...FRAME_LOOKS.map((id) => [id, LOOK_NAMES[id]])],
    'Standard, then the nine in the tour\'s order, each by its name');
  assert.ok(html.indexOf('id="new-look-enabled"') < html.indexOf('id="settings-look-section"'));
  assert.ok(html.indexOf('id="settings-look"') < html.indexOf('id="settings-local-agents-section"'));
  assert.doesNotMatch(html, /glass-look-enabled/, 'the one-look switch is gone');
});

// The gate, run: settings.js's own method against stub nodes.
function runAdminGate({ realAdmin, skin = 'standard' }) {
  const src = settingsJs();
  const start = src.indexOf('_renderAdminSection() {');
  assert.ok(start > 0);
  const method = src.slice(start, src.indexOf('\n    },', start) + '\n    }'.length);
  assert.match(method, /App\._realIsAdmin/, 'the un-masked value, as the admin preview reads it');
  const node = (extra) => {
    const cls = new Set(['hidden']);
    return { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) }, ...extra };
  };
  const nodes = {
    'settings-admin-section': node(), 'view-as-non-admin': node({ checked: false }), 'settings-look-section': node(),
    'settings-look': node({ options: [{ value: '' }, ...FRAME_LOOKS.map((value) => ({ value }))] }),
  };
  vm.runInNewContext(`({ ${method} })._renderAdminSection()`, {
    document: { getElementById: (id) => nodes[id] || null },
    App: { _realIsAdmin: realAdmin, user: { isAdmin: realAdmin } },
    localStorage: { getItem: () => null },
    window: { Skin: { get: () => skin } },
  });
  return { menuShown: !nodes['settings-look-section'].classList.contains('hidden'), adminShown: !nodes['settings-admin-section'].classList.contains('hidden') };
}

test('settings.js shows the Look menu only to a real admin', () => {
  assert.deepEqual(runAdminGate({ realAdmin: true }), { menuShown: true, adminShown: true });
  assert.deepEqual(runAdminGate({ realAdmin: false }), { menuShown: false, adminShown: false });
  assert.equal(runAdminGate({ realAdmin: false, skin: 'brand' }).menuShown, false, 'New look has its own switch');
});

test('a device left in one of the looks keeps the menu, so the way back to Standard is never hidden', () => {
  // An admin's device used by someone else, or an admin who lost the role:
  // the look is stored on the device, and the menu is the control that
  // clears it.
  assert.equal(runAdminGate({ realAdmin: false, skin: 'mosaic' }).menuShown, true);
  assert.equal(runAdminGate({ realAdmin: false, skin: 'mosaic' }).adminShown, false, 'only the menu, never the admin preview');
});

// The wiring, run: settings.js's own block for the two controls, against
// stub elements and a stub window.Skin.
function runLooksWiring({ skin = 'standard' } = {}) {
  const src = settingsJs();
  const start = src.indexOf("const lookToggle = document.getElementById('new-look-enabled');");
  const end = src.indexOf('// Platform-level language preference', start);
  assert.ok(start > 0 && end > start, 'the looks wiring is one block before the language preference');
  const el = (extra) => ({ listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, ...extra });
  const toggle = el({ checked: false });
  const select = el({ value: '', options: [{ value: '' }, ...FRAME_LOOKS.map((value) => ({ value }))] });
  const state = { skin, onChange: null };
  const window = { Skin: { get: () => state.skin, set: (v) => { state.skin = v; }, onChange: (fn) => { state.onChange = fn; } } };
  const document = { getElementById: (id) => ({ 'new-look-enabled': toggle, 'settings-look': select })[id] || null };
  vm.runInNewContext(`${src.slice(start, end)}\npaintLooks();`, { window, document });
  return { toggle, select, state };
}

test('the Look menu sets the look through window.Skin, and Standard clears it', () => {
  const { select, state } = runLooksWiring();
  select.listeners.change({ target: { value: 'mosaic' } });
  assert.equal(state.skin, 'mosaic');
  assert.equal(select.value, 'mosaic');
  select.listeners.change({ target: { value: '' } });
  assert.equal(state.skin, 'standard');
});

test('New look and the Look menu are exclusive, and both paint what is stored', () => {
  const on = runLooksWiring({ skin: 'pastel' });
  assert.equal(on.select.value, 'pastel', 'the stored look is selected');
  assert.equal(on.toggle.checked, false);
  on.toggle.listeners.change({ target: { checked: true } });
  assert.equal(on.state.skin, 'brand');
  assert.equal(on.select.value, '', 'New look is not one of the menu\'s looks: the menu reads Standard');
  assert.equal(on.toggle.checked, true);
  on.select.listeners.change({ target: { value: 'today' } });
  assert.equal(on.toggle.checked, false, 'choosing a look turns New look off');
  // Another tab changes the look: this pane repaints.
  on.state.skin = 'glass';
  on.state.onChange();
  assert.equal(on.select.value, 'glass');
});

test('the Look menu\'s words are English source with descriptions', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  for (const key of ['experimental.look.label', 'experimental.look.description', 'experimental.look.standard',
    ...FRAME_LOOKS.map((id) => `experimental.look.${id}`)]) {
    assert.ok(en[key], `${key} exists`);
    assert.equal(typeof en[key].text, 'string');
    assert.ok(en[key].description.length > 20, `${key} says where it appears`);
  }
  for (const id of FRAME_LOOKS) assert.equal(en[`experimental.look.${id}`].text, LOOK_NAMES[id]);
  assert.equal(en['experimental.glassLook.label'], undefined, 'the one-look switch\'s words are gone');
  const src = experimentalSrc();
  for (const id of FRAME_LOOKS) assert.ok(src.includes(`t('settings:experimental.look.${id}')`), `${id}'s name is read by a whole literal id`);
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
