'use strict';

// #3571: the Messages composer must stay above the iPhone keyboard.
//
// On iOS Safari the layout viewport does not shrink when the keyboard opens,
// and Safari pans the page by the keyboard's height. The kit publishes that
// height as `--un-kb-inset`, which `platform-kb-column` reserves on the
// Messages column — so the box moved a second time and landed near the TOP
// of the visible strip. The kit's settled pin (`window.scrollTo(0, 0)` on the
// fixed shell) is what cancels the pan first. The two React-owned Messages
// panes had no controller calling `attachScreenFx`, so no pin was attached.
//
// tests/platform-safe-bottom.test.js pins the CSS contract. This file RUNS
// lib/composer-keyboard.ts against a hand-stepped React (effects included)
// and a fake kit, and reads the kit's own physics for the recorded iOS
// measurements.
//
// Run with: node --test tests/composer-keyboard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── A React small enough to step through ─────────────────────────────────

function createFakeReact() {
  const slots = [];
  let cursor = 0;
  let renderFn = null;
  let passive = [];

  const slot = (init) => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = init();
    return slots[i];
  };
  const same = (a, b) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length
    && a.every((value, i) => Object.is(value, b[i]));

  const React = {
    useRef: (current) => slot(() => ({ current })),
    useEffect(effect, deps) {
      const s = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
      const rerun = s.fresh || deps === undefined || !same(s.deps, deps);
      if (!rerun) return;
      s.fresh = false;
      s.deps = deps;
      passive.push(() => {
        if (typeof s.cleanup === 'function') s.cleanup();
        s.cleanup = effect();
      });
    },
  };

  function render() {
    cursor = 0;
    passive = [];
    renderFn();
    for (const run of passive) run();
  }

  return {
    React,
    mount(fn) { renderFn = fn; render(); },
    rerender() { render(); },
    unmount() {
      renderFn = null;
      for (const s of slots) if (s && typeof s.cleanup === 'function') s.cleanup();
    },
  };
}

/** Install globals the module reads at call time; restore them afterwards. */
function withGlobals(t, globals) {
  const saved = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(globals)) {
    if (value === undefined) delete globalThis[name];
    else globalThis[name] = value;
  }
  t.after(() => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

const EL = { name: 'messages-thread-scroll' };
const HEADER = { name: 'platform-header' };

/** A kit whose attach/detach calls are recorded in order. */
function fakeKit() {
  const calls = [];
  const live = new Set();
  const kit = {
    calls,
    live,
    attachKeyboardAvoidance(el, options) {
      calls.push({ call: 'attach', el, options });
      live.add(el);
      const handle = {
        detach() {
          calls.push({ call: 'detach', el });
          live.delete(el);
        },
      };
      return handle;
    },
  };
  return kit;
}

function loadModule(t, kit) {
  withGlobals(t, {
    window: kit ? { unNative: kit } : {},
    document: { getElementById: (id) => (id === 'platform-header' ? HEADER : null) },
  });
  return loadTsx('frontend/src/lib/composer-keyboard.ts');
}

/** The same module, with React replaced by the stepper above. */
function loadHookModule(t, kit, React) {
  withGlobals(t, {
    window: kit ? { unNative: kit } : {},
    document: { getElementById: (id) => (id === 'platform-header' ? HEADER : null) },
  });
  return loadTsx('frontend/src/lib/composer-keyboard.ts', { stubs: { react: React } });
}

// ── The contract ─────────────────────────────────────────────────────────

test('the kit receives the scroller and the platform header', (t) => {
  const kit = fakeKit();
  const { attachComposerKeyboard } = loadModule(t, kit);

  attachComposerKeyboard(EL);

  assert.equal(kit.calls.length, 1);
  assert.equal(kit.calls[0].call, 'attach');
  assert.equal(kit.calls[0].el, EL, 'the scroller is the element handed to the kit');
  assert.deepEqual(kit.calls[0].options, { topEl: HEADER },
    'the fixed platform header is the bar the reveal keeps below');
});

test('the returned handle is the kit\'s, and detach is passed through once', (t) => {
  const kit = fakeKit();
  const { attachComposerKeyboard } = loadModule(t, kit);

  const handle = attachComposerKeyboard(EL);
  assert.ok(handle, 'attach returns the kit handle');
  assert.equal(typeof handle.detach, 'function', 'the handle carries the kit\'s detach');

  handle.detach();
  assert.deepEqual(kit.calls.map((c) => c.call), ['attach', 'detach']);
  assert.equal(kit.live.has(EL), false, 'the kit released the element');
});

test('no kit, no attach method, or no element returns cleanly', (t) => {
  const win = { unNative: undefined };
  withGlobals(t, { window: win, document: { getElementById: () => null } });
  const { attachComposerKeyboard } = loadTsx('frontend/src/lib/composer-keyboard.ts');

  // No element: returns without touching the window at all.
  assert.equal(attachComposerKeyboard(null), undefined);
  // A page with no `unNative` (the kit did not load).
  assert.equal(attachComposerKeyboard(EL), undefined);
  // A kit without the member (an older /v1 document, or a partial stub).
  win.unNative = {};
  assert.equal(attachComposerKeyboard(EL), undefined);
});

test('the hook attaches on mount and detaches on unmount', (t) => {
  const kit = fakeKit();
  const fake = createFakeReact();
  const { useComposerKeyboard } = loadHookModule(t, kit, fake.React);
  const ref = { current: EL };

  fake.mount(() => useComposerKeyboard(ref));
  assert.deepEqual(kit.calls.map((c) => c.call), ['attach']);
  assert.equal(kit.live.has(EL), true);

  fake.unmount();
  assert.deepEqual(kit.calls.map((c) => c.call), ['attach', 'detach'],
    'the pane\'s handle goes with the pane');
  assert.equal(kit.live.size, 0);
});

test('a replacement scroller gets a new handle, old detached first', (t) => {
  const kit = fakeKit();
  const fake = createFakeReact();
  const { useComposerKeyboard } = loadHookModule(t, kit, fake.React);
  const next = { name: 'replacement-scroll' };
  const ref = { current: EL };

  fake.mount(() => useComposerKeyboard(ref));
  ref.current = next;
  fake.rerender();

  assert.deepEqual(
    kit.calls.map((c) => `${c.call}:${c.el.name}`),
    ['attach:messages-thread-scroll', 'detach:messages-thread-scroll', 'attach:replacement-scroll'],
    'the old node is released before the new one is attached',
  );
  assert.equal(kit.live.has(next), true);
});

test('a rerender with the same node does not re-attach', (t) => {
  const kit = fakeKit();
  const fake = createFakeReact();
  const { useComposerKeyboard } = loadHookModule(t, kit, fake.React);
  const ref = { current: EL };

  fake.mount(() => useComposerKeyboard(ref));
  fake.rerender();
  fake.rerender();

  assert.deepEqual(kit.calls.map((c) => c.call), ['attach'],
    'typing must not churn the kit mid-conversation');
});

test('after unmount nothing is left attached', (t) => {
  const kit = fakeKit();
  const fake = createFakeReact();
  const { useComposerKeyboard } = loadHookModule(t, kit, fake.React);
  const ref = { current: EL };

  fake.mount(() => useComposerKeyboard(ref));
  fake.unmount();
  fake.unmount();

  assert.equal(kit.live.size, 0, 'no element is still claimed');
  assert.equal(kit.calls.filter((c) => c.call === 'detach').length, 1,
    'double unmount does not detach twice');
});

// ── The recorded iPhone measurement, through the kit's own math ──────────

test('the recorded iPhone metrics publish a 337px inset', () => {
  const { physics } = require('../public/usernode-native/v1/native.js');
  // Layout 714, visual 377, offset 337: Safari scrolled the page up 337px.
  assert.equal(physics.keyboardInset({ layoutHeight: 714, vvHeight: 377, vvScale: 1 }), 337);
});

test('without the pin the box lands near the top of the visible strip', () => {
  const { physics } = require('../public/usernode-native/v1/native.js');
  const layout = 714;
  const visual = 377;
  const pan = 337;
  const inset = physics.keyboardInset({ layoutHeight: layout, vvHeight: visual, vvScale: 1 });
  assert.equal(inset, 337);

  // The column reserves the inset at the foot of the layout; the visible
  // strip starts at the pan offset. The box's bottom therefore reads:
  const boxBottomInLayout = layout - inset;
  const fromVisibleTop = boxBottomInLayout - pan;
  assert.equal(fromVisibleTop, 40, 'the double lift puts the box ~40px below the top');

  // The settled pin resets the pan to 0, so the same box sits on the
  // keyboard line (the visual viewport's bottom).
  assert.equal(boxBottomInLayout - 0, visual, 'with the pan cancelled the box is above the keys');
});

test('the settled pin scrolls to 0 only in a fixed, overflow-hidden shell', () => {
  const src = read('public/usernode-native/v1/native.js');
  const start = src.indexOf('function settledPin()');
  const end = src.indexOf('function onVvEvent()');
  assert.ok(start > 0 && end > start, 'the kit\'s settled pin is still where this fix expects it');
  const pin = src.slice(start, end);

  assert.match(pin, /window\.scrollTo\(0, 0\)/, 'the pin cancels Safari\'s pan');
  assert.match(pin, /overflowY === 'hidden'/, 'but only for the fixed shell');
  assert.match(pin, /window\.scrollY \|\| window\.pageYOffset/, 'and only once the page has actually panned');

  // The CSS the pin depends on: the column reserves the inset once, and the
  // kit's own class is neutralised inside it.
  const css = read('public/css/app.css');
  assert.match(css, /html\.un-kb \.platform-kb-column \.un-kb-avoid \{[^}]*padding-bottom:\s*0/);
});

// ── Both Messages panes, and every other column ──────────────────────────

test('both Messages panes pair their column with the hook on the scroller', () => {
  const src = read('frontend/src/features/messages/index.tsx');
  const columns = src.match(/className=(?:"[^"]*platform-kb-column[^"]*"|\{[^}]*platform-kb-column[^}]*\})/g) || [];
  assert.equal(columns.length, 2, 'the conversation and the reply thread both reserve the inset');
  assert.ok(columns.some((c) => c.includes('messages-thread-pane')), 'conversation column');
  assert.ok(columns.some((c) => c.includes('messages-reply-pane')), 'reply-thread column');

  const hooks = src.match(/useComposerKeyboard\(scroller\)/g) || [];
  assert.equal(hooks.length, 2, 'each pane attaches the pin to its scroller');
});

test('every platform-kb-column in frontend has a pin', () => {
  const dir = path.join(ROOT, 'frontend/src');
  const columns = [];
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.tsx')) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/className=(?:"[^"]*platform-kb-column[^"]*"|\{[^}]*platform-kb-column[^}]*\})/.test(src)) {
        columns.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);

  assert.deepEqual(columns.sort(), [
    'frontend/src/features/dev-chat/view.tsx',
    'frontend/src/features/group-chat/general-chat.tsx',
    'frontend/src/features/group-chat/thread-shell.tsx',
    'frontend/src/features/messages/index.tsx',
  ], 'a new column must bring its own pin');

  // The three legacy surfaces get theirs through attachScreenFx, keyed by
  // screen, on the scroller inside that column.
  const legacy = [
    ['public/js/group-chat.js', /attachScreenFx\(\s*'gc-thread'[\s\S]{0,200}#gc-thread-scroll/],
    ['public/js/app-view.js', /attachScreenFx\(\s*'group-chat'[\s\S]{0,200}'gc-messages'/],
    ['frontend/src/features/dev-chat/dev-chat.js', /attachScreenFx\(\s*'dev-chat'[\s\S]{0,200}'dc-messages'/],
  ];
  for (const [file, re] of legacy) {
    assert.match(read(file), re, `${file} must attach keyboard avoidance to its column's scroller`);
  }
});
