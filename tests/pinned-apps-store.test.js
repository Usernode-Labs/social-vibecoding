'use strict';

// The desktop strip's pinned part (#5323): the store behind
// frontend/src/features/nav/strip-apps.tsx that holds the apps the viewer
// pinned there, written only by a drop on the "Pin here" slot (Home's drag
// recognizer, through pinApp) and by the strip itself (a drag back out, or
// its Unpin menu, through unpinApp).
//
// The contract mirrors the recents store (tests/nav-tab-bar.test.js holds
// that one): entries carry the display data the strip draws, the stored
// list names the account it was written for, unreadable storage is an
// empty list, and NOTHING here may run during an initial render — the
// store starts empty, which is what the prerender shows.
//
// Run with: node --test tests/pinned-apps-store.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

const STORE = 'frontend/src/features/nav/pinned-apps-store.js';

// A fresh module (and its own store) per test, over a Map-backed
// localStorage — the recents tests' stub, so nothing touches a real
// profile and each test starts from empty.
function makeStorage() {
  const storage = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  return { storage, raw: (k) => JSON.parse(storage.get(k)) };
}

const pin = (slug, over = {}) => ({ slug, name: slug[0].toUpperCase() + slug.slice(1), ...over });

test('the storage key is the one literal, exported so it cannot drift', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    assert.ok(mod.pinApp(pin('a'), 'ana'), 'a pin of a fresh app writes');
    assert.ok(storage.storage.has('usernode_pinned_apps_v2'), 'written under the pinned key');
    assert.equal(mod.PINNED_APPS_KEY, 'usernode_pinned_apps_v2');
    assert.equal(mod.PINNED_APPS_MAX, 4, 'four is still the most there is room for');
  } finally {
    delete global.window;
  }
});

test('the retired mirrored key is ignored and cleared: nothing carries over', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    storage.storage.set('usernode_pinned_apps_v1',
      JSON.stringify({ owner: 'ana', apps: [pin('a'), pin('b')] }));
    assert.deepEqual(mod.readPinnedApps('ana'), [],
      'the top row Home used to mirror is not a pin list');
    assert.equal(storage.storage.has('usernode_pinned_apps_v1'), false,
      'the retired key is removed, best effort, on the first read');
  } finally {
    delete global.window;
  }
});

test('entries are cleaned to display data, junk dropped, capped at four', () => {
  makeStorage();
  try {
    const mod = loadTsx(STORE);
    // Junk entries leave no hole, a missing name falls back to the slug,
    // and the clock recents carry is not part of a pin.
    assert.ok(mod.pinApp({ slug: 'a', name: 'A', iconUrl: 'https://sv.test/a.png', iconEmoji: '🎲', at: '2026-09-20T10:00:00Z' }, 'ana'));
    assert.ok(mod.pinApp({ name: 'No slug' }, 'ana') === false, 'no slug, no pin');
    assert.ok(mod.pinApp(null, 'ana') === false);
    assert.ok(mod.pinApp({ slug: '' }, 'ana') === false);
    assert.ok(mod.pinApp({ slug: 'b' }, 'ana'));
    const apps = mod.pinnedAppsStore.get().apps;
    assert.deepEqual(apps.map((a) => a.slug), ['a', 'b'], 'junk entries leave no hole');
    assert.deepEqual({ ...apps[0] },
      { slug: 'a', name: 'A', iconUrl: 'https://sv.test/a.png', iconEmoji: '🎲' },
      'an entry keeps its display data and carries no clock');
    assert.deepEqual({ ...apps[1] },
      { slug: 'b', name: 'b', iconUrl: null, iconEmoji: null },
      'a missing name falls back to the slug, missing icons to null');

    // The cap: the fifth pin is refused, the four stay.
    assert.ok(mod.pinApp(pin('p3'), 'ana'));
    assert.ok(mod.pinApp(pin('p4'), 'ana'));
    assert.equal(mod.pinApp(pin('p5'), 'ana'), false, 'a fifth pin is refused, not trimmed');
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['a', 'b', 'p3', 'p4']);
  } finally {
    delete global.window;
  }
});

test('pinStatus answers what a drop would do: ok, already, full', () => {
  makeStorage();
  try {
    const mod = loadTsx(STORE);
    assert.equal(mod.pinStatus('a'), 'ok', 'nothing pinned yet');
    assert.equal(mod.pinStatus(null), 'already', 'a nameless drop can never pin');
    mod.pinApp(pin('a'), 'ana');
    assert.equal(mod.pinStatus('a'), 'already', 'pinned already, off the store\'s own list');
    for (const slug of ['b', 'c', 'd']) mod.pinApp(pin(slug), 'ana');
    assert.equal(mod.pinStatus('e'), 'full', 'four are the most there is room for');
    assert.equal(mod.pinStatus('a'), 'already', 'and full also answers already for a pinned one');
  } finally {
    delete global.window;
  }
});

test('a pin is owner-scoped: written for one, read by another, empty', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    mod.pinApp(pin('a'), 'ana');
    mod.pinApp(pin('b'), 'ana');
    assert.equal(storage.raw('usernode_pinned_apps_v2').owner, 'ana');
    assert.deepEqual(mod.readPinnedApps('ana').map((a) => a.slug), ['a', 'b']);
    assert.deepEqual(mod.readPinnedApps('bo'), [], 'another account sees none of it');
    assert.deepEqual(mod.readPinnedApps(null), [], 'signed out reads nothing');
  } finally {
    delete global.window;
  }
});

test('no owner: the strip still shows the pin, but nothing is written', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    assert.ok(mod.pinApp(pin('a'), null));
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['a']);
    assert.equal(storage.storage.size, 0, 'an anonymous page stores nothing');
  } finally {
    delete global.window;
  }
});

test('a pin appends at the end; unpin takes it off and persists', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    mod.pinApp(pin('a'), 'ana');
    mod.pinApp(pin('b'), 'ana');
    assert.equal(mod.pinApp(pin('a'), 'ana'), false, 'a duplicate pin changes nothing');
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['a', 'b'],
      'the new pin went to the end, the duplicate was refused');
    assert.equal(mod.unpinApp('a', 'ana'), true);
    assert.equal(mod.unpinApp('a', 'ana'), false, 'unpinning twice is a no-op');
    assert.equal(mod.unpinApp('gone', 'ana'), false, 'unpinning an app never pinned too');
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['b']);
    assert.deepEqual(mod.readPinnedApps('ana').map((a) => a.slug), ['b'],
      'and the shorter list is what storage keeps');
    assert.equal(mod.unpinApp(null, 'ana'), false, 'no slug, nothing to unpin');
  } finally {
    delete global.window;
  }
});

test('unreadable or foreign storage reads as an empty list, never a throw', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    storage.storage.set('usernode_pinned_apps_v2', '{not json');
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'corrupt JSON');
    storage.storage.set('usernode_pinned_apps_v2', JSON.stringify({ owner: 'bo', apps: [pin('a')] }));
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'another account\'s list');
    storage.storage.set('usernode_pinned_apps_v2', JSON.stringify({ owner: 'ana', apps: 'nope' }));
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'a non-array apps field');
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'and reading twice is as safe as once');
  } finally {
    delete global.window;
  }
});

test('pinDropStore starts null, answers what a drop would do, and is never persisted', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    assert.deepEqual(mod.pinDropStore.get(), { drop: null },
      'no drag is up when the page loads: the prerender shows no slot');
    mod.pinDropStore.set({ drop: 'ok' });
    assert.equal(mod.pinDropStore.get().drop, 'ok');
    mod.pinDropStore.set({ drop: null });
    assert.deepEqual(mod.pinDropStore.get(), { drop: null }, 'and it clears');
    assert.equal(storage.storage.size, 0, 'a drag state lives for one gesture, not in storage');
  } finally {
    delete global.window;
  }
});

test('the store starts empty, which is what the prerender shows', () => {
  const previousWindow = global.window;
  try {
    delete global.window;
    const mod = loadTsx(STORE);
    assert.deepEqual(mod.pinnedAppsStore.get().apps, [],
      'no storage read at module load: the first render must match the prerender');
    assert.deepEqual(mod.pinDropStore.get(), { drop: null },
      'and no drag state either');
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});