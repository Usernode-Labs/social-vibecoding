// Tests for the #161 completion-notification plumbing.
//
// Three layers:
//   1. Route test for POST /api/sessions/:id/notify-on-done — the
//      client's arm/disarm endpoint (owner-only, idempotent, 204).
//   2. Unit tests for the sessions.js helpers behind the turn-completion
//      hooks: notifySessionDone (#138 always clear + insert) and
//      notifyAutoSolveDone (always insert).
//   3. Service tests for generic occurrence creation and the
//      session_opened / headless_cloned auto-dismiss registry entries.
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
    outbox: (initial.outbox || []).slice(),
    nextId: 1000,
  };
  const calls = [];

  async function query(sql, params = []) {
    const s = String(sql);
    calls.push({ sql: s, params });

    // Arm/disarm endpoint: UPDATE ... SET notify_on_done = $1 WHERE id = $2 AND user_id = $3
    if (/SET notify_on_done = \$1\s+WHERE id = \$2 AND user_id = \$3/i.test(s)) {
      const [armed, id, userId] = params;
      const row = state.sessions.get(Number(id));
      if (!row || row.user_id !== userId) return { rows: [], rowCount: 0 };
      row.notify_on_done = armed;
      return { rows: [], rowCount: 1 };
    }
    // Done hook: atomic check-and-clear.
    if (/SET notify_on_done = FALSE\s+WHERE id = \$1 AND notify_on_done = TRUE\s+RETURNING/i.test(s)) {
      const row = state.sessions.get(Number(params[0]));
      if (!row || !row.notify_on_done) return { rows: [], rowCount: 0 };
      row.notify_on_done = false;
      return { rows: [{ user_id: row.user_id, app_id: row.app_id }], rowCount: 1 };
    }
    // #138 done hook: unconditional clear + RETURNING (always-create).
    if (/SET notify_on_done = FALSE\s+WHERE id = \$1\s+RETURNING/i.test(s)) {
      const row = state.sessions.get(Number(params[0]));
      if (!row) return { rows: [], rowCount: 0 };
      row.notify_on_done = false;
      return { rows: [{ user_id: row.user_id, app_id: row.app_id }], rowCount: 1 };
    }
    // Unconditional disarm (stop handler / recovered turns / view).
    if (/SET notify_on_done = FALSE WHERE id = \$1/i.test(s)) {
      const row = state.sessions.get(Number(params[0]));
      if (row) row.notify_on_done = false;
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    // createSessionDoneNotification / createAutoSolveDoneNotification.
    if (/INSERT INTO notifications[\s\S]*'session_done'/i.test(s)) {
      const [userId, appId, sessionId] = params;
      const row = {
        id: state.nextId++, user_id: userId, app_id: appId, session_id: sessionId,
        source_user_id: null, kind: 'session_done', detail: null, read_at: null,
        created_at: new Date().toISOString(),
      };
      state.notifications.push(row);
      return { rows: [row] };
    }
    if (/INSERT INTO notifications[\s\S]*'auto_solve_done'/i.test(s)) {
      const [userId, appId, sessionId, detail] = params;
      const row = {
        id: state.nextId++, user_id: userId, app_id: appId, session_id: sessionId,
        source_user_id: null, kind: 'auto_solve_done', detail, read_at: null,
        created_at: new Date().toISOString(),
      };
      state.notifications.push(row);
      return { rows: [row] };
    }
    // Generic occurrence hydration + dedicated outbox handoff.
    if (/SELECT n\.id, n\.user_id, n\.kind[\s\S]*FROM notifications n[\s\S]*WHERE n\.id = ANY/i.test(s)) {
      const ids = params[0];
      return {
        rows: state.notifications.filter((x) => ids.includes(x.id)).map((n) => ({
          ...n, app_slug: 'my-app', app_name: 'My App', message_content: null,
          thread_type: null, thread_ref: null,
          pr_title: 'Add a feature', pr_number: 7, headless_issue_number: 42,
          branch_name: 'dev/alice-123', source_username: null,
        })),
      };
    }
    if (/INSERT INTO activity_notification_outbox/i.test(s)) {
      for (const item of JSON.parse(params[0])) {
        state.outbox.push({
          notification_id: item.notification_id,
          recipient_user_id: item.recipient_user_id,
          event: item.event,
        });
      }
      return { rows: [], rowCount: JSON.parse(params[0]).length };
    }
    if (/DELETE FROM notifications\s+WHERE id = ANY/i.test(s)) {
      const ids = params[0];
      const before = state.notifications.length;
      state.notifications = state.notifications.filter((n) => !ids.includes(n.id));
      return { rows: [], rowCount: before - state.notifications.length };
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

// Express harness: sessions router + a req.user shim. The drainGuard /
// chatLimiter middlewares ride along untouched (no draining, generous
// limiter) — only the notify-on-done route is exercised here.
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

// ── 1. Arm/disarm endpoint ──────────────────────────────────────────────

test('POST /notify-on-done arms, disarms, and is owner-only', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 1, app_id: 5, notify_on_done: false }]],
  });
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded);
  try {
    // Arm.
    let res = await fetch(`${srv.baseUrl}/api/sessions/10/notify-on-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ armed: true }),
    });
    assert.equal(res.status, 204);
    assert.equal(pool.state.sessions.get(10).notify_on_done, true);

    // Idempotent re-arm.
    res = await fetch(`${srv.baseUrl}/api/sessions/10/notify-on-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ armed: true }),
    });
    assert.equal(res.status, 204);
    assert.equal(pool.state.sessions.get(10).notify_on_done, true);

    // Disarm.
    res = await fetch(`${srv.baseUrl}/api/sessions/10/notify-on-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ armed: false }),
    });
    assert.equal(res.status, 204);
    assert.equal(pool.state.sessions.get(10).notify_on_done, false);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

test('POST /notify-on-done 404s for a session the caller does not own', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 999, app_id: 5, notify_on_done: false }]],
  });
  const loaded = loadSessions(pool);
  const srv = await startTestServer(loaded, { id: 1, username: 'alice' });
  try {
    const res = await fetch(`${srv.baseUrl}/api/sessions/10/notify-on-done`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ armed: true }),
    });
    assert.equal(res.status, 404);
    assert.equal(pool.state.sessions.get(10).notify_on_done, false);
  } finally {
    await srv.close();
    loaded.restore();
  }
});

// ── 2. Turn-completion helpers ──────────────────────────────────────────

test('notifySessionDone: Activity authority clears flag and enqueues one occurrence', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 1, app_id: 5, notify_on_done: true }]],
  });
  const loaded = loadSessions(pool);
  loaded.notifications.configureActivity({}, 'activity');
  try {
    await loaded.subject.notifySessionDone(pool, 10);

    assert.equal(pool.state.sessions.get(10).notify_on_done, false);
    assert.equal(pool.state.notifications.length, 0,
      'Activity-mode staging rows do not commit to Social');
    const rows = pool.state.outbox.filter((n) => n.event.facts.kind === 'session_done');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recipient_user_id, 1);

    assert.equal(loaded.pushes.length, 0,
      'Activity invalidates the browser only after publication succeeds');
    assert.equal(rows[0].event.kind, 'social.notification.occurred');
    assert.equal(rows[0].event.facts.sessionId, '10');
    assert.equal(rows[0].event.facts.prTitle, 'Add a feature');
    assert.equal(rows[0].event.facts.branchName, 'dev/alice-123');
  } finally {
    loaded.restore();
  }
});

// #138: completions now ALWAYS create the persistent green bell item — the
// done hook no longer gates on notify_on_done. An unarmed session still
// produces exactly one session_done insert + WS push.
test('notifySessionDone: unarmed → still creates and invalidates once', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 1, app_id: 5, notify_on_done: false }]],
  });
  const loaded = loadSessions(pool);
  try {
    await loaded.subject.notifySessionDone(pool, 10);
    const rows = pool.state.notifications.filter((n) => n.kind === 'session_done');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, 1);
    assert.equal(rows[0].session_id, 10);
    assert.equal(loaded.pushes.length, 1);
    assert.equal(loaded.pushes[0].payload.type, 'notifications_changed');
  } finally {
    loaded.restore();
  }
});

// Read state is not business identity. Repeated terminal hooks are tolerated
// as distinct occurrences rather than tracked with a workflow ledger.
test('notifySessionDone: repeat creates a second occurrence independent of read state', async () => {
  const pool = makeMockPool({
    sessions: [[10, { id: 10, user_id: 1, app_id: 5, notify_on_done: false }]],
  });
  const loaded = loadSessions(pool);
  try {
    await loaded.subject.notifySessionDone(pool, 10);
    await loaded.subject.notifySessionDone(pool, 10);
    const rows = pool.state.notifications.filter((n) => n.kind === 'session_done');
    assert.equal(rows.length, 2);
    assert.equal(loaded.pushes.length, 2);
  } finally {
    loaded.restore();
  }
});

test('notifyAutoSolveDone: each terminal hook freezes an occurrence with detail', async () => {
  const pool = makeMockPool({ sessions: [] });
  const loaded = loadSessions(pool);
  loaded.notifications.configureActivity({}, 'activity');
  try {
    await loaded.subject.notifyAutoSolveDone(pool, {
      userId: 2, appId: 5, sessionId: 30, detail: 'spec',
    });
    assert.equal(pool.state.notifications.length, 0,
      'Activity-mode staging rows do not commit to Social');
    const rows = pool.state.outbox.filter((n) => n.event.facts.kind === 'auto_solve_done');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event.facts.detail, 'spec');
    assert.equal(loaded.pushes.length, 0,
      'Activity invalidates the browser only after publication succeeds');
    assert.equal(rows[0].event.facts.headlessIssueNumber, 42);

    // A second terminal fire is a tolerated second occurrence.
    await loaded.subject.notifyAutoSolveDone(pool, {
      userId: 2, appId: 5, sessionId: 30, detail: 'spec',
    });
    assert.equal(pool.state.notifications.length, 0);
    assert.equal(pool.state.outbox.filter(
      (n) => n.event.facts.kind === 'auto_solve_done'
    ).length, 2);
    assert.equal(loaded.pushes.length, 0);
  } finally {
    loaded.restore();
  }
});

// ── 3. Service: creators' dedup + auto-dismiss registry ────────────────

test('createSessionDoneNotification does not use legacy read state as dedup identity', async () => {
  const pool = makeMockPool();
  const loaded = loadSessions(pool);
  try {
    const first = await loaded.notifications.createSessionDoneNotification(pool, {
      userId: 1, appId: 5, sessionId: 10,
    });
    assert.equal(first.length, 1);

    const dup = await loaded.notifications.createSessionDoneNotification(pool, {
      userId: 1, appId: 5, sessionId: 10,
    });
    assert.equal(dup.length, 1);

    // Once read, a new completion may notify again.
    pool.state.notifications[0].read_at = new Date().toISOString();
    const again = await loaded.notifications.createSessionDoneNotification(pool, {
      userId: 1, appId: 5, sessionId: 10,
    });
    assert.equal(again.length, 1);
    assert.equal(pool.state.notifications.length, 3);
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
      { kinds: ['session_done'], scope: 'session_id' }
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

test('headless_cloned auto-dismiss clears unread auto_solve_done for the source session', async () => {
  const pool = makeMockPool({
    notifications: [
      { id: 1, user_id: 1, app_id: 5, session_id: 30, kind: 'auto_solve_done', read_at: null },
      { id: 2, user_id: 2, app_id: 5, session_id: 30, kind: 'auto_solve_done', read_at: null },
    ],
  });
  const loaded = loadSessions(pool);
  try {
    assert.deepEqual(
      loaded.notifications.ACTION_COMPLETIONS.headless_cloned,
      { kinds: ['auto_solve_done'], scope: 'session_id' }
    );
    const cleared = await loaded.notifications.markReadForAction(pool, 1, 'headless_cloned', 30);
    assert.equal(cleared, 1);
    // Another user's notification for the same auto session is untouched.
    assert.equal(pool.state.notifications.find((n) => n.id === 2).read_at, null);
  } finally {
    loaded.restore();
  }
});

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
