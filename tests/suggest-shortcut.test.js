'use strict';

// #4289: the C key opens Suggest an improvement, on a computer, with nothing
// selected. Experimental, off by default, kept on the device.
//
// What is pinned, and each is a way it can be quietly wrong:
//
//   1. THE SWITCH. Off until a person turns it on, and stored where the
//      shortcut reads it.
//   2. ONLY A C NOBODY ELSE USED. Typing, a selection, a modifier, a dialog
//      on screen, or a screen that claimed the key (preventDefault) leaves it
//      alone, and the claim is read AFTER every listener has had the key.
//   3. FROM INSIDE AN APP. The bridge forwards an unused C without touching
//      the app's own handling, and the shell takes the message only from its
//      running app's frame while that frame holds focus.
//   4. ONE RULE, TWO COPIES. The shell and the bridge cannot share code, so
//      the same table of keys runs through both.
//   5. THE SEAMS. The Workshop claims its C, Settings paints and saves the
//      switch, and the bundle installs the listeners.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const shortcut = loadTsx('frontend/src/features/improve/suggest-shortcut.ts');
const BRIDGE = read('public/usernode-bridge/v1/bridge.js');
const BLOCK = BRIDGE.split('/* __USERNODE_SHORTCUTS_BEGIN__ */')[1]
  .split('/* __USERNODE_SHORTCUTS_END__ */')[0];

// ── Fakes ─────────────────────────────────────────────────────────────

const body = { tagName: 'BODY', closest: () => null };
const input = { tagName: 'INPUT', closest: () => null };
const textarea = { tagName: 'TEXTAREA', closest: () => null };
const select = { tagName: 'SELECT', closest: () => null };
const editable = { tagName: 'DIV', isContentEditable: true, closest: () => null };
const inTextbox = { tagName: 'SPAN', closest: (sel) => (sel.includes('textbox') ? {} : null) };
const shadowHost = { tagName: 'MY-WIDGET', closest: () => null };

function memoryStorage(on) {
  const map = new Map(on ? [[shortcut.SUGGEST_SHORTCUT_STORAGE_KEY, '1']] : []);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

// A key event as both documents see it. `path` is composedPath()'s answer;
// `later` runs as a listener registered after the one under test would.
function keyEvent(init = {}) {
  const e = {
    key: 'c', ctrlKey: false, metaKey: false, altKey: false, repeat: false, isComposing: false,
    target: body, defaultPrevented: false, ...init,
  };
  const path = init.path || [e.target];
  e.composedPath = () => path;
  e.preventDefault = () => { throw new Error('the shortcut must never claim a key'); };
  e.stopPropagation = () => { throw new Error('the shortcut must never stop a key'); };
  return e;
}

function shellHarness({
  enabled = true, fine = true, signedIn = true, panel = false, dialogs = [], active = body,
} = {}) {
  const listeners = {};
  const timers = [];
  const frameWin = { name: 'app frame' };
  const frame = { contentWindow: frameWin };
  let selection = '';
  let opened = 0;
  const doc = {
    activeElement: active === 'frame' ? frame : active,
    documentElement: { classList: { contains: (c) => panel && c === 'in-side-panel' } },
    getElementById: (id) => (id === 'app-iframe' ? frame : null),
    querySelectorAll: () => dialogs,
  };
  const win = {
    addEventListener(type, fn) { listeners[type] = fn; },
    setTimeout(fn) { timers.push(fn); },
    matchMedia: (q) => ({ matches: q === '(any-pointer: fine)' ? fine : false }),
    getSelection: () => ({ isCollapsed: !selection, toString: () => selection }),
  };
  const storage = memoryStorage(enabled);
  shortcut.installSuggestShortcut({
    win, doc, storage, open: () => { opened += 1; }, signedIn: () => signedIn,
  });
  return {
    doc, frame, frameWin, storage,
    select(text) { selection = text; },
    // Press, let any later listener act on the event, then run the task.
    press(init, later) {
      const e = keyEvent(init);
      listeners.keydown(e);
      if (later) later(e);
      const queued = timers.length;
      while (timers.length) timers.shift()();
      return { queued, opened };
    },
    message(data, source = frameWin) {
      listeners.message({ data, source });
      return opened;
    },
    get opened() { return opened; },
  };
}

function bridgeHarness({ top = false, platformShell = false, active = body, pointerLock = null } = {}) {
  const posted = [];
  const timers = [];
  let keydown = null;
  let selection = '';
  const window = {
    addEventListener(type, fn) { if (type === 'keydown') keydown = fn; },
    getSelection: () => ({ isCollapsed: !selection, toString: () => selection }),
  };
  window.parent = top ? window : { postMessage(message, origin) { posted.push({ message, origin }); } };
  if (platformShell) window.__usernodePlatformShell = true;
  const document = { activeElement: active, pointerLockElement: pointerLock };
  vm.runInNewContext(BLOCK, { window, document, setTimeout(fn) { timers.push(fn); }, String });
  return {
    installed: () => !!keydown,
    select(text) { selection = text; },
    press(init, later) {
      const e = keyEvent(init);
      keydown(e);
      if (later) later(e);
      while (timers.length) timers.shift()();
      return posted.length;
    },
    posted,
  };
}

// ── 1. The switch ─────────────────────────────────────────────────────

test('the shortcut is off until it is turned on, and the switch is what it reads', () => {
  const storage = memoryStorage(false);
  assert.equal(shortcut.suggestShortcutEnabled(storage), false, 'off by default');
  shortcut.setSuggestShortcutEnabled(true, storage);
  assert.equal(shortcut.suggestShortcutEnabled(storage), true);
  shortcut.setSuggestShortcutEnabled(false, storage);
  assert.equal(shortcut.suggestShortcutEnabled(storage), false);
  assert.equal(shortcut.suggestShortcutEnabled(null), false, 'no storage reads as off');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() {} };
  assert.equal(shortcut.suggestShortcutEnabled(broken), false, 'unreadable storage reads as off');
  assert.doesNotThrow(() => shortcut.setSuggestShortcutEnabled(true, broken));

  const h = shellHarness({ enabled: false });
  assert.equal(h.press().opened, 0, 'a C with the switch off does nothing');
  shortcut.setSuggestShortcutEnabled(true, h.storage);
  assert.equal(h.press().opened, 1, 'and opens once it is on, with no reload');
});

// ── 2. Only a C nobody else used ──────────────────────────────────────

test('a bare C opens Suggest an improvement, a task after the key', () => {
  const h = shellHarness();
  const { queued, opened } = h.press();
  assert.equal(queued, 1, 'decided in a later task, after every listener has had the key');
  assert.equal(opened, 1);
  assert.equal(h.press({ key: 'C' }).opened, 2, 'Shift or Caps Lock still counts');
});

test('not with a modifier, held down, mid-composition, or another key', () => {
  const h = shellHarness();
  for (const init of [
    { ctrlKey: true }, { metaKey: true }, { altKey: true },
    { repeat: true }, { isComposing: true }, { key: 'v' }, { key: 'Enter' },
  ]) {
    assert.equal(h.press(init).opened, 0, JSON.stringify(init));
  }
});

test('not while typing, including inside a shadow root, or with text selected', () => {
  for (const target of [input, textarea, select, editable, inTextbox]) {
    assert.equal(shellHarness().press({ target }).opened, 0, target.tagName);
  }
  assert.equal(shellHarness().press({ target: shadowHost, path: [input, shadowHost, body] }).opened, 0,
    'the real target, not the retargeted host');
  assert.equal(shellHarness({ active: textarea }).press().opened, 0, 'focus in a field');
  const h = shellHarness();
  h.select('some words');
  assert.equal(h.press().opened, 0, 'a selection');
  h.select('');
  assert.equal(h.press().opened, 1, 'a caret is not a selection');
});

test('a screen that claimed the key keeps it, however late its listener ran', () => {
  const h = shellHarness();
  assert.equal(h.press({}, (e) => { e.defaultPrevented = true; }).opened, 0);
});

test('not over a dialog, a sheet or a menu, nor on a phone, signed out, or in the side panel', () => {
  const shown = { closest: () => null, checkVisibility: () => true, getClientRects: () => ({ length: 1 }) };
  const shipped = { closest: () => null, getClientRects: () => ({ length: 0 }) };
  // The header's sheets while closed: laid out, but inert, invisible and
  // see-through, so they can animate in. Found by driving the real shell.
  const parked = { closest: (sel) => (sel.includes('[inert]') ? {} : null), getClientRects: () => ({ length: 1 }) };
  const faded = { closest: () => null, checkVisibility: () => false, getClientRects: () => ({ length: 1 }) };
  const older = { closest: () => null, getClientRects: () => ({ length: 1 }) };
  assert.equal(shellHarness({ dialogs: [shown] }).press().opened, 0, 'a dialog on screen');
  assert.equal(shellHarness({ dialogs: [shipped] }).press().opened, 1, 'a hidden one does not count');
  assert.equal(shellHarness({ dialogs: [parked] }).press().opened, 1, 'nor an inert one');
  assert.equal(shellHarness({ dialogs: [faded] }).press().opened, 1, 'nor one the browser says is invisible');
  assert.equal(shellHarness({ dialogs: [older] }).press().opened, 0, 'without checkVisibility, laid out counts');
  assert.equal(shellHarness({ fine: false }).press().opened, 0, 'touch only');
  assert.equal(shellHarness({ signedIn: false }).press().opened, 0, 'a visitor');
  assert.equal(shellHarness({ panel: true }).press().opened, 0, 'the side panel stands down');
});

// ── 3. From inside an app ─────────────────────────────────────────────

test('the shell takes the bridge\'s C only from its app frame, while that frame has focus', () => {
  const msg = { [shortcut.SHORTCUT_MESSAGE_KEY]: 'suggest' };
  assert.equal(shellHarness({ active: 'frame' }).message(msg), 1);
  assert.equal(shellHarness({ active: 'frame' }).message(msg, { name: 'another frame' }), 0, 'another frame');
  assert.equal(shellHarness({ active: body }).message(msg), 0, 'a frame without focus had no key pressed in it');
  assert.equal(shellHarness({ active: 'frame', enabled: false }).message(msg), 0, 'the switch');
  assert.equal(shellHarness({ active: 'frame', fine: false }).message(msg), 0, 'touch only');
  assert.equal(shellHarness({ active: 'frame' }).message({ [shortcut.SHORTCUT_MESSAGE_KEY]: 'other' }), 0);
  assert.equal(shellHarness({ active: 'frame' }).message(null), 0);
  assert.equal(shellHarness({ active: 'frame' }).message('suggest'), 0);
});

test('the bridge forwards an unused C to the shell and never touches the app\'s keys', () => {
  const b = bridgeHarness();
  assert.equal(b.press(), 1, 'keyEvent throws if preventDefault or stopPropagation is called');
  // Spread into this realm: the vm's objects have their own prototype.
  assert.deepEqual({ ...b.posted[0].message }, { __usernode_shortcut: 'suggest' });
  assert.equal(b.press({}, (e) => { e.defaultPrevented = true; }), 1, 'an app that claimed C keeps it');
  assert.equal(bridgeHarness({ pointerLock: {} }).press(), 0, 'a game holding the pointer');
});

test('the bridge installs nothing in a top frame and sends nothing from the platform\'s own document', () => {
  assert.equal(bridgeHarness({ top: true }).installed(), false);
  assert.equal(bridgeHarness({ platformShell: true }).press(), 0);
});

// ── 4. One rule, two copies ───────────────────────────────────────────

test('the shell and the bridge answer the same keys the same way', () => {
  const cases = [
    [{}, true],
    [{ key: 'C' }, true],
    [{ key: 'x' }, false],
    [{ ctrlKey: true }, false],
    [{ metaKey: true }, false],
    [{ altKey: true }, false],
    [{ repeat: true }, false],
    [{ isComposing: true }, false],
    [{ target: input }, false],
    [{ target: textarea }, false],
    [{ target: select }, false],
    [{ target: editable }, false],
    [{ target: inTextbox }, false],
    [{ target: shadowHost, path: [input, shadowHost, body] }, false],
    [{ target: shadowHost, path: [shadowHost, body] }, true],
  ];
  for (const [init, expected] of cases) {
    const label = JSON.stringify(init, (k, v) => (v && v.tagName ? v.tagName : v));
    assert.equal(shellHarness().press(init).opened === 1, expected, `shell: ${label}`);
    assert.equal(bridgeHarness().press(init) === 1, expected, `bridge: ${label}`);
  }
  for (const make of [shellHarness, bridgeHarness]) {
    const h = make();
    h.select('words');
    const r = h.press();
    assert.equal(typeof r === 'number' ? r : r.opened, 0, `${make.name}: a selection`);
  }
});

test('both hosted bridge copies carry the block', () => {
  assert.equal(read('public/usernode-bridge.js'), BRIDGE);
});

// ── 5. The seams ──────────────────────────────────────────────────────

test('the Workshop claims its C, so the two never both open', () => {
  const ws = read('frontend/src/features/dev-board/workshop/workshop.tsx');
  assert.match(ws, /if \(k === 'c' \|\| k === 'C'\) \{ e\.preventDefault\(\); toggleSheet\('comments'\); return; \}/);
});

test('the bundle installs the shortcut, and opens what the Suggest an improvement button opens', () => {
  assert.match(read('frontend/src/main.tsx'), /^import '\.\/features\/improve\/suggest-shortcut';$/m);
  const src = read('frontend/src/features/improve/suggest-shortcut.ts');
  assert.match(src, /w\.Improve\.giveFeedback\(\)/);
  assert.match(src, /bridge\.suggestShortcut = \{/, 'published for settings.js, which cannot import');
});

test('Settings, Experimental has the switch, unchecked as shipped, painted and saved through the module', () => {
  const { ExperimentalSection } = loadTsx('frontend/src/features/settings/sections/experimental.tsx', {
    stubs: { '../local-agents-list': { LocalAgentsList: () => null } },
  });
  const html = renderToHtml(createElement(ExperimentalSection));
  assert.match(html,
    /<label[^>]*><input id="suggest-shortcut-enabled" type="checkbox" class="un-switch"\/><span[^>]*>Press C to suggest an improvement<\/span><\/label>/);
  assert.match(html, /Saved on this device only\./);
  assert.ok(html.indexOf('id="suggest-shortcut-enabled"') < html.indexOf('id="settings-local-agents-section"'),
    'inside the Experimental block');

  const settings = read('frontend/src/features/settings/settings.js');
  const render = settings.match(/_renderExperimentalSection\(\) \{[\s\S]*?\n    \},/);
  assert.match(render[0], /getElementById\('suggest-shortcut-enabled'\)/, 'every paint shows the stored value');
  assert.match(render[0], /shortcut\.checked = !!shortcutPref\?\.enabled\(\)/);
  assert.match(settings, /pref\?\.setEnabled\(e\.target\.checked\)/, 'saved on change');
});
