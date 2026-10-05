'use strict';
const { withLanguage } = require("./lib/platform-language");

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
  const ctx = vm.createContext(withLanguage({
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
  }));
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
