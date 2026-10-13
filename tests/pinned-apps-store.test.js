'use strict';

// The desktop strip's pinned part (#4935): the store behind
// frontend/src/features/nav/strip-apps.tsx that holds the top row of My
// apps, written only by Home through the nav bridge's setPinnedApps.
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
    mod.setPinnedApps([pin('a')], 'ana');
    assert.ok(storage.storage.has('usernode_pinned_apps_v1'), 'written under the pinned key');
    assert.equal(mod.PINNED_APPS_KEY, 'usernode_pinned_apps_v1');
    assert.equal(mod.PINNED_APPS_MAX, 4, 'Home\'s top row is four columns wide');
  } finally {
    delete global.window;
  }
});

test('entries are cleaned to display data, junk dropped, capped at four', () => {
  makeStorage();
  try {
    const mod = loadTsx(STORE);
    mod.setPinnedApps([
      { slug: 'a', name: 'A', iconUrl: 'https://sv.test/a.png', iconEmoji: '🎲', at: '2026-09-20T10:00:00Z' },
      { name: 'No slug' },
      null,
      { slug: '', name: 'Empty slug' },
      { slug: 'b' },
    ], 'ana');
    const apps = mod.pinnedAppsStore.get().apps;
    assert.deepEqual(apps.map((a) => a.slug), ['a', 'b'], 'junk entries leave no hole');
    // Spread before asserting: the store lives in the loaded module's
    // realm, whose objects deepStrictEqual rejects against this file's.
    assert.deepEqual({ ...apps[0] },
      { slug: 'a', name: 'A', iconUrl: 'https://sv.test/a.png', iconEmoji: '🎲' },
      'an entry keeps its display data and carries no clock');
    assert.deepEqual({ ...apps[1] },
      { slug: 'b', name: 'b', iconUrl: null, iconEmoji: null },
      'a missing name falls back to the slug, missing icons to null');

    // The cap: five clean slugs still store four.
    mod.setPinnedApps(['p1', 'p2', 'p3', 'p4', 'p5'].map((s) => pin(s)), 'ana');
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['p1', 'p2', 'p3', 'p4']);
  } finally {
    delete global.window;
  }
});

test('a list is owner-scoped: written for one, read by another, empty', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    mod.setPinnedApps([pin('a'), pin('b')], 'ana');
    assert.equal(storage.raw('usernode_pinned_apps_v1').owner, 'ana');
    assert.deepEqual(mod.readPinnedApps('ana').map((a) => a.slug), ['a', 'b']);
    assert.deepEqual(mod.readPinnedApps('bo'), [], 'another account sees none of it');
    assert.deepEqual(mod.readPinnedApps(null), [], 'signed out reads nothing');
  } finally {
    delete global.window;
  }
});

test('no owner: the strip still shows the row, but nothing is written', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    mod.setPinnedApps([pin('a')], null);
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['a']);
    assert.equal(storage.storage.size, 0, 'an anonymous page stores nothing');
  } finally {
    delete global.window;
  }
});

test('republishing the same row is a no-op, a changed one is not', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    mod.setPinnedApps([pin('a'), pin('b')], 'ana');
    const wrote = () => JSON.stringify(storage.raw('usernode_pinned_apps_v1'));
    const before = wrote();
    const notified = [];
    const unsubscribe = mod.pinnedAppsStore.subscribe(() => notified.push(mod.pinnedAppsStore.get().apps));

    // Home re-renders often; every paint naming the same row must not
    // wake the strip or rewrite storage.
    mod.setPinnedApps([pin('a'), pin('b')], 'ana');
    assert.equal(notified.length, 0, 'an unchanged list does not notify');
    assert.equal(wrote(), before, 'and does not rewrite storage');

    // A different order is a different row: the drag that made it must
    // reach the strip and storage.
    mod.setPinnedApps([pin('b'), pin('a')], 'ana');
    assert.equal(notified.length, 1, 'a changed list notifies once');
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['b', 'a']);
    assert.deepEqual(mod.readPinnedApps('ana').map((a) => a.slug), ['b', 'a']);
    assert.equal(unsubscribe(), undefined, 'unsubscribe is safe to drop in');
  } finally {
    delete global.window;
  }
});

test('unreadable or foreign storage reads as an empty list, never a throw', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    storage.storage.set('usernode_pinned_apps_v1', '{not json');
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'corrupt JSON');
    storage.storage.set('usernode_pinned_apps_v1', JSON.stringify({ owner: 'bo', apps: [pin('a')] }));
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'another account\'s list');
    storage.storage.set('usernode_pinned_apps_v1', JSON.stringify({ owner: 'ana', apps: 'nope' }));
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'a non-array apps field');
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'and reading twice is as safe as once');
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
  } finally {
    if (previousWindow === undefined) delete global.window;
    else global.window = previousWindow;
  }
});
