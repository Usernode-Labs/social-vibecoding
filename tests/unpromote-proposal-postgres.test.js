// #3114: "Move back to Underway" — POST /api/sessions/:id/unpromote.
//
// A proposal in review can be taken back to Underway by its author without
// closing its pull request. The whole safety argument is one guarded UPDATE
// in services/session-lifecycle.js unpromoteSession, so the interesting
// half of this file runs that statement, the merge claim and recordVote
// against a REAL PostgreSQL: a mock pool cannot show that the merge claim and
// the move back exclude each other, or that a voided vote stops counting.
//
// Set TEST_DATABASE_URL to run the database tests; without a reachable server
// they skip (the unit-suite container has none). The source-level checks at
// the bottom run everywhere.
//
// Run with: node --test tests/unpromote-proposal-postgres.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VOTES_SRC = read('src/routes/votes.js');
const SESSIONS_SRC = read('src/routes/sessions.js');
const APP_VIEW_SRC = read('public/js/app-view.js');

const { currentVotePredicateSql } = require('../src/services/pr-vote-revision');

const DSN = process.env.TEST_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5432/postgres';
const SCHEMA_NAME = `unpromote_test_${process.pid}`;

// The merge claim and the promote CAS, lifted out of routes/votes.js rather
// than retyped, so this file keeps describing the statements that ship.
const MERGE_CLAIM_SQL = (() => {
  const m = VOTES_SRC.match(/`(UPDATE chat_sessions SET status = 'merging'\s+WHERE id = \$1 AND status = 'promoted'\s+RETURNING id)`/);
  assert.ok(m, 'the promoted -> merging claim must be findable in routes/votes.js');
  return m[1];
})();
const PROMOTE_SELECT_SQL = (() => {
  const start = VOTES_SRC.indexOf("router.post('/api/sessions/:id/promote'");
  const m = VOTES_SRC.slice(start).match(/pool\.query\(\s*`([\s\S]*?)`/);
  assert.ok(start > 0 && m, 'the promote precondition SELECT must be findable');
  return m[1];
})();
const PROMOTE_CAS_SQL = (() => {
  const m = VOTES_SRC.match(/const promoted = await pool\.query\(\s*`([\s\S]*?)`/);
  assert.ok(m, 'the promote status CAS must be findable in routes/votes.js');
  return m[1];
})();

const SHA = 'a'.repeat(40);

function stubModule(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
  return original;
}

async function connectPool() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch { return { skip: 'the pg driver is not installed' }; }
  const probe = new Pool({ connectionString: DSN, connectionTimeoutMillis: 1500, max: 1 });
  try {
    await probe.query('SELECT 1');
  } catch (err) {
    await probe.end().catch(() => {});
    if (process.env.TEST_DATABASE_URL) throw new Error(`TEST_DATABASE_URL is not reachable: ${err.message || err.code}`);
    return { skip: 'No local PostgreSQL; set TEST_DATABASE_URL to run the database tests.' };
  }
  await probe.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
  await probe.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
  await probe.end();
  const pool = new Pool({
    connectionString: DSN, max: 4, options: `-c search_path=${SCHEMA_NAME}`,
  });
  await pool.query(`
    CREATE TABLE apps (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL, name TEXT, repo_url TEXT);
    CREATE TABLE chat_sessions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      app_id INTEGER NOT NULL REFERENCES apps(id),
      status VARCHAR(20) NOT NULL,
      source TEXT,
      is_headless BOOLEAN NOT NULL DEFAULT FALSE,
      active_turn JSONB,
      approval_epoch INTEGER NOT NULL DEFAULT 0,
      stale_notified_at TIMESTAMPTZ,
      promoted_at TIMESTAMPTZ,
      pr_number INTEGER,
      pr_title TEXT,
      integration_block_reasons JSONB,
      reviewed_head_sha VARCHAR(40),
      imported_pr_head_sha VARCHAR(40));
    CREATE TABLE pr_votes (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES chat_sessions(id),
      user_id INTEGER NOT NULL,
      vote VARCHAR(10) NOT NULL,
      head_sha VARCHAR(40),
      approval_epoch INTEGER,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (session_id, user_id));
    CREATE TABLE pending_secret_declarations (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL,
      status TEXT NOT NULL);
    INSERT INTO apps (id, slug, name, repo_url) VALUES (1, 'my-app', 'My App', 'https://github.com/o/r');
  `);
  return { pool };
}

async function dropSchema(pool) {
  await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`).catch(() => {});
  await pool.end().catch(() => {});
}

// Load routes/sessions.js (and routes/votes.js for recordVote) with the pool,
// ws, the collaborator guard and worker teardown stubbed. Everything else is the real code.
function loadRoutes(pool) {
  const paths = {
    pool: require.resolve('../src/db/pool'),
    ws: require.resolve('../src/services/ws'),
    worker: require.resolve('../src/services/worker'),
    appAccess: require.resolve('../src/services/app-access'),
    lifecycle: require.resolve('../src/services/session-lifecycle'),
    sessions: require.resolve('../src/routes/sessions'),
    votes: require.resolve('../src/routes/votes'),
  };
  const spies = { chat: [], sessionUpdates: [], voteUpdates: [], destroyed: [] };
  const realWorker = require('../src/services/worker');
  const originals = [
    [paths.pool, stubModule(paths.pool, { getPool: () => pool })],
    [paths.ws, stubModule(paths.ws, {
      sendSystemMessage: async (_pool, appId, content, type, meta, thread) => {
        spies.chat.push({ appId, content, type, thread: thread || null });
      },
      pushSessionUpdate: (d) => spies.sessionUpdates.push(d),
      pushVoteUpdate: (d) => spies.voteUpdates.push(d),
      pushSessionState: () => {},
      pushIssueUpdate: () => {},
      broadcastGlobal: () => {},
      broadcastGlobalScoped: () => {},
      pushNotificationToUser: () => 0,
    })],
    // The app-level collaborator guard reads tables this schema does not
    // have; app visibility is not what this file is about.
    [paths.appAccess, stubModule(paths.appAccess, {
      ...require('../src/services/app-access'),
      sessionCollabGuard: () => (_req, _res, next) => next(),
    })],
    [paths.worker, stubModule(paths.worker, {
      ...realWorker,
      destroyWorker: async (name) => { spies.destroyed.push(name); },
    })],
  ];
  delete require.cache[paths.lifecycle];
  delete require.cache[paths.sessions];
  delete require.cache[paths.votes];
  const sessions = require('../src/routes/sessions');
  const votes = require('../src/routes/votes');
  const restore = () => {
    for (const [id, original] of originals) {
      if (original) require.cache[id] = original; else delete require.cache[id];
    }
    delete require.cache[paths.lifecycle];
    delete require.cache[paths.sessions];
    delete require.cache[paths.votes];
  };
  return { sessions, votes, spies, restore };
}

async function startServer(sessions) {
  let current = { id: 1, username: 'alice' };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = current; next(); });
  app.use(sessions.sessionRoutes({ jwtSecret: 'test' }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    as(user) { current = user; },
    async post(id) {
      const res = await fetch(`${base}/api/sessions/${id}/unpromote`, { method: 'POST' });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

async function seed(pool, row) {
  const r = {
    user_id: 1, app_id: 1, status: 'promoted', source: null, active_turn: null,
    pr_number: 7, pr_title: 'Tidy the header', reviewed_head_sha: SHA, ...row,
  };
  await pool.query(
    `INSERT INTO chat_sessions (id, user_id, app_id, status, source, active_turn,
       pr_number, pr_title, reviewed_head_sha, promoted_at, integration_block_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), '["checks"]'::jsonb)`,
    [r.id, r.user_id, r.app_id, r.status, r.source, r.active_turn,
      r.pr_number, r.pr_title, r.reviewed_head_sha]
  );
}

async function counted(pool, id) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pr_votes pv JOIN chat_sessions cs ON cs.id = pv.session_id
      WHERE cs.id = $1 AND ${currentVotePredicateSql('pv', 'cs')}`, [id]);
  return rows[0].n;
}

async function statusOf(pool, id) {
  const { rows } = await pool.query('SELECT status FROM chat_sessions WHERE id = $1', [id]);
  return rows[0]?.status;
}

test('unpromote against a real PostgreSQL', async (t) => {
  const conn = await connectPool();
  if (conn.skip) return t.skip(conn.skip);
  const { pool } = conn;
  const loaded = loadRoutes(pool);
  const srv = await startServer(loaded.sessions);
  const { recordVote } = loaded.votes;
  const vote = (sessionId, userId, v = 'yes') => recordVote({
    pool, session: { id: sessionId }, userId, vote: v, headSha: SHA, revisionEnforced: true,
  });

  try {
    await t.test('only the proposer may move it back; others get 403, unknown ids 404', async () => {
      await seed(pool, { id: 10 });
      srv.as({ id: 2, username: 'bob' });
      const denied = await srv.post(10);
      assert.equal(denied.status, 403);
      assert.equal(await statusOf(pool, 10), 'promoted', 'a refused request changes nothing');

      const missing = await srv.post(999);
      assert.equal(missing.status, 404);

      // Someone else's private Underway session reads as missing, not as
      // "not yours": the 403 is only for proposals already public.
      await seed(pool, { id: 11, status: 'paused' });
      assert.equal((await srv.post(11)).status, 404);
      srv.as({ id: 1, username: 'alice' });
    });

    await t.test('the author moves it back: paused, votes voided, lifecycle recorded', async () => {
      await vote(10, 2, 'yes');
      await vote(10, 3, 'yes');
      assert.equal(await counted(pool, 10), 2);

      const res = await srv.post(10);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { ok: true, status: 'paused' });
      assert.equal(await statusOf(pool, 10), 'paused');
      assert.equal(await counted(pool, 10), 0, 'every vote cast in review stops counting');
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pr_votes WHERE session_id = 10');
      assert.equal(rows[0].n, 2, 'the rows stay as a record, like clearApprovals');
      const { rows: s } = await pool.query(
        'SELECT integration_block_reasons, promoted_at FROM chat_sessions WHERE id = 10');
      assert.deepEqual(s[0].integration_block_reasons, [], 'nothing is blocking an Underway change');
      assert.ok(s[0].promoted_at, 'promoted_at stays: it records that it was once proposed');

      assert.deepEqual(loaded.spies.destroyed, ['usernode-worker-10']);
      assert.equal(loaded.spies.chat.length, 2, 'app chat and the proposal thread');
      assert.match(loaded.spies.chat[0].content, /alice moved PR #7: Tidy the header back to Underway/);
      assert.deepEqual(loaded.spies.chat[1].thread, { type: 'session', ref: 10 });
      assert.doesNotMatch(loaded.spies.chat[0].content, /—/, 'no em dashes in product copy');
      assert.equal(loaded.spies.sessionUpdates.at(-1).action, 'unpromoted');
      assert.equal(loaded.spies.voteUpdates.at(-1).sessionId, 10);
    });

    await t.test('it is idempotent', async () => {
      const again = await srv.post(10);
      assert.equal(again.status, 200);
      assert.equal(again.body.alreadyUnderway, true);
      assert.equal(loaded.spies.chat.length, 2, 'a repeat posts nothing');
    });

    await t.test('an Underway proposal cannot be voted on or claimed for a merge', async () => {
      const late = await vote(10, 4, 'yes');
      assert.equal(late.rowCount, 0, 'recordVote requires review, so a late click is refused');
      const claim = await pool.query(MERGE_CLAIM_SQL, [10]);
      assert.equal(claim.rowCount, 0, 'the merge claim cannot take an Underway proposal');
      assert.equal(await statusOf(pool, 10), 'paused');
    });

    await t.test('a proposal that has started merging, or merged, stays put', async () => {
      await seed(pool, { id: 20 });
      const claim = await pool.query(MERGE_CLAIM_SQL, [20]);
      assert.equal(claim.rowCount, 1);
      const res = await srv.post(20);
      assert.equal(res.status, 409);
      assert.match(res.body.error, /already merging/);
      assert.equal(await statusOf(pool, 20), 'merging');

      await seed(pool, { id: 21, status: 'merged' });
      assert.equal((await srv.post(21)).status, 409);
      assert.equal(await statusOf(pool, 21), 'merged');

      await seed(pool, { id: 22, status: 'archived' });
      assert.equal((await srv.post(22)).status, 409);
    });

    await t.test('the merge claim and the move back race: exactly one wins', async () => {
      for (let i = 0; i < 10; i += 1) {
        const id = 100 + i;
        await seed(pool, { id });
        const [claim, res] = await Promise.all([
          pool.query(MERGE_CLAIM_SQL, [id]),
          srv.post(id),
        ]);
        const status = await statusOf(pool, id);
        if (claim.rowCount === 1) {
          assert.equal(status, 'merging');
          assert.equal(res.status, 409);
        } else {
          assert.equal(status, 'paused');
          assert.equal(res.status, 200);
        }
      }
    });

    await t.test('a running build or a held secret refuses the move', async () => {
      await seed(pool, { id: 30, active_turn: JSON.stringify({ turnId: 'x' }) });
      const turn = await srv.post(30);
      assert.equal(turn.status, 409);
      assert.match(turn.body.error, /build is running/);
      assert.equal(await statusOf(pool, 30), 'promoted');

      await seed(pool, { id: 31 });
      const { activeWorkers } = require('../src/services/active-workers');
      activeWorkers.add(31);
      try {
        assert.equal((await srv.post(31)).status, 409);
        assert.equal(await statusOf(pool, 31), 'promoted');
      } finally { activeWorkers.delete(31); }

      await seed(pool, { id: 32 });
      await pool.query(`INSERT INTO pending_secret_declarations (session_id, status) VALUES (32, 'pending')`);
      const secret = await srv.post(32);
      assert.equal(secret.status, 409);
      assert.match(secret.body.error, /Withdraw it instead/);
      assert.equal(await statusOf(pool, 32), 'promoted');
    });

    await t.test('an imported PR returns to active, the state it was promoted from', async () => {
      await seed(pool, { id: 40, source: 'imported', reviewed_head_sha: null });
      const before = loaded.spies.destroyed.length;
      const res = await srv.post(40);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'active');
      assert.equal(await statusOf(pool, 40), 'active');
      assert.equal(loaded.spies.destroyed.length, before, 'an imported PR has no worker to tear down');
    });

    await t.test('re-promotion works through the promote route’s own statements', async () => {
      // Session 10 was moved back above with two voided votes.
      const { rows: eligible } = await pool.query(PROMOTE_SELECT_SQL, [10, 1]);
      assert.equal(eligible.length, 1, 'the promote route finds the Underway session');
      const cas = await pool.query(PROMOTE_CAS_SQL, [10, SHA, eligible[0].status]);
      assert.equal(cas.rowCount, 1);
      assert.equal(await statusOf(pool, 10), 'promoted');
      assert.equal(await counted(pool, 10), 0, 'the fresh review starts with no votes counted');

      const fresh = await vote(10, 2, 'yes');
      assert.equal(fresh.rowCount, 1);
      assert.equal(await counted(pool, 10), 1, 'a vote in the new review counts');

      // And it can be moved back a second time.
      assert.equal((await srv.post(10)).status, 200);
      assert.equal(await counted(pool, 10), 0);
    });
  } finally {
    await srv.close();
    loaded.restore();
    await dropSchema(pool);
  }
});

// ── Source-level checks (no database) ──────────────────────────────────

test('the route is owner-scoped through the lifecycle service', () => {
  const route = SESSIONS_SRC.match(/router\.post\('\/api\/sessions\/:id\/unpromote'[\s\S]*?\n  \}\);/);
  assert.ok(route, 'POST /api/sessions/:id/unpromote must be mounted');
  assert.match(route[0], /sessionLifecycle\.unpromoteSession\(\{\s*pool, sessionId, userId: req\.user\.id/);
  assert.match(route[0], /status\(403\)/);
});

test('the proposal menu and detail view offer the move to the author only', () => {
  const menu = APP_VIEW_SRC.match(/_proposalMenuItems\(pr, state\) \{[\s\S]*?\n  \},/);
  assert.ok(menu);
  assert.match(menu[0],
    /if \(st\.mine && !ro && !isMerged && !isMerging && pr\.status === 'promoted'\) \{\s*items\.push\(\{\s*label: 'Move back to Underway'/);
  assert.match(APP_VIEW_SRC, /key: 'unpromote', cls: 'gc-vote-btn', label: 'Move back to Underway'/);
  assert.match(APP_VIEW_SRC, /fetch\(`\/api\/sessions\/\$\{sessionId\}\/unpromote`, \{ method: 'POST' \}\)/,
    'the client path is spelled literally so the Global Chat inventory can see it');
  const fn = APP_VIEW_SRC.match(/async unpromoteProposal\(sessionId\) \{[\s\S]*?\n  \},/);
  assert.ok(fn);
  assert.match(fn[0], /Its votes are cleared and it cannot be merged until you propose it again/);
  assert.doesNotMatch(fn[0], /—/, 'no em dashes in the confirm copy');
});
