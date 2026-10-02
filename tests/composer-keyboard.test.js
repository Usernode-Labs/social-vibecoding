'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');
const nativePhysics = require('../public/usernode-native/v1/native.js').physics;

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const MESSAGES = read('frontend/src/features/messages/index.tsx');
const NATIVE = read('public/usernode-native/v1/native.js');

function between(source, start, end) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `missing start marker: ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing end marker: ${end}`);
  return source.slice(from, to);
}

function createReactHarness() {
  const slots = [];
  let cursor = 0;
  let renderFn;
  let scheduled = false;
  let unmounted = false;
  let effects = [];
  const changed = (a, b) => !a || !b || a.length !== b.length
    || a.some((value, index) => !Object.is(value, b[index]));
  const slot = (create) => {
    const index = cursor++;
    if (!(index in slots)) slots[index] = create();
    return slots[index];
  };
  const schedule = () => {
    if (scheduled || unmounted) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!unmounted) render();
    });
  };
  const useMemo = (factory, deps) => {
    const memo = slot(() => ({ fresh: true, deps: undefined, value: undefined }));
    if (memo.fresh || changed(memo.deps, deps)) {
      memo.fresh = false;
      memo.deps = deps;
      memo.value = factory();
    }
    return memo.value;
  };
  const React = {
    useRef: (current) => slot(() => ({ current })),
    useState(initial) {
      const state = slot(() => {
        const cell = { value: typeof initial === 'function' ? initial() : initial };
        cell.set = (next) => {
          const value = typeof next === 'function' ? next(cell.value) : next;
          if (Object.is(value, cell.value)) return;
          cell.value = value;
          schedule();
        };
        return cell;
      });
      return [state.value, state.set];
    },
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    useEffect(effect, deps) {
      const state = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
      if (!state.fresh && !changed(state.deps, deps)) return;
      state.fresh = false;
      state.deps = deps;
      effects.push(() => {
        if (typeof state.cleanup === 'function') state.cleanup();
        state.cleanup = effect();
      });
    },
  };
  function render() {
    cursor = 0;
    effects = [];
    renderFn();
    const pending = effects;
    effects = [];
    for (const run of pending) run();
  }
  return {
    React,
    mount(fn) { renderFn = fn; render(); },
    async flush() { await Promise.resolve(); await Promise.resolve(); },
    unmount() {
      unmounted = true;
      for (const state of slots) {
        if (typeof state?.cleanup === 'function') {
          state.cleanup();
          state.cleanup = undefined;
        }
      }
    },
  };
}

function loadHook(React) {
  return loadTsx('frontend/src/lib/composer-keyboard.ts', { stubs: { react: React } })
    .useComposerKeyboardAvoidance;
}

function setGlobals(values) {
  const saved = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  for (const [name, value] of Object.entries(values)) globalThis[name] = value;
  return () => {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
}

function makeClassList(initial = []) {
  const values = new Set(initial);
  return {
    add: (...names) => names.forEach((name) => values.add(name)),
    remove: (...names) => names.forEach((name) => values.delete(name)),
    contains: (name) => values.has(name),
    toggle(name, force) {
      const on = force === undefined ? !values.has(name) : !!force;
      if (on) values.add(name); else values.delete(name);
      return on;
    },
  };
}

function makeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    dispatch(type) {
      for (const listener of listeners.get(type) || []) listener({ type });
    },
    listenerCount() { return [...listeners.values()].reduce((n, items) => n + items.size, 0); },
  };
}

function makeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(fn, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > now) return;
        timers.delete(next[0]);
        next[1].fn();
      }
    },
  };
}

function loadNativeAttachKeyboardAvoidance(window, document, clock) {
  const start = NATIVE.indexOf('  function attachKeyboardAvoidance(');
  const end = NATIVE.indexOf('\n  /* ────────────────────────────────────────────────────────────────────\n   * Spring tuner', start);
  assert.notEqual(start, -1, 'native keyboard-avoidance implementation exists');
  assert.notEqual(end, -1, 'native keyboard-avoidance implementation is bounded');
  const declaration = NATIVE.slice(start, end).trim();
  return new Function(
    'window', 'document', 'platform', 'kbInset', 'prefersReducedMotion', 'gestures',
    'getComputedStyle', 'revealScrollDelta', 'isTextEntryField', 'KB_TAP_SLOP',
    'KB_SETTLE_MS', 'KB_FOCUS_FALLBACK_MS', 'setTimeout', 'clearTimeout',
    `${declaration}\nreturn attachKeyboardAvoidance;`,
  )(
    window, document, 'ios', 344, true, { owner: () => null },
    (element) => ({ overflowY: element === document.documentElement || element === document.body ? 'hidden' : '' }),
    nativePhysics.revealScrollDelta, nativePhysics.isTextEntryField, 8, 120, 250,
    clock.setTimeout.bind(clock), clock.clearTimeout.bind(clock),
  );
}

function makeElement() {
  return Object.assign(makeEventTarget(), {
    nodeType: 1,
    classList: makeClassList(),
    contains: () => false,
    getBoundingClientRect: () => ({ top: 84, bottom: 700 }),
    scrollTop: 0,
    scrollHeight: 700,
    clientHeight: 500,
    scrollTo() {},
  });
}

test('both Messages composers attach keyboard avoidance to their transcript scroller', () => {
  const conversation = between(MESSAGES, 'function ConversationThread(', 'function ThreadActivityRow(');
  const reply = between(MESSAGES, 'function ReplyThreadPanel(', 'function AppReplyThreadPanel(');
  for (const [name, component, className] of [
    ['conversation', conversation, 'messages-thread-scroll platform-safe-scroll'],
    ['reply thread', reply, 'messages-thread-scroll messages-reply-scroll platform-safe-scroll'],
  ]) {
    assert.match(component, /useComposerKeyboardAvoidance/, `${name} pane uses the hook`);
    assert.match(component, new RegExp(`ref=\\{keyboardScrollerRef\\} className="${className}"`),
      `${name} pane attaches the hook to its existing scroller`);
  }
});

test('the hook tracks replaced scrollers and safely detaches on unmount', async () => {
  const calls = [];
  const header = { nodeType: 1 };
  const restore = setGlobals({
    window: { unNative: {
      attachKeyboardAvoidance(element, options) {
        const call = { element, options, detached: 0 };
        calls.push(call);
        return { detach() { call.detached += 1; } };
      },
    } },
    document: { getElementById: (id) => id === 'platform-header' ? header : null },
  });
  try {
    const harness = createReactHarness();
    const useAvoidance = loadHook(harness.React);
    const scroller = { current: null };
    let setScroller;
    harness.mount(() => { setScroller = useAvoidance(scroller); });

    const first = makeElement();
    setScroller(first);
    await harness.flush();
    assert.equal(scroller.current, first);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].element, first);
    assert.deepEqual(calls[0].options, { topEl: header });

    setScroller(null);
    await harness.flush();
    assert.equal(calls[0].detached, 1, 'the old node detaches when its ref is cleared');
    assert.equal(scroller.current, null);

    const replacement = makeElement();
    setScroller(replacement);
    await harness.flush();
    assert.equal(calls.length, 2, 'the replacement node receives a fresh attachment');
    assert.equal(calls[1].element, replacement);
    harness.unmount();
    assert.equal(calls[1].detached, 1, 'the live node detaches on unmount');
  } finally {
    restore();
  }
});

test('missing scrollers or native keyboard support are safe no-ops', async () => {
  const restore = setGlobals({ window: {}, document: { getElementById: () => null } });
  try {
    const harness = createReactHarness();
    const useAvoidance = loadHook(harness.React);
    const scroller = { current: null };
    let setScroller;
    harness.mount(() => { setScroller = useAvoidance(scroller); });
    await harness.flush();
    assert.equal(scroller.current, null);

    const element = makeElement();
    setScroller(element);
    await harness.flush();
    assert.equal(scroller.current, element);
    assert.equal(element.listenerCount(), 0, 'no native listeners are added without kit support');
    harness.unmount();
  } finally {
    restore();
  }
});

test('settled iOS keyboard pan keeps both Messages composers visible above the keyboard', async () => {
  const layoutHeight = 844;
  const inset = 344;
  const composerHeight = 56;
  const header = { nodeType: 1, getBoundingClientRect: () => ({ bottom: 72 }) };

  for (const paneClass of ['messages-thread-scroll', 'messages-reply-scroll']) {
    const clock = makeClock();
    const viewport = makeEventTarget();
    viewport.height = layoutHeight - inset;
    viewport.scale = 1;
    const window = {
      visualViewport: viewport,
      innerHeight: viewport.height,
      scrollY: 620,
      pageYOffset: 620,
      scrollTo(_x, y) { this.scrollY = y; this.pageYOffset = y; },
    };
    const document = {
      documentElement: { classList: makeClassList(['un-kb']) },
      body: {},
      activeElement: null,
      getElementById: (id) => id === 'platform-header' ? header : null,
    };
    const attach = loadNativeAttachKeyboardAvoidance(window, document, clock);
    const calls = [];
    window.unNative = {
      attachKeyboardAvoidance(element, options) {
        calls.push({ element, options });
        return attach(element, options);
      },
    };
    const restore = setGlobals({ window, document });
    try {
      const harness = createReactHarness();
      const useAvoidance = loadHook(harness.React);
      const scroller = { current: null };
      let setScroller;
      harness.mount(() => { setScroller = useAvoidance(scroller); });
      const element = makeElement();
      element.dataset = { pane: paneClass };
      setScroller(element);
      await harness.flush();

      // The inset is already reserved on the parent column. Safari's focus
      // pan then carries that lifted composer above the shrunken viewport.
      const composerRect = () => ({
        top: layoutHeight - inset - composerHeight - window.scrollY,
        bottom: layoutHeight - inset - window.scrollY,
      });
      assert.ok(composerRect().bottom < 0,
        `${paneClass}: reproduces Safari's off-screen composer before settling`);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].element, element);
      assert.deepEqual(calls[0].options, { topEl: header });

      viewport.dispatch('resize');
      viewport.dispatch('scroll');
      clock.advance(120);

      const settled = composerRect();
      assert.equal(window.scrollY, 0, `${paneClass}: settled pin restores Safari's page pan`);
      assert.ok(settled.top >= 0, `${paneClass}: composer is in the visible viewport`);
      assert.ok(settled.bottom <= viewport.height,
        `${paneClass}: composer stays above the keyboard line`);

      harness.unmount();
      assert.equal(viewport.listenerCount(), 0, `${paneClass}: viewport listeners are detached`);
      assert.equal(element.listenerCount(), 0, `${paneClass}: scroller listeners are detached`);
      assert.equal(element.classList.contains('un-kb-avoid'), false,
        `${paneClass}: native class is removed during cleanup`);
    } finally {
      restore();
    }
  }
});
