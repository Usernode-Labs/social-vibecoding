// #2847: opening a proposal card, or interacting with anything on it, clears
// the viewer's "New proposal" (pr_proposed) notification for that proposal.
// Voting already did (the vote_cast entry, pinned elsewhere); this pins the
// other two paths:
//
//   1. The registry's `proposal_opened` action — pr_proposed only, scoped by
//      session_id — and POST /api/notifications/read { session_id } using it.
//   2. The client helper Notifications.markProposalSeen, extracted from the
//      shipped source and run against stubs.
//   3. AppView calls it on the topic page open and from a capture-phase
//      click on any proposal card in #dev-body.
//
// Run with: node --test tests/proposal-seen-clears-notification.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const poolModule = require('../src/db/pool');
const notifications = require('../src/services/notifications');

const ROOT = path.join(__dirname, '..');
const FE_SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'notifications', 'notifications.js'), 'utf8'
);
const APP_VIEW_SRC = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app-view.js'), 'utf8');

// ── 1. service + route ──────────────────────────────────────────────────

test('proposal_opened resolves pr_proposed and "ready to try", scoped by session_id', () => {
  // #6441: opening a change's page (or its before-and-after) answers its
  // "ready to try" as well as its "New proposal".
  assert.deepEqual(notifications.ACTION_COMPLETIONS.proposal_opened, {
    kinds: ['pr_proposed', 'build_ready'], scope: 'session_id',
  });
});

test('markReadForAction(proposal_opened) clears that user\'s unread pr_proposed rows for the session', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return { rowCount: 1, rows: [] }; } };
  const cleared = await notifications.markReadForAction(pool, 7, 'proposal_opened', 55);
  assert.equal(cleared, 1);
  assert.match(calls[0].sql, /user_id = \$1 AND session_id = \$2 AND kind = ANY\(\$3\) AND read_at IS NULL/);
  assert.deepEqual(calls[0].params, [7, 55, ['pr_proposed', 'build_ready']]);
});

function loadRoutes(pool) {
  const original = poolModule.getPool;
  poolModule.getPool = () => pool;
  const modulePath = require.resolve('../src/routes/notifications');
  delete require.cache[modulePath];
  const routes = require('../src/routes/notifications');
  poolModule.getPool = original;
  delete require.cache[modulePath];
  return routes;
}

function makePool({ cleared }) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      if (/^\s*UPDATE notifications/.test(sql)) return { rowCount: cleared, rows: [] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ c: 3, m: 1 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
}

async function withServer(pool, fn) {
  // Stand in for the WS module so the fan-out is observable and the real
  // socket server is never loaded.
  const wsPath = require.resolve('../src/services/ws');
  const saved = require.cache[wsPath];
  const pushes = [];
  require.cache[wsPath] = {
    id: wsPath, filename: wsPath, loaded: true,
    exports: { pushNotificationToUser: (userId, msg) => pushes.push({ userId, msg }) },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 7 }; next(); });
  app.use(loadRoutes(pool).notificationsRoutes({}));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const post = (body) => fetch(`http://127.0.0.1:${server.address().port}/api/notifications/read`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try {
    await fn(post, pushes);
  } finally {
    server.close();
    if (saved) require.cache[wsPath] = saved; else delete require.cache[wsPath];
  }
}

test('POST /api/notifications/read { session_id } clears the proposal nudge and fans out', async () => {
  const pool = makePool({ cleared: 1 });
  await withServer(pool, async (post, pushes) => {
    const res = await post({ session_id: 55 });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { unread: 3, messageUnread: 1, cleared: 1 });
    const update = pool.calls.find((c) => /UPDATE notifications/.test(c.sql));
    assert.deepEqual(update.params, [7, 55, ['pr_proposed', 'build_ready']]);
    assert.deepEqual(pushes, [{ userId: 7, msg: { type: 'notifications_changed' } }]);
  });
});

test('POST /api/notifications/read { session_id } with nothing to clear does not fan out', async () => {
  const pool = makePool({ cleared: 0 });
  await withServer(pool, async (post, pushes) => {
    const res = await post({ session_id: '55' });
    assert.deepEqual(await res.json(), { unread: 3, messageUnread: 1, cleared: 0 });
    assert.equal(pushes.length, 0);
  });
});

test('POST /api/notifications/read rejects a malformed session_id', async () => {
  for (const bad of [0, -1, 'abc', '1.5', 99999999999]) {
    const pool = makePool({ cleared: 0 });
    await withServer(pool, async (post) => {
      const res = await post({ session_id: bad });
      assert.equal(res.status, 400, `session_id ${JSON.stringify(bad)}`);
      assert.equal(pool.calls.length, 0);
    });
  }
});

// ── 2. client helper ────────────────────────────────────────────────────

function buildMarkProposalSeen(Notifications, fetchImpl) {
  const m = FE_SRC.match(/async markProposalSeen\(sessionId\) \{([\s\S]*?)\n {2}\},/);
  assert.ok(m, 'markProposalSeen() defined in notifications.js');
  // eslint-disable-next-line no-new-func
  return new Function('Notifications', 'fetch', `return (async (sessionId) => {${m[1]}})`)(
    Notifications, fetchImpl
  );
}

function stubNotifications(unread, items) {
  const renders = [];
  return {
    renders,
    unread,
    items,
    _renderBadge() { renders.push('badge'); },
    _renderList() { renders.push('list'); },
  };
}

test('markProposalSeen posts session_id, marks the matching row read, and adopts the server count', async () => {
  const items = [
    { id: 1, kind: 'pr_proposed', sessionId: 55, readAt: null },
    { id: 2, kind: 'revision_recheck', sessionId: 55, readAt: null },
    { id: 3, kind: 'pr_proposed', sessionId: 56, readAt: null },
    // #6441: its "ready to try" is answered by the same look.
    { id: 4, kind: 'build_ready', sessionId: 55, readAt: null },
    { id: 5, kind: 'build_ready', sessionId: 56, readAt: null },
  ];
  const N = stubNotifications(3, items);
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ unread: 2, cleared: 1 }) };
  };
  await buildMarkProposalSeen(N, fetchImpl)(55);
  assert.deepEqual(requests, [{ url: '/api/notifications/read', body: { session_id: 55 } }]);
  assert.ok(items[0].readAt, 'the proposal nudge is read');
  assert.equal(items[1].readAt, null, 'a re-vote ask is not answered by looking');
  assert.equal(items[2].readAt, null, 'another proposal is untouched');
  assert.ok(items[3].readAt, 'that change\'s ready to try is read');
  assert.equal(items[4].readAt, null, 'another change\'s is untouched');
  assert.equal(N.unread, 2);
  assert.deepEqual(N.renders, ['badge', 'list']);
});

test('markProposalSeen sends nothing when no notification is unread or the id is bad', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({}) }; };
  await buildMarkProposalSeen(stubNotifications(0, []), fetchImpl)(55);
  await buildMarkProposalSeen(stubNotifications(4, []), fetchImpl)(NaN);
  await buildMarkProposalSeen(stubNotifications(4, []), fetchImpl)(0);
  assert.equal(calls, 0);
});

// ── 3. AppView wiring ───────────────────────────────────────────────────

test('opening a proposal or session topic marks its nudge seen', () => {
  const m = APP_VIEW_SRC.match(/async _renderTopicSubView\(content, ref\) \{([\s\S]*?)AppView\._invalidateVoteRoster/);
  assert.ok(m, '_renderTopicSubView found');
  assert.match(m[1], /ref\.kind === 'proposal' \|\| ref\.kind === 'session'/);
  assert.match(m[1], /window\.Notifications\?\.markProposalSeen\?\.\(ref\.id\)/);
});

test('any click on a proposal card in #dev-body marks it seen, in the capture phase', () => {
  const m = APP_VIEW_SRC.match(
    /bodyEl\.addEventListener\('click', \(e\) => \{\s*const card = ([\s\S]*?)\}, \{ capture: true, signal: devBodySignal \}\);/
  );
  assert.ok(m, 'capture-phase card listener on #dev-body');
  for (const hook of ['[data-proposal-row]', '[data-shared-session-row]', '[data-session-chip]']) {
    assert.ok(m[1].includes(hook), `listener matches ${hook}`);
  }
  assert.match(m[1], /window\.Notifications\?\.markProposalSeen\?\.\(/);
  assert.doesNotMatch(m[1], /preventDefault|stopPropagation/, 'marking read never changes what the click does');
});

// ── 4. #6441: the other two ways a change is seen ───────────────────────

const THREAD_CHANGES_SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'dev-board', 'topic', 'thread-changes.tsx'), 'utf8'
);
const DETAIL_SRC = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'ai', 'detail.ts'), 'utf8'
);

test('a change drawn on its request\'s page marks its "ready to try" seen', () => {
  // A change with a request lands on the request's page, so that page is the
  // change's page: opening it answers its "ready to try".
  assert.match(THREAD_CHANGES_SRC, /window\.Notifications\?\.markProposalSeen\?\.\(item\.id\)/);
});

test('opening a change\'s before-and-after marks its "ready to try" seen', () => {
  assert.match(DETAIL_SRC, /if \(kind === 'shots' && valid\(ref\.changeId\)\)/);
  assert.match(DETAIL_SRC, /window\.Notifications\?\.markProposalSeen\?\.\(Number\(ref\.changeId\)\)/);
  assert.match(APP_VIEW_SRC, /if \(part === 'shots'\) window\.Notifications\?\.markProposalSeen\?\.\(Number\(id\)\)/);
});
