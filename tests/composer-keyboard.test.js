'use strict';

// #3571: on an iPhone, tapping the message box in Messages sent the composer
// above the top of the screen as the keyboard came up.
//
// Every chat screen holds its composer the same way (#1937): a flex column
// with a `flex: 1` scroller, and the typing slot + composer pinned below it
// as siblings. `platform-kb-column` reserves the keyboard inset on the
// column, which puts the composer on the keyboard line of the LAYOUT
// viewport. On iOS Safari that is only half of the story: before any inset
// exists, Safari PANS the page to reveal the tapped field by the full
// keyboard height, and the column then lifts the composer by the same inset
// inside a page already moved up. The two add, and the composer ends above
// the screen.
//
// The other half is the kit's settled pin: once the burst of viewport events
// goes quiet, `attachKeyboardAvoidance` sees a fixed shell and calls
// `window.scrollTo(0, 0)`, putting Safari's pan back. The legacy screens got
// that pin through `PlatformUI.attachScreenFx`; Messages' two React panes are
// mounted by no controller, so nothing attached it there. This file pins the
// geometry, the kit's real settled pin, the new React seam that attaches it,
// and an inventory of every composer column so a new one cannot miss it.
//
// Run with: node --test tests/composer-keyboard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const APP_CSS = read('public/css/app.css');
const NATIVE = read('public/usernode-native/v1/native.js');
const MODULE = 'frontend/src/lib/composer-keyboard.ts';
const MESSAGES = 'frontend/src/features/messages/index.tsx';

/** The body of `selector { … }` in app.css. */
function ruleBody(selector) {
  const start = APP_CSS.indexOf(`\n${selector} {`);
  assert.ok(start >= 0, `expected a \`${selector}\` rule in app.css`);
  const open = APP_CSS.indexOf('{', start);
  const close = APP_CSS.indexOf('}', open);
  return APP_CSS.slice(open + 1, close);
}

/** The kit's own `keyboardInset`, run from native.js in a VM. */
function kitKeyboardInset() {
  const start = NATIVE.indexOf('  var KB_MIN_INSET = 50;');
  const end = NATIVE.indexOf("  // The layout viewport's height", start);
  assert.ok(start >= 0 && end > start, 'native.js no longer defines keyboardInset');
  const context = vm.createContext({});
  vm.runInContext(NATIVE.slice(start, end), context);
  assert.equal(typeof context.keyboardInset, 'function');
  return context.keyboardInset;
}

// ── 1. The geometry ──────────────────────────────────────────────────────

test('reserving the inset lifts the composer ONTO the layout keyboard line, and Safari\'s pan then takes it off the screen', () => {
  const inset = kitKeyboardInset()({
    layoutHeight: 714, // measured iPhone Safari layout viewport
    vvHeight: 377, // the visible band above the keys
    vvScale: 1,
  });
  assert.equal(inset, 337, 'the keyboard took 337px of the layout viewport');

  // The shipped rule is the reservation: the column's bottom padding is the
  // kit-published inset, so its content bottom moves up by exactly `inset`.
  const column = ruleBody('html.un-kb .platform-kb-column');
  assert.match(column, /padding-bottom:\s*var\(--un-kb-inset, 0px\)/);

  const LAYOUT = 714;
  const COMPOSER = 92; // the card and its field row
  const BANNER = 50; // the "Replying to @name" strip above it
  // Screen coordinates = layout coordinates - Safari's pan.
  const box = (pan, banner = 0) => {
    const bottom = LAYOUT - inset - pan;
    return { top: bottom - COMPOSER - banner, bottom };
  };

  const panned = box(337);
  assert.ok(panned.top < 0, 'with Safari\'s pan left in place the composer starts above the screen');
  assert.equal(panned.bottom, 40, 'only its bottom edge is left, as reported');
  assert.ok(box(337, BANNER).top < panned.top,
    'the "Replying to" banner pushes it further above the screen');

  const settled = box(0);
  assert.equal(settled.bottom, 377, 'with the pan undone its bottom IS the keyboard line');
});

// ── 2. The kit's real settled pin ────────────────────────────────────────

function fakeScrollEl() {
  const classes = new Set();
  return {
    nodeType: 1,
    listeners: [],
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
    },
    addEventListener(type, fn) { this.listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const at = this.listeners.findIndex((entry) => entry.type === type && entry.fn === fn);
      if (at >= 0) this.listeners.splice(at, 1);
    },
    contains: () => true,
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
  };
}

function loadSettledPin({ platform = 'ios', scrollY = 0, fixedShell = true } = {}) {
  const start = NATIVE.indexOf('  var KB_TAP_SLOP = 8;');
  const end = NATIVE.indexOf('  /* ────────────────────────────────────────────────────────────────────', NATIVE.indexOf('  function attachKeyboardAvoidance('));
  assert.ok(start >= 0 && end > start, 'native.js no longer defines attachKeyboardAvoidance');

  const timerQueue = [];
  let nextTimer = 1;
  const scrollTo = [];

  const htmlClasses = new Set();
  const documentElement = {
    classList: {
      add: (...names) => names.forEach((name) => htmlClasses.add(name)),
      remove: (...names) => names.forEach((name) => htmlClasses.delete(name)),
      contains: (name) => htmlClasses.has(name),
      toggle: (name, on) => (on ? htmlClasses.add(name) : htmlClasses.delete(name)),
    },
    style: { setProperty() {} },
    clientHeight: 714,
  };
  const document = { documentElement, body: {}, activeElement: null };

  const vvListeners = [];
  const visualViewport = {
    height: 377,
    scale: 1,
    offsetTop: scrollY,
    addEventListener(type, fn) { vvListeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      const at = vvListeners.findIndex((entry) => entry.type === type && entry.fn === fn);
      if (at >= 0) vvListeners.splice(at, 1);
    },
  };

  const timerApi = {
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timerQueue.push({ id, fn, ms });
      return id;
    },
    clearTimeout(id) {
      const at = timerQueue.findIndex((entry) => entry.id === id);
      if (at >= 0) timerQueue.splice(at, 1);
    },
  };

  const window = {
    innerHeight: 714,
    scrollY: scrollY,
    pageYOffset: scrollY,
    visualViewport,
    scrollTo: (x, y) => scrollTo.push([x, y]),
  };

  const context = vm.createContext({
    platform,
    prefersReducedMotion: false,
    kbInset: 0,
    gestures: { owner: () => null },
    isTextEntryField: () => true,
    revealScrollDelta: () => 0,
    window,
    document,
    getComputedStyle: () => ({ overflowY: fixedShell ? 'hidden' : 'auto' }),
    console,
    ...timerApi,
  });
  vm.runInContext(NATIVE.slice(start, end), context);
  assert.equal(typeof context.attachKeyboardAvoidance, 'function');

  return {
    attach: context.attachKeyboardAvoidance,
    el: fakeScrollEl(),
    visualViewport,
    vvListeners,
    timerQueue,
    scrollTo,
    fire(type) {
      for (const entry of vvListeners.filter((item) => item.type === type)) entry.fn();
    },
    settle() {
      assert.equal(timerQueue.length, 1, 'a burst of viewport events coalesces to one settle');
      const [timer] = timerQueue.splice(0, 1);
      timer.fn();
    },
  };
}

test('the settled pin puts Safari\'s pan back once, after a burst of viewport events', () => {
  const kit = loadSettledPin({ scrollY: 337, fixedShell: true });
  const handle = kit.attach(kit.el, {});
  assert.ok(kit.el.classList.contains('un-kb-avoid'), 'the kit marks the scroller it avoids for');
  assert.equal(kit.vvListeners.length, 2, 'resize and scroll are both listened to');

  kit.fire('resize');
  kit.fire('scroll');
  kit.fire('resize');
  kit.settle();
  assert.deepEqual(kit.scrollTo, [[0, 0]], 'the page frame is put back exactly once');

  handle.detach();
  assert.deepEqual(kit.scrollTo, [[0, 0]], 'detach does not fire the pin again');
});

test('the settled pin leaves a normally scrolling page and an unpanned page alone', () => {
  const scrolling = loadSettledPin({ scrollY: 337, fixedShell: false });
  const scrollingHandle = scrolling.attach(scrolling.el, {});
  scrolling.fire('resize');
  scrolling.settle();
  assert.deepEqual(scrolling.scrollTo, [], 'never yank a page that scrolls normally');
  scrollingHandle.detach();

  const unpanned = loadSettledPin({ scrollY: 0, fixedShell: true });
  const unpannedHandle = unpanned.attach(unpanned.el, {});
  unpanned.fire('resize');
  unpanned.settle();
  assert.deepEqual(unpanned.scrollTo, [], 'nothing to put back when Safari did not pan');
  unpannedHandle.detach();
});

test('the kit attaches nothing on desktop and detach removes its class and listeners', () => {
  const desktop = loadSettledPin({ platform: 'desktop', scrollY: 337 });
  const noop = desktop.attach(desktop.el, {});
  assert.equal(desktop.el.classList.contains('un-kb-avoid'), false);
  assert.equal(desktop.el.listeners.length, 0);
  assert.equal(desktop.vvListeners.length, 0);
  noop.detach();

  const phone = loadSettledPin({ scrollY: 337 });
  const handle = phone.attach(phone.el, {});
  phone.fire('resize');
  assert.equal(phone.timerQueue.length, 1);
  handle.detach();
  assert.equal(phone.el.classList.contains('un-kb-avoid'), false);
  assert.equal(phone.el.listeners.length, 0, 'every scroller listener is removed');
  assert.equal(phone.vvListeners.length, 0, 'every viewport listener is removed');
  assert.equal(phone.timerQueue.length, 0, 'a pending settle is cancelled');
});

// ── 3. The module and its hook ───────────────────────────────────────────

function createHookHarness() {
  const slots = [];
  let cursor = 0;
  const same = (a, b) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const React = {
    useRef(initial) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect, deps) {
      const at = cursor++;
      const previous = slots[at];
      if (previous && deps !== undefined && previous.deps !== undefined && same(previous.deps, deps)) return;
      if (previous && typeof previous.cleanup === 'function') previous.cleanup();
      slots[at] = { deps, cleanup: effect() };
    },
  };
  return {
    React,
    render(hook, ref) {
      cursor = 0;
      hook(ref);
    },
    unmount() {
      for (const slot of slots) {
        if (slot && typeof slot.cleanup === 'function') slot.cleanup();
      }
      slots.length = 0;
    },
  };
}

function withGlobals(win, doc, fn) {
  const hadWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const hadDocument = Object.prototype.hasOwnProperty.call(globalThis, 'document');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = win;
  globalThis.document = doc;
  try {
    return fn();
  } finally {
    if (hadWindow) globalThis.window = previousWindow; else delete globalThis.window;
    if (hadDocument) globalThis.document = previousDocument; else delete globalThis.document;
  }
}

function recordingKit() {
  const calls = [];
  const handles = [];
  return {
    calls,
    handles,
    unNative: {
      attachKeyboardAvoidance(el, options) {
        calls.push({ el, options });
        const handle = { detached: 0, detach() { handle.detached += 1; } };
        handles.push(handle);
        return handle;
      },
    },
  };
}

test('the hook attaches once with the platform header, re-attaches on a new node, and detaches on unmount', () => {
  const root = createHookHarness();
  const api = loadTsx(MODULE, { stubs: { react: root.React } });
  const kit = recordingKit();
  const header = { id: 'platform-header' };
  const first = { node: 'first' };
  const second = { node: 'second' };
  const ref = { current: first };

  withGlobals(
    { unNative: kit.unNative },
    { getElementById: (id) => (id === 'platform-header' ? header : null) },
    () => {
      root.render(api.useComposerKeyboard, ref);
      assert.equal(kit.calls.length, 1, 'the first commit attaches');
      assert.equal(kit.calls[0].el, first);
      assert.equal(kit.calls[0].options.topEl, header, 'the pin is anchored below the platform header');

      root.render(api.useComposerKeyboard, ref);
      assert.equal(kit.calls.length, 1, 'the same scroller is not attached twice');

      ref.current = second;
      root.render(api.useComposerKeyboard, ref);
      assert.equal(kit.calls.length, 2, 'a replaced scroller is attached again');
      assert.equal(kit.handles[0].detached, 1, 'the old node is detached first');
      assert.equal(kit.calls[1].el, second);

      root.unmount();
      assert.equal(kit.handles[1].detached, 1, 'unmount detaches the live handle');
    },
  );
});

test('a scroller rendered after the first commit attaches when it appears', () => {
  const root = createHookHarness();
  const api = loadTsx(MODULE, { stubs: { react: root.React } });
  const kit = recordingKit();
  const ref = { current: null };

  withGlobals(
    { unNative: kit.unNative },
    { getElementById: () => null },
    () => {
      root.render(api.useComposerKeyboard, ref);
      assert.equal(kit.calls.length, 0, 'no scroller yet, nothing to attach');
      ref.current = { node: 'appeared' };
      root.render(api.useComposerKeyboard, ref);
      assert.equal(kit.calls.length, 1, 'the pane attached as soon as its scroller appeared');
      root.unmount();
    },
  );
});

test('a missing platform header still attaches; a missing kit or element is a quiet no-op', () => {
  const root = createHookHarness();
  const api = loadTsx(MODULE, { stubs: { react: root.React } });
  const kit = recordingKit();
  const ref = { current: { node: 'scroller' } };

  withGlobals(
    { unNative: kit.unNative },
    { getElementById: () => null },
    () => {
      root.render(api.useComposerKeyboard, ref);
      assert.equal(kit.calls.length, 1);
      assert.equal(kit.calls[0].options, undefined, 'no header means no topEl');
      root.unmount();
    },
  );

  const bare = createHookHarness();
  const bareApi = loadTsx(MODULE, { stubs: { react: bare.React } });
  const ref2 = { current: { node: 'scroller' } };
  withGlobals({}, { getElementById: () => null }, () => {
    bare.render(bareApi.useComposerKeyboard, ref2);
    bare.render(bareApi.useComposerKeyboard, { current: null });
    assert.doesNotThrow(() => bare.unmount());
  });
});

test('a kit that throws on attach is caught and yields a no-op', () => {
  const api = loadTsx(MODULE, { stubs: { react: createHookHarness().React } });
  const win = {
    unNative: {
      attachKeyboardAvoidance() { throw new Error('kit refused'); },
    },
  };
  const doc = { getElementById: () => null };
  const handle = api.attachComposerKeyboard({ node: 'scroller' }, win, doc);
  assert.doesNotThrow(() => handle.detach());
  assert.doesNotThrow(() => handle.detach());
});

test('detach is idempotent and swallows the kit\'s teardown error', () => {
  let detaches = 0;
  const api = loadTsx(MODULE, { stubs: { react: createHookHarness().React } });
  const win = {
    unNative: {
      attachKeyboardAvoidance() {
        return {
          detach() {
            detaches += 1;
            throw new Error('teardown failed');
          },
        };
      },
    },
  };
  const handle = api.attachComposerKeyboard({ node: 'scroller' }, win, { getElementById: () => null });
  handle.detach();
  handle.detach();
  assert.equal(detaches, 1, 'detaching twice must not tear down twice');
});

// ── 4. Every composer column carries the pin ─────────────────────────────

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.(ts|tsx|js)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

test('every platform-kb-column has the pin attached to its scroller', () => {
  const columns = walk('frontend/src')
    // A rendered class string, not a prose mention in a comment.
    .filter((file) => read(file).split('\n')
      .some((line) => line.includes('className') && line.includes('platform-kb-column')))
    .sort();

  const PINNED = {
    // React's own two panes attach the kit directly (lib/composer-keyboard).
    [MESSAGES]: { hook: true },
    // The legacy screens get the same pin from attachScreenFx.
    'frontend/src/features/group-chat/thread-shell.tsx': {
      site: 'public/js/group-chat.js',
      scroller: 'gc-thread-scroll',
    },
    'frontend/src/features/group-chat/general-chat.tsx': {
      site: 'public/js/app-view.js',
      scroller: 'gc-messages',
    },
    'frontend/src/features/dev-chat/view.tsx': {
      site: 'frontend/src/features/dev-chat/dev-chat.js',
      scroller: 'dc-messages',
    },
  };

  assert.deepEqual(columns, Object.keys(PINNED).sort(),
    'a new composer column must attach the settled pin too');

  for (const [file, pin] of Object.entries(PINNED)) {
    const source = read(file);
    if (pin.hook) {
      assert.match(source, /import \{[^}]*useComposerKeyboard[^}]*\} from '\.\.\/\.\.\/lib\/composer-keyboard';/,
        'Messages must import the React keyboard seam');
      const rendered = source.split('\n')
        .filter((line) => line.includes('className') && line.includes('platform-kb-column'))
        .length;
      const attached = (source.match(/useComposerKeyboard\(/g) || []).length;
      assert.equal(rendered, 2, 'the conversation and its reply thread each draw a column');
      assert.equal(attached, rendered,
        'every Messages column must call useComposerKeyboard on its scroller');
    } else {
      assert.match(source, new RegExp(`id="${pin.scroller}"`),
        `${file} must render the scroller the pin is attached to`);
      const site = read(pin.site);
      const at = site.indexOf('attachScreenFx(');
      assert.ok(at >= 0, `${pin.site} must attach the screen effects`);
      assert.match(site.slice(at, at + 500), new RegExp(`['"\`]#?${pin.scroller}['"\`]`),
        `${pin.site} must attach keyboard avoidance to #${pin.scroller}`);
    }
  }
});

test('a scroller inside a reserving column does not reserve the inset a second time', () => {
  const inner = ruleBody('html.un-kb .platform-kb-column .un-kb-avoid');
  assert.match(inner, /padding-bottom:\s*0/,
    'the kit adds un-kb-avoid at runtime; app.css must zero its inner padding');
});
