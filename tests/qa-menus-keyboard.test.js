// QA 2026-09-24 — Q4, Q13, Q15, Q18: menus, keyboard access and dialogs.
//
//   Q4   the proposal page's ⋯ opened and shut in the same click: the scroll
//        that focusing it nudged out of its clipped action band closed it.
//   Q13  the Messages composer's @ / # suggestions were mouse-only, and
//        Enter sent the half-typed name.
//   Q15  Leave / Remove / Block / Delete asked through window.confirm(),
//        which some webview hosts suppress.
//   Q18  menus that focus never reached, Escape that did nothing, kit
//        dialogs Tab walked out of, and no way past the screen to the rail.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// ── Q4: a scroll closes the ⋯ menu only when it moved the trigger ─────────

function appView() {
  const sandbox = { console, addEventListener() {}, document: { addEventListener() {} } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('public/js/app-view.js'), sandbox);
  return sandbox.AppView;
}

test('Q4: the focus nudge inside the clipped action band does not count as the page moving', () => {
  const AppView = appView();
  const at = (top, left = 900) => ({
    isConnected: true,
    getBoundingClientRect: () => ({ top, left }),
  });
  const open = (trigger) => ({ trigger, at: { top: 300, left: 900 } });
  assert.equal(AppView._cardMenuTriggerMoved(open(at(301))), false, 'a 1px nudge keeps the menu');
  assert.equal(AppView._cardMenuTriggerMoved(open(at(300, 898))), false);
  assert.equal(AppView._cardMenuTriggerMoved(open(at(340))), true, 'a real scroll still closes it');
  assert.equal(AppView._cardMenuTriggerMoved(open(at(300, 880))), true, 'sideways too (the board scrolls in both axes)');
  assert.equal(AppView._cardMenuTriggerMoved({ trigger: { isConnected: false }, at: { top: 0, left: 0 } }), true,
    'a trigger that is gone has nothing to stay beside');
});

test('Q4: the scroll dismisser spares the menu\'s own scroll and re-places on a nudge', () => {
  const src = read('public/js/app-view.js');
  const init = src.slice(src.indexOf('  _cardMenuInit() {'), src.indexOf('  _closeCardMenu() {'));
  assert.match(init, /open\.el\.contains\(t\)\) return;/, 'a scroll inside the menu never closes it');
  assert.match(init, /if \(!AppView\._cardMenuTriggerMoved\(open\)\) \{[\s\S]*?_positionCardMenu\(open\.el, open\.trigger\)/);
  assert.doesNotMatch(init, /window\.addEventListener\('scroll', \(\) => \{\s*if \(AppView\._openCardMenu\) AppView\._closeCardMenu\(\);/,
    'the old any-scroll-closes rule is gone');
  // `at` is recorded where the menu is placed, and again when a repaint
  // re-anchors it to the successor trigger.
  assert.match(src, /AppView\._openCardMenu = \{ key, el: menu, trigger, own, at: \{ top: at\.top, left: at\.left \} \};/);
  assert.match(src.slice(src.indexOf('  _reanchorCardMenu() {')), /open\.at = \{ top: at\.top, left: at\.left \};/);
});

// ── Q18: the shared React menu keys ───────────────────────────────────────

function fakeMenu(labels) {
  const doc = { activeElement: null };
  const items = labels.map((label) => {
    const el = {
      label,
      getClientRects: () => [1],
      focus() { doc.activeElement = el; },
    };
    return el;
  });
  const root = { querySelectorAll: () => items };
  return { doc, items, root };
}

test('Q18: roveMenuFocus moves and wraps with the arrows, jumps with Home/End, and ignores other keys', () => {
  const { roveMenuFocus, focusFirstItem } = loadTsx('frontend/src/lib/menu-keys.ts');
  const { doc, items, root } = fakeMenu(['Direct message', 'Group chat', 'Agent chat']);
  const saved = globalThis.document;
  globalThis.document = doc;
  try {
    const key = (k) => {
      let prevented = false;
      const handled = roveMenuFocus({ key: k, preventDefault() { prevented = true; } }, root);
      return { handled, prevented, at: doc.activeElement && doc.activeElement.label };
    };
    assert.equal(focusFirstItem(root), true);
    assert.equal(doc.activeElement, items[0]);
    assert.deepEqual(key('ArrowDown'), { handled: true, prevented: true, at: 'Group chat' });
    assert.deepEqual(key('End'), { handled: true, prevented: true, at: 'Agent chat' });
    assert.deepEqual(key('ArrowDown'), { handled: true, prevented: true, at: 'Direct message' }, 'wraps');
    assert.deepEqual(key('ArrowUp'), { handled: true, prevented: true, at: 'Agent chat' }, 'wraps back');
    assert.deepEqual(key('Home'), { handled: true, prevented: true, at: 'Direct message' });
    assert.deepEqual(key('a'), { handled: false, prevented: false, at: 'Direct message' });
  } finally {
    globalThis.document = saved;
  }
});

test('Q18: an anchored popover closes on a scroll only when its anchor moved, and Escape returns focus', () => {
  const src = read('frontend/src/lib/popover-dismiss.ts');
  assert.match(src, /export const ANCHOR_SCROLL_SLOP = 4;/);
  assert.match(src, /const onScroll = \(ev: Event\) => \{\s*if \(within\(ev\.target\)\) return;/,
    'a scroll inside the panel never closes it');
  assert.match(src, /window\.addEventListener\('scroll', onScroll, true\);/);
  assert.doesNotMatch(src, /window\.addEventListener\('scroll', shut, true\)/, 'no longer ANY scroll');
  assert.match(src, /if \(refocus\) insideRef\.current\[0\]\?\.current\?\.focus\(/);
});

test('Q18: the Messages "+" and the conversation ⋯ are keyboard menus', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const plus = src.slice(src.indexOf('function NewMessageButton()'), src.indexOf('/** The heading over each part of the list'));
  assert.match(plus, /const menuKeys = useMenuKeyboard\(open, popRef, btnRef, shut\);/);
  assert.match(plus, /id="messages-new-menu"[\s\S]*?onKeyDown=\{menuKeys\.onKeyDown\}/);
  const head = src.slice(src.indexOf('function ThreadHeader()'), src.indexOf('/** The day a message was sent'));
  assert.match(head, /useDismiss\(menu, \[menuWrapRef\], closeMenu\);/, 'an outside press and Escape close it');
  assert.match(head, /aria-haspopup="menu" aria-expanded=\{menu\}/);
  assert.match(head, /className="messages-thread-menu" role="menu"/);
  // 4 with QA Q14's "Rename group" row (merged from the Messages group).
  assert.equal((head.match(/role="menuitem"/g) || []).length, 4, 'every row is a menuitem');
});

test('Q18: the Workshop "+" menu closes on Escape and on a press anywhere, and roves with the arrows', () => {
  const src = read('public/js/app-view.js');
  const fn = src.slice(src.indexOf('  _wirePlusMenu(content) {'), src.indexOf('  // Re-pull live data for the dev card list.'));
  assert.match(fn, /document\.addEventListener\('click', \(e\) => \{[\s\S]*?close\(\);\s*\}, \{ signal \}\);/);
  assert.match(fn, /document\.addEventListener\('keydown', \(e\) => \{[\s\S]*?e\.key === 'Escape'[\s\S]*?btn\.focus\(/);
  assert.match(fn, /AppView\._roveMenuFocus\(e, menu, PLUS_ROWS,/);
  assert.doesNotMatch(fn, /content\.addEventListener\('click'/, 'the content-only dismisser, which a header press skipped, is gone');
});

test('Q18: the "Which workshop?" panel and the Homeroom menu take focus, rove, and give it back on Escape', () => {
  const ws = read('frontend/src/features/workshop/workshop-chrome.tsx');
  assert.match(ws, /<button id=\{id\} type="button" role="menuitem"/);
  assert.match(ws, /onKeyDown=\{\(event\) => \{ roveMenuFocus\(event, event\.currentTarget\); \}\}/);
  assert.match(ws, /focusFirstItem\(panelRef\.current\);/);
  assert.match(ws, /if \(event\.key !== 'Escape'\) return;\s*const back = opener\(\);/);
  const ctx = read('frontend/src/features/app-context/index.tsx');
  assert.match(ctx, /roveMenuFocus\(event, el, SHEET_ROWS\)/);
  assert.match(ctx, /if \(inside\) document\.getElementById\(MARK_ID\)\?\.focus\(/);
  assert.match(ctx, /const touring = !!tour && !tour\.classList\.contains\('hidden'\);/,
    'the welcome tour drives this menu and keeps its own focus');
});

// ── Q18: the kit's modal and alert keep Tab inside ────────────────────────

const NATIVE = read('public/usernode-native/v1/native.js');

test('Q18: presentModal and alertDialog register a Tab trap on the shared modal stack', () => {
  assert.match(NATIVE, /var entry = \{ dismissible: dismissible, dismiss: dismiss, trap: card \};/);
  const trap = NATIVE.slice(NATIVE.indexOf('  function focusablesIn(root) {'), NATIVE.indexOf('  // presentModal({ content'));
  assert.match(trap, /if \(e\.key !== 'Tab' \|\| e\.defaultPrevented \|\| !modalStack\.length\) return;/);
  assert.match(trap, /if \(activePopover\) return;/, 'a popover over the modal keeps its own Tab');
  assert.match(trap, /else if \(!e\.shiftKey && active === last\) next = first;/);
  assert.match(trap, /else if \(e\.shiftKey && \(active === first \|\| active === card\)\) next = last;/);
});

function alertHarness() {
  const doc = { activeElement: null, body: null };
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.parentNode = null; this.listeners = {}; this.className = ''; this.attrs = {}; }
    appendChild(el) { this.children.push(el); el.parentNode = this; return el; }
    removeChild(el) { this.children.splice(this.children.indexOf(el), 1); el.parentNode = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener() {}
    click() { for (const fn of this.listeners.click || []) fn({ target: this }); }
    focus() { doc.activeElement = this; }
    get classList() { return { add() {}, remove() {}, contains: () => false }; }
  }
  doc.createElement = (tag) => new El(tag);
  doc.body = new El('body');
  const prev = new El('button');
  prev.isConnected = true;
  doc.activeElement = prev;
  const frames = [];
  const context = vm.createContext({
    document: doc,
    window: { addEventListener() {} },
    activePopover: null,
    onBackdropDismiss() {},
    getComputedStyle: () => ({ opacity: '0' }),
    requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
    cancelAnimationFrame() {},
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout() {},
  });
  const section = (start) => { const at = NATIVE.indexOf(start); return NATIVE.slice(at, NATIVE.indexOf('\n  /* ', at)); };
  vm.runInContext(`${section('  var modalStack = []')}\n${section('  function alertDialog(options)')}\nthis.modalStack = modalStack;`, context);
  return { context, doc, prev, frames };
}

test('Q15/Q18: a confirm is an alertdialog that starts on Cancel, answers Escape, and gives focus back', async () => {
  const h = alertHarness();
  const answer = h.context.alertDialog({
    title: 'Remove @ada from this group?',
    buttons: [{ label: 'Cancel', style: 'cancel' }, { label: 'Remove', style: 'destructive' }],
  });
  const card = h.doc.body.children[1];
  assert.equal(card.attrs.role, 'alertdialog');
  assert.equal(card.attrs['aria-modal'], 'true');
  assert.ok(card.attrs['aria-labelledby'], 'named by its title');
  assert.equal(h.context.modalStack.length, 1, 'on the modal stack, above any dialog it was asked from');
  const entry = h.context.modalStack[0];
  assert.equal(entry.trap, card, 'Tab stays on its buttons');
  assert.equal(entry.dismissible, true, 'Escape has an answer: Cancel');
  for (const fn of h.frames.splice(0)) fn();
  const [cancel] = card.children.at(-1).children;
  assert.equal(h.doc.activeElement, cancel, 'a destructive question starts on Cancel');
  entry.dismiss(); // what the stack's Escape handler calls
  const res = await answer;
  assert.equal(res.button.style, 'cancel');
  assert.equal(h.context.modalStack.length, 0, 'answered alerts leave the stack');
  assert.equal(h.doc.activeElement, h.prev, 'focus goes back where it was');
});

test('Q18: an alert with two answers and no cancel has no Escape, and a plain one starts on its primary', () => {
  const h = alertHarness();
  h.context.alertDialog({ title: 'Pick one', buttons: [{ label: 'A' }, { label: 'B' }] });
  assert.equal(h.context.modalStack[0].dismissible, false);
  for (const fn of h.frames.splice(0)) fn();
  const card = h.doc.body.children[1];
  assert.equal(h.doc.activeElement, card.children.at(-1).children[1], 'the last button, the primary answer');
});

// ── Q15: Messages asks through the app's confirm dialog ───────────────────

test('Q15: Messages and the group chat never call window.confirm()', () => {
  for (const file of [
    'frontend/src/features/messages/index.tsx',
    'frontend/src/features/messages/members-dialog.tsx',
    'frontend/src/features/messages/message-row.tsx',
    'frontend/src/features/messages/create-dialog.tsx',
    'frontend/src/features/group-chat/transcript.tsx',
  ]) {
    const code = read(file).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /window\.confirm\(/, `${file} asks through lib/confirm.ts`);
    assert.match(code, /confirmAction\(\{/, `${file} uses confirmAction`);
  }
});

test('Q15: confirmAction goes through ConfirmModal.show and resolves its boolean', async () => {
  const { confirmAction } = loadTsx('frontend/src/lib/confirm.ts');
  const saved = globalThis.window;
  const seen = [];
  globalThis.window = {
    ConfirmModal: { show: async (opts) => { seen.push(opts); return opts.confirmLabel === 'Leave'; } },
    confirm: () => { throw new Error('the browser confirm must not be reached'); },
  };
  try {
    assert.equal(await confirmAction({ title: 'Leave Launch crew?', confirmLabel: 'Leave', danger: true }), true);
    assert.equal(await confirmAction({ title: 'Block @ada?', confirmLabel: 'Block', danger: true }), false);
    assert.deepEqual(seen.map((o) => o.title), ['Leave Launch crew?', 'Block @ada?']);
  } finally {
    globalThis.window = saved;
  }
});

// ── Q13: the composer's suggestion list is a keyboard listbox ─────────────

test('Q13: Enter, Tab and the arrows belong to an open suggestion list before they send', () => {
  const src = read('frontend/src/features/messages/composer.tsx');
  // The :emoji menu (#2985) takes its keys ahead of this list; the two never
  // show together, since that menu opens only with no @ or # list up.
  assert.match(src, /onKeyDown=\{\(event\) => \{ if \(onEmojiKeyDown\(event\)\) return; if \(suggestionKeys\(event\)\) return; if \(event\.key === 'Enter'/,
    'the list gets the key first; Enter sends only when no list took it');
  const keys = src.slice(src.indexOf('function suggestionKeys('), src.indexOf('function insertChannel('));
  assert.match(keys, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
  assert.match(keys, /\(event\.key === 'Enter' && !event\.shiftKey\) \|\| \(event\.key === 'Tab' && !event\.shiftKey\)/);
  assert.match(keys, /event\.key === 'Escape'[\s\S]*?setDismissedAt\(value\)/);
  assert.match(src, /aria-activedescendant=\{activeOption >= 0 \? optionId\(activeOption\) : undefined\}/);
  assert.equal((src.match(/role="option" tabIndex=\{-1\} aria-selected=\{index === activeOption\}/g) || []).length, 2,
    'both the @ and the # lists');
  assert.match(read('public/css/app.css'), /\.messages-mention-menu button\[aria-selected="true"\] \{/);
  // A pick moves the caret in the render's layout effect, not a frame later,
  // so a key typed straight after Enter lands after the name it picked.
  const picks = src.slice(src.indexOf('function insertChannel('), src.indexOf('async function addFiles('));
  assert.equal((picks.match(/placeCaretAfterPick\(input, before\.length\);/g) || []).length, 2, 'the @ and the # pick');
  assert.doesNotMatch(picks, /requestAnimationFrame/);
  assert.match(src, /function placeCaretAfterPick\(input: HTMLTextAreaElement \| null, at: number\) \{\s*emojiCaret\.current = at;/);
});

// ── Q18: Skip to navigation ───────────────────────────────────────────────

test('Q18: Skip to navigation is the first island in the shell and lands on the rail, not a route', () => {
  const shell = read('frontend/src/Shell.tsx');
  const body = shell.slice(shell.indexOf('export function Shell()'));
  const first = body.match(/<Island name="([A-Za-z]+)">/);
  assert.equal(first && first[1], 'SkipToNavigation');
  const link = read('frontend/src/features/nav/skip-link.tsx');
  assert.match(link, /event\.preventDefault\(\);/, 'the fragment would route to a screen called "platform-tabs"');
  assert.match(link, /nav\.querySelectorAll<HTMLElement>\('a\.platform-tab'\)/);
  assert.match(link, /useVisibility\('platform-tabs', true\)/, 'hidden where the route has no rail');
  assert.doesNotMatch(link, /\sid=/, 'no new id in the shell inventory');
});
