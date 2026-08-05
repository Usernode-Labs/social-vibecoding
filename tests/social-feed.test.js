'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const service = require('../src/services/social-feed');

const at = '2026-08-05T10:00:00.000Z';
function row(over = {}) {
  return {
    type: 'proposal', sort_type: 2, source_id: 12, occurred_at: at,
    actor_username: 'builder', app_id: 3, app_slug: 'public-app',
    app_name: 'Public App', session_id: 12, pr_number: 7,
    pr_title: 'Useful change', pr_status: 'promoted',
    author_username: 'builder', ...over,
  };
}

test('cursor is opaque, versioned and rejects malformed or unsafe values', () => {
  const encoded = service.encodeCursor(row());
  assert.deepEqual(service.decodeCursor(encoded), { at, type: 2, id: 12 });
  for (const bad of ['', 'not-json', Buffer.from('{}').toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, at, t: 9, id: 1 })).toString('base64url'),
    Buffer.from(JSON.stringify({ v: 1, at, t: 1, id: 0 })).toString('base64url')]) {
    assert.equal(service.decodeCursor(bad), null);
  }
});

test('serialization exposes only the typed public card contract', () => {
  const proposal = service.serialize(row());
  assert.deepEqual(proposal, {
    id: 'proposal:12', type: 'proposal', occurred_at: at,
    actor: { username: 'builder' },
    app: { id: 3, slug: 'public-app', name: 'Public App' },
    proposal: { id: 12, number: 7, title: 'Useful change', status: 'proposed', author: 'builder' },
  });
  const app = service.serialize(row({
    type: 'app_created', sort_type: 1, source_id: 3,
    session_id: null, pr_number: null, pr_title: null,
    pr_status: null, author_username: null,
  }));
  assert.equal(app.proposal, undefined);
  assert.equal(service.proposalStatus('merging'), 'merging');
  assert.equal(service.proposalStatus('merged'), 'merged');
});

test('service uses stable keyset pagination and repeats privacy filters per source', async () => {
  let call;
  const rows = [
    row({ type: 'kudos', sort_type: 3, source_id: 15, actor_username: 'fan' }),
    row(),
    row({ type: 'app_created', sort_type: 1, source_id: 3, session_id: null,
      pr_number: null, pr_title: null, pr_status: null, author_username: null }),
  ];
  const pool = { query: async (sql, params) => { call = { sql, params }; return { rows }; } };
  const cursor = { at: '2026-08-06T00:00:00.000Z', type: 3, id: 99 };
  const page = await service.listSocialFeed(pool, { limit: 2, cursor });
  assert.equal(page.items.length, 2);
  assert.equal(page.has_more, true);
  assert.deepEqual(service.decodeCursor(page.next_cursor), { at, type: 2, id: 12 });
  assert.deepEqual(call.params, [cursor.at, 3, 99, 3]);
  assert.match(call.sql, /\(occurred_at, sort_type, source_id\) < \(\$1/);
  assert.match(call.sql, /ORDER BY occurred_at DESC, sort_type DESC, source_id DESC/);
  assert.equal((call.sql.match(/a\.view_visibility = 'public'/g) || []).length, 3);
  assert.equal((call.sql.match(/cs\.is_headless = FALSE/g) || []).length, 2);
  assert.equal((call.sql.match(/cs\.status IN \('promoted', 'merging', 'merged'\)/g) || []).length, 2);
  assert.match(call.sql, /a\.status <> 'error'/);
  assert.match(call.sql, /JOIN users creator/);
  assert.match(call.sql, /JOIN users giver/);
  assert.match(call.sql, /JOIN users author/);
  assert.doesNotMatch(call.sql, /FROM events/);
  assert.match(call.sql, /make_interval\(days => 30\)/);
});

test('limit defaults to 20 and clamps to 50', () => {
  assert.equal(service.clampLimit(undefined), 20);
  assert.equal(service.clampLimit('0'), 20);
  assert.equal(service.clampLimit('500'), 50);
  assert.equal(service.clampLimit('4'), 4);
});

// Route-level authentication and cursor validation run before the DB read.
const poolModule = require('../src/db/pool');
const originalGetPool = poolModule.getPool;
let queryCount = 0;
poolModule.getPool = () => ({
  query: async () => { queryCount += 1; return { rows: [] }; },
});
delete require.cache[require.resolve('../src/routes/social-feed')];
const { socialFeedRoutes } = require('../src/routes/social-feed');
poolModule.getPool = originalGetPool;

let server;
test.before(async () => {
  const app = express();
  app.use((req, _res, next) => {
    if (req.headers['x-test-user'] === 'yes') req.user = { id: 4, username: 'viewer' };
    next();
  });
  app.use(socialFeedRoutes({}));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
});
test.after(() => server?.close());

async function get(path, signedIn = true) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    headers: signedIn ? { 'x-test-user': 'yes' } : {},
  });
  return { status: res.status, body: await res.json() };
}

test('route requires a signed-in viewer', async () => {
  const res = await get('/api/social-feed', false);
  assert.equal(res.status, 401);
});

test('route rejects an invalid cursor without querying', async () => {
  const before = queryCount;
  const res = await get('/api/social-feed?before=broken');
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Invalid cursor');
  assert.equal(queryCount, before);
});

test('route returns the bounded feed page', async () => {
  const res = await get('/api/social-feed?limit=4');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { items: [], has_more: false, next_cursor: null });
});
