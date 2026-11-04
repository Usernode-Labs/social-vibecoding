'use strict';

// #6249: attached files are kept with a message draft, per composer scope, on
// this device — the way typed words already are. Leaving a conversation and
// coming back re-shows the same chips, without uploading anything again.
//
// The store is executed here with a fake localStorage and a controllable
// clock, because the behaviour that matters is what a saved list reads back:
// its own scope only, nothing older than the upload cleanup, and nothing at
// all for a value it cannot read.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');

const KEY = (scope) => `usernode:messages-draft-attachments:${scope}`;
const HOUR = 60 * 60 * 1000;

// Every import the store pulls in that this test does not exercise. A
// property returns a no-op function, so module evaluation finds them defined.
const stub = () => new Proxy({}, { get: () => () => undefined });
const STUBS = {
  '../../lib/i18n/runtime': stub(),
  '../../lib/action-outbox': stub(),
  '../../lib/kept-copies': stub(),
  '../../lib/offline': stub(),
  '../ai/door': stub(),
  '../nav/nav-store.js': stub(),
  '../nav-drawer/messages-drawer': stub(),
  './api': stub(),
  './bot-shared': stub(),
  './channels': stub(),
  './channel-hub': stub(),
  './inbox': stub(),
  './outbox': stub(),
  './request-page': stub(),
  './unread-anchor': stub(),
};

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

const NOW = Date.parse('2026-11-04T10:00:00Z');
const file = (id) => ({
  id,
  name: `${id}.png`,
  size: 1024,
  contentType: 'image/png',
  kind: 'image',
  url: `/api/attachments/${id}`,
  viewUrl: null,
});

/** A fresh evaluation of the store, against `storage`, with the clock stopped. */
function loadStore(storage) {
  globalThis.localStorage = storage;
  return loadTsx('frontend/src/features/messages/store.ts', { stubs: STUBS });
}

test('saved files are kept per composer scope', () => {
  const storage = fakeStorage();
  const store = loadStore(storage);
  const now = Date.now;
  Date.now = () => NOW;
  try {
    store.setDraftAttachments(42, [file('a'), file('b')]);
    store.setDraftAttachments('42:t7', [file('c')]);
    assert.deepEqual(store.draftAttachmentsFor(42).map((item) => item.id), ['a', 'b']);
    assert.deepEqual(store.draftAttachmentsFor('42:t7').map((item) => item.id), ['c']);
    // The file's details are kept as the server sent them, so nothing is
    // uploaded again; each entry carries when it was saved.
    const saved = JSON.parse(storage.getItem(KEY(42)));
    assert.equal(saved[0].attachment.url, '/api/attachments/a');
    assert.equal(saved[0].savedAt, NOW);
  } finally { Date.now = now; }
});

test('a draft saved by an earlier visit is read back by a fresh store (a remount)', () => {
  const storage = fakeStorage();
  const now = Date.now;
  Date.now = () => NOW;
  try {
    loadStore(storage).setDraftAttachments(42, [file('a')]);
    // A new module: the in-memory map is empty, so this reads localStorage,
    // exactly as a reload or leaving Messages and coming back does.
    const again = loadStore(storage);
    assert.deepEqual(again.draftAttachmentsFor(42).map((item) => item.id), ['a']);
  } finally { Date.now = now; }
});

test('an entry older than the upload cleanup is dropped and the key rewritten', () => {
  const storage = fakeStorage();
  const store = loadStore(storage);
  const now = Date.now;
  Date.now = () => NOW;
  try {
    storage.setItem(KEY(42), JSON.stringify([
      { attachment: file('old'), savedAt: NOW - 23 * HOUR - 1 },
      { attachment: file('fresh'), savedAt: NOW - 22 * HOUR },
    ]));
    assert.deepEqual(store.draftAttachmentsFor(42).map((item) => item.id), ['fresh']);
    const rewritten = JSON.parse(storage.getItem(KEY(42)));
    assert.deepEqual(rewritten.map((entry) => entry.attachment.id), ['fresh'],
      'the aged-out entry does not come back on the next read');
  } finally { Date.now = now; }
});

test('an empty list removes the saved key', () => {
  const storage = fakeStorage();
  const store = loadStore(storage);
  store.setDraftAttachments(42, [file('a')]);
  assert.ok(storage.getItem(KEY(42)));
  store.setDraftAttachments(42, []);
  assert.equal(storage.getItem(KEY(42)), null);
  assert.deepEqual(store.draftAttachmentsFor(42), []);
});

test('a value it cannot read gives no files instead of throwing', () => {
  const storage = fakeStorage();
  const store = loadStore(storage);
  storage.setItem(KEY(42), '{not json');
  assert.deepEqual(store.draftAttachmentsFor(42), []);
  storage.setItem(KEY('42:t7'), JSON.stringify({ attachment: file('a') }));
  assert.deepEqual(store.draftAttachmentsFor('42:t7'), []);
  storage.setItem(KEY('1:t2'), JSON.stringify([{ attachment: { name: 'no id' }, savedAt: Date.now() }]));
  assert.deepEqual(store.draftAttachmentsFor('1:t2'), []);
});

test('re-saving an attachment keeps the time it was first saved', () => {
  const storage = fakeStorage();
  const store = loadStore(storage);
  const now = Date.now;
  Date.now = () => NOW;
  try {
    store.setDraftAttachments(42, [file('a')]);
  } finally { Date.now = now; }
  const later = loadStore(storage);
  const nowAgain = Date.now;
  Date.now = () => NOW + 6 * HOUR;
  try {
    later.setDraftAttachments(42, [file('a'), file('b')]);
    const saved = JSON.parse(storage.getItem(KEY(42)));
    assert.deepEqual(saved.map((entry) => entry.savedAt), [NOW, NOW + 6 * HOUR],
      'the file already saved keeps its first time, so it still ages out on schedule');
  } finally { Date.now = nowAgain; }
});
