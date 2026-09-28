'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const express = require('express');
const groups = require('../frontend/src/features/notifications/filter-groups.json');
const notifications = require('../src/services/notifications');
const poolModule = require('../src/db/pool');
const frontend = fs.readFileSync('frontend/src/features/notifications/notifications.js', 'utf8');
const method = frontend.match(/async loadKind\(kind, more = false\) \{([\s\S]*?)\n  \},/)[1];
function pager(fetch) {
  const controller = { items: [], filterPages: {}, nextBefore: { id: 80 }, _renderList() {} };
  const load = new Function('Notifications', 'fetch', 'URLSearchParams', 'window',
    `return async function(kind, more = false) {${method}}`)(controller, fetch, URLSearchParams, { location: { search: '' } });
  return { controller, load };
}
const response = (notifications, hasMore = false, nextBefore = null) => ({
  ok: true, json: async () => ({ notifications, hasMore, nextBefore }),
});
const row = (id, kind) => ({ id, kind, createdAt: `2026-09-28T10:00:${String(id).padStart(2, '0')}Z` });

test('types have specific membership, including conversation mentions and revised votes', () => {
  assert.deepEqual(groups.mentions.kinds, ['mention', 'conversation_mention']);
  assert.ok(groups.votes.kinds.includes('revision_recheck'));
  assert.ok(groups.invitations.kinds.includes('friend_accept'));
  assert.ok(!groups.votes.kinds.includes('kudos'));
});

test('kind pagination keeps recipient and cursor predicates together', async () => {
  let query;
  await notifications.listForUser({ query: async (sql, args) => { query = { sql, args }; return { rows: [] }; } },
    42, { limit: 10, before: { createdAt: '2026-09-28T00:00:00Z', id: 99 }, kinds: groups.mentions.kinds });
  assert.match(query.sql, /n\.user_id = \$1/);
  assert.match(query.sql, /\(n.created_at, n.id\) < \(\$2, \$3\)/);
  assert.match(query.sql, /n.kind = ANY\(\$4\)/);
  assert.deepEqual(query.args, [42, '2026-09-28T00:00:00Z', 99, groups.mentions.kinds, 10]);
});

test('named filters reject unknown and prototype keys; login remains required', async (t) => {
  const previous = poolModule.getPool;
  let queries = 0;
  poolModule.getPool = () => ({ query: async () => { queries++; return { rows: [] }; } });
  const path = require.resolve('../src/routes/notifications');
  delete require.cache[path];
  const { notificationsRoutes } = require(path);
  poolModule.getPool = previous;
  delete require.cache[path];
  const app = express();
  app.use((req, res, next) => { if (req.headers['x-test-user']) req.user = { id: 42 }; next(); });
  app.use(notificationsRoutes({}));
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const kind of ['unknown', 'toString', '__proto__', 'mentions&kind=votes']) {
    const res = await fetch(`${origin}/api/notifications?kind=${kind}`, { headers: { 'x-test-user': '42' } });
    assert.equal(res.status, 400, kind);
  }
  assert.equal(queries, 0);
  assert.equal((await fetch(`${origin}/api/notifications?kind=mentions`)).status, 401);
});

test('filter cursors are independent and older matching rows are merged without duplicates', async () => {
  const requests = [];
  const { controller, load } = pager(async url => {
    requests.push(String(url));
    const kind = new URL(url, 'https://example.test').searchParams.get('kind');
    return kind === 'votes' ? response([row(9, 'proposal_vote')], true, { createdAt: 'earlier', id: 9 })
      : response([row(8, 'mention')]);
  });
  await load('votes'); await load('mentions'); await load('votes', true);
  assert.equal(controller.items.length, 2);
  assert.match(requests[2], /before=earlier&before_id=9/);
  assert.doesNotMatch(requests[1], /before/);
  assert.deepEqual(controller.nextBefore, { id: 80 });
  assert.equal(controller.filterPages.mentions.hasMore, false);
});

test('failed filtered reads expose a retry and retain their cursor and rows', async () => {
  let fail = false;
  const { controller, load } = pager(async () => {
    if (fail) return { ok: false };
    return response([row(9, 'kudos')], true, { createdAt: 'earlier', id: 9 });
  });
  await load('kudos'); fail = true; await load('kudos', true);
  assert.match(controller.filterPages.kudos.error, /Try again/);
  assert.equal(controller.filterPages.kudos.loading, false);
  assert.equal(controller.filterPages.kudos.nextBefore.id, 9);
  fail = false; await load('kudos', true);
  assert.equal(controller.filterPages.kudos.error, null);
  assert.equal(controller.items.length, 1);
});

test('overlapping filters and refresh cannot replace the current feed with stale rows', async () => {
  const pending = {};
  const { controller, load } = pager(url => new Promise(resolve => {
    pending[new URL(url, 'https://example.test').searchParams.get('kind')] = resolve;
  }));
  const votes = load('votes'); const mentions = load('mentions');
  pending.mentions(response([row(4, 'mention')])); await mentions;
  controller.filterPages = {}; controller.items = [];
  pending.votes(response([row(5, 'proposal_vote')])); await votes;
  assert.deepEqual(controller.items, []);
  assert.deepEqual(controller.filterPages, {});
});
