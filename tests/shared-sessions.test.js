// Route tests for the shared-session surface (src/routes/sessions.js):
//
//   GET  /api/apps/:slug/shared-sessions — every user's explicitly-shared
//        in-flight sessions on an app (the Dev board's bottom-of-In-progress
//        cards). The WHERE clause is the privacy contract: only shared_at-set,
//        active/paused, non-headless rows may ever leave the server.
//   POST /api/sessions/:id/share | /unshare — owner-scoped visibility toggle
//        (chat_sessions.shared_at).
//
// Same harness shape as tests/me-active-sessions.test.js: override getPool
// BEFORE requiring the route module, mount the router on a real express app,
// inject req.user, and dispatch stubbed pool responses on query text.
//
// Run with: node --test tests/shared-sessions.test.js

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

const worker = require('../src/services/worker');
const { activeWorkers } = require('../src/services/active-workers');

const { sessionRoutes } = require('../src/routes/sessions');
const express = require('express');

const VIEWER = { id: 7, username: 'tester' };

// A public app row satisfying appAccess.getAppForUser / checkAppAccess.
const APP_ROW = {
  id: 42, slug: 'demo', created_by: 7, self_hosted: false,
  collab_visibility: 'public', view_visibility: 'public',
};

function startServer() {
  const app = express();
  // Mirrors the real app's global JSON parser (server.js), which is what
  // makes POST /share's optional `{ transcript: true }` body readable.
  app.use(express.json());
  app.use((req, res, next) => { req.user = VIEWER; next(); });
  app.use(sessionRoutes({}));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function sharedRow(overrides = {}) {
  return {
    id: 1,
    session_title: 'Shared session',
    pr_title: null,
    branch_name: 'dev/them-1',
    status: 'active',
    staging_url: null,
    can_preview: false,
    user_id: 99,
    username: 'them',
    shared_at: '2026-06-12T00:00:00Z',
    created_at: '2026-06-11T00:00:00Z',
    last_activity_at: '2026-06-12T01:00:00Z',
    chat_count: 0,
    last_message_at: null,
    ...overrides,
  };
}

// Dispatch pool queries by shape: the app-by-slug access lookup, the
// session→app collab guard, the shared-sessions list, and the share /
// unshare UPDATEs.
function makeDispatcher({
  sharedRows = [], shareResult = [], unshareResult = [],
  shareTranscriptResult = [], unshareTranscriptResult = [],
} = {}) {
  return async (sql, params) => {
    if (/FROM apps WHERE slug = \$1/.test(sql)) {
      return { rows: params[0] === APP_ROW.slug ? [APP_ROW] : [] };
    }
    if (/FROM chat_sessions cs JOIN apps a ON a\.id = cs\.app_id/.test(sql)
        && /collab_visibility/.test(sql)) {
      return { rows: [APP_ROW] }; // sessionCollabGuard resolve
    }
    // Order matters: /share-transcript sets BOTH stamps, so its SQL also
    // matches "SET shared_at = COALESCE" — match the narrower shape first.
    if (/transcript_shared_at = COALESCE/.test(sql)) {
      return { rows: shareTranscriptResult };
    }
    if (/SET transcript_shared_at = NULL/.test(sql)) {
      return { rows: unshareTranscriptResult };
    }
    if (/shared_at IS NOT NULL/.test(sql)) {
      return { rows: sharedRows };
    }
    if (/SET shared_at = COALESCE/.test(sql)) {
      return { rows: shareResult };
    }
    if (/SET shared_at = NULL/.test(sql)) {
      return { rows: unshareResult };
    }
    return { rows: [] };
  };
}

async function get(server, path) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { res, body: await res.json() };
}

async function post(server, path, json) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    ...(json === undefined ? {} : {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    }),
  });
  return { res, body: await res.json() };
}

test('shared-sessions WHERE clause is the privacy contract', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/apps/demo/shared-sessions');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(body.sessions, []);

    const q = capturedQueries.find((c) => /shared_at IS NOT NULL/.test(c.sql));
    assert.ok(q, 'shared-sessions query was issued');
    // Only explicitly shared, in-flight, human sessions of THIS app.
    assert.match(q.sql, /cs\.shared_at IS NOT NULL/);
    assert.match(q.sql, /status IN \('active', 'paused'\)/);
    assert.match(q.sql, /is_headless = FALSE/);
    assert.deepStrictEqual(q.params, [APP_ROW.id]);
    // Oldest-shared first so new shares append at the column bottom.
    assert.match(q.sql, /ORDER BY cs\.shared_at ASC/);
    // Card data: owner name + discussion stats ride along…
    assert.match(q.sql, /u\.username/);
    assert.match(q.sql, /chat_count/);
    // #689: can_preview is DERIVED from pr_number (a PR exists once the
    // first commit is pushed) so the card can offer an on-demand rebuild…
    assert.match(q.sql, /\(cs\.pr_number IS NOT NULL\) AS can_preview/);
    // …but nothing that opens the owner's dev chat — pr_number itself is
    // never selected bare, only inside the boolean above.
    assert.doesNotMatch(q.sql, /pr_url/);
    assert.doesNotMatch(q.sql, /cc_session_id/);
    assert.doesNotMatch(q.sql, /cs\.pr_number,/);
    // Transcript sharing adds a BOOLEAN plus a count for the chip label —
    // never the transcript itself, and never the raw timestamp column
    // (the card only needs "is it readable?").
    assert.match(q.sql, /\(cs\.transcript_shared_at IS NOT NULL\) AS transcript_shared/);
    assert.match(q.sql, /AS message_count/);
    assert.doesNotMatch(q.sql, /m\.content/);
  } finally {
    server.close();
  }
});

test('shared-sessions rows pass through with a busy annotation', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    sharedRows: [
      sharedRow({ id: 11 }),                       // busy via activeWorkers
      sharedRow({ id: 12, status: 'paused', can_preview: true }), // idle
      sharedRow({ id: 13 }),                       // busy via isInFlight
    ],
  });
  activeWorkers.clear();
  activeWorkers.add(11);
  const realIsInFlight = worker.isInFlight;
  worker.isInFlight = (id) => id === 13;
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/apps/demo/shared-sessions');
    assert.strictEqual(res.status, 200);
    const byId = Object.fromEntries(body.sessions.map((s) => [s.id, s]));
    assert.strictEqual(byId[11].busy, true);
    assert.strictEqual(byId[12].busy, false);
    assert.strictEqual(byId[13].busy, true);
    assert.strictEqual(byId[11].username, 'them');
    // #689: the derived can_preview boolean passes through untouched.
    assert.strictEqual(byId[11].can_preview, false);
    assert.strictEqual(byId[12].can_preview, true);
  } finally {
    worker.isInFlight = realIsInFlight;
    activeWorkers.clear();
    server.close();
  }
});

test('shared-sessions 404s on an unknown app', async () => {
  poolQueryHandler = makeDispatcher();
  const server = await startServer();
  try {
    const { res } = await get(server, '/api/apps/nope/shared-sessions');
    assert.strictEqual(res.status, 404);
  } finally {
    server.close();
  }
});

test('share is owner-scoped: the UPDATE keys on (id, viewer) and keeps the original shared_at', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    shareResult: [{ id: 5, shared_at: '2026-06-12T00:00:00Z', app_id: 42, app_slug: 'demo' }],
  });
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/sessions/5/share');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.ok, true);
    assert.ok(body.shared_at);

    const q = capturedQueries.find((c) => /SET shared_at = COALESCE/.test(c.sql));
    assert.ok(q, 'share UPDATE was issued');
    // Third param is the transcript opt-in, FALSE with no body — see the
    // next test for why that default is the load-bearing part.
    assert.deepStrictEqual(q.params, [5, VIEWER.id, false]);
    assert.match(q.sql, /cs\.user_id = \$2/);
    assert.match(q.sql, /is_headless = FALSE/);
    // Idempotent re-share keeps the first shared_at (ordering stability).
    assert.match(q.sql, /COALESCE\(cs\.shared_at, NOW\(\)\)/);
  } finally {
    server.close();
  }
});

test('plain share does NOT publish the transcript (the default must stay private)', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    shareResult: [{ id: 5, shared_at: '2026-06-12T00:00:00Z', transcript_shared_at: null, app_id: 42, app_slug: 'demo' }],
  });
  const server = await startServer();
  try {
    // Every pre-existing caller of /share sends no body at all.
    const { res, body } = await post(server, '/api/sessions/5/share');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.transcript_shared_at, null);

    const q = capturedQueries.find((c) => /SET shared_at = COALESCE/.test(c.sql));
    assert.strictEqual(q.params[2], false, 'transcript flag defaults to false');
    // With the flag false the CASE leaves the column as-is, so a session
    // whose transcript was already shared isn't silently un-shared either.
    assert.match(q.sql, /ELSE cs\.transcript_shared_at END/);
  } finally {
    server.close();
  }
});

test('share with { transcript: true } sets BOTH stamps in one write', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    shareResult: [{
      id: 5, shared_at: '2026-06-12T00:00:00Z',
      transcript_shared_at: '2026-06-12T00:00:00Z', app_id: 42, app_slug: 'demo',
    }],
  });
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/sessions/5/share', { transcript: true });
    assert.strictEqual(res.status, 200);
    assert.ok(body.shared_at);
    assert.ok(body.transcript_shared_at);

    const q = capturedQueries.find((c) => /SET shared_at = COALESCE/.test(c.sql));
    assert.strictEqual(q.params[2], true);
    assert.match(q.sql, /COALESCE\(cs\.transcript_shared_at, NOW\(\)\)/);
  } finally {
    server.close();
  }
});

test('share-transcript sets both stamps (publishing the chat implies visibility)', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    shareTranscriptResult: [{
      id: 5, shared_at: '2026-06-12T00:00:00Z',
      transcript_shared_at: '2026-06-12T00:05:00Z', app_id: 42, app_slug: 'demo',
    }],
  });
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/sessions/5/share-transcript');
    assert.strictEqual(res.status, 200);
    assert.ok(body.shared_at, 'shared_at comes back set');
    assert.ok(body.transcript_shared_at);

    const q = capturedQueries.find((c) => /transcript_shared_at = COALESCE/.test(c.sql));
    assert.ok(q, 'share-transcript UPDATE was issued');
    assert.deepStrictEqual(q.params, [5, VIEWER.id]);
    // Owner-scoped, non-headless, and it sets shared_at too so the flags
    // can never disagree in the "readable but invisible" direction.
    assert.match(q.sql, /cs\.user_id = \$2/);
    assert.match(q.sql, /is_headless = FALSE/);
    assert.match(q.sql, /shared_at = COALESCE\(cs\.shared_at, NOW\(\)\)/);
    // Idempotent: re-sharing keeps both original stamps.
    assert.match(q.sql, /COALESCE\(cs\.transcript_shared_at, NOW\(\)\)/);
  } finally {
    server.close();
  }
});

test("share-transcript on a session the viewer doesn't own is a 404", async () => {
  poolQueryHandler = makeDispatcher({ shareTranscriptResult: [] });
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/sessions/5/share-transcript');
    assert.strictEqual(res.status, 404);
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('unshare-transcript clears ONLY the transcript stamp', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    unshareTranscriptResult: [{ id: 5, shared_at: '2026-06-12T00:00:00Z', app_id: 42, app_slug: 'demo' }],
  });
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/sessions/5/unshare-transcript');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.transcript_shared_at, null);
    // The session stays on the board — revoking reading is not hiding.
    assert.ok(body.shared_at);

    const q = capturedQueries.find((c) => /SET transcript_shared_at = NULL/.test(c.sql));
    assert.ok(q, 'unshare-transcript UPDATE was issued');
    assert.deepStrictEqual(q.params, [5, VIEWER.id]);
    // Anchored so it can't be satisfied by the `transcript_shared_at =
    // NULL` substring: the SET clause must touch the transcript column and
    // nothing else.
    assert.doesNotMatch(q.sql, /SET shared_at = NULL/, 'must not clear shared_at');
    assert.doesNotMatch(q.sql, /,\s*shared_at = NULL/, 'must not clear shared_at');
    // Not status-filtered: revoking has to work on a promoted/archived row
    // just as well as an active one.
    assert.doesNotMatch(q.sql, /status IN/);
  } finally {
    server.close();
  }
});

test("share on a session the viewer doesn't own is a 404", async () => {
  poolQueryHandler = makeDispatcher({ shareResult: [] });
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/sessions/5/share');
    assert.strictEqual(res.status, 404);
    assert.ok(body.error);
  } finally {
    server.close();
  }
});

test('unshare clears BOTH stamps, owner-scoped, 404 otherwise', async () => {
  capturedQueries = [];
  poolQueryHandler = makeDispatcher({
    unshareResult: [{ id: 5, app_id: 42, app_slug: 'demo' }],
  });
  const server = await startServer();
  try {
    const { res, body } = await post(server, '/api/sessions/5/unshare');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.ok, true);
    const q = capturedQueries.find((c) => /SET shared_at = NULL/.test(c.sql));
    assert.ok(q, 'unshare UPDATE was issued');
    assert.deepStrictEqual(q.params, [5, VIEWER.id]);
    // Hiding a session must never leave its chat readable behind a card
    // nobody can see — a reader could still hold the session id.
    assert.match(q.sql, /transcript_shared_at = NULL/);

    poolQueryHandler = makeDispatcher({ unshareResult: [] });
    const denied = await post(server, '/api/sessions/5/unshare');
    assert.strictEqual(denied.res.status, 404);
  } finally {
    server.close();
  }
});

test('database failure surfaces as a 500', async () => {
  poolQueryHandler = async () => { throw new Error('boom'); };
  const server = await startServer();
  try {
    const { res, body } = await get(server, '/api/apps/demo/shared-sessions');
    assert.strictEqual(res.status, 500);
    assert.ok(body.error);
  } finally {
    poolQueryHandler = async () => ({ rows: [] });
    server.close();
  }
});
