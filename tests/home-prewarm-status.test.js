'use strict';

// #1882: warming an app the finger is on must not be decided once, from a
// status snapshot taken the first time the card was ever attached.
//
// `_wirePrewarm` is called from app-grid.tsx's `wireRef`, which is guarded by
// a module-level `WeakSet` — so it runs EXACTLY ONCE per card DOM node, and
// React keeps that node across re-renders. It used to read
// `card.dataset.status` at that moment and attach nothing unless the app was
// already 'running'. An app that was stopped when the homepage first painted
// therefore never got the listeners, and never got them later either, however
// many times it came up. That is precisely the slow case the issue is about:
// a cold homepage load, where apps are still spinning up (#2284/#2285/#2286
// are all about rows moving INTO 'running' while the viewer watches).
//
// The status check belongs at EVENT time, and already exists there:
// `App.prewarmApp` re-reads the live launcher record and returns unless
// `rec.status === 'running'`. So the listeners attach unconditionally and the
// live record decides — the same shape browse.js's two call sites already
// have, which is why only the homepage carried this defect.
//
// Run with: node --test tests/home-prewarm-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { installAppCard } = require('./helpers/app-card');
const { HOME_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { installGridStore } = require('./helpers/home-grid-store');

/** A card element stub that records the listeners wired onto it. */
function makeCard(dataset) {
  const listeners = [];
  return {
    dataset,
    listeners,
    addEventListener(type, fn, opts) { listeners.push({ type, fn, opts }); },
    removeEventListener() {},
  };
}

function makeHome() {
  const warmed = [];
  const sandbox = {
    console,
    App: {
      user: { id: 1 },
      prewarmApp: (slug) => { warmed.push(slug); },
    },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      createElement: () => ({ set textContent(_v) {}, get innerHTML() { return ''; } }),
      body: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    localStorage: (() => {
      const m = new Map();
      return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
      };
    })(),
    alert: () => {}, confirm: () => true,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL,
    location: { search: '', origin: 'https://sv.test' },
    addEventListener: () => {}, removeEventListener: () => {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, warmed };
}

test('a card that was not running when it was wired still warms once it is', () => {
  const { Home, warmed } = makeHome();
  // The homepage painted while this app was still coming up.
  const card = makeCard({ slug: 'notes', status: 'stopped', demo: 'false' });
  Home._wirePrewarm(card);

  assert.ok(card.listeners.length > 0,
    'the listeners attach regardless of the status at wire time');

  // It is running by the time the finger lands — the card node is the same
  // one React kept, so nothing re-wires it.
  card.dataset.status = 'running';
  for (const l of card.listeners) l.fn();

  assert.deepEqual(warmed, ['notes', 'notes'].slice(0, card.listeners.length),
    'every wired gesture reaches App.prewarmApp, which owns the live check');
});

test('a running card wires exactly the two gestures it always did', () => {
  const { Home } = makeHome();
  const card = makeCard({ slug: 'notes', status: 'running', demo: 'false' });
  Home._wirePrewarm(card);

  assert.deepEqual(card.listeners.map((l) => l.type).sort(), ['mouseenter', 'pointerdown']);
  const down = card.listeners.find((l) => l.type === 'pointerdown');
  assert.equal(down.opts && down.opts.passive, true,
    'pointerdown stays passive: it must never delay scrolling');
});

test('a demo card is still skipped outright', () => {
  const { Home, warmed } = makeHome();
  const card = makeCard({ slug: 'demo-app', status: 'running', demo: 'true' });
  Home._wirePrewarm(card);
  assert.equal(card.listeners.length, 0, 'nothing to warm for a demo tile');
  assert.deepEqual(warmed, []);
});

test('a card with no slug is skipped', () => {
  const { Home } = makeHome();
  const card = makeCard({ status: 'running', demo: 'false' });
  Home._wirePrewarm(card);
  assert.equal(card.listeners.length, 0);
});
