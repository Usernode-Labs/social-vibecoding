// Route tests for the read-only transcript surface
// (GET /api/sessions/:id/transcript in src/routes/sessions.js).
//
// The authorization predicate is the privacy contract: a transcript leaves
// the server only when BOTH share stamps are set (or the caller owns the
// session). These tests pin the SQL that enforces it plus the side-effect-free
// posture that makes this route safe to expose — no auto-resume, no
// last_activity_at bump, no notification clearing, unlike the owner-scoped
// GET /api/sessions/:id it sits beside.
//
// Same harness shape as tests/shared-sessions.test.js: override getPool
// BEFORE requiring the route module, mount the router on a real express app,
// inject req.user, and dispatch stubbed pool responses on query text.
//
// Run with: node --test tests/session-transcript-route.test.js

const { test } = require('node:test');
const assert = require('node:assert');

const poolMod = require('../src/db/pool');
let poolQueryHandler = async () => ({ rows: [] });
let capturedQueries = [];
poolMod.getPool = () => ({
  query: (sql, params) => {
    capturedQueries.push({ sql, params });
    return poolQueryHandler(sql, params);
  },
});

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'reader' };
const OWNER_ID = 99;

const APP_ROW = {
  id: 42, slug: 'demo', created_by: 7, self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
};

function startServer() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

async function get(server, path) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { res, body: await res.json() };
}

// The header row the transcript route selects. `sessionRow: null` models the
// authorization predicate NOT matching — which is exactly what a
// not-shared / partially-shared session produces, since both NULL checks
// live in the WHERE clause rather than in JS.
function makeDispatcher({ sessionRow = null, messages = [] } = {}) {
  return async (sql) => {
    if (/FROM apps WHERE slug = \$1/.test(sql)) return { rows: [APP_ROW] };
    if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id/.test(sql)
        && /collab_visibility/.test(sql)) {
      return { rows: [APP_ROW] }; // sessionCollabGuard resolve
    }
    if (/transcript_shared_at/.test(sql) && /JOIN users u/.test(sql)) {
      return { rows: sessionRow ? [sessionRow] : [] };
    }
    if (/FROM chat_session_messages/.test(sql)) return { rows: messages };
    return { rows: [] };
  };
}

function sessionRow(overrides = {}) {
  return {
    id: 5,
    session_title: 'Their session',
    pr_title: null,
    branch_name: 'dev/them-1',
    status: 'paused',
    user_id: OWNER_ID,
    username: 'them',
    shared_at: '2026-07-01T00:00:00Z',
    transcript_shared_at: '2026-07-01T00:05:00Z',
    created_at: '2026-06-30T00:00:00Z',
    message_count: 3,
    ...overrides,
  };
}

test('the authorization predicate requires BOTH stamps (or ownership)', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({ sessionRow: sessionRow() });
  const server = await startServer();
  try {
    await get(server, '/api/sessions/5/transcript');
    const q = capturedQueries.find((c) => /transcript_shared_at/.test(c.sql) && /JOIN users u/.test(c.sql));
    assert.ok(q, 'transcript header query was issued');
    assert.match(q.sql, /cs\.shared_at IS NOT NULL/);
    assert.match(q.sql, /cs\.transcript_shared_at IS NOT NULL/);
    assert.match(q.sql, /cs\.is_headless = FALSE/);
    // The owner escape hatch is an OR on the same query, not a second
    // (laxer) code path.
    assert.match(q.sql, /cs\.user_id = \$2/);
    assert.deepStrictEqual(q.params, [5, VIEWER.id]);
  } finally {
    server.close();
  }
});

test('404 when the session is visible but the transcript is NOT shared', async () => {
  // shared_at set, transcript_shared_at NULL → the WHERE clause matches
  // nothing, so the route sees no row.
  poolQueryHandler = makeDispatcher({ sessionRow: null });
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/sessions/5/transcript');
    assert.strictEqual(res.status, 404);
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('404 when neither stamp is set', async () => {
  poolQueryHandler = makeDispatcher({ sessionRow: null });
  const server = await startServer();
  try {
    const { res } = await get(server, '/api/sessions/5/transcript');
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test('serves a sanitised transcript to a non-owner when both stamps are set', async () => {
  poolQueryHandler = makeDispatcher({
    sessionRow: sessionRow(),
    // The route reads newest-first then flips, so the stub is DESC by id.
    messages: [
      {
        id: 3, role: 'system', content: 'Claude Code log', model: null,
        token_count: 0, cost_cents: 0,
        metadata: { ccLog: 'SECRET stderr' }, created_at: '2026-07-01T00:03:00Z',
      },
      {
        id: 2, role: 'assistant', content: 'On it.', model: 'claude-opus-5',
        token_count: 900, cost_cents: 4.2, metadata: {},
        created_at: '2026-07-01T00:02:00Z',
      },
      {
        id: 1, role: 'user', content: 'Fix the cards', model: null,
        token_count: 0, cost_cents: 0,
        metadata: { attachments: [{ id: 'a'.repeat(32), filename: 'shot.png', kind: 'image', sizeBytes: 10 }] },
        created_at: '2026-07-01T00:01:00Z',
      },
    ],
  });
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/sessions/5/transcript');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.session.username, 'them');
    assert.strictEqual(body.session.message_count, 3);
    assert.strictEqual(body.session.is_owner, false);
    assert.strictEqual(body.session.can_fork, true);
    assert.strictEqual(body.truncated, false);

    // Oldest-first for rendering.
    assert.deepStrictEqual(body.messages.map((m) => m.id), [1, 2, 3]);

    // Sanitised on the way out — the route must not hand back raw rows.
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('SECRET stderr'), 'ccLog withheld');
    assert.ok(!serialized.includes('a'.repeat(32)), 'attachment id withheld');
    assert.ok(!serialized.includes('cost_cents'), 'cost withheld');
    assert.ok(!serialized.includes('token_count'), 'token count withheld');
    assert.strictEqual(body.messages[0].metadata.attachments[0].filename, 'shot.png');
  } finally {
    server.close();
  }
});

test('the owner gets the identical sanitised payload, flagged is_owner', async () => {
  poolQueryHandler = makeDispatcher({
    sessionRow: sessionRow({ user_id: VIEWER.id, username: 'reader' }),
    messages: [{
      id: 1, role: 'user', content: 'mine', model: null,
      metadata: { ccLog: 'still withheld' }, created_at: '2026-07-01T00:01:00Z',
    }],
  });
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/sessions/5/transcript');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.session.is_owner, true);
    // Forking your own chat is meaningless — "Start a new change" is that.
    assert.strictEqual(body.session.can_fork, false);
    // Same sanitiser: the owner's preview shows what OTHERS see, so there
    // is no second, laxer rendering path to keep in sync.
    assert.ok(!JSON.stringify(body).includes('still withheld'));
  } finally {
    server.close();
  }
});

test('an unshared owner-only session still serves to its owner', async () => {
  // Both stamps NULL, caller is the owner → the OR branch matches.
  poolQueryHandler = makeDispatcher({
    sessionRow: sessionRow({
      user_id: VIEWER.id, username: 'reader',
      shared_at: null, transcript_shared_at: null,
    }),
    messages: [],
  });
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/sessions/5/transcript');
    assert.strictEqual(res.status, 200);
    // …but can_fork stays false: nothing is published, so there is nothing
    // for anyone (including the owner) to fork from here.
    assert.strictEqual(body.session.can_fork, false);
  } finally {
    server.close();
  }
});

test('a long transcript is capped and flagged truncated, keeping the END', async () => {
  const { MAX_TRANSCRIPT_MESSAGES } = require('../src/services/transcript-share');
  // The route asks for cap+1 rows DESC to detect overflow. Simulate the DB
  // returning that many (ids descending from the newest).
  const messages = [];
  for (let i = 0; i < MAX_TRANSCRIPT_MESSAGES + 1; i++) {
    messages.push({
      id: 1000 - i, role: 'user', content: `m${1000 - i}`, model: null,
      metadata: {}, created_at: '2026-07-01T00:00:00Z',
    });
  }
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({ sessionRow: sessionRow(), messages });
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/sessions/5/transcript');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.truncated, true);
    assert.strictEqual(body.messages.length, MAX_TRANSCRIPT_MESSAGES);
    // Truncation drops the OLDEST messages: the newest id survives and is
    // last (oldest-first ordering), so a reader sees how the chat ended.
    assert.strictEqual(body.messages[body.messages.length - 1].id, 1000);

    // Not just /FROM chat_session_messages/ — the header query carries a
    // message_count subquery over the same table and would match first.
    const mq = capturedQueries.find((c) => /ORDER BY id DESC/.test(c.sql));
    assert.ok(mq, 'message window query was issued');
    assert.strictEqual(mq.params[1], MAX_TRANSCRIPT_MESSAGES + 1);
  } finally {
    server.close();
  }
});

test('the route has NO side effects (no resume, no activity bump, no notif clear)', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({ sessionRow: sessionRow(), messages: [] });
  const server = await startServer();
  try {
    await get(server, '/api/sessions/5/transcript');
    // This is why the transcript is a separate route rather than a relaxed
    // GET /api/sessions/:id: reading someone's chat must not resume their
    // session, refresh its auto-pause timer, or clear their notifications.
    for (const q of capturedQueries) {
      assert.doesNotMatch(q.sql, /^\s*UPDATE/i, `unexpected write: ${q.sql}`);
      assert.doesNotMatch(q.sql, /last_activity_at = NOW\(\)/);
      assert.doesNotMatch(q.sql, /notify_on_done/);
    }
  } finally {
    server.close();
  }
});

test('a database failure surfaces as a 500', async () => {
  poolQueryHandler = async (sql) => {
    if (/collab_visibility/.test(sql)) return { rows: [APP_ROW] };
    throw new Error('boom');
  };
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/sessions/5/transcript');
    assert.strictEqual(res.status, 500);
    assert.ok(body.error);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});
