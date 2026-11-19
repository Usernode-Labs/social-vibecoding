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

test('paper is stored and applied like brand', () => {
  const { Skin, store, attrs } = runSkin();
  Skin.set('paper');
  assert.equal(store.get('homeroom:skin'), 'paper');
  assert.equal(attrs.get('data-skin'), 'paper');
  assert.equal(Skin.get(), 'paper');
  Skin.set('standard');
  assert.equal(store.get('homeroom:skin'), 'standard');
  assert.equal(attrs.has('data-skin'), false);
  Skin.set('brand');
  assert.equal(store.has('homeroom:skin'), false, 'the default look is the absence of the key');
  assert.equal(attrs.get('data-skin'), 'brand');
});

test('a stored paper is on <html> as soon as the module runs', () => {
  assert.equal(runSkin({ stored: 'paper' }).attrs.get('data-skin'), 'paper');
});

test('brand still works beside paper', () => {
  const { Skin, attrs } = runSkin({ stored: 'paper' });
  Skin.set('brand');
  assert.equal(attrs.get('data-skin'), 'brand');
  assert.equal(Skin.get(), 'brand');
});

test('?skin= pins the look for this load and stores nothing', () => {
  const r = runSkin({ stored: 'brand', search: '?skin=paper' });
  assert.equal(r.attrs.get('data-skin'), 'paper');
  assert.equal(r.Skin.get(), 'paper');
  assert.equal(r.store.get('homeroom:skin'), 'brand', 'the pin is for this load only');
  const off = runSkin({ stored: 'paper', search: '?skin=standard' });
  assert.equal(off.attrs.has('data-skin'), false, 'standard pins the standard look over a stored one');
  assert.equal(runSkin({ search: '?skin=neon' }).Skin.get(), 'brand', 'an unknown pin is ignored: the default look');
  assert.equal(runSkin({ search: '?skin=standard' }).Skin.get(), 'standard', 'standard pins the earlier look over the default');
});

test('a pick applies and holds even when the browser refuses to store it', () => {
  const fired = [];
  // Storage can be read but not written: the old value stays stored.
  const r = runSkin({ stored: 'paper', storageThrows: true });
  assert.equal(r.attrs.get('data-skin'), 'paper');
  r.Skin.onChange(() => fired.push(r.Skin.get()));
  r.Skin.set('brand');
  assert.equal(r.attrs.get('data-skin'), 'brand', 'the picked look is on <html> at once');
  assert.equal(r.Skin.get(), 'brand', 'and is what every reader gets, not the stale stored look');
  assert.deepEqual(fired, ['brand'], 'and the listeners repaint');
  assert.equal(r.store.get('homeroom:skin'), 'paper', 'storage still holds the old value: the write was refused');
});

test('a pick replaces a look named in the address, keeping the rest of it', () => {
  const r = runSkin({
    search: '?skin=paper&tab=2',
    href: 'https://app.example/wall?skin=paper&tab=2#section',
  });
  assert.equal(r.replaced.length, 0, 'a load alone never rewrites the address');
  r.Skin.set('brand');
  assert.equal(r.Skin.get(), 'brand');
  assert.equal(r.store.get('homeroom:skin'), 'brand');
  assert.deepEqual(r.replaced, ['/wall?tab=2#section'],
    'the skin parameter is gone, the other parameters and the hash stay');
});

test('a pick made in another tab takes over, after a local pick', () => {
  const r = runSkin({ stored: 'paper' });
  r.Skin.set('brand');
  assert.equal(r.Skin.get(), 'brand');
  r.store.set('homeroom:skin', 'paper');
  for (const fn of r.listeners) fn({ key: 'homeroom:skin' });
  assert.equal(r.attrs.get('data-skin'), 'paper', 'the in-memory pick is dropped for the other tab\'s');
  assert.equal(r.Skin.get(), 'paper');
});

// ── The look of the frame ────────────────────────────────────────────────
//
// Paper is the one look left of the tour's looks over the one frame.
// `brand` ("Paper, simplified, with brand styling", the old New look
// redrawn) is a look of the menu too, but not one of the frame's: it keeps
// the standard pages. Four were drawn and retired on 12 Nov 2026 (Brand kit,
// Workbench, Today, Playground), and four more on 19 Nov 2026 (Glass,
// Pastel, Mosaic, Sunrise).

const FRAME_LOOKS = ['paper'];
const RETIRED_LOOKS = ['brandkit', 'workbench', 'today', 'playground', 'glass', 'pastel', 'mosaic', 'sunrise'];

test('every frame look is stored, applied and pinned alike', () => {
  for (const look of FRAME_LOOKS) {
    const { Skin, store, attrs } = runSkin();
    Skin.set(look);
    assert.equal(store.get('homeroom:skin'), look);
    assert.equal(attrs.get('data-skin'), look);
    assert.equal(runSkin({ stored: look }).attrs.get('data-skin'), look, `${look} is on <html> as the module runs`);
    assert.equal(runSkin({ search: `?skin=${look}` }).Skin.get(), look, `?skin=${look} pins it`);
  }
});

// A device that chose a retired look keeps its id in storage. Nothing
// draws it any more, so it must read as the default look everywhere (brand
// since 15 Nov 2026, which keeps the standard pages): never its own
// attribute for app.css, no frame for the islands.
test('a retired look, stored or named in the address, is the default look', () => {
  for (const look of RETIRED_LOOKS) {
    const stored = runSkin({ stored: look });
    assert.equal(stored.Skin.get(), 'brand', `${look} in storage reads as the default`);
    assert.equal(stored.attrs.get('data-skin'), 'brand', `${look} in storage never reaches <html>`);
    const pinned = runSkin({ search: `?skin=${look}` });
    assert.equal(pinned.Skin.get(), 'brand', `?skin=${look} pins nothing`);
    assert.equal(pinned.attrs.get('data-skin'), 'brand');
    // The address cannot bring one back over a look that is stored.
    assert.equal(runSkin({ stored: 'paper', search: `?skin=${look}` }).Skin.get(), 'paper');
    // A pick after it works as on a fresh device.
    stored.Skin.set('paper');
    assert.equal(stored.attrs.get('data-skin'), 'paper');
    assert.equal(stored.store.get('homeroom:skin'), 'paper');
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

test('the head and the hook list the same looks, the frame\'s one after brand', () => {
  const head = skinModuleSrc().match(/const SKINS = \[([^\]]*)\]/);
  assert.ok(head, 'the head module lists its looks');
  const listed = head[1].split(',').map((s) => s.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepEqual(listed, ['wip', 'brand', ...FRAME_LOOKS]);
  const mod = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  assert.deepEqual([...mod.FRAME_SKINS], FRAME_LOOKS);
  assert.deepEqual([...mod.MENU_SKINS], listed, 'the menu offers exactly the looks the head stores');
  for (const look of FRAME_LOOKS) assert.equal(mod.isFrameSkin(look), true, look);
  assert.equal(mod.isFrameSkin('standard'), false);
  assert.equal(mod.isFrameSkin('brand'), false, 'brand keeps the standard pages');
  globalThis.window = { Skin: { get: () => 'paper', onChange() {} } };
  try { assert.equal(mod.currentSkin(), 'paper'); } finally { delete globalThis.window; }
});

// ── The settings switch ──────────────────────────────────────────────────

// The picker is an admin's preview while the looks are drawn screen by
// screen: one select, shipped hidden, which settings.js shows only to a
// REAL admin (the same reading of App._realIsAdmin that shows "view as
// non-admin"). New look's own switch stood above it until 13 Nov 2026;
// its look, redrawn, is the menu's first option now.

const LOOK_NAMES = { wip: 'Standard (WIP)', brand: 'Paper, simplified, with brand styling', paper: 'Paper' };
const MENU_LOOKS = ['wip', 'brand', ...FRAME_LOOKS];

test('Settings › Experimental offers every look in one menu, shipped hidden, and no New look switch', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const html = renderComponent('frontend/src/features/settings/sections/experimental.tsx', 'ExperimentalSection', {});
  const section = html.match(/<div id="settings-look-section" class="([^"]*)">([\s\S]*?)<\/select>/);
  assert.ok(section, 'the menu has its own gated wrapper');
  assert.match(section[1], /^hidden /, 'hidden until the admin gate lifts it');
  assert.match(section[2], /<label[^>]*for="settings-look"[^>]*>Look<\/label>/);
  const options = [...section[2].matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
  // Standard (WIP) is listed once per token set, each named with (WIP), right after the look itself.
  const WIP_SETS = [['wip:brand', 'Homeroom brand kit (WIP)'], ['wip:brand2', 'Homeroom brand kit V2 (WIP)'], ['wip:highlighter', 'Highlighter (WIP)']];
  assert.deepEqual(options, [['', 'Standard'], ...MENU_LOOKS.flatMap((id) => (id === 'wip' ? [[id, LOOK_NAMES[id]], ...WIP_SETS] : [[id, LOOK_NAMES[id]]]))],
    'Standard, then Standard (WIP) and each of its token sets, brand and Paper, each by its name');
  assert.doesNotMatch(html, /new-look-enabled/, 'the New look switch is gone: its look is the menu\'s');
  assert.doesNotMatch(experimentalSrc(), /settings:experimental\.newLook\./, 'and so are its words');
  assert.doesNotMatch(html, /settings-local-agents-section/, 'the Local coding agent list it sat above is retired');
  assert.doesNotMatch(html, /glass-look-enabled/, 'the one-look switch is gone');
});

// 15 Nov 2026: with the default look everyone's, the look menu and the
// light/dark switch beside the bell are asked for, by a switch under the menu.
test('under the menu, a switch shows the look tools beside the bell, off by default', () => {
  const { renderComponent } = require('./lib/render-tsx');
  const { message } = require('./lib/platform-i18n');
  const html = renderComponent('frontend/src/features/settings/sections/experimental.tsx', 'ExperimentalSection', {});
  const section = html.slice(html.indexOf('id="settings-look-section"'), html.indexOf('id="settings-local-agents-section"'));
  assert.ok(section.indexOf('id="settings-look"') < section.indexOf('id="settings-look-tools"'), 'the switch sits under the menu, in the same gated section');
  assert.ok(section.includes(message('settings:experimental.lookTools.label')));
  assert.equal(message('settings:experimental.lookTools.label'), 'Show the look menu and the light and dark switch beside the bell');
  assert.match(message('settings:experimental.look.description'), /^Homeroom is drawn in “Paper, simplified, with brand styling” unless another look is chosen here\./);
  // The wiring, run: the change is the save, through the head's window.Skin.
  const src = settingsJs();
  const start = src.indexOf("const lookTools = document.getElementById('settings-look-tools');");
  const end = src.indexOf('// Platform-level language preference', start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const heard = [];
  let on = false;
  const box = { checked: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  vm.runInNewContext(src.slice(start, end), {
    document: { getElementById: (id) => (id === 'settings-look-tools' ? box : null) },
    window: { Skin: { tools: () => on, setTools: (v) => { calls.push(v); on = v; }, onChange: (fn) => heard.push(fn) } },
  });
  box.listeners.change({ target: { checked: true } });
  assert.deepEqual(calls, [true]);
  // Another tab, or the head module's own listeners, repaint the box.
  on = false; heard[0]();
  assert.equal(box.checked, false);
  on = true; heard[0]();
  assert.equal(box.checked, true);
  assert.match(src, /const lookTools = document\.getElementById\('settings-look-tools'\);\s*if \(lookTools\) lookTools\.checked = window\.Skin\?\.tools\?\.\(\) === true;/, 'and the section paints it when it opens');
});

// The gate, run: settings.js's own method against stub nodes.
function runAdminGate({ realAdmin, skin = 'brand', tools = false }) {
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
    window: { Skin: { get: () => skin, DEFAULT: 'brand', tools: () => tools } },
  });
  return { menuShown: !nodes['settings-look-section'].classList.contains('hidden'), adminShown: !nodes['settings-admin-section'].classList.contains('hidden') };
}

test('settings.js shows the Look menu only to a real admin', () => {
  assert.deepEqual(runAdminGate({ realAdmin: true }), { menuShown: true, adminShown: true });
  assert.deepEqual(runAdminGate({ realAdmin: false }), { menuShown: false, adminShown: false });
});

test('a device left in a look other than the default keeps the menu, so the way back is never hidden', () => {
  // An admin's device used by someone else, or an admin who lost the role:
  // the look is stored on the device, and the menu is the control that
  // clears it.
  assert.equal(runAdminGate({ realAdmin: false, skin: 'paper' }).menuShown, true);
  assert.equal(runAdminGate({ realAdmin: false, skin: 'paper' }).adminShown, false, 'only the menu, never the admin preview');
  assert.equal(runAdminGate({ realAdmin: false, skin: 'standard' }).menuShown, true, 'the earlier look is a choice too');
  // 15 Nov 2026: brand is the default, everyone's, so it shows the menu to
  // nobody but an admin.
  assert.equal(runAdminGate({ realAdmin: false, skin: 'brand' }).menuShown, false);
  // A device that turned the look tools on keeps the section, whose switch turns them off.
  assert.equal(runAdminGate({ realAdmin: false, skin: 'brand', tools: true }).menuShown, true);
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
  select.listeners.change({ target: { value: 'paper' } });
  assert.equal(state.skin, 'paper');
  assert.equal(select.value, 'paper');
  select.listeners.change({ target: { value: '' } });
  assert.equal(state.skin, 'standard');
});

test('the menu paints what is stored, brand among its looks, and follows another tab', () => {
  const on = runLooksWiring({ skin: 'paper' });
  assert.equal(on.select.value, 'paper', 'the stored look is selected');
  // A device the old New look switch left in brand reads as that option.
  assert.equal(runLooksWiring({ skin: 'brand' }).select.value, 'brand');
  on.select.listeners.change({ target: { value: 'brand' } });
  assert.equal(on.state.skin, 'brand');
  assert.equal(on.select.value, 'brand');
  on.select.listeners.change({ target: { value: 'wip' } });
  assert.equal(on.state.skin, 'wip');
  // Another tab changes the look: this pane repaints.
  on.state.skin = 'paper';
  on.state.onChange();
  assert.equal(on.select.value, 'paper');
});

test('the Look menu\'s words are English source with descriptions', () => {
  const en = JSON.parse(read('frontend', 'locales', 'en', 'settings.json'));
  for (const key of ['experimental.look.label', 'experimental.look.description', 'experimental.look.standard',
    ...MENU_LOOKS.map((id) => `experimental.look.${id}`)]) {
    assert.ok(en[key], `${key} exists`);
    assert.equal(typeof en[key].text, 'string');
    assert.ok(en[key].description.length > 20, `${key} says where it appears`);
  }
  for (const id of MENU_LOOKS) assert.equal(en[`experimental.look.${id}`].text, LOOK_NAMES[id]);
  assert.equal(en['experimental.glassLook.label'], undefined, 'the one-look switch\'s words are gone');
  assert.equal(en['experimental.newLook.label'], undefined, 'New look\'s words are gone with its switch');
  assert.equal(en['experimental.newLook.description'], undefined);
  const src = experimentalSrc();
  for (const id of MENU_LOOKS) assert.ok(src.includes(`t('settings:experimental.look.${id}')`), `${id}'s name is read by a whole literal id`);
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
  globalThis.window = { Skin: { get: () => 'paper', onChange() {} } };
  try {
    assert.equal(mod.currentSkin(), 'paper');
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
