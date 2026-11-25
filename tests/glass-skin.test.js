// The head's skin switch beyond the brand look (tests/brand-look.test.js).
// `window.Skin` keeps the choice on the device under 'homeroom:skin' and
// sets data-skin="<look>" on <html> before first paint; `?skin=` pins a look
// for one load, for the capture runner; app.css draws the look from the
// attribute in light AND dark. The file is named for Glass, the first look
// of the one frame, retired on 19 Nov 2026 with Pastel, Mosaic and Sunrise;
// Paper is the frame's look now. This suite holds the Skin module, the hook
// and the Settings picker.
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
// (the same slice tests/brand-look.test.js takes).
function skinModuleSrc() {
  const src = headSrc();
  const start = src.indexOf('window.Skin = (function () {');
  assert.ok(start > 0, 'head.html must assign window.Skin');
  const end = src.indexOf('}());', start);
  assert.ok(end > start, 'the Skin module is one IIFE');
  return src.slice(start, end + '}());'.length);
}

// Runs the module against a stub window/document. `stored` seeds storage,
// `search` is the page's query string, `broken` makes every storage access
// throw, `storageThrows` makes only writes throw (storage readable, not
// writable), `href` is the page's full address.
function runSkin({ stored = null, search = '', broken = false, storageThrows = false, href = null } = {}) {
  const store = new Map(stored === null ? [] : [['homeroom:skin', stored]]);
  const attrs = new Map();
  const listeners = [];
  const replaced = [];
  const localStorage = {
    getItem(k) { if (broken) throw new Error('blocked'); return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { if (broken || storageThrows) throw new Error('blocked'); store.set(k, String(v)); },
    removeItem(k) { if (broken || storageThrows) throw new Error('blocked'); store.delete(k); },
  };
  const window = {
    localStorage,
    location: { search, href: href || `https://app.example/${search}` },
    history: { replaceState(state, title, url) { replaced.push(url); } },
    addEventListener(type, fn) { if (type === 'storage') listeners.push(fn); },
  };
  const document = {
    documentElement: {
      setAttribute(k, v) { attrs.set(k, String(v)); },
      removeAttribute(k) { attrs.delete(k); },
    },
  };
  vm.runInNewContext(skinModuleSrc(), { window, document, URLSearchParams, URL });
  return { Skin: window.Skin, store, attrs, listeners, replaced };
}

// ── The inline head module ───────────────────────────────────────────────

test('brand is stored and applied, and Standard clears it', () => {
  const { Skin, store, attrs } = runSkin();
  Skin.set('brand');
  assert.equal(store.get('homeroom:skin'), 'brand');
  assert.equal(attrs.get('data-skin'), 'brand');
  assert.equal(Skin.get(), 'brand');
  Skin.set('standard');
  assert.equal(store.has('homeroom:skin'), false);
  assert.equal(attrs.has('data-skin'), false);
});

test('a stored brand is on <html> as soon as the module runs', () => {
  assert.equal(runSkin({ stored: 'brand' }).attrs.get('data-skin'), 'brand');
});

// 'wip', "Homeroom brand kit (WIP)", was where a change to the standard look
// was tried first. It was removed on 24 Nov 2026 (#7071): a device that had
// it stored, an address that names it and a pick of it all read as Standard.
test('wip is gone: stored, pinned or picked, it is the standard look and sets no attribute of its own', () => {
  const stored = runSkin({ stored: 'wip' });
  assert.equal(stored.Skin.get(), 'standard');
  assert.equal(stored.attrs.has('data-skin'), false);
  assert.equal(stored.attrs.has('data-skin-wip'), false);
  assert.equal(stored.attrs.has('data-wip-tokens'), false);
  const pinned = runSkin({ stored: 'brand', search: '?skin=wip' });
  assert.equal(pinned.Skin.get(), 'brand', 'the address cannot bring it back over a stored look');
  const picked = runSkin({ stored: 'brand' });
  picked.Skin.set('wip');
  assert.equal(picked.Skin.get(), 'standard', 'a pick of it is a pick of Standard');
  assert.equal(picked.store.has('homeroom:skin'), false);
  assert.equal(picked.attrs.has('data-skin-wip'), false);
  assert.doesNotMatch(skinModuleSrc(), /data-skin-wip|data-wip-tokens|WIP_TOKENS/, 'the head writes nothing for it');
  assert.equal(typeof stored.Skin.getTokens, 'undefined', 'there is no token set to choose');
});

test('?skin= pins the look for this load and stores nothing', () => {
  const r = runSkin({ search: '?skin=brand' });
  assert.equal(r.attrs.get('data-skin'), 'brand');
  assert.equal(r.Skin.get(), 'brand');
  assert.equal(r.store.has('homeroom:skin'), false, 'the pin is for this load only');
  const off = runSkin({ stored: 'brand', search: '?skin=standard' });
  assert.equal(off.attrs.has('data-skin'), false, 'standard pins the standard look over a stored one');
  assert.equal(off.store.get('homeroom:skin'), 'brand');
  assert.equal(runSkin({ search: '?skin=neon' }).Skin.get(), 'standard', 'an unknown pin is ignored');
});

test('a pick applies and holds even when the browser refuses to store it', () => {
  const fired = [];
  // Storage can be read but not written: the old value stays stored.
  const r = runSkin({ stored: 'brand', storageThrows: true });
  assert.equal(r.attrs.get('data-skin'), 'brand');
  r.Skin.onChange(() => fired.push(r.Skin.get()));
  r.Skin.set('standard');
  assert.equal(r.attrs.has('data-skin'), false, 'the picked look is on <html> at once');
  assert.equal(r.Skin.get(), 'standard', 'and is what every reader gets, not the stale stored look');
  assert.deepEqual(fired, ['standard'], 'and the listeners repaint');
  assert.equal(r.store.get('homeroom:skin'), 'brand', 'storage still holds the old value: the write was refused');
});

test('a pick replaces a look named in the address, keeping the rest of it', () => {
  const r = runSkin({
    search: '?skin=wip&tab=2',
    href: 'https://app.example/wall?skin=wip&tab=2#section',
  });
  assert.equal(r.replaced.length, 0, 'a load alone never rewrites the address');
  r.Skin.set('brand');
  assert.equal(r.Skin.get(), 'brand');
  assert.equal(r.store.get('homeroom:skin'), 'brand');
  assert.deepEqual(r.replaced, ['/wall?tab=2#section'],
    'the skin parameter is gone, the other parameters and the hash stay');
});

test('a pick made in another tab takes over, after a local pick', () => {
  const r = runSkin({ stored: 'brand' });
  r.Skin.set('standard');
  assert.equal(r.Skin.get(), 'standard');
  r.store.set('homeroom:skin', 'brand');
  for (const fn of r.listeners) fn({ key: 'homeroom:skin' });
  assert.equal(r.attrs.get('data-skin'), 'brand', 'the in-memory pick is dropped for the other tab\'s');
  assert.equal(r.Skin.get(), 'brand');
});

// ── The looks that are gone ──────────────────────────────────────────────
//
// The Look menu keeps two since 24 Nov 2026 (#7071): Standard and 'brand'
// ("Paper, simplified, with brand styling", the old New look redrawn, which
// keeps the standard pages). Four looks of the one frame were retired on 12
// Nov 2026 (Brand kit, Workbench, Today, Playground) and four more on 19 Nov
// 2026 (Glass, Pastel, Mosaic, Sunrise). Paper, the frame's last, left the
// menus and the head on 20 Nov 2026: its drawing is still in the tree, with
// nothing that reaches it, until it is removed in its own change.

const FRAME_LOOKS = ['paper'];
const RETIRED_LOOKS = ['brandkit', 'workbench', 'today', 'playground', 'glass', 'pastel', 'mosaic', 'sunrise', 'wip'];

test('paper is neither stored, applied nor pinned any more', () => {
  for (const look of FRAME_LOOKS) {
    const stored = runSkin({ stored: look });
    assert.equal(stored.Skin.get(), 'standard', `${look} in storage reads as standard`);
    assert.equal(stored.attrs.has('data-skin'), false);
    const pinned = runSkin({ search: `?skin=${look}` });
    assert.equal(pinned.Skin.get(), 'standard', `?skin=${look} pins nothing`);
    assert.equal(pinned.attrs.has('data-skin'), false);
    const picked = runSkin({ stored: 'brand' });
    picked.Skin.set(look);
    assert.equal(picked.Skin.get(), 'standard', 'a pick of it is a pick of Standard');
    assert.equal(picked.store.has('homeroom:skin'), false);
    assert.doesNotMatch(experimentalSrc(), new RegExp(`value="${look}"`), `${look} is not offered in Settings`);
  }
});

// A device that chose a retired look keeps its id in storage. Nothing
// draws it any more, so it must read as the standard design everywhere: no
// attribute for app.css, no frame for the islands, Standard in the menus.
test('a retired look, stored or named in the address, is the standard design', () => {
  for (const look of RETIRED_LOOKS) {
    const stored = runSkin({ stored: look });
    assert.equal(stored.Skin.get(), 'standard', `${look} in storage reads as standard`);
    assert.equal(stored.attrs.has('data-skin'), false, `${look} in storage puts no data-skin on <html>`);
    const pinned = runSkin({ search: `?skin=${look}` });
    assert.equal(pinned.Skin.get(), 'standard', `?skin=${look} pins nothing`);
    assert.equal(pinned.attrs.has('data-skin'), false);
    // The address cannot bring one back over a look that is stored.
    assert.equal(runSkin({ stored: 'brand', search: `?skin=${look}` }).Skin.get(), 'brand');
    // A pick after it works as on a fresh device.
    stored.Skin.set('brand');
    assert.equal(stored.attrs.get('data-skin'), 'brand');
    assert.equal(stored.store.get('homeroom:skin'), 'brand');
  }
  const mod = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  for (const look of RETIRED_LOOKS) {
    assert.equal(mod.isFrameSkin(look), false, `${look} draws no frame`);
    // Even a head module that still answered it (a cached shell) is not believed.
    globalThis.window = { Skin: { get: () => look, onChange() {} } };
    try { assert.equal(mod.currentSkin(), 'standard'); } finally { delete globalThis.window; }
  }
  // Nothing of them is left to draw: no rule, no source, no name.
  const css = read('public', 'css', 'app.css');
  for (const look of RETIRED_LOOKS) {
    assert.ok(!css.includes(`data-skin="${look}"`), `app.css has no rule for ${look}`);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'frontend', 'looks', `${look}.css`)), false, `${look}.css is gone`);
    assert.doesNotMatch(experimentalSrc(), new RegExp(`value="${look}"`), `${look} is not offered in Settings`);
  }
});

test('the head and the hook list the same one look, and it is not the frame\'s', () => {
  const head = skinModuleSrc().match(/const SKINS = \[([^\]]*)\]/);
  assert.ok(head, 'the head module lists its looks');
  const listed = head[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(listed, ['brand']);
  const mod = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  assert.deepEqual([...mod.FRAME_SKINS], FRAME_LOOKS);
  assert.deepEqual([...mod.MENU_SKINS], listed, 'the menu offers exactly the looks the head stores');
  assert.deepEqual([...mod.LOOK_CHOICES], ['standard', ...listed], 'two entries, Standard first');
  assert.equal(mod.isFrameSkin('standard'), false);
  assert.equal(mod.isFrameSkin('brand'), false, 'brand keeps the standard pages');
  assert.equal(mod.isKitHome('standard'), true);
  assert.equal(mod.isKitHome('brand'), false);
  // Even a head module that still answered paper or wip (a cached shell) is not believed.
  for (const gone of ['paper', 'wip']) {
    globalThis.window = { Skin: { get: () => gone, onChange() {} } };
    try { assert.equal(mod.currentSkin(), 'standard'); } finally { delete globalThis.window; }
  }
});

// ── The settings switch ──────────────────────────────────────────────────

// The picker is an admin's preview while the looks are drawn screen by
// screen: one select, shipped hidden, which settings.js shows only to a
// REAL admin (the same reading of App._realIsAdmin that shows "view as
// non-admin"). New look's own switch stood above it until 13 Nov 2026;
// its look, redrawn, is the menu's first option now.

const LOOK_NAMES = { brand: 'Paper, simplified, with brand styling' };
const LOOK_IDS = { brand: 'experimental.look.brand' };
const MENU_LOOKS = ['brand'];

test('Settings › Experimental offers the two looks in one menu, shipped hidden, and no New look switch', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/settings/sections/experimental.tsx', 'ExperimentalSection', {});
  const section = html.match(/<div id="settings-look-section" class="([^"]*)">([\s\S]*?)<\/select>/);
  assert.ok(section, 'the menu has its own gated wrapper');
  assert.match(section[1], /^hidden /, 'hidden until the admin gate lifts it');
  assert.match(section[2], /<label[^>]*for="settings-look"[^>]*>Look<\/label>/);
  const options = [...section[2].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(options, [['', 'Standard'], ...MENU_LOOKS.map((id) => [id, LOOK_NAMES[id]])],
    'two looks: Standard and Paper simplified, each by its name');
  assert.doesNotMatch(html, /new-look-enabled/, 'the New look switch is gone: its look is the menu\'s');
  assert.doesNotMatch(experimentalSrc(), /settings:experimental\.newLook\./, 'and so are its words');
  assert.doesNotMatch(html, /settings-local-agents-section/, 'the Local coding agent list it sat above is retired');
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
    'settings-look': node({ options: [{ value: '' }, ...MENU_LOOKS.map((value) => ({ value }))] }),
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
});

test('a device left in one of the looks keeps the menu, so the way back to Standard is never hidden', () => {
  // An admin's device used by someone else, or an admin who lost the role:
  // the look is stored on the device, and the menu is the control that
  // clears it.
  assert.equal(runAdminGate({ realAdmin: false, skin: 'brand' }).adminShown, false, 'only the menu, never the admin preview');
  // A device that had the old New look switch on stored 'brand'. The switch
  // is gone, so the menu is its way back too.
  assert.equal(runAdminGate({ realAdmin: false, skin: 'brand' }).menuShown, true);
});

// The wiring, run: settings.js's own block for the menu, against stub
// elements and a stub window.Skin.
function runLooksWiring({ skin = 'standard' } = {}) {
  const src = settingsJs();
  assert.doesNotMatch(src, /new-look-enabled/, 'settings.js wires no New look switch');
  const start = src.indexOf("const lookSelect = document.getElementById('settings-look');");
  const end = src.indexOf('// Platform-level language preference', start);
  assert.ok(start > 0 && end > start, 'the looks wiring is one block before the language preference');
  const el = (extra) => ({ listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, ...extra });
  const select = el({ value: '', options: [{ value: '' }, ...MENU_LOOKS.map((value) => ({ value }))] });
  const state = { skin, onChange: null };
  const window = { Skin: { get: () => state.skin, set: (v) => { state.skin = v; }, onChange: (fn) => { state.onChange = fn; } } };
  const document = { getElementById: (id) => ({ 'settings-look': select })[id] || null };
  vm.runInNewContext(`${src.slice(start, end)}\npaintLooks();`, { window, document });
  return { select, state };
}

test('the Look menu sets the look through window.Skin, and Standard clears it', () => {
  const { select, state } = runLooksWiring();
  select.listeners.change({ target: { value: 'brand' } });
  assert.equal(state.skin, 'brand');
  assert.equal(select.value, 'brand');
  select.listeners.change({ target: { value: '' } });
  assert.equal(state.skin, 'standard');
});

test('the menu paints what is stored, brand among its looks, and follows another tab', () => {
  // A device the old New look switch left in brand reads as that option.
  const on = runLooksWiring({ skin: 'brand' });
  assert.equal(on.select.value, 'brand', 'the stored look is selected');
  on.select.listeners.change({ target: { value: '' } });
  assert.equal(on.state.skin, 'standard');
  // Another tab changes the look: this pane repaints.
  on.state.skin = 'brand';
  on.state.onChange();
  assert.equal(on.select.value, 'brand');
  // A look the menu does not offer (a cached head still answering paper, or the removed wip) reads as Standard.
  for (const gone of ['paper', 'wip']) {
    on.state.skin = gone;
    on.state.onChange();
    assert.equal(on.select.value, '');
  }
});

test('the Look menu\'s words are English source with descriptions', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  for (const key of ['experimental.look.label', 'experimental.look.description', 'experimental.look.standard',
    ...MENU_LOOKS.map((id) => LOOK_IDS[id])]) {
    assert.ok(en[key], `${key} exists`);
    assert.equal(typeof en[key].text, 'string');
    assert.ok(en[key].description.length > 20, `${key} says where it appears`);
  }
  for (const id of MENU_LOOKS) assert.equal(en[LOOK_IDS[id]].text, LOOK_NAMES[id]);
  for (const gone of ['experimental.look.wip', 'experimental.look.paper', 'experimental.wipTokens.brand', 'experimental.wipTokens.brand2', 'experimental.wipTokens.highlighter']) {
    assert.equal(en[gone], undefined, `${gone} went with its menu entry`);
  }
  assert.equal(en['experimental.glassLook.label'], undefined, 'the one-look switch\'s words are gone');
  assert.equal(en['experimental.newLook.label'], undefined, 'New look\'s words are gone with its switch');
  assert.equal(en['experimental.newLook.description'], undefined);
  const src = experimentalSrc();
  for (const id of MENU_LOOKS) assert.ok(src.includes(`t('settings:${LOOK_IDS[id]}')`), `${id}'s name is read by a whole literal id`);
});

// The stylesheet's side (each look's block, tokens, typeface and rules) is
// held as a table over the five in tests/frame-looks.test.js.

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
  globalThis.window = { Skin: { get: () => 'brand', onChange() {} } };
  try {
    assert.equal(mod.currentSkin(), 'brand');
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
