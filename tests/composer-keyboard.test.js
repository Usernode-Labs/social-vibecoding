'use strict';
// #3571: "Clicking the message field on mobile Safari to reply to a message
// sends the message box off screen as the keyboard comes up."
//
// Every chat screen reserves the kit's keyboard inset on its composer column
// (`.platform-kb-column`, #1937). On iOS that is only safe together with the
// kit's settled pin (native.js attachKeyboardAvoidance -> settledPin), which
// puts back the pan Safari makes on the tap. The legacy-mounted chats get the
// pin from PlatformUI.attachScreenFx; the Messages conversation and its reply
// thread are React's and had nothing, so the pan stayed and the lifted
// composer sat above the top of the screen.
//
// Four parts:
//   1. the geometry, evaluated from the shipped rule with the measured iOS
//      numbers: panned, the composer is off screen; pan undone, it is on the
//      keyboard line;
//   2. the kit's own settled pin, executed: it undoes the pan in a fixed
//      shell, and only there;
//   3. lib/composer-keyboard.ts, executed: the attach/detach and the hook's
//      lifecycle against a stubbed React;
//   4. an inventory: every column that reserves the inset has the pin
//      attached to its scroller, by a legacy controller or by the hook.
//
// What this cannot do is raise a real iOS keyboard. The numbers in (1) are
// the kit's own Safari measurements (#1938, recorded in native.js's history).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_CSS = read('public/css/app.css');
const NATIVE_JS = read('public/usernode-native/v1/native.js');
const { physics } = require('../public/usernode-native/v1/native.js');

// iPhone Safari with the keyboard up, as the kit measured it (#1938): the
// layout viewport (documentElement.clientHeight) stays 714, the visual
// viewport is 377, and Safari has panned the page by 337 to reveal the field.
const LAYOUT = 714;
const VV_HEIGHT = 377;
const PAN = 337;
const COMPOSER = 64; // a composer card, one line, no reply banner
const REPLY_BANNER = 50; // "Replying to @…" adds this much above the field

// ── 1. The geometry ─────────────────────────────────────────────────────

function columnPadding(inset) {
  const rule = /html\.un-kb \.platform-kb-column\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(rule, 'html.un-kb .platform-kb-column rule is missing');
  const m = /padding-bottom:\s*var\(--un-kb-inset,\s*0px\)/.exec(rule[1]);
  assert.ok(m, 'the column reserves the kit inset as its bottom padding');
  return inset;
}

// Where the composer is ON SCREEN (visual viewport px) with the column's
// reservation applied, given the page's pan.
function composerOnScreen({ pan, banner = 0 }) {
  const inset = physics.keyboardInset({ layoutHeight: LAYOUT, vvHeight: VV_HEIGHT, vvScale: 1 });
  assert.equal(inset, 337, 'the kit measures the keyboard against the layout viewport');
  const bottom = LAYOUT - columnPadding(inset); // layout px: the column's content edge
  const top = bottom - COMPOSER - banner;
  return { top: top - pan, bottom: bottom - pan };
}

test('panned by Safari, the reserved column puts the composer above the screen', () => {
  // This is the report: the composer lifted by the inset INSIDE a page Safari
  // has already moved up by the same amount.
  const plain = composerOnScreen({ pan: PAN });
  assert.ok(plain.top < 0, `the composer's top is off screen (${plain.top})`);
  assert.ok(plain.bottom < COMPOSER, 'and most of it with it');
  const reply = composerOnScreen({ pan: PAN, banner: REPLY_BANNER });
  assert.ok(reply.top < plain.top, 'a reply banner pushes more of it off the top');
});

test('with the pan put back, the composer sits on the keyboard line, whole', () => {
  for (const banner of [0, REPLY_BANNER]) {
    const box = composerOnScreen({ pan: 0, banner });
    assert.ok(box.top >= 0, 'its top is on screen');
    assert.equal(box.bottom, VV_HEIGHT, 'its bottom is exactly the top of the keys');
  }
});

// ── 2. The kit's settled pin, executed ──────────────────────────────────

function kitHarness({ scrollY = PAN, overflowY = 'hidden', platform = 'ios' } = {}) {
  const start = NATIVE_JS.indexOf('  var KB_TAP_SLOP');
  const end = NATIVE_JS.lastIndexOf('  /*', NATIVE_JS.indexOf('Spring tuner (?un-tune=1)', start));
  assert.ok(start > 0 && end > start, 'the kit\'s attachKeyboardAvoidance section exists');
  const vvListeners = {};
  const timers = [];
  const scrolledTo = [];
  const classes = new Set();
  const scrollEl = {
    nodeType: 1,
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
    },
    addEventListener() {},
    removeEventListener() {},
    contains: () => false, // the composer is OUTSIDE the scroller, below it
  };
  const win = {
    visualViewport: {
      addEventListener: (type, fn) => { vvListeners[type] = fn; },
      removeEventListener: (type) => { delete vvListeners[type]; },
    },
    scrollY,
    pageYOffset: scrollY,
    scrollTo: (x, y) => { scrolledTo.push([x, y]); win.scrollY = y; win.pageYOffset = y; },
    innerHeight: VV_HEIGHT,
  };
  const doc = { activeElement: null, documentElement: { classList: { contains: () => true } }, body: {} };
  const ctx = vm.createContext({
    window: win,
    document: doc,
    console,
    platform,
    prefersReducedMotion: false,
    kbInset: 337,
    gestures: { owner: () => null },
    isTextEntryField: physics.isTextEntryField,
    revealScrollDelta: physics.revealScrollDelta,
    getComputedStyle: () => ({ overflowY }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
  });
  vm.runInContext(NATIVE_JS.slice(start, end), ctx);
  const handle = ctx.attachKeyboardAvoidance(scrollEl, {});
  return { win, vvListeners, timers, scrolledTo, classes, handle };
}

test('the kit\'s settled pin puts a fixed shell\'s keyboard pan back', () => {
  const h = kitHarness();
  assert.ok(h.classes.has('un-kb-avoid'), 'the kit marks the scroller it attached to');
  assert.ok(h.vvListeners.resize, 'it follows the visual viewport');
  h.vvListeners.resize();
  h.vvListeners.resize(); // the keyboard opens in a burst
  const live = h.timers.filter((t) => t.ms === 120);
  assert.equal(live.length, 2);
  live.forEach((t) => t.fn()); // the first was cleared: only the last acts
  assert.deepEqual(h.scrolledTo, [[0, 0]], 'once, ~120ms after the burst goes quiet');
  h.handle.detach();
  assert.ok(!h.classes.has('un-kb-avoid'), 'detach takes the class back off');
  assert.equal(h.vvListeners.resize, undefined, 'and stops listening');
});

test('the pin leaves a page that scrolls, and an unpanned page, alone', () => {
  const paged = kitHarness({ overflowY: 'auto' });
  paged.vvListeners.resize();
  paged.timers.at(-1).fn();
  assert.deepEqual(paged.scrolledTo, [], 'a normally scrolling document is never yanked');
  const flat = kitHarness({ scrollY: 0 });
  flat.vvListeners.resize();
  flat.timers.at(-1).fn();
  assert.deepEqual(flat.scrolledTo, [], 'nothing to put back');
});

test('the kit attaches nothing on desktop', () => {
  const h = kitHarness({ platform: 'desktop' });
  assert.ok(!h.classes.has('un-kb-avoid'));
  assert.equal(h.vvListeners.resize, undefined);
});

// ── 3. lib/composer-keyboard.ts, executed ───────────────────────────────

// Just enough React for one hook: refs that persist across renders, effects
// run after a "commit" when their deps change, cleanups on change and unmount.
function fakeReact() {
  let slots = [];
  let i = 0;
  const pending = [];
  const React = {
    useRef(init) {
      const k = i++;
      if (!slots[k]) slots[k] = { current: init };
      return slots[k];
    },
    useEffect(fn, deps) {
      const k = i++;
      const prev = slots[k];
      const changed = !prev || !deps || !prev.deps || deps.some((d, j) => d !== prev.deps[j]);
      if (!prev) slots[k] = { deps, cleanup: null };
      if (changed) pending.push(() => {
        if (slots[k].cleanup) slots[k].cleanup();
        slots[k].deps = deps;
        const c = fn();
        slots[k].cleanup = typeof c === 'function' ? c : null;
      });
    },
  };
  return {
    React,
    render(hook) { i = 0; hook(); pending.splice(0).forEach((run) => run()); },
    unmount() { slots.forEach((s) => s && s.cleanup && s.cleanup()); slots = []; },
  };
}

function fakeKit() {
  const calls = [];
  const kit = {
    attachKeyboardAvoidance(el, opts) {
      const call = { el, opts, detached: 0 };
      calls.push(call);
      return { detach: () => { call.detached += 1; } };
    },
  };
  return { kit, calls };
}

const HEADER = { id: 'platform-header' };
const DOC = { getElementById: (id) => (id === 'platform-header' ? HEADER : null) };

test('attachComposerKeyboard hands the kit the scroller and the platform header', () => {
  const { attachComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts');
  const { kit, calls } = fakeKit();
  const el = { nodeType: 1 };
  const detach = attachComposerKeyboard(el, { unNative: kit }, DOC);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].el, el);
  assert.equal(calls[0].opts.topEl, HEADER, 'the bar the group chat is handed too');
  detach();
  detach();
  assert.equal(calls[0].detached, 1, 'detach is idempotent');
});

test('a screen with a bar of its own hands the kit that bar instead (the first session\'s make screen)', () => {
  const { attachComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts');
  const { kit, calls } = fakeKit();
  const bar = { id: 'make-bar' };
  attachComposerKeyboard({ nodeType: 1 }, { unNative: kit }, DOC, bar);
  assert.equal(calls[0].opts.topEl, bar);
  attachComposerKeyboard({ nodeType: 1 }, { unNative: kit }, DOC, null);
  assert.deepEqual(calls[1].opts, {}, 'null: no bar, the scroller\'s own top');
  attachComposerKeyboard({ nodeType: 1 }, { unNative: kit }, DOC);
  assert.equal(calls[2].opts.topEl, HEADER, 'left out: the platform header, as before');
});

test('useComposerKeyboard hands over the bar its second ref holds', () => {
  const r = fakeReact();
  const { useComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts', { stubs: { react: r.React } });
  const { kit, calls } = fakeKit();
  const prevWin = global.window;
  const prevDoc = global.document;
  global.window = { unNative: kit };
  global.document = DOC;
  try {
    const scroller = { current: { nodeType: 1 } };
    const bar = { current: { id: 'make-bar' } };
    r.render(() => useComposerKeyboard(scroller, bar));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.topEl, bar.current);
    r.unmount();
    assert.equal(calls[0].detached, 1);
  } finally {
    global.window = prevWin;
    global.document = prevDoc;
  }
});

test('attachComposerKeyboard is a no-op without an element or a kit, and survives a throwing kit', () => {
  const { attachComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts');
  const { kit, calls } = fakeKit();
  assert.doesNotThrow(() => attachComposerKeyboard(null, { unNative: kit }, DOC)());
  assert.equal(calls.length, 0);
  assert.doesNotThrow(() => attachComposerKeyboard({ nodeType: 1 }, {}, DOC)());
  const throwing = { attachKeyboardAvoidance() { throw new Error('boom'); } };
  assert.doesNotThrow(() => attachComposerKeyboard({ nodeType: 1 }, { unNative: throwing }, DOC)());
});

test('useComposerKeyboard follows the scroller: attaches when it appears, once, and detaches when it goes', () => {
  const r = fakeReact();
  const { useComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts', { stubs: { react: r.React } });
  const { kit, calls } = fakeKit();
  const prevWin = global.window;
  const prevDoc = global.document;
  global.window = { unNative: kit };
  global.document = DOC;
  try {
    const ref = { current: null };
    const use = () => useComposerKeyboard(ref);
    r.render(use); // the empty state: no scroller rendered
    assert.equal(calls.length, 0);
    const first = { nodeType: 1 };
    ref.current = first;
    r.render(use); // a conversation opens
    assert.equal(calls.length, 1);
    assert.equal(calls[0].el, first);
    r.render(use); // a new message, the same node
    r.render(use);
    assert.equal(calls.length, 1, 'no re-attach while the node is the same');
    const second = { nodeType: 1 };
    ref.current = second;
    r.render(use); // React handed it a new node
    assert.equal(calls[0].detached, 1, 'the old node is let go');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].el, second);
    r.unmount();
    assert.equal(calls[1].detached, 1, 'unmount detaches');
  } finally {
    global.window = prevWin;
    global.document = prevDoc;
  }
});

// ── 4. Every reserving column has the pin ───────────────────────────────

// A column that reserves the keyboard inset, and where the kit's avoidance is
// attached to its scroller. A new column fails here until it says.
const COLUMNS = {
  'frontend/src/features/group-chat/general-chat.tsx': {
    file: 'public/js/app-view.js',
    re: /attachScreenFx\(\s*'group-chat',\s*document\.getElementById\('gc-messages'\)/,
  },
  'frontend/src/features/group-chat/thread-shell.tsx': {
    file: 'public/js/group-chat.js',
    re: /attachScreenFx\(\s*'gc-thread',\s*container\.querySelector\('#gc-thread-scroll'\)/,
  },
  'frontend/src/features/dev-chat/view.tsx': {
    file: 'frontend/src/features/dev-chat/dev-chat.js',
    re: /attachScreenFx\(\s*'dev-chat',\s*document\.getElementById\('dc-messages'\)/,
  },
  'frontend/src/features/messages/index.tsx': { hook: true },
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (/\.(tsx|ts|jsx|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const WORN = /className=(?:"[^"]*"|\{`[^`]*`\})/g;

test('every column that reserves the keyboard inset has the kit\'s pin on its scroller', () => {
  const found = walk('frontend/src').filter((file) =>
    (read(file).match(WORN) || []).some((c) => c.includes('platform-kb-column')));
  assert.deepEqual(found.sort(), Object.keys(COLUMNS).sort(),
    'a new platform-kb-column must attach the kit (lib/composer-keyboard.ts) and be listed here');
  for (const [file, where] of Object.entries(COLUMNS)) {
    if (where.hook) continue;
    assert.match(read(where.file), where.re, `${file}: its scroller gets attachScreenFx in ${where.file}`);
  }
});

// The body of one top-level function in a source file.
function fnBody(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start > -1, `${name} is defined`);
  const next = src.indexOf('\nfunction ', start + 1);
  const nextExport = src.indexOf('\nexport function ', start + 1);
  const ends = [next, nextExport].filter((n) => n > -1);
  return src.slice(start, ends.length ? Math.min(...ends) : undefined);
}

test('Messages: the conversation and its reply thread attach the kit to the scroller they render', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  assert.match(src, /import \{ useComposerKeyboard \} from '\.\.\/\.\.\/lib\/composer-keyboard';/);
  for (const name of ['ConversationThread', 'ReplyThreadPanel']) {
    const body = fnBody(src, name);
    assert.ok((body.match(WORN) || []).some((c) => c.includes('platform-kb-column')),
      `${name} draws a reserving column`);
    assert.match(body, /useComposerKeyboard\(scroller\);/, `${name} attaches the kit's keyboard avoidance`);
    // The kit adds `un-kb-avoid` to this node at runtime; a className that
    // changes between renders would have React strip it again.
    const scroller = /<div ref=\{scroller\} className=("[^"]*")/.exec(body);
    assert.ok(scroller, `${name}'s scroller has a constant, literal className`);
    assert.ok(!scroller[1].includes('un-kb-avoid'), 'and does not write the kit\'s class itself');
  }
  // Called before ConversationThread's early returns, so the hook order holds.
  const conv = fnBody(src, 'ConversationThread');
  assert.ok(conv.indexOf('useComposerKeyboard(scroller)') < conv.indexOf('return '),
    'the hook runs on every render, ahead of any early return');
});

test('the kit\'s class inside a reserving column is kept from reserving the inset twice', () => {
  const inner = /html\.un-kb \.platform-kb-column \.un-kb-avoid\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(inner, 'html.un-kb .platform-kb-column .un-kb-avoid rule is missing');
  assert.match(inner[1], /padding-bottom:\s*0/);
});

// ── 4. The composer's own tap: no pan at all (5 Oct 2026) ───────────────
//
// The pin above puts iOS's pan back a quarter second after the keys settle,
// which is what was SEEN: in the Homeroom app and in iOS Safari the
// composer rose into the top half of the screen, then dropped back onto the
// keys. The column option takes the composer's tap the way the scroller's
// fields are taken: focused with preventScroll, so there is no pan to put
// back, and the column's own inset places it.

function columnHarness() {
  const start = NATIVE_JS.indexOf('  var KB_TAP_SLOP');
  const end = NATIVE_JS.lastIndexOf('  /*', NATIVE_JS.indexOf('Spring tuner (?un-tune=1)', start));
  const timers = [];
  const listen = (bag) => ({
    addEventListener: (type, fn) => { bag[type] = fn; },
    removeEventListener: (type) => { delete bag[type]; },
  });
  const scrollerOn = {};
  const columnOn = {};
  const focused = [];
  const field = (inScroller) => ({
    nodeType: 1,
    tagName: 'TEXTAREA',
    value: 'a draft',
    readOnly: false,
    disabled: false,
    isContentEditable: false,
    inScroller,
    selection: null,
    closest(sel) { return /textarea/.test(sel) ? this : null; },
    focus(opts) { focused.push({ field: this, opts }); doc.activeElement = this; },
    setSelectionRange(a, b) { this.selection = [a, b]; },
  });
  const transcriptField = field(true);
  const composerField = field(false);
  const scrollEl = {
    nodeType: 1,
    classList: { contains: () => false, add() {}, remove() {} },
    ...listen(scrollerOn),
    contains: (n) => n === transcriptField,
  };
  const column = {
    nodeType: 1,
    ...listen(columnOn),
    contains: (n) => n === scrollEl || n === transcriptField || n === composerField,
  };
  const doc = { activeElement: null, documentElement: { classList: { contains: () => false } }, body: {} };
  const ctx = vm.createContext({
    window: { visualViewport: listen({}), scrollY: 0, pageYOffset: 0, scrollTo() {}, innerHeight: VV_HEIGHT },
    document: doc,
    console,
    platform: 'ios',
    prefersReducedMotion: false,
    kbInset: 0,
    gestures: { owner: () => null },
    isTextEntryField: physics.isTextEntryField,
    revealScrollDelta: physics.revealScrollDelta,
    getComputedStyle: () => ({ overflowY: 'hidden' }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
  });
  vm.runInContext(NATIVE_JS.slice(start, end), ctx);
  const handle = ctx.attachKeyboardAvoidance(scrollEl, { column });
  const tap = (target) => {
    let prevented = false;
    const touches = [{ clientX: 10, clientY: 10 }];
    columnOn.touchstart({ touches, target });
    columnOn.touchend({ touches: [], target, cancelable: true, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  return { handle, tap, focused, timers, scrollerOn, columnOn, transcriptField, composerField };
}

test('the composer\'s tap is focused without the pan, its draft picked up at the end, and nothing revealed', () => {
  const h = columnHarness();
  assert.ok(h.columnOn.touchend, 'the column carries the touch listeners');
  assert.equal(h.scrollerOn.touchend, undefined, 'and only the column: a tap in the scroller bubbles to it once');
  assert.equal(h.tap(h.composerField), true, 'the native tap (focus, pan, click) is cancelled');
  assert.deepEqual(h.focused.map((f) => [f.field, f.opts && f.opts.preventScroll]), [[h.composerField, true]]);
  assert.deepEqual(h.composerField.selection, [7, 7], 'the caret at the end of "a draft"');
  assert.equal(h.timers.filter((t) => t.ms === 250).length, 0, 'no reveal: the column places the composer');
});

test('a field in the scroller is still revealed, and an already-focused composer keeps its native taps', () => {
  const h = columnHarness();
  assert.equal(h.tap(h.transcriptField), true);
  assert.equal(h.timers.filter((t) => t.ms === 250).length, 1, 'the scroller\'s field waits for the settled pin');
  h.tap(h.composerField);
  assert.equal(h.tap(h.composerField), false, 'a second tap moves the caret natively');
  h.handle.detach();
  assert.equal(h.columnOn.touchend, undefined, 'detach takes the column\'s listeners off');
});

test('every chat hands the kit its composer column', () => {
  const { attachComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts');
  const { kit, calls } = fakeKit();
  const column = { id: 'col' };
  const el = { nodeType: 1, closest: (sel) => (sel === '.platform-kb-column' ? column : null) };
  attachComposerKeyboard(el, { unNative: kit }, DOC);
  assert.equal(calls[0].opts.column, column, 'React chats (Messages, #general)');
  assert.match(read('public/js/platform-ui.js'),
    /const column = typeof scrollEl\.closest === 'function' \? scrollEl\.closest\('\.platform-kb-column'\) : null;\s+handles\.push\(un\.attachKeyboardAvoidance\(scrollEl, \{ topEl: topEl \|\| undefined, column: column \|\| undefined \}\)\);/,
    'and the legacy-mounted ones (a project\'s chat, a topic thread, a dev chat) through attachScreenFx');
});

// ── 5. The column rides the keys (5 Oct 2026) ───────────────────────────
//
// In the app (no web view resize) the keyboard's height reached the page
// with the keys ~84% up, and the column's padding snapped the composer and
// the transcript there in one frame; on the way down the tab bar's band came
// back in the blur while the padding eased out in 150ms, so the composer
// hopped 16pt up and then outran the keys. A keyboard-sized step of the
// scroller's foot right after a focus or a blur now plays out on the
// column's padding along the keys' curve.

function rideHarness({ fixedShell = true, reduced = false } = {}) {
  const start = NATIVE_JS.indexOf('  var KB_TAP_SLOP');
  const end = NATIVE_JS.lastIndexOf('  /*', NATIVE_JS.indexOf('Spring tuner (?un-tune=1)', start));
  const listen = (bag) => ({
    addEventListener: (type, fn) => { bag[type] = fn; },
    removeEventListener: (type) => { delete bag[type]; },
  });
  let now = 1000;
  const animations = [];
  const scrollEl = {
    nodeType: 1, offsetTop: 100, offsetHeight: 500,
    classList: { contains: () => false, add() {}, remove() {} },
    ...listen({}),
    contains: () => false,
  };
  const columnOn = {};
  const column = {
    nodeType: 1, style: { transition: '' },
    ...listen(columnOn),
    contains: (n) => n === scrollEl,
    animate(frames, opts) {
      const anim = { frames, opts, cancelled: false, cancel() { this.cancelled = true; if (this.oncancel) this.oncancel(); } };
      animations.push(anim);
      return anim;
    },
  };
  let observed = null;
  class FakeRO { constructor(cb) { this.cb = cb; } observe(el) { observed = { el, cb: this.cb }; } disconnect() { observed = null; } }
  const ctx = vm.createContext({
    window: { visualViewport: listen({}), ResizeObserver: FakeRO, performance: { now: () => now }, scrollY: 0, pageYOffset: 0, scrollTo() {}, innerHeight: VV_HEIGHT },
    document: { activeElement: null, documentElement: { classList: { contains: () => true } }, body: {} },
    console, platform: 'ios', prefersReducedMotion: reduced, kbInset: 0,
    gestures: { owner: () => null },
    isTextEntryField: physics.isTextEntryField, revealScrollDelta: physics.revealScrollDelta,
    getComputedStyle: (el) => (el === column ? { paddingBottom: '335px' } : { overflowY: fixedShell ? 'hidden' : 'auto' }),
    setTimeout: () => 0, clearTimeout() {},
  });
  vm.runInContext(NATIVE_JS.slice(start, end), ctx);
  const handle = ctx.attachKeyboardAvoidance(scrollEl, { column });
  return {
    ctx, handle, column, columnOn, animations,
    tick: (ms) => { now += ms; },
    moveFoot: (dy) => { scrollEl.offsetHeight += dy; observed.cb(); },
    observing: () => observed && observed.el === scrollEl,
  };
}

test('the keys\' curve, and the padding keyframes from where the keys already are to where they land', () => {
  const h = rideHarness();
  const ease = h.ctx.kbEase;
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(Math.abs(ease(0.25) - 0.58) < 0.01, 'measured: 58% of the way at 75ms of 300ms');
  // Up by 259px onto a 335px padding, the keys 45% of the way: it starts
  // short of the top by what is left and ends exactly on the CSS value.
  const frames = h.ctx.kbRideFrames(335, -259, 0.45, 4);
  assert.equal(frames.length, 5);
  assert.equal(frames[0].offset, 0);
  assert.equal(frames[4].offset, 1);
  assert.equal(frames[4].paddingBottom, '335px');
  assert.ok(parseFloat(frames[0].paddingBottom) < 335 && parseFloat(frames[0].paddingBottom) > 335 - 259);
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(parseFloat(frames[i].paddingBottom) >= parseFloat(frames[i - 1].paddingBottom), 'one way, never back');
  }
  // Down: from the keys' top to none, never below zero.
  const down = h.ctx.kbRideFrames(0, 259, 0, 4);
  assert.equal(down[0].paddingBottom, '259px');
  assert.equal(down[4].paddingBottom, '0px');
});

test('a keyboard-sized step right after a focus rides; the padding transition is out of its way', () => {
  const h = rideHarness();
  assert.ok(h.observing(), 'it watches the scroller\'s box');
  assert.equal(h.column.style.transition, 'none', 'a running transition would outrank the animation');
  h.columnOn.focusin({ type: 'focusin' });
  h.tick(180);
  h.moveFoot(-259); // the keys' height lands: the composer's foot goes up
  assert.equal(h.animations.length, 1);
  const up = h.animations[0];
  assert.equal(up.opts.easing, 'linear');
  assert.equal(up.opts.duration, Math.round(300 * (1 - 0.45)), 'from 45% at most: the app hears late');
  h.moveFoot(-3); // its own padding, frame by frame
  assert.equal(h.animations.length, 1, 'never rides its own movement');
  // Tapping away mid-ride stops it where it is; the drop then rides from there.
  h.columnOn.focusout({ type: 'focusout' });
  assert.equal(up.cancelled, true);
  h.tick(16);
  h.moveFoot(262);
  assert.equal(h.animations.length, 2);
  assert.ok(h.animations[1].opts.duration > 250, 'down starts with the blur');
});

test('no ride for a small step, a late one, outside a fixed shell, or with reduced motion; detach restores the column', () => {
  const small = rideHarness();
  small.columnOn.focusin({ type: 'focusin' });
  small.moveFoot(-60); // the tab bar's band, a QuickType row
  assert.equal(small.animations.length, 0);
  const late = rideHarness();
  late.columnOn.focusin({ type: 'focusin' });
  late.tick(1500);
  late.moveFoot(-259); // a rotation, a resize: not the keys
  assert.equal(late.animations.length, 0);
  const paged = rideHarness({ fixedShell: false });
  paged.columnOn.focusin({ type: 'focusin' });
  paged.moveFoot(-259);
  assert.equal(paged.animations.length, 0, 'a browser page pans its own way');
  const still = rideHarness({ reduced: true });
  still.columnOn.focusin({ type: 'focusin' });
  still.moveFoot(-259);
  assert.equal(still.animations.length, 0);
  still.handle.detach();
  assert.equal(still.column.style.transition, '');
  assert.equal(still.columnOn.focusin, undefined);
});
