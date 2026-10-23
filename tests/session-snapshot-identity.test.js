'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../public/js/app.js'), 'utf8');

function session() {
  const store = new Map();
  const document = { cookie: 'usernode_api_scope=' + 'a'.repeat(64) };
  let drops = 0;
  const methods = ['saveSessionSnapshot', 'readSessionSnapshot', 'clearSessionSnapshot', '_sessionCacheScope'].map(name => {
    const start = source.indexOf(`\n  ${name}(`);
    assert.ok(start > -1);
    return source.slice(start, source.indexOf('\n  },', start) + '\n  },'.length);
  });
  const context = { document, Date, JSON,
    localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    drop: () => { drops++; store.clear(); } };
  vm.createContext(context);
  vm.runInContext(`const App = { SESSION_SNAPSHOT_KEY: 'fixture', SESSION_SNAPSHOT_MAX_AGE_MS: 30 * 86400_000,
    _dropCachedSession: drop, ${methods.join('\n')} }; globalThis.app = App;`, context);
  return { app: context.app, document, store, get drops() { return drops; } };
}

test('the current session can restore its display snapshot and another session clears it before use', () => {
  const h = session();
  h.app.saveSessionSnapshot({ id: 101, username: 'FAKE_A' });
  assert.equal(h.app.readSessionSnapshot().user.username, 'FAKE_A');
  h.document.cookie = 'usernode_api_scope=' + 'b'.repeat(64);
  assert.equal(h.app.readSessionSnapshot(), null);
  assert.equal(h.drops, 1);
  assert.equal(h.store.size, 0);
});

test('expired/missing hints and unscoped legacy snapshots cannot revive a previous user', () => {
  const h = session();
  h.app.saveSessionSnapshot({ id: 101, username: 'FAKE_A' });
  h.document.cookie = '';
  assert.equal(h.app.readSessionSnapshot(), null);
  assert.equal(h.drops, 1);
  h.store.set('fixture', JSON.stringify({ user: { id: 101, username: 'FAKE_OLD' }, savedAt: Date.now() }));
  assert.equal(h.app.readSessionSnapshot(), null);
  assert.equal(h.drops, 2);
  h.app.saveSessionSnapshot({ id: 202, username: 'FAKE_B' });
  assert.equal(h.store.size, 0, 'an unpartitioned snapshot is never written');
});
