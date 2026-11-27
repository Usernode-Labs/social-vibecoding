'use strict';

// A React small enough to step through, and just enough DOM, for the Sheet
// and the Menu (frontend/src/lib/sheet.ts, frontend/src/lib/menu.ts). Shared
// by tests/sheet-menu-primitives.test.js and
// tests/sheet-overlay-kit-adoption.test.js.

// ── A React small enough to step through ─────────────────────────────────

function createFakeReact() {
  // The component rendering now; each mounted one keeps its own hooks.
  let current = null;
  const changed = (prev, next) =>
    !prev || !next || prev.length !== next.length || prev.some((v, i) => !Object.is(v, next[i]));
  const slot = (init) => {
    const c = current;
    const i = c.cursor++;
    if (!(i in c.slots)) c.slots[i] = init();
    return c.slots[i];
  };
  const effectHook = (queue) => (effect, deps) => {
    const s = slot(() => ({ fresh: true, deps: undefined, cleanup: undefined }));
    if (!s.fresh && !changed(s.deps, deps)) return;
    s.fresh = false;
    s.deps = deps;
    current[queue].push(() => {
      if (typeof s.cleanup === 'function') s.cleanup();
      s.cleanup = effect();
    });
  };
  const React = {
    useRef: (value) => slot(() => ({ current: value })),
    useState(initial) {
      const s = slot(() => {
        const state = { value: initial };
        state.set = (next) => { state.value = typeof next === 'function' ? next(state.value) : next; };
        return state;
      });
      return [s.value, s.set];
    },
    useMemo(factory, deps) {
      const s = slot(() => ({ fresh: true, deps: undefined, value: undefined }));
      if (s.fresh || changed(s.deps, deps)) {
        s.fresh = false;
        s.deps = deps;
        s.value = factory();
      }
      return s.value;
    },
    useCallback: (fn, deps) => React.useMemo(() => fn, deps),
    useLayoutEffect: effectHook('layout'),
    useEffect: effectHook('passive'),
  };
  /** Mount `fn` as a component: renders now, with its effects, layout first. */
  function mount(fn) {
    const c = { slots: [], cursor: 0, layout: [], passive: [] };
    const render = () => {
      current = c;
      c.cursor = 0;
      c.layout = [];
      c.passive = [];
      try { fn(); } finally { current = null; }
      for (const run of c.layout) run();
      for (const run of c.passive) run();
    };
    render();
    return {
      rerender: render,
      unmount() { for (const s of c.slots) if (s && typeof s.cleanup === 'function') s.cleanup(); },
    };
  }
  return { React, mount };
}

// ── Just enough DOM ──────────────────────────────────────────────────────

function createDom() {
  const listeners = [];
  const doc = {
    activeElement: null,
    body: null,
    documentElement: null,
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); },
    removeEventListener(type, fn, capture) {
      const at = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === !!capture);
      if (at !== -1) listeners.splice(at, 1);
    },
    querySelector: () => null,
  };
  function node(label, { focusable = false } = {}) {
    const n = {
      label,
      parent: null,
      kids: [],
      attrs: {},
      focusable,
      isConnected: true,
      classes: new Set(),
      classList: {
        add(c) { n.classes.add(c); },
        remove(c) { n.classes.delete(c); },
        contains: (c) => n.classes.has(c),
      },
      append(child) { child.parent = n; n.kids.push(child); return child; },
      appendChild(child) { return n.append(child); },
      contains(other) { for (let x = other; x; x = x.parent) if (x === n) return true; return false; },
      setAttribute(k, v) { n.attrs[k] = String(v); },
      getAttribute(k) { return k in n.attrs ? n.attrs[k] : null; },
      hasAttribute(k) { return k in n.attrs; },
      removeAttribute(k) { delete n.attrs[k]; },
      focus() { doc.activeElement = n; },
      getClientRects: () => [{}],
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
      closest: () => null,
      descendants() { return n.kids.flatMap((k) => [k, ...k.descendants()]); },
      querySelector(sel) {
        if (sel === '[autofocus]') return n.descendants().find((d) => d.hasAttribute('autofocus')) || null;
        return null;
      },
      querySelectorAll() { return n.descendants().filter((d) => d.focusable); },
    };
    return n;
  }
  doc.body = node('body');
  doc.documentElement = node('html');
  doc.activeElement = doc.body;
  // Capture listeners first, then bubble, as the document dispatches a key
  // that started on something inside it.
  function key(k, { shiftKey = false, prevented = false } = {}) {
    const event = {
      key: k,
      shiftKey,
      defaultPrevented: prevented,
      stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; },
    };
    for (const phase of [true, false]) {
      for (const l of listeners.slice()) {
        if (l.type !== 'keydown' || l.capture !== phase || event.stopped) continue;
        l.fn(event);
      }
    }
    return event;
  }
  return { doc, node, key, listeners };
}

module.exports = { createFakeReact, createDom };
