// The completion notifications a change's turns used to write (#161, #138,
// #3181): session_done and session_stalled. Nothing creates them any more,
// but rows already written still draw in the bell, so:
//   1. GET /api/sessions/:id dismisses them only when a person opened the
//      change (`?opened=1`), and only the owner's;
//   2. the session_opened auto-dismiss registry entry clears both kinds,
//      scoped by session;
//   3. serialize and the list/get hydrations carry what the bell draws.
//
// Like kudos.test.js, the pool is an in-memory mock that pattern-matches
// SQL, and the ws module is stubbed via require.cache so pushes are
// recorded instead of broadcast. No real Postgres / sockets.
//
// Run with: node --test tests/session-done-notifications.test.js

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
// Returns { subject, notifications, pushes, restore }.
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
  });
  // Force fresh resolution against the stubs.
  delete require.cache[sessionsPath];
  delete require.cache[notificationsPath];

  const subject = require('../src/routes/sessions');
  const notifications = require('../src/services/notifications');

  const restore = () => {
    if (origPool) require.cache[poolPath] = origPool; else delete require.cache[poolPath];
    if (origWs) require.cache[wsPath] = origWs; else delete require.cache[wsPath];
    delete require.cache[sessionsPath];
    delete require.cache[notificationsPath];
  };
  return { subject, notifications, pushes, restore };
}

// ── In-memory mock pool ─────────────────────────────────────────────────
// Holds chat_sessions rows keyed by id and a notifications array, and
// answers the handful of SQL shapes the #161 code paths issue. Records
// every call so tests can assert on the SQL too.
function makeMockPool(initial = {}) {
  const state = {
    sessions: new Map(initial.sessions || []),
    notifications: (initial.notifications || []).slice(),
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // Activity bump on the session view.
    if (/UPDATE chat_sessions SET last_activity_at = NOW\(\)/i.test(s)) {
      const row = state.sessions.get(Number(params[0]));
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    // GET /api/sessions/:id — the session record (owner OR admin).
    if (/FROM chat_sessions cs\s+JOIN apps a ON cs\.app_id = a\.id/i.test(s)) {
      const row = state.sessions.get(Number(params[0]));
      if (!row || (row.user_id !== params[1] && !params[2])) return { rows: [], rowCount: 0 };
      return {
        rows: [{
          status: 'active', ...row,
          app_slug: 'my-app', app_name: 'My App', yes_count: 0, no_count: 0,
        }],
        rowCount: 1,
      };
    }
    // markReadForAction.
    if (/UPDATE notifications[\s\S]*SET read_at = NOW\(\)[\s\S]*kind = ANY\(\$3\)/i.test(s)) {
      const [userId, scopeId, kinds] = params;
      const scopeCol = /session_id = \$2/.test(s) ? 'session_id' : 'app_id';
      let cleared = 0;
      for (const n of state.notifications) {
        if (n.user_id === userId && n[scopeCol] === scopeId
            && kinds.includes(n.kind) && !n.read_at) {
          n.read_at = new Date().toISOString();
          cleared++;
        }
      }
      return { rows: [], rowCount: cleared };
    }
    return { rows: [], rowCount: 0 };
  }

  return {
    query, state, calls,
    issued: (re) => calls.some((c) => re.test(c.sql)),
  };
}

// Express harness: sessions router + a req.user shim.
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

// ── 1. GET /api/sessions/:id and the "user saw it" gate ─────────────────
//
// An unread session_done row is what the bell's badge counts. Screens
// refetch this route programmatically, so when it dismissed unconditionally
// the completion was read within ~200ms of being written and the badge
// never appeared. The dismiss requires the caller to say a person opened
// the session with ?opened=1.

async function getSession(srv, id, qs = '') {
  const res = await fetch(`${srv.baseUrl}/api/sessions/${id}${qs}`);
  assert.equal(res.status, 200);
  // The dismiss is fire-and-forget — let its microtask/query settle.
  await new Promise((r) => setTimeout(r, 20));
  return res;
}

function unreadDone(pool, sessionId) {
  return pool.state.notifications.filter(
    (n) => n.session_id === sessionId && n.kind === 'session_done' && !n.read_at
  ).length;
}

test('GET /api/sessions/:id leaves the completion unread for a machine refetch', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 1, app_id: 5 }]],
    notifications: [
      { id: 1, user_id: 1, app_id: 5, session_id: 10, kind: 'session_done', read_at: null },
    ],
  });
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    await getSession(srv, 10);

    // The badge's input survives: still unread, no notifications UPDATE at all.
    assert.equal(unreadDone(pool, 10), 1);
    assert.equal(pool.issued(/UPDATE notifications/i), false);
    assert.equal(loaded.pushes.length, 0);
    // The activity bump still runs (an owner's poll means the session is in
    // use).
    const bump = pool.calls.filter((c) => /UPDATE chat_sessions SET last_activity_at/i.test(c.sql));
    assert.equal(bump.length, 1);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('GET /api/sessions/:id?opened=1 dismisses the completion', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 1, app_id: 5 }]],
    notifications: [
      { id: 1, user_id: 1, app_id: 5, session_id: 10, kind: 'session_done', read_at: null },
      // A different session's completion is out of scope and stays unread.
      { id: 2, user_id: 1, app_id: 5, session_id: 11, kind: 'session_done', read_at: null },
    ],
  });
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    await getSession(srv, 10, '?opened=1');

    assert.equal(unreadDone(pool, 10), 0);
    assert.equal(unreadDone(pool, 11), 1);
    // Other tabs repaint their badge off the change.
    assert.deepEqual(loaded.pushes, [{ userId: 1, payload: { type: 'notifications_changed' } }]);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('GET /api/sessions/:id?opened=1 as a non-owner admin dismisses nothing', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, app_id: 5 }]],
    notifications: [
      { id: 1, user_id: 999, app_id: 5, session_id: 10, kind: 'session_done', read_at: null },
    ],
  });
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded, { id: 1, username: 'cap', isAdmin: true });
  try {
    await getSession(srv, 10, '?opened=1');

    // An admin (or the capture suite) reading someone's session must not
    // resolve the owner's notification or keep the session awake.
    assert.equal(unreadDone(pool, 10), 1);
    assert.equal(pool.issued(/UPDATE chat_sessions SET last_activity_at/i), false);
    assert.equal(loaded.pushes.length, 0);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── 2. The auto-dismiss registry ─────────────────────────────────────────

test('session_opened auto-dismiss also answers "stopped before finishing" (#3181)', async () => {
  const pool = makeMockPool({
    notifications: [
      { id: 1, user_id: 1, app_id: 5, session_id: 10, kind: 'session_stalled', read_at: null },
      { id: 2, user_id: 1, app_id: 5, session_id: 11, kind: 'session_stalled', read_at: null },
    ],
  });
  const loaded = loadSessions(pool);
  try {
    const cleared = await loaded.notifications.markReadForAction(pool, 1, 'session_opened', 10);
    assert.equal(cleared, 1);
    assert.ok(pool.state.notifications.find((n) => n.id === 1).read_at);
    assert.equal(pool.state.notifications.find((n) => n.id === 2).read_at, null,
      'another session\'s row is untouched');
  } finally {
    loaded.restore();
  }
});

test('session_opened auto-dismiss clears unread session_done scoped by session', async () => {
  const pool = makeMockPool({
    notifications: [
      { id: 1, user_id: 1, app_id: 5, session_id: 10, kind: 'session_done', read_at: null },
      { id: 2, user_id: 1, app_id: 5, session_id: 11, kind: 'session_done', read_at: null },
      { id: 3, user_id: 1, app_id: 5, session_id: 10, kind: 'mention', read_at: null },
    ],
  });
  const loaded = loadSessions(pool);
  try {
    assert.deepEqual(
      loaded.notifications.ACTION_COMPLETIONS.session_opened,
      { kinds: ['session_done', 'session_stalled'], scope: 'session_id' }
    );
    const cleared = await loaded.notifications.markReadForAction(pool, 1, 'session_opened', 10);
    assert.equal(cleared, 1);
    // Only the matching session's session_done row was cleared.
    assert.ok(pool.state.notifications.find((n) => n.id === 1).read_at);
    assert.equal(pool.state.notifications.find((n) => n.id === 2).read_at, null);
    assert.equal(pool.state.notifications.find((n) => n.id === 3).read_at, null);
  } finally {
    loaded.restore();
  }
});

// ── 3. What the bell draws ───────────────────────────────────────────────

test('serialize exposes headlessIssueNumber and branchName for the drawer', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const out = loaded.notifications.serialize({
      id: 1, kind: 'auto_solve_done', read_at: null, created_at: 'now',
      app_id: 5, app_slug: 's', app_name: 'A', chat_message_id: null,
      message_content: null, session_id: 30, pr_title: null, pr_number: null,
      headless_issue_number: 42, branch_name: 'dev/auto-issue-42-1',
      source_username: null, detail: 'code',
    });
    assert.equal(out.headlessIssueNumber, 42);
    assert.equal(out.branchName, 'dev/auto-issue-42-1');
    assert.equal(out.detail, 'code');
  } finally {
    loaded.restore();
  }
});

// #971: serialize must carry the session's display title, and must not
// invent one when the column is NULL (the client's ladder needs a falsy
// value to fall through to prTitle / branchName).
test('serialize exposes sessionTitle, passing NULL through untouched', () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  const base = {
    id: 1, kind: 'session_done', read_at: null, created_at: 'now',
    app_id: 5, app_slug: 's', app_name: 'A', chat_message_id: null,
    message_content: null, session_id: 30, pr_number: null,
    headless_issue_number: null, source_username: null, detail: null,
  };
  try {
    const titled = loaded.notifications.serialize({
      ...base, session_title: 'Web UI app proposals implementation',
      pr_title: null, branch_name: 'dev/evan-1785951671234',
    });
    assert.equal(titled.sessionTitle, 'Web UI app proposals implementation');
    assert.equal(titled.branchName, 'dev/evan-1785951671234', 'ladder tail still rides along');

    const untitled = loaded.notifications.serialize({
      ...base, session_title: null, pr_title: null,
      branch_name: 'dev/evan-1785999999999',
    });
    assert.equal(untitled.sessionTitle, null, 'NULL stays falsy so the ladder falls through');
  } finally {
    loaded.restore();
  }
});

// #971: the three hydration queries are copy-pasted, so a change to one can
// silently skip the others. Assert every session-joining query selects the
// title column.
test('listForUser and getForUser both select cs.session_title', async () => {
  const seen = [];
  const pool = {
    query(sql) {
      seen.push(String(sql));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  const loaded = loadSessions(pool);
  try {
    await loaded.notifications.listForUser(pool, 7, { limit: 10 });
    await loaded.notifications.getForUser(pool, 7, 1);
    assert.equal(seen.length, 2, 'both queries issued');
    for (const sql of seen) {
      assert.match(sql, /LEFT JOIN chat_sessions cs/, 'joins the session row');
      assert.match(sql, /cs\.session_title/, 'selects the session title');
      // The rest of the label ladder must stay selected alongside it.
      assert.match(sql, /cs\.pr_title/);
      assert.match(sql, /cs\.branch_name/);
    }
  } finally {
    loaded.restore();
  }
});
