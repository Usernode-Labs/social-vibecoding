'use strict';

// The desktop sidebar's pins (#5323): the store behind
// frontend/src/features/nav/rail-pinned.tsx that holds what the viewer
// pinned there (the strip's apps until 18 Oct 2026, their communities since:
// the same slugs), written only by a drop on the "Pin here" slot (Home's
// drag recognizer, through pinApp) and by the section itself (a drag back
// out, or its Unpin menu, through unpinApp).
//
// The list is the account's (src/services/community-pins.js,
// tests/community-pins-postgres.test.js): this store is its copy on the
// page. Entries carry the display data the sidebar draws, the device's copy
// names the account it was written for, unreadable storage is an empty
// list, a change lands here at once and the account's answer stands after
// it, a device's pins from before are sent up once, and NOTHING here may run
// during an initial render — the store starts empty, which is what the
// prerender shows.
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

test('the storage keys are the one literals, exported so they cannot drift', () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    assert.ok(mod.pinApp(pin('a'), 'ana'), 'a pin of a fresh app writes');
    assert.ok(storage.storage.has('usernode_community_pins_v1'), 'the account\'s copy, on this device');
    assert.equal(mod.PINNED_APPS_KEY, 'usernode_community_pins_v1');
    assert.equal(mod.PINNED_APPS_DEVICE_KEY, 'usernode_pinned_apps_v2', 'the device\'s own pins from before, sent up once');
    assert.equal(mod.PINNED_APPS_MAX, 4, 'four is still the most there is room for');
    assert.equal(require('../src/services/community-pins').PINS_MAX, mod.PINNED_APPS_MAX, 'the account keeps the same four');
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
    assert.equal(storage.raw('usernode_community_pins_v1').owner, 'ana');
    assert.deepEqual(mod.readPinnedApps('ana').map((a) => a.slug), ['a', 'b']);
    assert.deepEqual(mod.readPinnedApps('bo'), [], 'another account sees none of it');
    assert.deepEqual(mod.readPinnedApps(null), [], 'signed out reads nothing');
  } finally {
    delete global.window;
  }
});

test('no owner: the sidebar still shows the pin, but nothing is written', () => {
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
    storage.storage.set('usernode_community_pins_v1', '{not json');
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'corrupt JSON');
    storage.storage.set('usernode_community_pins_v1', JSON.stringify({ owner: 'bo', apps: [pin('a')] }));
    assert.deepEqual(mod.readPinnedApps('ana'), [], 'another account\'s list');
    storage.storage.set('usernode_community_pins_v1', JSON.stringify({ owner: 'ana', apps: 'nope' }));
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
// ── The account's list ──────────────────────────────────────────────────

// A fetch on the window, as the page has it: each call recorded, each answer
// what the test says the account says.
function withFetch(answer) {
  const calls = [];
  window.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
    const { status = 200, body } = await answer(url, opts, calls.length);
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the account\'s pins are read when someone signs in, and kept as this device\'s copy', async () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    const calls = withFetch(() => ({ body: { pins: [pin('chess'), pin('gym')] } }));
    await mod.loadPins('ana');
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['GET', '/api/me/community-pins']]);
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['chess', 'gym']);
    assert.deepEqual(storage.raw('usernode_community_pins_v1').apps.map((a) => a.slug), ['chess', 'gym']);
    assert.deepEqual(mod.readPinnedApps('ana').map((a) => a.slug), ['chess', 'gym'], 'drawn at once next time');
    // Signed out: nothing is read.
    await mod.loadPins(null);
    assert.equal(calls.length, 1);
  } finally {
    delete global.window;
  }
});

test('a device\'s own pins from before are sent up once, then forgotten', async () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    storage.storage.set('usernode_pinned_apps_v2', JSON.stringify({ owner: 'ana', apps: [pin('run'), pin('dice')] }));
    const calls = withFetch(() => ({ body: { pins: [pin('chess'), pin('run')] } }));
    await mod.loadPins('ana');
    assert.deepEqual(calls.map((c) => [c.method, c.url, c.body]), [['POST', '/api/me/community-pins/import', { slugs: ['run', 'dice'] }]]);
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['chess', 'run'], 'the account\'s answer stands');
    assert.equal(storage.storage.has('usernode_pinned_apps_v2'), false, 'sent once');
    await mod.loadPins('ana');
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET'], 'and never again');
    // Another account's old pins on this device are not this one's to send.
    storage.storage.set('usernode_pinned_apps_v2', JSON.stringify({ owner: 'bo', apps: [pin('run')] }));
    await mod.loadPins('ana');
    assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET', 'GET']);
  } finally {
    delete global.window;
  }
});

test('an answer for someone no longer signed in is dropped; a failed read keeps the copy', async () => {
  const storage = makeStorage();
  try {
    const mod = loadTsx(STORE);
    let release;
    const late = new Promise((resolve) => { release = resolve; });
    withFetch(async (url, opts, n) => (n === 1 ? (await late, { body: { pins: [pin('anas')] } }) : { body: { pins: [pin('bos')] } }));
    const first = mod.loadPins('ana');
    await mod.loadPins('bo');
    release();
    await first;
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['bos'], 'ana\'s late answer does not land on bo');
    withFetch(() => ({ status: 500, body: { error: 'down' } }));
    await mod.loadPins('bo');
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['bos']);
    assert.deepEqual(storage.raw('usernode_community_pins_v1').apps.map((a) => a.slug), ['bos']);
  } finally {
    delete global.window;
  }
});

test('a pin lands at once and the account\'s answer stands; a refusal reads the account again', async () => {
  makeStorage();
  try {
    const mod = loadTsx(STORE);
    let calls = withFetch((url, opts) => ({ body: { pins: opts.method === 'PUT' ? [pin('chess'), pin('gym')] : [] } }));
    assert.equal(mod.pinApp(pin('gym'), 'ana'), true);
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['gym'], 'under the press');
    await settled();
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['PUT', '/api/me/community-pins/gym']]);
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['chess', 'gym'], 'the account\'s list');
    // Refused (four already, or a Join said no to): back to what the account holds.
    calls = withFetch((url, opts) => (opts.method === 'PUT'
      ? { status: 409, body: { error: 'Unpin one first: four is the most.', code: 'pins_full' } }
      : { body: { pins: [pin('chess'), pin('gym')] } }));
    assert.equal(mod.pinApp(pin('run'), 'ana'), true);
    await settled(); await settled();
    assert.deepEqual(calls.map((c) => c.method), ['PUT', 'GET']);
    assert.deepEqual(mod.pinnedAppsStore.get().apps.map((a) => a.slug), ['chess', 'gym']);
    // Unpin sends DELETE.
    calls = withFetch(() => ({ body: { pins: [pin('chess')] } }));
    assert.equal(mod.unpinApp('gym', 'ana'), true);
    await settled();
    assert.deepEqual(calls.map((c) => [c.method, c.url]), [['DELETE', '/api/me/community-pins/gym']]);
    // Leaving a community: its pin goes here too, and nothing is sent.
    calls = withFetch(() => ({ body: { pins: [] } }));
    mod.forgetPin('chess', 'ana');
    assert.deepEqual(mod.pinnedAppsStore.get().apps, []);
    await settled();
    assert.equal(calls.length, 0);
  } finally {
    delete global.window;
  }
});

test('sign-in reads the account\'s pins, and a community left loses its pin', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const mount = fs.readFileSync(path.join(__dirname, '../frontend/src/features/nav/mount.ts'), 'utf8');
  assert.match(mount, /pinnedAppsStore\.set\(\{ apps: readPinnedApps\(viewer \|\| null\) \}\);\s*pinDropStore\.set\(\{ drop: null \}\);\s*void loadPins\(viewer \|\| null\);/);
  assert.match(mount, /document\.addEventListener\('sv:membership-changed', \(event\) => \{[\s\S]*?if \(detail && detail\.slug && !detail\.joined\) forgetPin\(detail\.slug, navStore\.get\(\)\.viewer\);/);
  const home = fs.readFileSync(path.join(__dirname, '../frontend/src/features/home/home.js'), 'utf8');
  assert.match(home, /MEMBERSHIP_EVENT: 'sv:membership-changed',/, 'the event Home dispatches once a leave lands');
});
