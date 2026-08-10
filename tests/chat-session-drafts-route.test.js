// #940: GET / POST / DELETE /api/sessions/:id/drafts — the write side of
// saved dev-chat drafts, now persisted per ACCOUNT instead of per browser.
//
// The contracts guarded here:
//
//   1. OWNERSHIP IS THE ONLY GATE, and a miss is a flat 404. Someone else's
//      session must not be distinguishable from a nonexistent one, and there
//      is deliberately NO status restriction — drafts stay readable and
//      deletable on a paused or archived session, exactly as the
//      localStorage list was.
//   2. draft_id is CLIENT-supplied, so it is strictly validated and only
//      ever passed as a bound parameter.
//   3. POST IS IDEMPOTENT on (session, draft id) — that is what lets a
//      device flush its offline mirror without special-casing "already
//      uploaded", and it must not trip the cap when re-sending a draft the
//      server already holds.
//   4. DELETE IS IDEMPOTENT — an already-gone row is still a 200, which is
//      what makes tombstone replay safe.
//   5. Ordering is saved_at ASC, draft_id ASC ("newest last"), matching the
//      client's render order.
//   6. The table is staging:private — FORCED, since it FKs the private
//      chat_sessions and a public table FK-ing a private one is what the
//      clone's FK-closure discovery forbids.
//
// HTTP tests against a throwaway express app over a substring-dispatching
// mock pool — the idiom of tests/home-layout-api.test.js.
//
// Run with: node --test tests/chat-session-drafts-route.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const SCHEMA = read('src/db/schema.sql');
const ROUTE = read('src/routes/chat-drafts.js');
const SERVER = read('server.js');
const LIMITS = read('src/middleware/rate-limits.js');
const MIGRATE = read('src/db/migrate.js');
const SESSIONS = read('src/routes/sessions.js');
const DEV_CHAT = read('public/js/dev-chat.js');
const DAPP = JSON.parse(read('dapp.json'));

const USER = { id: 7, username: 'tester', isAdmin: false };
const OTHER = { id: 99, username: 'someone-else', isAdmin: false };

// state.sessions: [{ id, user_id }]   state.drafts: [{ session_id, draft_id, content, saved_at }]
function makeMockPool(state) {
  const calls = [];
  const run = async (rawSql, params = []) => {
    const sql = String(rawSql).replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });

    if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)) return { rows: [] };

    if (/FROM chat_sessions cs/i.test(sql)) {
      const [id, userId] = params;
      const hit = (state.sessions || []).find(
        (s) => Number(s.id) === Number(id) && Number(s.user_id) === Number(userId)
      );
      return { rows: hit ? [{ id: hit.id, user_id: hit.user_id }] : [] };
    }

    if (/SELECT COUNT\(\*\)/i.test(sql) && /chat_session_drafts/i.test(sql)) {
      const [sessionId, draftId] = params;
      const mine = (state.drafts || []).filter((d) => Number(d.session_id) === Number(sessionId));
      return { rows: [{ total: mine.length, mine: mine.filter((d) => d.draft_id === draftId).length }] };
    }

    if (/INSERT INTO chat_session_drafts/i.test(sql)) {
      const [session_id, user_id, draft_id, content, saved_at] = params;
      const exists = (state.drafts || []).some(
        (d) => Number(d.session_id) === Number(session_id) && d.draft_id === draft_id
      );
      if (exists) return { rows: [], rowCount: 0 }; // ON CONFLICT DO NOTHING
      (state.drafts = state.drafts || []).push({
        session_id, user_id, draft_id, content,
        saved_at: saved_at || new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    if (/DELETE FROM chat_session_drafts/i.test(sql)) {
      const [sessionId, draftId] = params;
      const before = (state.drafts || []).length;
      state.drafts = (state.drafts || []).filter(
        (d) => !(Number(d.session_id) === Number(sessionId) && d.draft_id === draftId)
      );
      return { rows: [], rowCount: before - state.drafts.length };
    }

    if (/FROM chat_session_drafts/i.test(sql)) {
      const [sessionId] = params;
      const rows = (state.drafts || [])
        .filter((d) => Number(d.session_id) === Number(sessionId))
        .map((d) => ({ draft_id: d.draft_id, content: d.content, saved_at: d.saved_at }))
        .sort((a, b) => (
          String(a.saved_at) === String(b.saved_at)
            ? (a.draft_id < b.draft_id ? -1 : a.draft_id > b.draft_id ? 1 : 0)
            : (String(a.saved_at) < String(b.saved_at) ? -1 : 1)
        ));
      return { rows };
    }

    return { rows: [] };
  };

  const client = { query: run, release() {} };
  return { pool: { query: run, async connect() { return client; } }, calls };
}

function makeApp(state = {}, { user } = {}) {
  const { pool, calls } = makeMockPool(state);
  const poolModule = require('../src/db/pool');
  const originalGetPool = poolModule.getPool;
  poolModule.getPool = () => pool;
  let routes;
  try {
    delete require.cache[require.resolve('../src/routes/chat-drafts')];
    routes = require('../src/routes/chat-drafts').chatDraftsRoutes();
  } finally {
    poolModule.getPool = originalGetPool;
  }
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use(routes);
  return { app, calls, state };
}

async function req(app, method, url, payload) {
  const server = app.listen(0);
  // The harness preload (tests/lib/test-net.js) pins hostless listens to
  // 127.0.0.1, which makes the bind complete on the next tick instead of
  // synchronously — so wait for it before reading the assigned port.
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      ...(payload === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}
const get = (app, url) => req(app, 'GET', url);
const post = (app, url, payload) => req(app, 'POST', url, payload);
const del = (app, url) => req(app, 'DELETE', url);

const OWNED = { sessions: [{ id: 42, user_id: USER.id }] };
const seed = (extra = {}) => ({ sessions: [{ id: 42, user_id: USER.id }], drafts: [], ...extra });

// ── auth + ownership ───────────────────────────────────────────────────

test('every endpoint 401s without a user', async () => {
  const { app } = makeApp(seed());
  assert.equal((await get(app, '/api/sessions/42/drafts')).status, 401);
  assert.equal((await post(app, '/api/sessions/42/drafts', { text: 'hi' })).status, 401);
  assert.equal((await del(app, '/api/sessions/42/drafts/abc')).status, 401);
});

test('someone else\'s session is a flat 404, not a 403', async () => {
  const { app } = makeApp(seed(), { user: OTHER });
  for (const r of [
    await get(app, '/api/sessions/42/drafts'),
    await post(app, '/api/sessions/42/drafts', { text: 'hi' }),
    await del(app, '/api/sessions/42/drafts/abc'),
  ]) {
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'Session not found');
  }
});

test('the ownership predicate is in the SQL, not just in JS', async () => {
  const { app, calls } = makeApp(seed(), { user: USER });
  await get(app, '/api/sessions/42/drafts');
  const gate = calls.find((c) => /FROM chat_sessions cs/i.test(c.sql));
  assert.match(gate.sql, /cs\.id = \$1 AND cs\.user_id = \$2/);
  assert.deepEqual(gate.params, [42, USER.id]);
});

test('drafts stay reachable regardless of session status (no status filter)', () => {
  // Paused/archived sessions must keep their drafts readable and deletable,
  // exactly as the localStorage list did. Guard against a well-meaning
  // "AND cs.status IN (...)" being added later.
  assert.doesNotMatch(ROUTE, /cs\.status\s+IN/i);
});

// ── POST ───────────────────────────────────────────────────────────────

test('POST stores a draft and returns the authoritative list', async () => {
  const { app, state } = makeApp(seed(), { user: USER });
  const r = await post(app, '/api/sessions/42/drafts', { id: 'd1', text: '  hello  ' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.max, 20);
  assert.deepEqual(r.body.drafts.map((d) => d.text), ['hello']); // trimmed
  assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].user_id, USER.id);
});

test('POST rejects empty / whitespace-only / oversized text', async () => {
  const { app } = makeApp(seed(), { user: USER });
  assert.equal((await post(app, '/api/sessions/42/drafts', { text: '' })).status, 400);
  assert.equal((await post(app, '/api/sessions/42/drafts', { text: '   ' })).status, 400);
  assert.equal((await post(app, '/api/sessions/42/drafts', {})).status, 400);
  const big = await post(app, '/api/sessions/42/drafts', { text: 'x'.repeat(10001) });
  assert.equal(big.status, 400);
  assert.match(big.body.error, /10000 characters/);
});

test('POST rejects a malformed draft id rather than silently replacing it', async () => {
  const { app } = makeApp(seed(), { user: USER });
  for (const id of ['has space', 'x'.repeat(33), 'semi;colon', "quote'", '../etc']) {
    const r = await post(app, '/api/sessions/42/drafts', { id, text: 'hi' });
    assert.equal(r.status, 400, `id ${JSON.stringify(id)} must be rejected`);
    assert.equal(r.body.error, 'Bad draft id');
  }
});

test('POST generates an id when the client omits one', async () => {
  const { app } = makeApp(seed(), { user: USER });
  const r = await post(app, '/api/sessions/42/drafts', { text: 'hi' });
  assert.equal(r.status, 200);
  assert.match(r.body.id, /^[A-Za-z0-9_-]{1,32}$/);
});

test('POST is idempotent on a repeated draft id', async () => {
  const { app, state } = makeApp(seed(), { user: USER });
  await post(app, '/api/sessions/42/drafts', { id: 'd1', text: 'first' });
  const r = await post(app, '/api/sessions/42/drafts', { id: 'd1', text: 'first' });
  assert.equal(r.status, 200);
  assert.equal(state.drafts.length, 1, 're-upload must not duplicate');
  assert.equal(r.body.drafts.length, 1);
});

test('the 20-draft cap 409s, but a re-upload of a stored draft still passes', async () => {
  const drafts = Array.from({ length: 20 }, (_, i) => ({
    session_id: 42, user_id: USER.id, draft_id: `d${i}`, content: `draft ${i}`,
    saved_at: `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`,
  }));
  const { app } = makeApp(seed({ drafts }), { user: USER });

  const full = await post(app, '/api/sessions/42/drafts', { id: 'new', text: 'one more' });
  assert.equal(full.status, 409);
  assert.equal(full.body.code, 'draft_cap');
  assert.match(full.body.error, /20 saved drafts/);

  // Re-sending one the server ALREADY holds is the reconcile flush's normal
  // case and must not be refused by the cap.
  const again = await post(app, '/api/sessions/42/drafts', { id: 'd3', text: 'draft 3' });
  assert.equal(again.status, 200);
});

test('a client-supplied savedAt is clamped into [now - 30d, now]', () => {
  const { clampSavedAt } = require('../src/routes/chat-drafts');
  const now = Date.now();
  assert.equal(clampSavedAt(null), null);
  assert.equal(clampSavedAt('not a date'), null);
  // Far future → clamped back to ~now.
  assert.ok(clampSavedAt('2099-01-01T00:00:00.000Z').getTime() <= now + 1000);
  // Ancient → clamped forward to ~30 days ago.
  const old = clampSavedAt('1990-01-01T00:00:00.000Z').getTime();
  assert.ok(old >= now - (30 * 24 * 60 * 60 * 1000) - 1000);
  // A sane recent value survives untouched.
  const recent = new Date(now - 60_000).toISOString();
  assert.equal(clampSavedAt(recent).toISOString(), recent);
});

// ── DELETE ─────────────────────────────────────────────────────────────

test('DELETE removes just that draft', async () => {
  const drafts = [
    { session_id: 42, user_id: USER.id, draft_id: 'a', content: 'A', saved_at: '2026-01-01T00:00:00.000Z' },
    { session_id: 42, user_id: USER.id, draft_id: 'b', content: 'B', saved_at: '2026-01-01T00:01:00.000Z' },
  ];
  const { app, state } = makeApp(seed({ drafts }), { user: USER });
  const r = await del(app, '/api/sessions/42/drafts/a');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.drafts.map((d) => d.id), ['b']);
  assert.equal(state.drafts.length, 1);
});

test('DELETE of a missing id is a 200 — tombstone replay must be safe', async () => {
  const { app } = makeApp(seed(), { user: USER });
  const r = await del(app, '/api/sessions/42/drafts/nothinghere');
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(r.body.drafts, []);
});

test('DELETE rejects a malformed draft id', async () => {
  const { app } = makeApp(seed(), { user: USER });
  const r = await del(app, '/api/sessions/42/drafts/' + encodeURIComponent('bad id;'));
  assert.equal(r.status, 400);
});

// ── ordering + shape ───────────────────────────────────────────────────

test('the list is ordered saved_at ASC, draft_id ASC (newest last)', async () => {
  const { app, calls } = makeApp(seed({
    drafts: [
      { session_id: 42, user_id: USER.id, draft_id: 'zz', content: 'late', saved_at: '2026-01-01T00:05:00.000Z' },
      { session_id: 42, user_id: USER.id, draft_id: 'aa', content: 'early', saved_at: '2026-01-01T00:01:00.000Z' },
      { session_id: 42, user_id: USER.id, draft_id: 'ab', content: 'tie', saved_at: '2026-01-01T00:01:00.000Z' },
    ],
  }), { user: USER });
  const r = await get(app, '/api/sessions/42/drafts');
  assert.deepEqual(r.body.drafts.map((d) => d.text), ['early', 'tie', 'late']);
  const list = calls.find((c) => /ORDER BY saved_at ASC, draft_id ASC/.test(c.sql));
  assert.ok(list, 'the ORDER BY must be in the SQL, not applied in JS');
});

test('the wire shape is { id, text, savedAt } — matching the client draft object', async () => {
  const { app } = makeApp(seed({
    drafts: [{ session_id: 42, user_id: USER.id, draft_id: 'a', content: 'A', saved_at: '2026-01-01T00:00:00.000Z' }],
  }), { user: USER });
  const r = await get(app, '/api/sessions/42/drafts');
  assert.deepEqual(Object.keys(r.body.drafts[0]).sort(), ['id', 'savedAt', 'text']);
});

test('a bad session id is a 400, not a NaN query', async () => {
  const { app } = makeApp(seed(), { user: USER });
  assert.equal((await get(app, '/api/sessions/abc/drafts')).status, 400);
});

// ── cross-device push ──────────────────────────────────────────────────

test('mutations fan out per-USER, never app-scoped', () => {
  assert.match(ROUTE, /pushNotificationToUser/);
  assert.match(ROUTE, /session_drafts_changed/);
  // broadcastGlobalScoped would put private drafts on every client with
  // that app open.
  assert.doesNotMatch(ROUTE, /broadcastGlobalScoped|broadcastGlobal\b/);
});

test('the client handles the push and only for the open session', () => {
  const APP_JS = read('public/js/app.js');
  assert.match(APP_JS, /case 'session_drafts_changed':/);
  assert.match(APP_JS, /applyDraftsUpdate/);
  assert.match(DEV_CHAT, /applyDraftsUpdate\(sessionId\)\s*\{/);
});

// ── wiring ─────────────────────────────────────────────────────────────

test('the router is mounted in server.js', () => {
  assert.match(SERVER, /require\('\.\/src\/routes\/chat-drafts'\)/);
  assert.match(SERVER, /app\.use\(chatDraftsRoutes\(config\)\)/);
});

test('writes are rate limited per user', () => {
  assert.match(LIMITS, /const draftWriteLimiter = makeLimiter\(\{[\s\S]*?keyByUser: true/);
  assert.match(LIMITS, /module\.exports = \{[^}]*draftWriteLimiter/);
  assert.match(ROUTE, /router\.post\([^,]+,\s*draftWriteLimiter/);
  assert.match(ROUTE, /router\.delete\([^,]+,\s*draftWriteLimiter/);
  // A GET is cheap and runs on every session open — don't throttle reads.
  assert.doesNotMatch(ROUTE, /router\.get\([^,]+,\s*draftWriteLimiter/);
});

test('there is deliberately no full-replace PUT', () => {
  // A last-write-wins replace lets a stale device resurrect a draft another
  // device just sent; per-row insert/delete has no lost-update window.
  assert.doesNotMatch(ROUTE, /router\.put\(/);
});

test('GET /api/sessions/:id carries the drafts, best-effort', () => {
  assert.match(SESSIONS, /const \{ listDrafts \} = require\('\.\/chat-drafts'\)/);
  assert.match(SESSIONS, /res\.json\(\{ session, messages, drafts \}\)/);
  // Best-effort: a drafts hiccup must not break opening a session.
  assert.match(SESSIONS, /let drafts = null;[\s\S]{0,300}?catch/);
});

// ── schema + privacy ───────────────────────────────────────────────────

test('schema defines chat_session_drafts with a cascading FK to its session', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS chat_session_drafts/);
  assert.match(
    SCHEMA,
    /session_id INTEGER\s+NOT NULL REFERENCES chat_sessions\(id\) ON DELETE CASCADE/
  );
  assert.match(SCHEMA, /user_id\s+INTEGER\s+NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(SCHEMA, /PRIMARY KEY \(session_id, draft_id\)/);
  assert.match(SCHEMA, /CHECK \(length\(content\) BETWEEN 1 AND 10000\)/);
  assert.match(SCHEMA, /idx_chat_session_drafts_session[\s\S]{0,120}saved_at, draft_id/);
});

test('chat_session_drafts is staging:private — forced, not a preference', () => {
  // It FKs the private chat_sessions, and a PUBLIC table FK-ing a private
  // one is exactly the combination the clone's FK-closure discovery forbids.
  assert.match(SCHEMA, /COMMENT ON TABLE chat_session_drafts IS 'staging:private'/);
});

test('drafts never leak into the shared transcript surface', () => {
  // Unsent drafts stay private even when the session AND its transcript are
  // published. The only place sessions.js may mention the table is the
  // owner-scoped GET, via listDrafts.
  const transcript = SESSIONS.slice(
    SESSIONS.indexOf("router.get('/api/sessions/:id/transcript'"),
    SESSIONS.indexOf("router.post('/api/sessions/:id/fork'")
  );
  assert.ok(transcript.length > 0, 'transcript route must still exist');
  assert.doesNotMatch(transcript, /chat_session_drafts|listDrafts/);
  assert.doesNotMatch(read('src/services/transcript-share.js'), /chat_session_drafts/);
});

// ── staging fixture + deep link ────────────────────────────────────────

test('migrate registers the saved-drafts staging fixture', () => {
  assert.match(MIGRATE, /await seedStagingSavedDrafts\(pool, config\)/);
  assert.match(MIGRATE, /async function seedStagingSavedDrafts\(pool, config\)/);
});

test('the fixture is staging-gated, idempotent and obviously fake', () => {
  const fn = MIGRATE.slice(
    MIGRATE.indexOf('async function seedStagingSavedDrafts'),
    MIGRATE.indexOf('async function seedStagingSharedSession')
  );
  assert.match(fn, /if \(process\.env\.USERNODE_ENV !== 'staging'\) return;/);
  assert.match(fn, /ON CONFLICT \(id\) DO UPDATE SET user_id = EXCLUDED\.user_id/);
  assert.match(fn, /ON CONFLICT \(session_id, draft_id\) DO UPDATE SET user_id = EXCLUDED\.user_id/);
  assert.match(fn, /\[staging fixture\]/);
  assert.match(MIGRATE, /STAGING_SAVED_DRAFTS_SESSION_ID = 990402/);
  assert.match(MIGRATE, /Staging demo draft: also make the header sticky when scrolling\./);
  assert.match(MIGRATE, /Staging demo draft: rename the "Submit" button to "Publish"\./);
});

test('the fixture id does not collide with an existing 99xxxx fixture', () => {
  const ids = [...MIGRATE.matchAll(/\b(99\d{4})\b/g)].map((m) => m[1]);
  assert.ok(ids.includes('990402'));
  // 990402 must be introduced by exactly one constant.
  const declarations = [...MIGRATE.matchAll(/=\s*990402\b/g)];
  assert.equal(declarations.length, 1);
});

test('dapp.json covers both the demo paint and the DB-backed path', () => {
  const tests = DAPP.tests || [];
  const dbBacked = tests.find((t) => t.path === '/#app/usernode-2d5619/dev/sessions/990402');
  assert.ok(dbBacked, 'a check must render drafts straight from the database');
  assert.match(dbBacked.expectSelector, /dc-draft-row/);
  assert.match(dbBacked.expectText, /Staging demo draft/);

  const label = tests.find((t) => (t.expectText || '').includes('on all your devices'));
  assert.ok(label, 'the cross-device header label must be pinned by a check');
  assert.equal(label.path, '/?shot=drafts#app/usernode-2d5619/dev/sessions/990401');

  // The pre-existing demo-paint check must survive — it is the regression
  // guard that the ?shot fallback still works when the server list is empty.
  assert.ok(tests.some((t) => (t.name || '').includes('send/edit/trash (#798)')));
});

test('the client cap matches the server cap', () => {
  const { MAX_DRAFTS } = require('../src/routes/chat-drafts');
  assert.equal(MAX_DRAFTS, 20);
  assert.match(DEV_CHAT, /MAX_SAVED_DRAFTS: 20,/);
});
