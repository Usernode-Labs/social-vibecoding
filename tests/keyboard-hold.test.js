'use strict';
// 5 October 2026, two reports of one family:
//
//   - iOS Homeroom app, the Homeroom bot's DM: tapping the message box to
//     reply sent the transcript back to its oldest line ("11:27 AM … Here's
//     yours:"), so the message being answered was off screen while typing.
//   - iOS Safari, a project's Discussion tab, as an invitee: tapping in to
//     talk left a blank cream page with the keys up; no messages, no
//     composer, no header.
//
// Both chats decide whether to follow new lines from the scroller's own
// scroll events, and the keys arriving move the scroller as well as the
// reader does. Four parts:
//   1. lib/keyboard-hold.ts executed against fakes: a composer focused while
//      the reader is at the newest line holds the bottom while the keys
//      arrive, and lets the reader take over at once;
//   2. Messages' conversation (stick-to-bottom.ts) uses it: a scroll the
//      keyboard caused does not un-pin the thread;
//   3. the group chat (a classic script) uses the same hold;
//   4. app.css lays the Discussion tab's room on the visible band while the
//      keys are up in a phone browser, and nothing focuses its composer on
//      open.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const hold = loadTsx('frontend/src/lib/keyboard-hold.ts');

function listening(props = {}) {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); },
    fire(type, event = {}) { (listeners[type] || []).slice().forEach((fn) => fn(event)); },
    count(type) { return (listeners[type] || []).length; },
    ...props,
  };
}

// A transcript beside its composer, in a column, in a window with a clock.
function chat({ scrollTop = 1400 } = {}) {
  let clock = 0;
  let seq = 0;
  const timers = [];
  const composer = { nodeType: 1, tagName: 'TEXTAREA' };
  const cardInput = { nodeType: 1, tagName: 'INPUT', type: 'text' };
  const column = listening();
  let top = scrollTop;
  const el = listening({
    nodeType: 1,
    isConnected: true,
    parentElement: column,
    scrollHeight: 2000,
    clientHeight: 600,
    children: [],
    contains: (node) => node === cardInput,
    scroll() { this.fire('scroll'); },
  });
  // A browser's clamp (an accessor: a spread would have copied a value).
  Object.defineProperty(el, 'scrollTop', {
    get() { return top; },
    set(v) { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)); },
  });
  const env = listening({
    visualViewport: listening(),
    performance: { now: () => clock },
    setTimeout(fn, ms) { seq += 1; timers.push({ id: seq, fn, due: clock + ms }); return seq; },
    clearTimeout(id) { const at = timers.findIndex((t) => t.id === id); if (at >= 0) timers.splice(at, 1); },
  });
  const advance = (ms) => {
    const end = clock + ms;
    for (;;) {
      const due = timers.filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      clock = due.due;
      due.fn();
    }
    clock = end;
  };
  return { el, column, env, composer, cardInput, advance, get timers() { return timers.length; } };
}

// ── 1. The hold ─────────────────────────────────────────────────────────

test('isTypingField: what raises a text keyboard', () => {
  const { isTypingField } = hold;
  assert.equal(isTypingField({ nodeType: 1, tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingField({ nodeType: 1, tagName: 'INPUT' }), true, 'no type is text');
  assert.equal(isTypingField({ nodeType: 1, tagName: 'INPUT', type: 'search' }), true);
  assert.equal(isTypingField({ nodeType: 1, tagName: 'DIV', isContentEditable: true }), true);
  for (const type of ['checkbox', 'button', 'file', 'date']) {
    assert.equal(isTypingField({ nodeType: 1, tagName: 'INPUT', type }), false, type);
  }
  assert.equal(isTypingField({ nodeType: 1, tagName: 'TEXTAREA', readOnly: true }), false);
  assert.equal(isTypingField({ nodeType: 1, tagName: 'BUTTON' }), false);
  assert.equal(isTypingField(null), false);
});

test('the composer focused at the newest line holds it while the keys arrive, then lets go', () => {
  const { attachKeyboardHold, KEYBOARD_HOLD_MS, KEYBOARD_SETTLE_MS } = hold;
  assert.equal(KEYBOARD_HOLD_MS, 1200);
  assert.equal(KEYBOARD_SETTLE_MS, 400);
  const c = chat();
  let follows = 0;
  const h = attachKeyboardHold(c.el, { pinned: () => true, follow: () => { follows += 1; } }, c.env);
  assert.equal(h.holding(), false);
  c.column.fire('focusin', { target: c.composer });
  assert.equal(h.holding(), true);
  // The keys: the host resizes, and each resize puts the newest line back
  // and keeps the hold a little longer.
  c.advance(1000);
  c.env.visualViewport.fire('resize');
  assert.equal(follows, 1);
  c.advance(399);
  assert.equal(h.holding(), true, 'held past the first 1200ms by the late resize');
  c.env.fire('resize');
  assert.equal(follows, 2, 'the window\'s resize too: the app resizes its web view');
  c.advance(400);
  assert.equal(h.holding(), false);
  assert.equal(follows, 3, 'and one last look when the hold runs out');
  assert.equal(c.timers, 0, 'no timer left behind');
});

test('the reader\'s own hand ends the hold; a field in the transcript or a reader up in history holds nothing', () => {
  const { attachKeyboardHold } = hold;
  const c = chat();
  const h = attachKeyboardHold(c.el, { pinned: () => true, follow() {} }, c.env);
  for (const hand of ['touchstart', 'wheel', 'pointerdown', 'keydown']) {
    c.column.fire('focusin', { target: c.composer });
    assert.equal(h.holding(), true);
    c.el.fire(hand);
    assert.equal(h.holding(), false, `${hand} on the transcript is the reader`);
  }
  c.column.fire('focusin', { target: c.cardInput });
  assert.equal(h.holding(), false, 'a card\'s own input inside the transcript');
  c.column.fire('focusin', { target: { nodeType: 1, tagName: 'BUTTON' } });
  assert.equal(h.holding(), false, 'Send takes no keyboard');

  const up = chat();
  const reading = attachKeyboardHold(up.el, { pinned: () => false, follow() {} }, up.env);
  up.column.fire('focusin', { target: up.composer });
  assert.equal(reading.holding(), false, 'a reader up in the history is never moved');
});

test('detach lets go of everything, and a transcript taken off the page lets go by itself', () => {
  const { attachKeyboardHold } = hold;
  const c = chat();
  const h = attachKeyboardHold(c.el, { pinned: () => true, follow() {} }, c.env);
  assert.equal(c.column.count('focusin'), 1);
  assert.equal(c.env.visualViewport.count('resize'), 1);
  assert.equal(c.env.count('resize'), 1);
  h.detach();
  assert.equal(c.column.count('focusin'), 0);
  assert.equal(c.env.visualViewport.count('resize'), 0);
  assert.equal(c.env.count('resize'), 0);
  for (const hand of ['touchstart', 'wheel', 'pointerdown', 'keydown']) assert.equal(c.el.count(hand), 0);

  const gone = chat();
  attachKeyboardHold(gone.el, { pinned: () => true, follow() {} }, gone.env);
  gone.el.isConnected = false; // the group chat re-renders its pane
  gone.env.visualViewport.fire('resize');
  assert.equal(gone.env.visualViewport.count('resize'), 0);
});

// ── 2. Messages' conversation ──────────────────────────────────────────

test('the DM: a scroll the keyboard caused does not send the thread to its oldest line', () => {
  const { attachStickToBottom } = loadTsx('frontend/src/features/messages/stick-to-bottom.ts');
  const c = chat({ scrollTop: 1400 });
  const pinned = { current: true };
  attachStickToBottom(c.el, pinned, { current: true }, c.env);
  c.el.scroll(); // where the reader left it: the bottom
  assert.equal(pinned.current, true);
  // Tap the message box; the keys come up, and something puts the
  // transcript back at its top with a scroll event.
  c.column.fire('focusin', { target: c.composer });
  c.el.scrollTop = 0;
  c.el.scroll();
  assert.equal(pinned.current, true, 'still pinned: that was not the reader');
  assert.equal(c.el.scrollTop, 1400, 'back at the newest line');
  // The keys took height: the resize follows.
  c.el.clientHeight = 300;
  c.env.visualViewport.fire('resize');
  assert.equal(c.el.scrollTop, 1700);
  // The reader scrolls up to read while typing: theirs, and respected.
  c.el.fire('touchstart');
  c.el.scrollTop = 500;
  c.el.scroll();
  assert.equal(pinned.current, false);
  c.advance(2000);
  assert.equal(c.el.scrollTop, 500, 'never yanked down');
});

test('without the keyboard a scroll is still the reader\'s, exactly as before', () => {
  const { attachStickToBottom } = loadTsx('frontend/src/features/messages/stick-to-bottom.ts');
  const c = chat({ scrollTop: 1400 });
  const pinned = { current: true };
  attachStickToBottom(c.el, pinned, { current: true }, c.env);
  c.el.scrollTop = 200;
  c.el.scroll();
  assert.equal(pinned.current, false);
  const src = read('frontend/src/features/messages/stick-to-bottom.ts');
  assert.match(src, /import \{ attachKeyboardHold, type HoldEnv \} from '\.\.\/\.\.\/lib\/keyboard-hold';/);
  assert.match(src, /if \(hold\.holding\(\)\) \{\s*\/\/[^\n]*\n\s*if \(pinned\.current && !isNearBottom\(el, 1\)\) follow\(\);\s*return;\s*\}\s*pinned\.current = atPresent\.current && isNearBottom\(el\);/);
});

// ── 3. The group chat ──────────────────────────────────────────────────

test('the group chat holds its newest line through the keys with the same hold', () => {
  const gc = read('public/js/group-chat.js');
  const attach = gc.slice(gc.indexOf('  attachScrollHandlers() {'), gc.indexOf('  // ── A bell row\'s message, brought into view'));
  assert.match(attach, /const hold = window\.UsernodeKeyboardHold\s*\?\s*window\.UsernodeKeyboardHold\.attach\(container, \{\s*pinned: \(\) => !!GroupChat\._lockedToBottom,\s*follow: pinBottom,\s*\}\)\s*: null;/);
  // While held, a scroll is the keyboard's: back to the bottom, still locked,
  // and no history load from a scroll to 0.
  assert.match(attach, /container\.addEventListener\('scroll', \(\) => \{\s*if \(hold && hold\.holding\(\)\) \{[\s\S]*?pinBottom\(\);\s*return;\s*\}\s*if \(container\.scrollTop === 0 && GroupChat\.hasMore\) \{/);
  // The global is published from the boot bundle, beside keyboard-open.
  const main = read('frontend/src/main.tsx');
  assert.ok(main.indexOf("import './lib/keyboard-hold';") > main.indexOf("import './lib/keyboard-open';"));
  assert.match(read('frontend/src/lib/keyboard-hold.ts'), /UsernodeKeyboardHold = \{\s*attach: attachKeyboardHold,\s*\};/);
});

// ── 4. The Discussion tab in a phone browser ────────────────────────────

test('with the keys up in a phone browser the Discussion room is laid on the visible band, composer on the keys', () => {
  const css = read('public/css/app.css');
  const block = css.slice(css.indexOf('/* WITH THE KEYBOARD UP IN A PHONE BROWSER, THE ROOM IS WHAT IS SEEN'));
  const rules = block.slice(block.indexOf('@media (max-width: 767px) {'), block.indexOf('\n}\n') + 2);
  assert.match(rules, /html\[data-browser-scroller\]\.platform-kb-open \.dev-ws-discussion \{\s*position: fixed;\s*left: 0;\s*right: 0;\s*top: var\(--platform-vv-top, 0px\);\s*bottom: var\(--platform-kb-cover, 0px\);/);
  // The column reserves nothing more: the band already ends at the keys.
  assert.match(rules, /html\[data-browser-scroller\]\.platform-kb-open \.dev-ws-discussion \.platform-kb-column \{\s*padding-bottom: 0;\s*\}/);
  // It outranks the kit's reservation (html.un-kb .platform-kb-column).
  assert.match(css, /html\.un-kb \.platform-kb-column \{\s*padding-bottom: var\(--un-kb-inset, 0px\);/);
  // The bounded shell (the app, an installed app) is untouched: no
  // data-browser-scroller there.
  assert.doesNotMatch(rules, /html\.platform-kb-open \.dev-ws-discussion \{/);
});

test('opening the Discussion tab puts no caret in its composer: only a tap, or a reply on a mouse, does', () => {
  const discussion = read('frontend/src/features/dev-board/workshop/project-discussion.tsx');
  assert.doesNotMatch(discussion, /\.focus\(/);
  const general = read('frontend/src/features/group-chat/general-chat.tsx');
  assert.doesNotMatch(general, /autoFocus|\.focus\(/);
  const view = read('public/js/app-view.js');
  const tab = view.slice(view.indexOf('  renderGroupChatTab(ctx) {'), view.indexOf('  renderGroupChatTab(ctx) {') + 9000);
  assert.doesNotMatch(tab, /gcInput\.focus\(/);
  // A staged reply only takes the caret where there is a fine pointer.
  assert.match(read('public/js/group-chat.js'), /if \(fine\) input\.focus\(\);/);
});
