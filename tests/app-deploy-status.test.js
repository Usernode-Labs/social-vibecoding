'use strict';

// "Is this app deploying?" (src/services/app-deploy-status.js), the question
// the version pill, heal, rollover and the merged list ask: a legacy deploy
// in this process (its map), or one the app-delivery workflow machine runs
// in any process (the app's row, apps.deploy_state, given by the caller).
//
// Run with: node --test tests/app-deploy-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const ws = require.resolve('../src/services/ws');
const broadcasts = [];
require.cache[ws] = { id: ws, filename: ws, loaded: true,
  exports: { broadcastGlobalScoped: (...args) => broadcasts.push(args) }, paths: [] };
const status = require('../src/services/app-deploy-status');

const row = (o = {}) => ({ deploy_state: 'deploying', deploy_started_at: new Date('2026-10-14T10:00:00Z'), deploy_from_sha: 'a'.repeat(40), ...o });

test('a deploy app delivery runs is read from the row, by any process', () => {
  assert.deepEqual(status.read('app-one', row()),
    { deploying: true, startedAt: '2026-10-14T10:00:00.000Z', fromSha: 'a'.repeat(40) });
  assert.equal(status.read('app-one', row({ deploy_state: null })), null);
  assert.equal(status.read('app-one'), null, 'no row read, nothing in memory: not deploying');
});

test('a deploy app delivery runs is not called stale: the machine retries one whose process died', () => {
  const long = row({ deploy_started_at: new Date(Date.now() - 2 * 60 * 60 * 1000) });
  assert.equal(status.read('app-two', long).deploying, true);
});

test('this process\'s own legacy deploy answers first, as before', () => {
  broadcasts.length = 0;
  status.markStart('app-three', { fromSha: 'b'.repeat(40) });
  try {
    assert.equal(status.read('app-three', row({ deploy_state: null })).fromSha, 'b'.repeat(40));
  } finally { status.markEnd('app-three', {}); }
  assert.equal(status.read('app-three', row({ deploy_state: null })), null);
  assert.equal(broadcasts.length, 2);
  assert.ok(broadcasts.every(([payload, routing]) => payload.appSlug === 'app-three' && routing.appSlug === 'app-three'));
});

