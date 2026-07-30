// #846 — POST /api/sessions/:id/chat must refuse an IMPORTED proposal.
//
// An imported proposal's branch belongs to an external author on GitHub, and
// the proposal has no dev chat at all (the platform hides every dev-side
// entry point for it). Before this change the route accepted any owned row in
// status 'active' or 'promoted', so the composer on the wrongly-opened
// dev-chat view could dispatch a real AI dev turn onto somebody else's
// branch. The lookup now excludes source='imported' and answers a NAMED 409
// (rather than a bare 404) so the failure is legible if a stale client hits
// it, while native sessions are untouched.
//
// Route-level, with the pool / services stubbed via require.cache — same
// shape as tests/ensure-staging.test.js. No real Postgres / worker / LLM.
//
// Run with: node --test tests/pr-import-chat-refused.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

// A pool that answers the chat route's two opening SELECTs:
//   1. the main lookup (excludes imported rows) — `row`, or nothing;
//   2. the imported probe that decides 404 vs the named 409 — driven by
//      `importedProbe`.
function makePool({ row, importedProbe }) {
  const seen = [];
  return {
    seen,
    query: async (sql, params) => {
      const s = String(sql);
      seen.push(s);
      if (/FROM chat_sessions cs\s*\n?\s*JOIN apps a/i.test(s) && /is_headless = FALSE/.test(s)) {
        return { rows: row ? [row] : [] };
      }
      if (/SELECT 1 FROM chat_sessions/.test(s) && /source = 'imported'/.test(s)) {
        return { rows: importedProbe ? [{ '?column?': 1 }] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function loadSessions(pool) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    appAccess: require.resolve('../src/services/app-access'),
    limits: require.resolve('../src/services/limits'),
    sessions: require.resolve('../src/routes/sessions'),
  };

  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => pool })],
    [paths.ws, stubModule(paths.ws, {
      broadcastGlobal: () => {},
      pushSessionUpdate: () => {},
      pushNotificationToUser: () => 0,
      sendSystemMessage: async () => {},
    })],
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      sessionCollabGuard: () => (_req, _res, next) => next(),
    })],
    // A native session must get PAST the session lookup. Short-circuit the
    // very next step (billing) so the handler answers a recognisable 429
    // instead of dragging a worker + LLM call into this test.
    [paths.limits, stubModule(paths.limits, {
      ...require('../src/services/limits'),
      resolveBillingPath: async () => ({ error: 'stubbed budget stop' }),
    })],
  ];

  delete require.cache[paths.sessions];
  const subject = require('../src/routes/sessions');

  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.sessions];
  };
  return { subject, restore };
}

async function startServer(subject, user = { id: 1, username: 'alice' }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  app.use(subject.sessionRoutes({ jwtSecret: 'test' }));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

async function postChat(pool, sessionId = 42) {
  const loaded = loadSessions(pool);
  const server = await startServer(loaded.subject);
  try {
    const res = await fetch(`${server.baseUrl}/api/sessions/${sessionId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'please change the colors' }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } finally {
    await server.close();
    loaded.restore();
  }
}

const NATIVE_ACTIVE = {
  id: 42, user_id: 1, status: 'active', source: 'native', branch_name: 'feat/x',
  app_slug: 'my-app', app_name: 'My App', repo_url: 'https://github.com/owner/repo',
};

test('chat on an imported proposal is refused with a named 409', async () => {
  // Main lookup finds nothing (the row is excluded as imported); the probe
  // confirms the row exists and IS imported.
  const { status, body } = await postChat(makePool({ row: null, importedProbe: true }));
  assert.equal(status, 409, 'refused, not a bare 404');
  assert.match(body.error, /imported from GitHub/i, 'names the reason');
  assert.match(body.error, /no dev chat/i);
  assert.match(body.error, /proposal page/i, 'points at the right surface');
});

test('chat on a genuinely missing session still 404s', async () => {
  const { status, body } = await postChat(makePool({ row: null, importedProbe: false }));
  assert.equal(status, 404, 'unrelated misses keep the old 404');
  assert.match(body.error, /Active session not found/i);
});

test('chat on a native session is unaffected by the imported guard', async () => {
  const { status, body } = await postChat(makePool({ row: NATIVE_ACTIVE, importedProbe: false }));
  assert.notEqual(status, 409, 'native session not refused as imported');
  assert.notEqual(status, 404, 'native session found');
  // Got past the session lookup into the billing step (stubbed to stop).
  assert.equal(status, 429);
  assert.match(body.error, /stubbed budget stop/);
});

test("the chat lookup excludes imported rows in SQL, not just in a post-check", async () => {
  const pool = makePool({ row: null, importedProbe: true });
  await postChat(pool);
  const lookup = pool.seen.find((s) => /is_headless = FALSE/.test(s));
  assert.ok(lookup, 'main lookup ran');
  assert.match(lookup, /source IS DISTINCT FROM 'imported'/,
    'imported rows are filtered by the query itself');
});
