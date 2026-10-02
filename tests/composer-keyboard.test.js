'use strict';
// #3571: on an iPhone, tapping the Messages composer threw the box off the
// top of the screen as the keyboard came up. A chat screen holds its composer
// in a flex column that reserves the kit's `--un-kb-inset` as bottom padding
// (`.platform-kb-column`), so the composer sits on the keyboard line of the
// LAYOUT viewport. That is only half the job on iOS Safari, which also PANS
// the page on the tap — before the inset exists — to reveal the field. The
// column then lifts the composer by the inset inside a page already moved up
// by the same amount, leaving the box near the top edge.
//
// The chats that worked were never doing the padding alone: each is mounted by
// a legacy controller that calls `PlatformUI.attachScreenFx` on its scroller,
// which attaches the kit's `unNative.attachKeyboardAvoidance`. Its settled pin
// puts the iOS pan back with `window.scrollTo(0, 0)`. The Messages
// conversation and its reply thread are React-owned and mounted by no such
// controller, so this file pins the new React seam that attaches it
// (frontend/src/lib/composer-keyboard.ts) — and pins that every screen
// reserving the inset on its scroller also pins its scroller.
//
// Run with: node --test tests/composer-keyboard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');
const { physics } = require('../public/usernode-native/v1/native.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const APP_CSS = read('public/css/app.css');
const NATIVE_JS = read('public/usernode-native/v1/native.js');
const MESSAGES = read('frontend/src/features/messages/index.tsx');

// The kit's keyboard section, run as it ships: the constants, the reveal math
// and `attachKeyboardAvoidance` itself. `physics` (the kit's Node export)
// supplies the pure halves this section closes over.
const KB_SECTION = NATIVE_JS.slice(
  NATIVE_JS.indexOf('  var KB_TAP_SLOP = 8;'),
  NATIVE_JS.indexOf('  function maybeMountTuner() {'),
);

// ── A CSS length, evaluated ─────────────────────────────────────────────
// A compact copy of the grammar tests/visual-viewport.test.js uses: calc(),
// var()/env() with fallbacks, and px. That is all the declarations read here.
function evalCss(src, { vars = {}, env = {} } = {}) {
  const s = src.trim();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const peek = (t) => s.startsWith(t, i);
  const expect = (t) => { ws(); if (!peek(t)) throw new Error(`expected "${t}" at ${i}`); i += t.length; };
  const ident = () => { ws(); const m = /^[-\w]+/.exec(s.slice(i)); if (!m) throw new Error(`name at ${i}`); i += m[0].length; return m[0]; };
  function factor() {
    ws();
    if (peek('calc(')) { i += 5; const v = sum(); expect(')'); return v; }
    if (peek('(')) { i += 1; const v = sum(); expect(')'); return v; }
    if (peek('var(') || peek('env(')) {
      const table = peek('var(') ? vars : env;
      i += 4;
      const name = ident();
      ws();
      let fallback;
      if (peek(',')) { i += 1; fallback = sum(); }
      expect(')');
      if (Object.prototype.hasOwnProperty.call(table, name)) return table[name];
      if (fallback === undefined) throw new Error(`${name} has no value and no fallback`);
      return fallback;
    }
    const m = /^(\d*\.?\d+)(px)?/.exec(s.slice(i));
    if (!m) throw new Error(`unexpected "${s.slice(i, i + 16)}"`);
    i += m[0].length;
    return Number(m[1]);
  }
  function product() { let v = factor(); for (;;) { ws(); if (peek('*')) { i += 1; v *= factor(); } else if (peek('/')) { i += 1; v /= factor(); } else return v; } }
  function sum() { let v = product(); for (;;) { ws(); if (peek('+')) { i += 1; v += product(); } else if (peek('-')) { i += 1; v -= product(); } else return v; } }
  const value = sum();
  ws();
  if (i !== s.length) throw new Error(`trailing "${s.slice(i)}"`);
  return value;
}

/** The value a rule body gives a property — the LAST declaration wins. */
function declared(body, prop) {
  const all = [...body.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;]+);`, 'g'))];
  assert.ok(all.length, `${prop} is declared`);
  return all[all.length - 1][1].trim();
}
/** Every `\n<selector> {` rule body in a stylesheet. */
function rules(css, selector) {
  const out = [];
  const head = `\n${selector} {`;
  for (let at = css.indexOf(head); at >= 0; at = css.indexOf(head, at + 1)) {
    out.push(css.slice(at + head.length, css.indexOf('\n}', at + 1)));
  }
  return out;
}

// ── 1. The geometry, from the shipped rule ───────────────────────────────

test('a panned page puts the composer off the top; the settled pin puts it back', () => {
  // The kit's measured iPhone Safari numbers (native.js #1938): an 812px
  // screen, 409px visual viewport under a 403px pan. Here: layout 714, visual
  // viewport 377, pan 337 — the same 337px keyboard.
  const LAYOUT = 714, VVH = 377, PAN = 337;
  const inset = physics.keyboardInset({ layoutHeight: LAYOUT, vvHeight: VVH, vvScale: 1 });
  assert.equal(inset, PAN, 'the kit measures the keyboard as the layout/viewport difference');

  // The column reserves that inset as its own bottom padding — the shipped
  // declaration, evaluated with the measured inset.
  const colRules = rules(APP_CSS, 'html.un-kb .platform-kb-column');
  assert.ok(colRules.length, 'html.un-kb .platform-kb-column exists');
  const paddingRule = colRules.find((b) => /(^|\s)padding-bottom:/.test(b));
  assert.ok(paddingRule, 'the rule reserves a bottom padding');
  const reserved = evalCss(declared(paddingRule, 'padding-bottom'), { vars: { '--un-kb-inset': inset } });
  assert.equal(reserved, PAN);

  // Unpanned, the composer's bottom sits on the keyboard line (column of the
  // layout viewport height, inset taken off the foot).
  const composerHeight = 64;
  const composerBottom = LAYOUT - reserved;
  assert.equal(composerBottom, VVH, 'the composer rests exactly on the keyboard line');

  // Panned, the document has moved up by the same amount, so the composer's
  // box moves with it — off the top of the screen.
  const pannedTop = composerBottom - PAN - composerHeight;
  const pannedBottom = composerBottom - PAN;
  assert.equal(pannedBottom, 40, 'the panned composer bottom is ~40px from the top edge');
  assert.ok(pannedTop < 0, 'and its top is above the screen');
});

// ── 2. The kit's settled pin, executed ───────────────────────────────────

function makeVV() {
  const listeners = {};
  return {
    count: (type) => (listeners[type] || []).length,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) { if (listeners[type]) listeners[type] = listeners[type].filter((f) => f !== fn); },
    emit(type) { (listeners[type] || []).slice().forEach((fn) => fn()); },
  };
}

function fakeScrollEl() {
  const classes = new Set();
  const listeners = {};
  return {
    nodeType: 1,
    scrollTop: 0,
    scrollHeight: 800,
    clientHeight: 400,
    classList: {
      add: (n) => classes.add(n),
      remove: (n) => classes.delete(n),
      contains: (n) => classes.has(n),
    },
    addEventListener: (t, fn, opts) => { listeners[t] = { fn, opts }; },
    removeEventListener: (t) => { delete listeners[t]; },
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, bottom: 400 }),
    scrollTo: () => {},
    _classes: classes,
    _listeners: listeners,
  };
}

/** Boot the kit's keyboard section with just enough window/document. */
function kbHarness({ platform = 'ios', vv = true, scrollY = 0, fixedShell = true, hasVV = true } = {}) {
  const vvObj = hasVV ? makeVV() : null;
  const scrollToCalls = [];
  const timers = [];
  const win = {
    visualViewport: vvObj,
    innerHeight: 714,
    scrollY,
    pageYOffset: scrollY,
    scrollTo: (x, y) => { scrollToCalls.push([x, y]); win.scrollY = 0; win.pageYOffset = 0; },
  };
  const document = {
    activeElement: null,
    documentElement: { classList: { contains: () => false, toggle() {} }, style: { setProperty() {} } },
    body: {},
  };
  const context = vm.createContext({
    window: win,
    document,
    console,
    platform,
    prefersReducedMotion: false,
    kbInset: 0,
    gestures: { owner: () => null },
    isTextEntryField: physics.isTextEntryField,
    revealScrollDelta: physics.revealScrollDelta,
    getComputedStyle: () => ({ overflowY: fixedShell ? 'hidden' : 'visible' }),
    setTimeout: (fn) => { timers.push({ fn }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
  });
  vm.runInContext(KB_SECTION, context);
  return {
    context,
    vv: vvObj,
    win,
    scrollToCalls,
    timers,
    attach(scrollEl = fakeScrollEl()) {
      return context.attachKeyboardAvoidance(scrollEl, { topEl: { nodeType: 1 } });
    },
    runSettle() {
      // Run every scheduled callback, which is the 120ms settled pin.
      timers.slice().forEach((t) => t.fn());
    },
  };
}

test('the settled pin puts a fixed shell\'s pan back once, and only there', () => {
  const h = kbHarness({ scrollY: 337, fixedShell: true });
  const el = fakeScrollEl();
  h.attach(el);
  assert.ok(el._classes.has('un-kb-avoid'), 'the kit adds its avoidance class to the scroller');
  h.vv.emit('resize');
  h.runSettle();
  assert.deepEqual(h.scrollToCalls, [[0, 0]], 'the iOS pan is reset once');
  // A second burst (QuickType resizing the viewport) leaves the now-unpanned
  // page alone — never a scrollTo per settle.
  h.vv.emit('resize');
  h.runSettle();
  assert.deepEqual(h.scrollToCalls, [[0, 0]]);

  // A normally-scrolling page that attached an inner pane is never yanked.
  const scrolling = kbHarness({ scrollY: 337, fixedShell: false });
  scrolling.attach(fakeScrollEl());
  scrolling.vv.emit('resize');
  scrolling.runSettle();
  assert.deepEqual(scrolling.scrollToCalls, [], 'not a fixed shell: left alone');

  // An unpanned page has nothing to reset.
  const plain = kbHarness({ scrollY: 0, fixedShell: true });
  plain.attach(fakeScrollEl());
  plain.vv.emit('resize');
  plain.runSettle();
  assert.deepEqual(plain.scrollToCalls, [], 'no pan: nothing to reset');
});

test('desktop attaches nothing — no listeners, no class, no pin', () => {
  const h = kbHarness({ platform: 'desktop' });
  const el = fakeScrollEl();
  h.attach(el);
  assert.equal(h.vv.count('resize'), 0);
  assert.equal(h.vv.count('scroll'), 0);
  assert.ok(!el._classes.has('un-kb-avoid'));
  h.vv.emit('resize');
  h.runSettle();
  assert.deepEqual(h.scrollToCalls, []);
});

test('detach removes the listeners and the class', () => {
  const h = kbHarness();
  const el = fakeScrollEl();
  const handle = h.attach(el);
  assert.equal(h.vv.count('resize'), 1);
  handle.detach();
  assert.equal(h.vv.count('resize'), 0);
  assert.ok(!el._classes.has('un-kb-avoid'));
});

// ── 3. attachComposerKeyboard ────────────────────────────────────────────

const { attachComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts');

test('attachComposerKeyboard hands the kit the scroller and the platform header', () => {
  const calls = [];
  const header = { id: 'platform-header' };
  const win = {
    unNative: {
      attachKeyboardAvoidance(el, opts) { calls.push({ el, opts }); return { detach() {} }; },
    },
  };
  const doc = { getElementById: (id) => (id === 'platform-header' ? header : null) };
  const el = {};
  const detach = attachComposerKeyboard(el, win, doc);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].el, el);
  assert.equal(calls[0].opts.topEl, header, 'the same element attachScreenFx is handed for the group chat');
  detach();
});

test('attachComposerKeyboard is a no-op without an element or the kit, and survives a throwing kit', () => {
  const win = { unNative: { attachKeyboardAvoidance: () => ({ detach() {} }) } };
  assert.doesNotThrow(() => attachComposerKeyboard(null, win, { getElementById: () => null })());
  // No kit at all.
  assert.doesNotThrow(() => attachComposerKeyboard({}, {}, { getElementById: () => null })());
  // A throwing kit degrades to a no-op, and its detach never throws.
  const boom = { unNative: { attachKeyboardAvoidance() { throw new Error('nope'); } } };
  const detach = attachComposerKeyboard({}, boom, { getElementById: () => null });
  assert.doesNotThrow(() => detach());
});

test('attachComposerKeyboard detach is idempotent', () => {
  let detaches = 0;
  const win = { unNative: { attachKeyboardAvoidance: () => ({ detach: () => { detaches += 1; } }) } };
  const detach = attachComposerKeyboard({}, win, { getElementById: () => null });
  detach();
  detach();
  detach();
  assert.equal(detaches, 1);
});

// ── 4. useComposerKeyboard, against a stepped React ──────────────────────

function createFakeReact() {
  const slots = [];
  let cursor = 0;
  const pending = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return slots[i]; };
  const React = {
    useRef: (current) => slot(() => ({ current })),
    useEffect(effect, deps) {
      const s = slot(() => ({ cleanup: undefined, had: false, deps: undefined }));
      const changed = deps === undefined || !s.had
        || deps.length !== (s.deps || []).length || deps.some((v, i) => !Object.is(v, s.deps[i]));
      if (!changed) return;
      s.had = true; s.deps = deps;
      pending.push({ s, effect });
    },
  };
  return {
    React,
    commit(fn) {
      cursor = 0;
      pending.length = 0;
      fn();
      const batch = pending.slice();
      pending.length = 0;
      for (const e of batch) {
        if (typeof e.s.cleanup === 'function') { const c = e.s.cleanup; e.s.cleanup = undefined; c(); }
      }
      for (const e of batch) e.s.cleanup = e.effect();
    },
    unmount() {
      for (const s of slots) {
        if (s && typeof s.cleanup === 'function') { const c = s.cleanup; s.cleanup = undefined; c(); }
      }
    },
  };
}

function composerHookHarness() {
  const react = createFakeReact();
  const { useComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts', { stubs: { react: react.React } });
  const ref = { current: null };
  const log = [];
  globalThis.window = {
    unNative: {
      attachKeyboardAvoidance: (el) => {
        log.push({ type: 'attach', el });
        return { detach: () => log.push({ type: 'detach', el }) };
      },
    },
  };
  globalThis.document = { getElementById: () => null };
  return {
    react,
    ref,
    log,
    run: () => react.commit(() => useComposerKeyboard(ref)),
    unmount: () => react.unmount(),
  };
}

test('useComposerKeyboard attaches when the scroller appears, once per node, and re-attaches on a new one', () => {
  const h = composerHookHarness();
  try {
    h.run(); // ref is null yet
    assert.deepEqual(h.log, [], 'nothing to attach while the scroller is absent');

    const a = { id: 'a' };
    h.ref.current = a;
    h.run();
    assert.deepEqual(h.log, [{ type: 'attach', el: a }], 'the scroller that appeared gets the kit');

    h.run(); // same node re-committed
    assert.equal(h.log.length, 1, 'never attached twice to one node');

    const b = { id: 'b' };
    h.ref.current = b;
    h.run();
    assert.deepEqual(h.log, [
      { type: 'attach', el: a },
      { type: 'detach', el: a },
      { type: 'attach', el: b },
    ], 'a new node detaches the old and attaches itself');

    h.unmount();
    assert.equal(h.log[h.log.length - 1].type, 'detach');
    assert.equal(h.log[h.log.length - 1].el, b, 'unmount detaches the live node');
  } finally {
    delete globalThis.window;
    delete globalThis.document;
  }
});

// ── 5. Inventory: every inset-reserving scroller pins its scroller ────────

test('every screen that reserves the keyboard inset also pins its scroller', () => {
  // The four screens built as a flex column with a flex-1 scroller. Each must
  // carry the settled pin, or the iOS pan survives and the composer leaves the
  // screen — which is exactly the Messages bug (#3571).
  const COLUMNS = [
    // General chat, its topic thread, and the dev chat render their columns in
    // React but are still mounted by legacy controllers, which attach the pin
    // with attachScreenFx.
    ['frontend/src/features/group-chat/general-chat.tsx', 'public/js/app-view.js', /attachScreenFx/],
    ['frontend/src/features/group-chat/thread-shell.tsx', 'public/js/group-chat.js', /attachScreenFx/],
    ['frontend/src/features/dev-chat/view.tsx', 'frontend/src/features/dev-chat/dev-chat.js', /attachScreenFx/],
    // Messages is React-owned: the conversation and its reply thread attach the
    // pin through the new hook.
    ['frontend/src/features/messages/index.tsx', 'frontend/src/features/messages/index.tsx', /useComposerKeyboard\(scroller\)/],
  ];
  for (const [file, pinFile, pin] of COLUMNS) {
    assert.match(read(file), /platform-kb-column/, `${file} reserves the keyboard inset on its column`);
    assert.match(read(pinFile), pin, `${file} must pin its scroller (${pinFile}) so the iOS pan is put back`);
  }

  // The Messages scroller writes no `un-kb-avoid` of its own and keeps a
  // constant literal className, so React never reconciles away the class the
  // kit adds at runtime.
  const worn = MESSAGES.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) || [];
  assert.deepEqual(worn.filter((c) => c.includes('un-kb-avoid')), [],
    'Messages must not reserve the inset twice (column + un-kb-avoid)');

  // A NEW reserving column fails until it declares its pin: scan the tree.
  const known = new Set(COLUMNS.map(([file]) => file));
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      // A rendered column wears the class on a className, on one line; prose
      // mentions (this seam's own doc comment) are not a column.
      else if (/\.(ts|tsx)$/.test(entry.name)
        && /className=[^\n]*platform-kb-column/.test(read(rel))) found.push(rel);
    }
  };
  walk('frontend/src');
  for (const file of found) {
    assert.ok(known.has(file),
      `${file} reserves the keyboard inset but is not declared — attach the settled pin and list it here`);
  }
});
