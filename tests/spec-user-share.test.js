// Tests for the HISTORICAL #86 private spec shares after the share-to-user
// endpoint was retired in favor of Messages (#1343).
//
// What must keep holding:
//   1. GET /api/sessions/:id/specs/:version — the read gate stays widened by
//      an existing chat_session_spec_user_shares row: the recipient of an old
//      share can still fetch the exact shared version while an unrelated
//      third user still 404s, and the share stays version-scoped.
//   2. POST /api/sessions/:id/specs/:version/share-user is GONE — the route
//      is absent from the router (Express falls through to a 404 without
//      touching the database), and the sessions module no longer references
//      createSpecSharedNotification (which was removed with it). New private
//      shares are conversation messages: see sendMessage in
//      src/services/conversations.js and tests/platform-messaging-core.test.js.
//
// Like session-done-notifications.test.js, the pool is an in-memory mock
// that pattern-matches SQL, and the ws module is stubbed via require.cache
// so pushes are recorded instead of broadcast. No real Postgres / sockets.
//
// Run with: node --test tests/spec-user-share.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

// ── require.cache stubbing ──────────────────────────────────────────────

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = {
    id, filename: id, loaded: true, exports,
    paths: original ? original.paths : [],
  };
  return original;
}

// Load ../src/routes/sessions fresh with a mock pool + a ws spy.
function loadSessions(mockPool) {
  const poolPath = require.resolve('../src/db/pool');
  const wsPath = require.resolve('../src/services/ws');
  const sessionsPath = require.resolve('../src/routes/sessions');
  const notificationsPath = require.resolve('../src/services/notifications');

  const pushes = [];
  const origPool = stubModule(poolPath, { getPool: () => mockPool });
  const origWs = stubModule(wsPath, {
    pushNotificationToUser: (userId, payload) => { pushes.push({ userId, payload }); return 1; },
    broadcastGlobal: () => {},
    broadcast: () => {},
  });
  delete require.cache[sessionsPath];
  delete require.cache[notificationsPath];

  const subject = require('../src/routes/sessions');

  const restore = () => {
    if (origPool) require.cache[poolPath] = origPool; else delete require.cache[poolPath];
    if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
    delete require.cache[sessionsPath];
    delete require.cache[notificationsPath];
  };
  return { subject, pushes, restore };
}

// ── In-memory mock pool ─────────────────────────────────────────────────
// Holds the tables the widened spec read gate touches, and answers the SQL
// shape it issues.
function makeMockPool(initial = {}) {
  const state = {
    // Map<id, { id, user_id, app_id }>
    sessions: new Map(initial.sessions || []),
    // [{ session_id, version, content, shared_to_group_at }]
    specs: (initial.specs || []).slice(),
    // [{ session_id, version, recipient_id, shared_by }] — historical rows.
    shares: (initial.shares || []).slice(),
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // Widened spec read gate (GET /specs/:version).
    if (/FROM chat_session_specs s[\s\S]*JOIN chat_sessions cs[\s\S]*chat_session_spec_user_shares us/i.test(s)) {
      const [sessionId, version, userId] = params.map(Number);
      const cs = state.sessions.get(sessionId);
      const spec = state.specs.find(
        (x) => x.session_id === sessionId && x.version === version
      );
      if (!cs || !spec) return { rows: [] };
      const shared = state.shares.some(
        (x) => x.session_id === sessionId && x.version === version && x.recipient_id === userId
      );
      if (cs.user_id !== userId && !spec.shared_to_group_at && !shared) return { rows: [] };
      return {
        rows: [{
          version: spec.version, content: spec.content, built_at: null,
          commit_sha: null, pr_number: null, shared_to_group_at: spec.shared_to_group_at || null,
        }],
      };
    }
    return { rows: [], rowCount: 0 };
  }

  return {
    query, state, calls,
    issued: (re) => calls.some((c) => re.test(c.sql)),
  };
}

// Express harness with a per-request user shim.
async function startTestServer(loaded, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(loaded.subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function baseState() {
  return {
    sessions: [[10, { id: 10, user_id: 1, app_id: 5 }]],
    specs: [{ session_id: 10, version: 3, content: '# My spec', shared_to_group_at: null }],
    // A share row minted by the retired endpoint before #1343.
    shares: [{ session_id: 10, version: 3, recipient_id: 2, shared_by: 1 }],
  };
}

// ── GET /specs/:version read gate (historical shares) ───────────────────

test('historical share recipient can GET the shared version; a third user still 404s', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);

  // Recipient (Bob, id 2).
  const asBob = await startTestServer(loaded, { id: 2, username: 'Bob' });
  try {
    const res = await fetch(`${asBob.baseUrl}/api/sessions/10/specs/3`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.spec.version, 3);
    assert.equal(data.spec.content, '# My spec');
  } finally {
    await asBob.close();
  }

  // Unrelated third user (carol, id 3) — not owner, not shared, not group-shared.
  const asCarol = await startTestServer(loaded, { id: 3, username: 'carol' });
  try {
    const res = await fetch(`${asCarol.baseUrl}/api/sessions/10/specs/3`);
    assert.equal(res.status, 404);
  } finally {
    await asCarol.close();
  }

  // The share is version-scoped: Bob cannot read a DIFFERENT version.
  pool.state.specs.push({ session_id: 10, version: 4, content: '# v4', shared_to_group_at: null });
  const asBob2 = await startTestServer(loaded, { id: 2, username: 'Bob' });
  try {
    const res = await fetch(`${asBob2.baseUrl}/api/sessions/10/specs/4`);
    assert.equal(res.status, 404);
  } finally {
    await asBob2.close();
    loaded.restore();
  }
});

// ── The share-user endpoint is retired ──────────────────────────────────

test('POST /specs/:version/share-user no longer exists and writes nothing', async () => {
  const pool = makeMockPool(baseState());
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/10/specs/3/share-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Bob' }),
    });
    // No matching route: Express's default 404. The router's session
    // view gate still runs its access lookup, but nothing is written and
    // nothing is pushed.
    assert.equal(res.status, 404);
    assert.ok(!pool.issued(/INSERT/i), 'the request wrote nothing');
    assert.equal(loaded.pushes.length, 0);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('the sessions router and notifications service carry no share-user remnants', () => {
  const root = path.join(__dirname, '..');
  const sessionsSource = fs.readFileSync(path.join(root, 'src/routes/sessions.js'), 'utf8');
  const notificationsSource = fs.readFileSync(path.join(root, 'src/services/notifications.js'), 'utf8');
  assert.ok(!sessionsSource.includes("'/api/sessions/:id/specs/:version/share-user'"),
    'the route registration is gone');
  assert.ok(!sessionsSource.includes('createSpecSharedNotification'),
    'sessions.js no longer mints spec_shared notifications');
  assert.ok(!notificationsSource.includes('createSpecSharedNotification'),
    'the spec_shared creator was removed with its only caller');
  // The HISTORICAL read arm stays: existing chat_session_spec_user_shares
  // rows keep granting access to the exact shared version.
  assert.ok(sessionsSource.includes('chat_session_spec_user_shares'),
    'the user-share arm of the visibility fragment is preserved');
});
