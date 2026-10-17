'use strict';

// #3571 — the Messages composer stays on screen when the iPhone keyboard opens.
//
// Tapping the message field on mobile Safari panned the page up (the kit
// measured 337px of pan under a 337px keyboard inset on iPhone Safari, its
// issue #1938 history), and the column then lifted the composer by the inset
// inside the already panned page: only a sliver of the composer's card
// stayed visible at the top edge. The legacy-mounted chats attach the kit's
// keyboard avoidance — `attachKeyboardAvoidance`, whose settled pin puts the
// pan back ~120ms after the viewport burst goes quiet — through
// `PlatformUI.attachScreenFx`; the Messages conversation and its reply
// thread are React panes no controller mounts, so nothing attached it there.
// The fix is a small hook (`frontend/src/lib/composer-keyboard.ts`) that
// calls the kit directly on the two panes' scrollers.
//
// Three kinds of test here, matching the spec:
//
//   1. GEOMETRY, read from the shipped rule and the kit's own physics: with
//      the measured numbers, the reserved column puts the composer above
//      the screen with Safari's pan in, and on the keyboard line whole with
//      the pan undone.
//   2. THE KIT'S SETTLED PIN, executed: the real native.js runs in a vm
//      sandbox (a fake iPhone document — the same trick the suite uses
//      where a DOM is not available) and the assertions drive the attached
//      handlers by hand. It undoes the pan in a fixed shell, leaves a page
//      that scrolls and an unpanned page alone, and attaches nothing on
//      desktop.
//   3. THE HOOK'S LIFECYCLE and an INVENTORY of who pins which column.
//
// Run with: node --test tests/composer-keyboard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_CSS = read('public/css/app.css');
const NATIVE_SRC = read('public/usernode-native/v1/native.js');
const MESSAGES = read('frontend/src/features/messages/index.tsx');
const HOOK = read('frontend/src/lib/composer-keyboard.ts');

// ── 1. the geometry, read from the shipped rule ──────────────────────────

test('the column reserves the kit inset, and with the measured numbers the composer lands on the keyboard line once the pan is undone', () => {
  // The shipped reservation: every chat column pins its composer above the
  // keyboard this way — the scroller above, the composer a sibling below.
  const column = /html\.un-kb \.platform-kb-column \{\s*padding-bottom:\s*var\(--un-kb-inset, 0px\);/.exec(APP_CSS);
  assert.ok(column, 'html.un-kb .platform-kb-column must reserve --un-kb-inset as bottom padding');

  // The kit's own inset for the numbers its Safari measurements recorded
  // (issue #1938): layout viewport 714, visual viewport 377 → the keyboard
  // is 337px of the layout viewport.
  const { physics } = require('../public/usernode-native/v1/native.js');
  const inset = physics.keyboardInset({ layoutHeight: 714, vvHeight: 377, vvScale: 1 });
  assert.equal(inset, 337, 'the kit measures the iPhone Safari keyboard at 337px');

  // The column pins the composer's bottom edge inset above the LAYOUT
  // viewport's bottom, in page coordinates.
  const composerBottom = 714 - inset;
  assert.equal(composerBottom, 377);

  // Today — Safari panned the page up 337px on the tap, before the inset
  // published, so the visible band is page rows 337..714: the composer's
  // bottom edge is 40px below the band's TOP, its card mostly off screen.
  const panInBandTop = 337;
  assert.equal(composerBottom - panInBandTop, 40);
  // A composer card is ~90px tall, so 40px is the reported sliver: the box
  // has ridden off the top with the pan.
  assert.ok(composerBottom - panInBandTop < 90, 'with the pan in, only a sliver of the composer stays visible');

  // The fix — the settled pin puts the pan back, the band is page rows
  // 0..377, and the composer's bottom edge sits exactly on the band's
  // bottom: the keyboard line, whole.
  const panUndoneBandTop = 0;
  assert.equal(composerBottom - panUndoneBandTop, 377);
  assert.equal(composerBottom, 377, 'with the pan undone the composer bottom is the visual viewport bottom: the keyboard line');
});

// ── 2. the kit's settled pin, executed ───────────────────────────────────

// A fake iPhone document, enough of one for native.js to load and attach.
// native.js is plain JS, so a vm sandbox is enough — no JSX, no React.
function fakeEl(tagName) {
  const classes = new Set();
  return {
    nodeType: 1,
    tagName,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    addEventListener() {},
    removeEventListener() {},
    contains: () => false,
    closest: () => null,
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    style: {},
  };
}

// `overflowY` decides the fixed-shell answer the pin reads; `query` can pin
// the platform (`?un-platform=desktop`) the way the kit itself lets a host.
function kitSandbox(overflowY, query = '') {
  const sb = { console, URLSearchParams, Promise, Error, TypeError };
  sb.window = sb;
  sb.location = { search: query };
  sb.navigator = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    maxTouchPoints: 5,
  };
  const de = fakeEl('HTML');
  const body = fakeEl('BODY');
  sb.document = {
    documentElement: de,
    body,
    readyState: 'complete',
    addEventListener() {},
    createElement: () => fakeEl('DIV'),
    getElementById: () => null,
    activeElement: null,
  };
  const styles = new Map([[de, { overflowY }], [body, { overflowY: 'scroll' }]]);
  sb.getComputedStyle = (el) => styles.get(el) || { overflowY: 'scroll' };
  const vvHandlers = {};
  sb.visualViewport = {
    addEventListener: (type, fn) => { (vvHandlers[type] = vvHandlers[type] || []).push(fn); },
    removeEventListener() {},
    height: 377,
    offsetTop: 337,
  };
  sb.scrollToCalls = [];
  sb.scrollY = 0;
  sb.scrollTo = (...args) => sb.scrollToCalls.push(args);
  sb.addEventListener = () => {};
  sb.removeEventListener = () => {};
  sb.matchMedia = () => ({ matches: false });
  // The kit's timers and rAF — a vm context has none of node's globals.
  sb.setTimeout = setTimeout;
  sb.clearTimeout = clearTimeout;
  sb.setInterval = setInterval;
  sb.clearInterval = clearInterval;
  sb.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  return { sb, vvHandlers };
}

function loadKit(sb) {
  vm.createContext(sb);
  vm.runInContext(NATIVE_SRC, sb, { filename: 'native.js' });
  assert.equal(sb.unNative.platform, 'ios', 'the sandbox reads as an iPhone');
  return sb.unNative;
}

const waitSettle = () => new Promise((resolve) => setTimeout(resolve, 180)); // > KB_SETTLE_MS (120)

test('the kit attaches to the scroller and its settled pin undoes Safari pan in a fixed shell', async () => {
  const { sb, vvHandlers } = kitSandbox('hidden'); // html, body { overflow: hidden } — the fixed shell
  const un = loadKit(sb);
  const scroller = fakeEl('DIV');
  const handle = un.attachKeyboardAvoidance(scroller, { topEl: fakeEl('HEADER') });
  assert.ok(handle && typeof handle.detach === 'function');
  // The kit marks the scroller with its class (the suppression rule in
  // app.css keeps the column from reserving the inset twice).
  assert.equal(scroller.classList.contains('un-kb-avoid'), true);

  // The keyboard's burst of viewport events, then the quiet period.
  sb.scrollY = 337;
  (vvHandlers.resize || []).forEach((fn) => fn());
  await waitSettle();
  assert.deepEqual(sb.scrollToCalls, [[0, 0]], 'the settled pin scrolls the panned page back to 0 in a fixed shell');
  handle.detach();
});

test('the settled pin leaves a page that scrolls, and an unpanned page, alone', async () => {
  // A normally-scrolling page that attached an inner pane: no yank.
  const scrollable = kitSandbox('auto');
  const un = loadKit(scrollable.sb);
  const handle = un.attachKeyboardAvoidance(fakeEl('DIV'), {});
  scrollable.sb.scrollY = 337;
  (scrollable.vvHandlers.resize || []).forEach((fn) => fn());
  await waitSettle();
  assert.deepEqual(scrollable.sb.scrollToCalls, [], 'a page that scrolls itself keeps its scroll');

  // No pan to undo: the pin is a no-op there too.
  const unpanned = kitSandbox('hidden');
  const un2 = loadKit(unpanned.sb);
  const handle2 = un2.attachKeyboardAvoidance(fakeEl('DIV'), {});
  (unpanned.vvHandlers.resize || []).forEach((fn) => fn());
  await waitSettle();
  assert.deepEqual(unpanned.sb.scrollToCalls, [], 'an unpanned page is left alone');
  handle.detach();
  handle2.detach();
});

test('the kit attaches nothing on desktop', () => {
  const { sb } = kitSandbox('hidden', '?un-platform=desktop');
  vm.createContext(sb);
  vm.runInContext(NATIVE_SRC, sb, { filename: 'native.js' });
  assert.equal(sb.unNative.platform, 'desktop');
  const scroller = fakeEl('DIV');
  const handle = sb.unNative.attachKeyboardAvoidance(scroller, {});
  assert.deepEqual(sb.scrollToCalls, []);
  assert.equal(scroller.classList.contains('un-kb-avoid'), false, 'desktop: no class, no attachment — the hook is inert there');
  assert.equal(typeof handle.detach, 'function');
  handle.detach();
});

// ── 3. the hook's lifecycle ──────────────────────────────────────────────

// The suite has no React and no DOM (`npm test` runs without
// frontend/node_modules' render tree), so the hook is driven through the
// same stubbed-React trick dialog-suspend-exit.test.js uses: useEffect is
// captured and run by hand, exactly as React would.
let lastEffect = null;
const reactStub = { useEffect(fn, deps) { lastEffect = { fn, deps }; } };
const { attachComposerKeyboard, useComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts', {
  stubs: { react: reactStub },
});

let calls; // [[scroller, opts]] the fake kit received
let detached;
const realDocument = globalThis.document;
const header = fakeEl2('HEADER');
function fakeEl2(tagName) {
  return { nodeType: 1, tagName };
}

function installKit(attachImpl) {
  calls = [];
  detached = [];
  globalThis.window = globalThis;
  globalThis.unNative = {
    attachKeyboardAvoidance(el, opts) {
      calls.push([el, opts]);
      const handle = { detach: () => detached.push(el) };
      if (attachImpl) return attachImpl(el, opts, handle);
      return handle;
    },
  };
  globalThis.document = { getElementById: (id) => (id === 'platform-header' ? header : null) };
}
function uninstallKit() {
  delete globalThis.unNative;
  delete globalThis.document;
  if (realDocument === undefined) delete globalThis.window;
  else globalThis.window = realDocument;
}

test('attachComposerKeyboard hands the kit the scroller and the platform header, and the detach detaches', () => {
  installKit();
  try {
    const scroller = fakeEl2('DIV');
    const detach = attachComposerKeyboard(scroller);
    assert.deepEqual(calls, [[scroller, { topEl: header }]], 'the kit gets the scroller and #platform-header as topEl');
    assert.equal(typeof detach, 'function');
    detach();
    assert.deepEqual(detached, [scroller], 'the detach detaches the kit handle');
    // Never throws twice.
    detach();
    assert.equal(detached.length, 1, 'detaching again is a no-op, not a throw');
  } finally { uninstallKit(); }
});

test('useComposerKeyboard attaches once on mount, re-attaches on a new node, detaches on unmount', () => {
  installKit();
  try {
    const ref = { current: fakeEl2('DIV') };
    lastEffect = null;
    useComposerKeyboard(ref);
    assert.ok(lastEffect, 'the hook registers one effect');
    // Mount.
    let cleanup = lastEffect.fn();
    assert.equal(calls.length, 1, 'one attach on mount');
    assert.equal(calls[0][0], ref.current);
    // React hands the scroller a new node (a re-mounted pane): cleanup, then
    // the effect again.
    const old = ref.current;
    ref.current = fakeEl2('DIV');
    cleanup();
    assert.deepEqual(detached, [old], 'the old node is detached first');
    cleanup = lastEffect.fn();
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], ref.current, 'the new node is attached in its place');
    // Unmount.
    cleanup();
    assert.deepEqual(detached, [old, ref.current]);
  } finally { uninstallKit(); }
});

test('no element, no kit, a throwing kit: the hook stays a no-op and never breaks an unmount', () => {
  installKit();
  try {
    assert.equal(calls.length, 0);
    const emptyRef = { current: null };
    let cleanup = attachComposerKeyboard(null);
    cleanup();
    assert.deepEqual(calls, [], 'no element: the kit is never called, the detach is a no-op');
    lastEffect = null;
    useComposerKeyboard(emptyRef);
    cleanup = lastEffect.fn();
    cleanup();
    assert.deepEqual(calls, [], 'an unmounted ref is a no-op too');

    delete globalThis.unNative;
    const detachNoKit = attachComposerKeyboard(fakeEl2('DIV'));
    assert.doesNotThrow(detachNoKit, 'without the kit, attach returns a detach that never throws');

    installKit((el, opts, handle) => { throw new Error('kit exploded'); });
    let throwingDetach;
    assert.doesNotThrow(() => { throwingDetach = attachComposerKeyboard(fakeEl2('DIV')); }, 'a throwing kit call does not propagate');
    assert.doesNotThrow(throwingDetach, 'its detach never throws either');
  } finally { uninstallKit(); }
});

// ── 4. the inventory: every column's scroller has the kit's pin ──────────

// The four legacy-mounted columns are pinned by their controllers'
// `attachScreenFx` calls; the two Messages panes by the hook. A new
// `.platform-kb-column` that neither of those covers fails here — the same
// sliver, one screen later.
test('every .platform-kb-column in frontend/src has the kit pin on its scroller', () => {
  const FRONTEND_SRC = path.join(ROOT, 'frontend', 'src');
  const carriers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(tsx?|js)$/.test(entry.name)) {
        const rel = path.relative(ROOT, p).split(path.sep).join('/');
        const src = fs.readFileSync(p, 'utf8');
        if (/className="[^"]*platform-kb-column/.test(src) || /className=\{`[^`]*platform-kb-column/.test(src)) carriers.push(rel);
      }
    }
  };
  walk(FRONTEND_SRC);
  assert.deepEqual(carriers.sort(), [
    'frontend/src/features/dev-chat/view.tsx',
    'frontend/src/features/group-chat/general-chat.tsx',
    'frontend/src/features/group-chat/thread-shell.tsx',
    'frontend/src/features/messages/index.tsx',
  ], 'the set of columns is known: a new one needs its pin added and this list extended');

  // The two Messages panes, by the hook.
  const hookCalls = MESSAGES.match(/useComposerKeyboard\(scroller\)/g) || [];
  assert.equal(hookCalls.length, 2, 'both Messages panes call useComposerKeyboard(scroller)');
  assert.ok(HOOK.includes('useComposerKeyboard'), 'the hook is the one composer-keyboard.ts defines');

  // …before their early returns, so the hook order holds.
  const conversation = MESSAGES.slice(MESSAGES.indexOf('function ConversationThread'));
  const reply = MESSAGES.slice(MESSAGES.indexOf('function ReplyThreadPanel'));
  assert.ok(conversation.indexOf('useComposerKeyboard(scroller)') < conversation.indexOf("snap.route.embedded !== embedded"),
    'ConversationThread calls the hook before its first early return');
  assert.ok(reply.indexOf('useComposerKeyboard(scroller)') < reply.indexOf('if (!conversationId || !rootId) return null'),
    'ReplyThreadPanel calls the hook before its early return (it returns null without a thread root)');

  // …and their scroller className stays a constant literal without
  // `un-kb-avoid` (the kit adds that class at runtime; React must not
  // render or strip it).
  assert.ok(MESSAGES.includes('className="messages-thread-scroll platform-safe-scroll"'),
    'the conversation scroller keeps its constant literal class');
  assert.ok(MESSAGES.includes('className="messages-thread-scroll messages-reply-scroll platform-safe-scroll"'),
    'the thread scroller keeps its constant literal class');
  assert.doesNotMatch(MESSAGES, /className=[^>]*un-kb-avoid/, 'no Messages source renders un-kb-avoid');

  // The legacy-mounted ones, by their controller's attachScreenFx call.
  const pairs = [
    ['frontend/src/features/group-chat/general-chat.tsx', 'public/js/app-view.js', 'gc-messages'],
    ['frontend/src/features/group-chat/thread-shell.tsx', 'public/js/group-chat.js', 'gc-thread-scroll'],
    ['frontend/src/features/dev-chat/view.tsx', 'frontend/src/features/dev-chat/dev-chat.js', 'dc-messages'],
  ];
  for (const [reactFile, controller, scrollerId] of pairs) {
    const reactSrc = read(reactFile);
    assert.ok(reactSrc.includes(`id="${scrollerId}"`),
      `${reactFile} renders the scroller #${scrollerId}`);
    const attach = read(controller);
    assert.ok(attach.includes('attachScreenFx'), `${controller} attaches the kit through attachScreenFx`);
    assert.ok(attach.includes(scrollerId), `${controller} attaches it on #${scrollerId}`);
  }
});

test('the existing suppression rule still keeps the kit class from reserving the inset twice', () => {
  const inner = /html\.un-kb \.platform-kb-column \.un-kb-avoid\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(inner, 'html.un-kb .platform-kb-column .un-kb-avoid rule is missing');
  assert.match(inner[1], /padding-bottom:\s*0/, 'the kit class pads nothing inside a column');
});