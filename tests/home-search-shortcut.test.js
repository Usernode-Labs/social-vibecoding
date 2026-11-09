'use strict';

// #6462: / from anywhere in the Homeroom window, or Ctrl+K (⌘K) on Home,
// puts the cursor in Home's search box
// (frontend/src/features/home/search-shortcut.ts, installed by home.js
// `_wireSearch`, announced by index.tsx `aria-keyshortcuts`).
//
// What is pinned, each a way it can be quietly wrong:
//
//   1. THE KEYS. K with Ctrl or Cmd and no Shift or Alt; / with no Ctrl, Cmd
//      or Alt (Shift is allowed). Nothing for a bare K, a repeat, or
//      mid-composition.
//   2. THE SCOPES. Ctrl+K answers only while Home shows, so "Your
//      communities" and "Find a setting" keep it elsewhere. / answers
//      anywhere, except on Settings, whose own box keeps it. Neither fires
//      while typing, while a dialog or sheet is up, in comment mode, in the
//      side panel, or when another handler claimed the key.
//   3. THE SEAM. On Home it focuses and selects the field and prevents the
//      browser's default; from another screen it hands over to
//      `Home.focusSearch`. home.js installs it once, and the field states
//      the keys a screen reader announces.
//   4. THE WORDS. The placeholder carries the hint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const sh = loadTsx('frontend/src/features/home/search-shortcut.ts');
const HOME = read('frontend/src/features/home/home.js');
const INDEX = read('frontend/src/features/home/index.tsx');

const body = { tagName: 'BODY', closest: () => null };
const input = { tagName: 'INPUT', closest: () => null };
const textarea = { tagName: 'TEXTAREA', closest: () => null };
const editable = { tagName: 'DIV', isContentEditable: true, closest: () => null };

function key(init = {}) {
  return {
    key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, target: body,
    preventDefault() { this.defaultPrevented = true; },
    ...init,
  };
}

function harness({
  home = true, settings = false, dialog = false, comment = false,
  active = body, embedded = false,
} = {}) {
  const listeners = {};
  const calls = [];
  const screen = (hidden) => ({ classList: { contains: (c) => hidden && c === 'hidden' } });
  const visibleDialog = { closest: () => null, checkVisibility: () => true };
  const doc = {
    activeElement: active,
    documentElement: { classList: { contains: (c) => embedded && c === 'in-side-panel' } },
    getElementById: (id) => {
      if (id === 'home-screen') return screen(!home);
      if (id === 'settings-screen') return screen(!settings);
      if (id === 'comment-pin-host') return comment ? {} : null;
      return null;
    },
    querySelectorAll: () => (dialog ? [visibleDialog] : []),
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
  };
  const uninstall = sh.installHomeSearchShortcut({
    doc,
    open: (showing) => { calls.push(showing ? 'focus-home' : 'navigate'); },
  });
  const press = (init) => {
    const e = key(init);
    for (const fn of listeners.keydown || []) fn(e);
    return e;
  };
  return { press, calls, uninstall, listeners };
}

// ── 1. The keys ───────────────────────────────────────────────────────

test('K needs Ctrl or Cmd and no Shift or Alt; / needs no Ctrl, Cmd or Alt', () => {
  assert.equal(sh.homeSearchShortcutKind(key()), 'k', '⌘K');
  assert.equal(sh.homeSearchShortcutKind(key({ metaKey: false, ctrlKey: true })), 'k', 'Ctrl+K off a Mac');
  assert.equal(sh.homeSearchShortcutKind(key({ key: 'K', metaKey: false, ctrlKey: true })), 'k', 'Caps Lock');
  assert.equal(sh.homeSearchShortcutKind(key({ metaKey: false })), null, 'a bare K');
  assert.equal(sh.homeSearchShortcutKind(key({ shiftKey: true })), null, 'Ctrl+Shift+K is the browser\'s');
  assert.equal(sh.homeSearchShortcutKind(key({ altKey: true })), null);
  assert.equal(sh.homeSearchShortcutKind(key({ repeat: true })), null, 'not a held key');
  assert.equal(sh.homeSearchShortcutKind(key({ isComposing: true })), null);
  assert.equal(sh.homeSearchShortcutKind(key({ key: 'j' })), null);
  assert.equal(sh.homeSearchShortcutKind(key({ key: '/', metaKey: false })), 'slash');
  assert.equal(sh.homeSearchShortcutKind(key({ key: '/', metaKey: false, shiftKey: true })), 'slash',
    'some keyboards need Shift for /');
  assert.equal(sh.homeSearchShortcutKind(key({ key: '/', metaKey: false, ctrlKey: true })), null);
  assert.equal(sh.homeSearchShortcutKind(key({ key: '/', metaKey: false, altKey: true })), null);
  assert.equal(sh.homeSearchShortcutKind(null), null);
});

// ── 2. The scopes ─────────────────────────────────────────────────────

const HOME_ONLY = {
  homeShowing: true, settingsShowing: false, dialog: false,
  commentMode: false, typing: false, embedded: false,
};

test('the answer: Ctrl+K only on Home, / everywhere but Settings', () => {
  assert.equal(sh.homeSearchShortcutAnswer(key(), HOME_ONLY), 'focus');
  assert.equal(sh.homeSearchShortcutAnswer(key(), { ...HOME_ONLY, homeShowing: false }), null,
    'elsewhere Ctrl+K is "Your communities"');
  const slash = key({ key: '/', metaKey: false });
  assert.equal(sh.homeSearchShortcutAnswer(slash, { ...HOME_ONLY, homeShowing: false }), 'focus',
    '/ opens Home from another screen');
  assert.equal(sh.homeSearchShortcutAnswer(slash, { ...HOME_ONLY, settingsShowing: true }), null,
    'Settings keeps / for "Find a setting"');
  assert.equal(sh.homeSearchShortcutAnswer(key(), { ...HOME_ONLY, homeShowing: false, settingsShowing: true }), null,
    'Ctrl+K on Settings is "Find a setting"');
});

test('the answer: never while typing, under a dialog, in comment mode, the side panel, or after a claim', () => {
  for (const k of [key(), key({ key: '/', metaKey: false })]) {
    for (const off of ['typing', 'dialog', 'commentMode', 'embedded']) {
      assert.equal(sh.homeSearchShortcutAnswer(k, { ...HOME_ONLY, [off]: true }), null, off);
    }
    assert.equal(sh.homeSearchShortcutAnswer({ ...k, defaultPrevented: true }, HOME_ONLY), null,
      'somebody claimed it');
  }
});

// ── 3. The seam ───────────────────────────────────────────────────────

test('installed: on Home the chord focuses at once and prevents the browser\'s default', () => {
  const h = harness({ home: true });
  const e = h.press({ ctrlKey: true, metaKey: false });
  assert.deepEqual(h.calls, ['focus-home']);
  assert.equal(e.defaultPrevented, true);
});

test('installed: / off Home hands over to Home, and Ctrl+K off Home is left alone', () => {
  const h = harness({ home: false });
  const slash = h.press({ key: '/', metaKey: false });
  assert.deepEqual(h.calls, ['navigate']);
  assert.equal(slash.defaultPrevented, true, 'the browser\'s quick-find does not also run');
  const k = h.press();
  assert.deepEqual(h.calls, ['navigate'], '"Your communities" keeps Ctrl+K');
  assert.equal(k.defaultPrevented, false, 'so its own listener still sees it');
  h.uninstall();
  assert.equal((h.listeners.keydown || []).length, 0, 'and it uninstalls');
});

test('installed: typing in a field, a dialog, comment mode and the side panel all stand down', () => {
  for (const [name, opts, init] of [
    ['an input', {}, { target: input }],
    ['a textarea', {}, { target: textarea }],
    ['an editable element', {}, { target: editable }],
    ['focus in a field', { active: input }, {}],
    ['a dialog up', { dialog: true }, {}],
    ['comment mode', { comment: true }, {}],
    ['the side panel', { embedded: true }, {}],
  ]) {
    const h = harness(opts);
    for (const init2 of [{ ...init }, { key: '/', metaKey: false, ...init }]) {
      const e = h.press(init2);
      assert.deepEqual(h.calls, [], `${name}: nothing happens`);
      assert.equal(e.defaultPrevented, false, `${name}: the key is left to the page`);
    }
  }
  // A key composed through a shadow root is read at its real target.
  const h = harness();
  h.press({ target: { tagName: 'MY-WIDGET', closest: () => null }, composedPath: () => [textarea] });
  assert.deepEqual(h.calls, []);
});

test('home.js installs the shortcut in _wireSearch, and the field announces the keys', () => {
  const start = HOME.indexOf('_wireSearch() {');
  const wire = HOME.slice(start, HOME.indexOf('_wireDiscoveryCards(listEl, onChange)', start));
  assert.ok(wire.length > 200, 'located _wireSearch');
  assert.match(wire, /installHomeSearchShortcut\(\{/);
  assert.match(wire, /open: \(showing\) => \{[\s\S]{0,200}?Home\.focusSearch\(\)/,
    'from another screen it is the same way in as the sidebar glyph');
  assert.match(wire, /input\.focus\(\{ preventScroll: false \}\);[\s\S]{0,80}?input\.select\?\.\(\)/,
    'on Home the field takes focus and selects what is there');
  assert.match(INDEX, /aria-keyshortcuts=\{HOME_SEARCH_SHORTCUT_KEYS\}/);
  assert.match(INDEX, /import \{ HOME_SEARCH_SHORTCUT_KEYS \} from '\.\/search-shortcut';/);
  assert.equal(sh.HOME_SEARCH_SHORTCUT_KEYS, 'Control+K Meta+K /');
});

// ── 4. The words ──────────────────────────────────────────────────────

test('the search box carries the Ctrl+K hint', () => {
  const text = message('home:search.placeholder');
  assert.match(text, /\(Ctrl\+K\)$/);
  assert.ok(text.startsWith('Search apps and communities'), 'the field\'s own words stay first');
});
