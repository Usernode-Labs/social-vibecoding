'use strict';

// #5290: ⌘K (Ctrl+K) searches your communities from anywhere in the
// signed-in shell: "Your communities" opens with its search focused
// (frontend/src/features/workshop/community-shortcut.ts, mounted by
// community-switcher.tsx).
//
// What is pinned, each a way it can be quietly wrong:
//
//   1. ONLY THE CHORD. K with Cmd or Ctrl, without Shift (Firefox's console)
//      or Alt, not a held key's repeats, not mid-composition.
//   2. ONLY WHEN NOBODY ELSE WANTS IT. Typing in a field, another dialog up,
//      a handler that claimed the key, nobody signed in, the side panel:
//      nothing happens and the browser keeps its own Ctrl+K.
//   3. ITS DEFAULT IS PREVENTED ONLY WHEN IT ANSWERS, and pressed again with
//      the switcher open (focus in its own search box), it closes it.
//   4. THE SEAMS. The switcher installs it, opens from 'shortcut' with the
//      search focused, and the search box announces the keys.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const sc = loadTsx('frontend/src/features/workshop/community-shortcut.ts');
const SWITCHER = read('frontend/src/features/workshop/community-switcher.tsx');

const body = { tagName: 'BODY', closest: () => null };
const input = { tagName: 'INPUT', closest: () => null };
const textarea = { tagName: 'TEXTAREA', closest: () => null };
const editable = { tagName: 'DIV', isContentEditable: true, closest: () => null };

function key(init = {}) {
  const e = {
    key: 'k', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false, target: body,
    preventDefault() { this.defaultPrevented = true; },
    ...init,
  };
  return e;
}

function harness({ open = false, signedIn = true, dialog = false, active = body, embedded = false } = {}) {
  const listeners = {};
  const calls = [];
  let isOpen = open;
  const win = {
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
  };
  const visibleDialog = { closest: () => null, checkVisibility: () => true };
  const doc = {
    activeElement: active,
    documentElement: { classList: { contains: (c) => embedded && c === 'in-side-panel' } },
    getElementById: () => null,
    querySelectorAll: () => (dialog ? [visibleDialog] : []),
  };
  const uninstall = sc.installCommunityShortcut({
    win,
    doc,
    isOpen: () => isOpen,
    open: () => { calls.push('open'); isOpen = true; },
    close: () => { calls.push('close'); isOpen = false; },
    signedIn: () => signedIn,
  });
  const press = (init) => {
    const e = key(init);
    for (const fn of listeners.keydown || []) fn(e);
    return e;
  };
  return { press, calls, uninstall, listeners };
}

test('only ⌘K or Ctrl+K, without Shift or Alt, counts', () => {
  assert.equal(sc.isCommunityShortcut(key()), true);
  assert.equal(sc.isCommunityShortcut(key({ metaKey: false, ctrlKey: true })), true, 'Ctrl+K off a Mac');
  assert.equal(sc.isCommunityShortcut(key({ key: 'K' })), true, 'Caps Lock');
  assert.equal(sc.isCommunityShortcut(key({ metaKey: false })), false, 'a bare K');
  assert.equal(sc.isCommunityShortcut(key({ shiftKey: true })), false, 'Ctrl+Shift+K is the browser\'s');
  assert.equal(sc.isCommunityShortcut(key({ altKey: true })), false);
  assert.equal(sc.isCommunityShortcut(key({ repeat: true })), false, 'not a held key');
  assert.equal(sc.isCommunityShortcut(key({ isComposing: true })), false);
  assert.equal(sc.isCommunityShortcut(key({ key: 'j' })), false);
  assert.equal(sc.isCommunityShortcut(null), false);
});

test('the answer: open, close, or nothing', () => {
  const ctx = { switcherOpen: false, typing: false, dialog: false, signedIn: true, embedded: false };
  assert.equal(sc.communityShortcutAnswer(key(), ctx), 'open');
  assert.equal(sc.communityShortcutAnswer(key(), { ...ctx, typing: true }), null, 'typing in a field');
  assert.equal(sc.communityShortcutAnswer(key(), { ...ctx, dialog: true }), null, 'another dialog is up');
  assert.equal(sc.communityShortcutAnswer(key(), { ...ctx, signedIn: false }), null, 'nobody signed in');
  assert.equal(sc.communityShortcutAnswer(key(), { ...ctx, embedded: true }), null, 'the side panel');
  assert.equal(sc.communityShortcutAnswer(key({ defaultPrevented: true }), ctx), null, 'somebody claimed it');
  assert.equal(sc.communityShortcutAnswer(key(), { ...ctx, switcherOpen: true, typing: true }), 'close',
    'open, with focus in its own search box, it shuts');
});

test('installed: it opens, prevents the default only when it answers, and closes again', () => {
  const h = harness();
  const first = h.press();
  assert.deepEqual(h.calls, ['open']);
  assert.equal(first.defaultPrevented, true, 'the browser\'s own ⌘K does not also run');
  const again = h.press();
  assert.deepEqual(h.calls, ['open', 'close'], 'pressed again, it shuts');
  assert.equal(again.defaultPrevented, true);
  const other = h.press({ key: 'j' });
  assert.equal(other.defaultPrevented, false, 'another key is left alone');
  h.uninstall();
  assert.equal((h.listeners.keydown || []).length, 0, 'and it uninstalls');
});

test('installed: typing, a dialog, the side panel and a signed-out page leave the browser its Ctrl+K', () => {
  for (const [name, opts, init] of [
    ['an input', {}, { target: input }],
    ['a textarea', {}, { target: textarea }],
    ['an editable element', {}, { target: editable }],
    ['focus in a field', { active: input }, {}],
    ['a dialog up', { dialog: true }, {}],
    ['signed out', { signedIn: false }, {}],
    ['the side panel', { embedded: true }, {}],
  ]) {
    const h = harness(opts);
    const e = h.press({ ctrlKey: true, metaKey: false, ...init });
    assert.deepEqual(h.calls, [], `${name}: nothing opens`);
    assert.equal(e.defaultPrevented, false, `${name}: the default is left`);
  }
  // A key composed through a shadow root is read at its real target.
  const h = harness();
  h.press({ target: { tagName: 'MY-WIDGET', closest: () => null }, composedPath: () => [input] });
  assert.deepEqual(h.calls, []);
});

test('the switcher installs it, opens from it with the search focused, and the box names the keys', () => {
  assert.match(SWITCHER, /useEffect\(\(\) => installCommunityShortcut\(\{[\s\S]{0,300}open: \(\) => openSwitcher\('shortcut'\),\s*close: closeSwitcher,/);
  assert.match(SWITCHER, /aria-keyshortcuts=\{COMMUNITY_SHORTCUT_KEYS\}/);
  assert.equal(sc.COMMUNITY_SHORTCUT_KEYS, 'Meta+K Control+K');
  assert.match(SWITCHER, /st\.switcher === 'shortcut'\s*\? \{ left: '50%', top: '12vh', transform: 'translateX\(-50%\)' \}/,
    'on a wide window it comes down in the middle, not hung off the header');
  const scope = read('frontend/src/features/workshop/community-scope.ts');
  assert.match(scope, /export type SwitcherFrom = 'header' \| 'shortcut';/);
});
