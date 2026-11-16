// The #86 private "Share to user" spec read gate.
//
// Sharing a plan privately is retired (POST /api/sessions/:id/specs/:version/
// share-user is gone, and no spec_shared notification is created), but a
// share row written before stays honoured: GET /api/sessions/:id/specs/
// :version lets the recipient fetch the exact shared version while an
// unrelated third user still 404s.
//
// The pool is an in-memory mock that pattern-matches SQL, and the ws module
// is stubbed via require.cache. No real Postgres / sockets.
//
// Run with: node --test tests/spec-user-share.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

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

  const pushes = [];
  const origPool = stubModule(poolPath, { getPool: () => mockPool });
  const origWs = stubModule(wsPath, {
    pushNotificationToUser: (userId, payload) => { pushes.push({ userId, payload }); return 1; },
    broadcastGlobal: () => {},
    broadcast: () => {},
  });
  delete require.cache[sessionsPath];

  const subject = require('../src/routes/sessions');

  const restore = () => {
    if (origPool) require.cache[poolPath] = origPool; else delete require.cache[poolPath];
    if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
    delete require.cache[sessionsPath];
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
    // [{ session_id, version, recipient_id, shared_by }]
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
  app.use((req, _res, next) => { req.user = req.testUser || user; next(); });
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
  };
}

// ── GET /specs/:version ─────────────────────────────────────────────────

test('recipient can GET the shared version; an unrelated third user still 404s', async () => {
  const init = baseState();
  init.shares = [{ session_id: 10, version: 3, recipient_id: 2, shared_by: 1 }];
  const pool = makeMockPool(init);
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
