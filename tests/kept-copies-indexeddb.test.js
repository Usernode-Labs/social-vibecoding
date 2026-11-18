'use strict';

// The native-offline proposal (18 Nov 2026): the copies a device keeps to
// draw offline (lib/kept-copies.ts) live in IndexedDB behind an in-memory
// mirror, under a budget localStorage could not give them. The offline test
// on production found a 76-conversation Messages list (176k characters) never
// kept, because localStorage's budget allowed 150k a copy; a cold launch with
// no network then had no list to draw.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const KEPT = 'frontend/src/lib/kept-copies.ts';
const ADA = 'a'.repeat(64);

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    get length() { return map.size; },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/** Just enough IndexedDB for the mirror: one database, one store, string keys. */
function fakeIndexedDb(data = new Map()) {
  const db = {
    createObjectStore() {},
    transaction() {
      const tx = {};
      tx.objectStore = () => ({
        getAllKeys: () => ({ result: [...data.keys()] }),
        getAll: () => ({ result: [...data.values()] }),
        put: (value, key) => { data.set(key, value); },
        delete: (key) => { data.delete(key); },
      });
      setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
      return tx;
    },
  };
  return {
    data,
    factory: {
      open() {
        const req = {};
        setTimeout(() => {
          req.result = db;
          if (req.onupgradeneeded) req.onupgradeneeded();
          if (req.onsuccess) req.onsuccess();
        }, 0);
        return req;
      },
    },
  };
}

function device(t, { idb = fakeIndexedDb(), local = fakeStorage() } = {}) {
  const keys = ['window', 'document', 'localStorage', 'indexedDB', 'navigator'];
  const saved = keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const set = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  set('localStorage', local);
  set('indexedDB', idb.factory);
  set('document', { cookie: `__Host-usernode_api_scope=${ADA}` });
  set('window', { location: { search: '', hash: '' } });
  set('navigator', { storage: { persist: () => Promise.resolve(true) } });
  return { idb, local };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a copy too large for localStorage is kept in IndexedDB, and read back after a relaunch', async (t) => {
  const { idb } = device(t);
  const kept = loadTsx(KEPT);
  await kept.keptLoaded();
  const list = { conversations: [{ id: 1, preview: 'x'.repeat(176_000) }] };
  assert.ok(JSON.stringify(list).length > kept.KEPT_MAX_CHARS, 'larger than localStorage\'s budget allowed');
  kept.keepCopy('conversations', list);
  assert.deepEqual(kept.keptCopy('conversations'), list, 'drawn from the mirror at once');
  await settle();
  assert.ok(idb.data.has('usernode:kept:conversations'), 'and written behind it to the database');

  // A relaunch: a new page, the same database.
  const again = loadTsx(KEPT);
  assert.equal(again.keptCopy('conversations'), null, 'not readable before the mirror has loaded');
  await again.keptLoaded();
  assert.deepEqual(again.keptCopy('conversations'), list, 'readable once it has');
});

test('an older build\'s copies in localStorage move to IndexedDB on the first load', async (t) => {
  const entry = JSON.stringify({ scope: ADA, at: Date.now() - 1000, data: { pins: [{ slug: 'p' }] } });
  const local = fakeStorage({ 'usernode:kept:owner': ADA, 'usernode:kept:home:pins': entry, 'usernode.session.v1': '{}' });
  const { idb } = device(t, { local });
  const kept = loadTsx(KEPT);
  assert.deepEqual(kept.keptCopy('home:pins'), { pins: [{ slug: 'p' }] }, 'readable from localStorage while the database loads');
  await kept.keptLoaded();
  await settle();
  assert.equal(local.getItem('usernode:kept:home:pins'), null, 'gone from localStorage, which the boot state needs');
  assert.equal(local.getItem('usernode.session.v1'), '{}', 'nothing else there is touched');
  assert.equal(local.getItem('usernode:kept:owner'), ADA, 'whose the copies are stays in localStorage');
  assert.equal(idb.data.get('usernode:kept:home:pins'), entry);
  assert.deepEqual(kept.keptCopy('home:pins'), { pins: [{ slug: 'p' }] });
});

test('a sign-out forgets every copy, in the database and in localStorage', async (t) => {
  const { idb, local } = device(t);
  const kept = loadTsx(KEPT);
  await kept.keptLoaded();
  kept.keepCopy('ai:work', { items: [1] });
  await settle();
  assert.ok(idb.data.size > 0);
  kept.forgetKeptCopies();
  await settle();
  assert.equal(kept.keptCopy('ai:work'), null);
  assert.ok(![...idb.data.keys()].some((key) => key.startsWith('usernode:kept:')), 'the database is empty of copies');
  assert.ok(![...local.map.keys()].some((key) => key.startsWith('usernode:kept:') && key !== 'usernode:kept:owner'),
    'and so is localStorage (the read above noted whose copies they are again)');
});

test('the IndexedDB budget is the larger one, and drawing a copy tells the screen\'s freshness', async (t) => {
  device(t);
  const kept = loadTsx(KEPT);
  await kept.keptLoaded();
  assert.ok(kept.KEPT_DB_MAX_CHARS >= 10 * kept.KEPT_MAX_CHARS);
  assert.ok(kept.KEPT_DB_TOTAL_CHARS >= 10 * kept.KEPT_TOTAL_CHARS);
  kept.keepCopy('too-big', 'x'.repeat(kept.KEPT_DB_MAX_CHARS));
  assert.equal(kept.keptCopy('too-big'), null, 'one past the per-copy limit is still not kept');

  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', KEPT), 'utf8');
  assert.match(source, /noteSaved\(`kept:\$\{name\}`, entry\.at\)/, 'a drawn copy notes when it was saved');
  assert.match(source, /noteFresh\(`kept:\$\{name\}`\)/, 'a new answer says the screen is current');
});
