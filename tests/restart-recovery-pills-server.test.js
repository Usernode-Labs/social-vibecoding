'use strict';

// Server-side half of #786: every restart-recovery breadcrumb must persist
// the turn's quick-reply pills (and broadcast them on its status event), and
// the boot-time backfill sweep must repair the two shapes that leave no
// breadcrumb at all.
//
// Without these the dev-chat pill bar comes back empty after a restart: the
// pills on a dispatch turn come ONLY from the Mayor's phase-2 wrap-up, which
// the recovery paths deliberately don't resume.
//
// server.js only boots under the require.main guard, so requiring it here
// exposes adoptOrphanWorker + restoreMissingQuickReplies without starting
// servers. worker and ws are stubbed via require.cache BEFORE the require so
// server.js binds the stubs.
//
// Run with: node --test tests/restart-recovery-pills-server.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';

const recoveryPills = require('../src/services/recovery-pills');

// ── worker stub ─────────────────────────────────────────────────────────
// isWorkerExecuting returns `true` so adoptOrphanWorker takes the mid-exec
// "kill the orphan exec" branch (case d); flipped per-test where needed.
let workerExecuting = true;
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  destroyWorker: async () => {},
  adoptWarmWorker: () => {},
  isWorkerExecuting: async () => workerExecuting,
  watchWorker: async () => ({}),
  stopTurn: async () => false,
  clearActiveTurn: async () => {},
};

// ── ws stub (restoreMissingQuickReplies broadcasts its breadcrumb) ──────
const broadcasts = [];
const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = {
  ...realWs,
  broadcastGlobal: (msg) => { broadcasts.push(msg); },
};

// ── db/pool stub (restoreMissingQuickReplies resolves its own pool) ─────
let backfillPool = null;
const poolPath = require.resolve('../src/db/pool');
const realPool = require(poolPath);
require.cache[poolPath].exports = {
  ...realPool,
  getPool: () => backfillPool,
};

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let adoptOrphanWorker;
let restoreMissingQuickReplies;
try {
  ({ adoptOrphanWorker, restoreMissingQuickReplies } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const activeWorkersSvc = require('../src/services/active-workers');

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// Collect the metadata of every chat_session_messages INSERT a pool saw.
function insertedRows(calls) {
  return calls
    .filter((c) => /INSERT INTO chat_session_messages/i.test(c.sql))
    .map((c) => ({
      sessionId: c.params[0],
      content: c.params[1] ?? c.params[2],
      metadata: JSON.parse(c.params[c.params.length - 1] || '{}'),
    }));
}

// ── 1. adoptOrphanWorker breadcrumbs ───────────────────────────────────

function makeAdoptPool(sessionRow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      if (/SELECT cs\.\*/i.test(String(sql))) return { rows: sessionRow ? [sessionRow] : [] };
      return { rows: [], rowCount: 0 };
    },
  };
}

const SESSION = {
  id: 77, status: 'active', is_headless: false, user_id: 1, app_id: 1,
  username: 'alice', app_slug: 'my-app', app_name: 'My App',
  repo_url: 'https://github.com/owner/repo',
  branch_name: 'dev/chat-77',
  cc_session_id: 'cc-1',
  active_turn: null,
};

test.beforeEach(() => { broadcasts.length = 0; });

test('mid-exec-killed breadcrumb carries the unrecoverable pills', async () => {
  workerExecuting = true;
  const pool = makeAdoptPool({ ...SESSION });
  await adoptOrphanWorker(
    { name: 'usernode-worker-77', sessionId: 77, state: 'running' },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: (m) => broadcasts.push(m) }
  );

  const rows = insertedRows(pool.calls);
  assert.equal(rows.length, 1, 'one breadcrumb posted');
  assert.match(rows[0].content, /Lost connection mid-turn after restart/);
  assert.deepEqual(rows[0].metadata.quickReplies,
    recoveryPills.buildRecoveryQuickReplies('unrecoverable'));

  const status = broadcasts.find((b) => b.event === 'status');
  assert.ok(status, 'a status event was broadcast');
  assert.deepEqual(status.quickReplies,
    recoveryPills.buildRecoveryQuickReplies('unrecoverable'),
    'the live tab gets the pills without a reload');
});

test('worker-gone breadcrumb carries the unrecoverable pills', async () => {
  // No container for the session (state 'exited' with an active_turn record)
  // takes the "its worker is gone" branch.
  workerExecuting = false;
  const pool = makeAdoptPool({
    ...SESSION,
    active_turn: { mode: 'build', journal: '/turns/t1.jsonl', startedAt: new Date(0).toISOString() },
  });
  await adoptOrphanWorker(
    { name: 'usernode-worker-77', sessionId: 77, state: 'exited' },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: (m) => broadcasts.push(m) }
  );

  const rows = insertedRows(pool.calls);
  const gone = rows.find((r) => /its worker is gone/.test(String(r.content)));
  assert.ok(gone, 'the worker-gone breadcrumb was posted');
  assert.deepEqual(gone.metadata.quickReplies,
    recoveryPills.buildRecoveryQuickReplies('unrecoverable'));
});

// ── 2. resumeDetachedTurnInner / watchdog breadcrumbs (source-invariant)
//
// Those two live behind boot-only code paths that would need the journal
// transport and the notification stack stubbed to drive end-to-end; assert
// the wiring at the source level instead, which is what would regress.

test('the recovered-turn success tail picks its pill kind from the outcome', () => {
  assert.match(SERVER_SRC,
    /breadcrumbPillKind = finalizeOutcome === 'push_failed' \? 'push_failed' : 'code_done'/,
    'a recovered build breadcrumb must carry code_done pills, or push_failed when the push failed');
  assert.match(SERVER_SRC,
    /'Coding turn recovered after a platform restart\.',\s*\n\s*JSON\.stringify\(breadcrumbPills \? \{ quickReplies: breadcrumbPills \} : \{\}\)/,
    'the generic recovery breadcrumb persists its pills');
  assert.match(SERVER_SRC,
    /text: 'Coding turn recovered after a platform restart\.',\s*\n\s*quickReplies: breadcrumbPills \|\| undefined/,
    "the generic recovery breadcrumb's status event carries its pills");
});

test('the recovered scout tails carry spec_done / unrecoverable pills', () => {
  assert.match(SERVER_SRC, /const specPills = recoveryPills\.buildRecoveryQuickReplies\('spec_done'\)/,
    'a recovered scout turn that drafted a spec gets the spec pills');
  assert.match(SERVER_SRC, /const noSpecPills = recoveryPills\.buildRecoveryQuickReplies\('unrecoverable'\)/,
    'a recovered scout turn with no spec text gets retry pills');
  assert.match(SERVER_SRC, /recoveryPills\.SCOUT_NO_SPEC_BREADCRUMB/,
    'the no-spec outcome is persisted, not emit-only (it used to vanish on reload)');
});

test('the failed-resume and watchdog-reap breadcrumbs carry retry pills', () => {
  assert.match(SERVER_SRC, /const failedPills = recoveryPills\.buildRecoveryQuickReplies\('unrecoverable'\)/);
  assert.match(SERVER_SRC, /const reapPills = recoveryPills\.buildRecoveryQuickReplies\('unrecoverable'\)/);
  assert.match(SERVER_SRC, /const goneP = recoveryPills\.buildRecoveryQuickReplies\('unrecoverable'\)/);
});

test('the backfill sweep is chained post-listen onto the recovery block', () => {
  // Hard constraint: it must never run before the listener is up. It hangs
  // off the same fire-and-forget chain as the other boot recovery steps.
  assert.match(SERVER_SRC,
    /resumeHeadlessRuns\(config\)[\s\S]{0,600}\.then\(\(\) => restoreMissingQuickReplies\(config\)\)/,
    'restoreMissingQuickReplies is chained after resumeHeadlessRuns');
  const listenIdx = SERVER_SRC.indexOf('const server = app.listen(');
  const chainIdx = SERVER_SRC.indexOf('.then(() => restoreMissingQuickReplies(config))');
  assert.ok(listenIdx >= 0 && chainIdx > listenIdx,
    'the backfill call site must come after app.listen()');
});

// ── 3. restoreMissingQuickReplies — the boot backfill sweep ────────────

// Fake pool driven by a per-test script: the candidate sessions, the newest
// user/assistant row per session, and the newest system row per session.
function makeBackfillPool({ sessions = [], lastRows = {}, newestSystem = {} } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (/FROM chat_sessions/i.test(text) && /is_headless = FALSE/i.test(text)) {
        return { rows: sessions };
      }
      if (/role IN \('user', 'assistant'\)/i.test(text)) {
        const row = lastRows[params[0]];
        return { rows: row ? [row] : [] };
      }
      if (/role = 'system'/i.test(text) && /SELECT content/i.test(text)) {
        const row = newestSystem[params[0]];
        return { rows: row ? [row] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function writes(pool) {
  return pool.calls.filter((c) => /^\s*(INSERT|UPDATE)/i.test(c.sql.trim()));
}

test('backfill: a row that already has pills is left alone', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 1, pr_number: 5, spec_md: 'x' }],
    lastRows: { 1: { id: 10, role: 'assistant', content: 'done', metadata: { quickReplies: ['Make a tweak'] } } },
  });
  await restoreMissingQuickReplies({});
  assert.deepEqual(writes(backfillPool), [], 'no writes for an already-healthy session');
  assert.deepEqual(broadcasts, []);
});

test('backfill: a bare assistant row with a PR gets the code_done pills', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 2, pr_number: 41, spec_md: null }],
    lastRows: { 2: { id: 20, role: 'assistant', content: "I'll have the agent do that.", metadata: {} } },
  });
  await restoreMissingQuickReplies({});
  const w = writes(backfillPool);
  assert.equal(w.length, 1);
  assert.match(w[0].sql, /UPDATE chat_session_messages/);
  assert.match(w[0].sql, /'\{quickReplies\}'/);
  assert.deepEqual(JSON.parse(w[0].params[0]),
    recoveryPills.buildRecoveryQuickReplies('code_done'));
  assert.equal(w[0].params[1], 20, 'patched the row the client actually reads');
});

test('backfill: a spec but no PR gets the spec_done pills', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 3, pr_number: null, spec_md: '## User-facing changes\n\nx' }],
    lastRows: { 3: { id: 30, role: 'assistant', content: 'Scouting.', metadata: {} } },
  });
  await restoreMissingQuickReplies({});
  assert.deepEqual(JSON.parse(writes(backfillPool)[0].params[0]),
    recoveryPills.buildRecoveryQuickReplies('spec_done'));
});

test('backfill: neither PR nor spec falls back to unknown_state', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 4, pr_number: null, spec_md: '   ' }],
    lastRows: { 4: { id: 40, role: 'assistant', content: 'Hello.', metadata: {} } },
  });
  await restoreMissingQuickReplies({});
  assert.deepEqual(JSON.parse(writes(backfillPool)[0].params[0]),
    recoveryPills.buildRecoveryQuickReplies('unknown_state'));
});

test('backfill: a trailing user row gets the missed-reply breadcrumb + resend pill', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 5, pr_number: null, spec_md: null }],
    lastRows: { 5: { id: 50, role: 'user', content: 'Make the leaderboard sort by score', metadata: {} } },
    newestSystem: { 5: { content: 'Thinking about your request...' } },
  });
  await restoreMissingQuickReplies({});
  const w = writes(backfillPool);
  assert.equal(w.length, 1);
  assert.match(w[0].sql, /INSERT INTO chat_session_messages/);
  assert.equal(w[0].params[1], recoveryPills.UNANSWERED_BREADCRUMB);
  assert.deepEqual(JSON.parse(w[0].params[2]).quickReplies,
    ['Make the leaderboard sort by score', "What's the current state?"]);

  const status = broadcasts.find((b) => b.event === 'status');
  assert.ok(status, 'the breadcrumb is broadcast so an open tab repaints');
  assert.equal(status.text, recoveryPills.UNANSWERED_BREADCRUMB);
  assert.deepEqual(status.quickReplies,
    ['Make the leaderboard sort by score', "What's the current state?"]);
});

test('backfill: the missed-reply breadcrumb is not posted twice across boots', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 6, pr_number: null, spec_md: null }],
    lastRows: { 6: { id: 60, role: 'user', content: 'Make it blue', metadata: {} } },
    newestSystem: { 6: { content: recoveryPills.UNANSWERED_BREADCRUMB } },
  });
  await restoreMissingQuickReplies({});
  assert.deepEqual(writes(backfillPool), [], 'a second boot must not duplicate the breadcrumb');
});

test('backfill: a question turn is skipped (answer chips take precedence)', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 7, pr_number: null, spec_md: null }],
    lastRows: {
      7: {
        id: 70, role: 'assistant', content: '1. Which header?',
        metadata: { suggestions: [{ question: 'Which header?', answers: ['The top bar'] }] },
      },
    },
  });
  await restoreMissingQuickReplies({});
  assert.deepEqual(writes(backfillPool), []);
});

test('backfill: a busy session is skipped before any read of its messages', async () => {
  backfillPool = makeBackfillPool({
    sessions: [{ id: 8, pr_number: 9, spec_md: null }],
    lastRows: { 8: { id: 80, role: 'assistant', content: 'x', metadata: {} } },
  });
  activeWorkersSvc.activeWorkers.add(8);
  try {
    await restoreMissingQuickReplies({});
  } finally {
    activeWorkersSvc.activeWorkers.delete(8);
  }
  assert.deepEqual(writes(backfillPool), [], 'a live consumer will post its own breadcrumb');
  assert.equal(
    backfillPool.calls.filter((c) => /role IN \('user', 'assistant'\)/.test(c.sql)).length,
    0,
    'the busy guard short-circuits before the per-session reads'
  );
});

test('backfill: the candidate query is bounded and excludes in-flight/headless rows', async () => {
  backfillPool = makeBackfillPool({ sessions: [] });
  await restoreMissingQuickReplies({});
  const q = backfillPool.calls[0];
  assert.match(q.sql, /status IN \('active', 'promoted'\)/);
  assert.match(q.sql, /is_headless = FALSE/);
  assert.match(q.sql, /active_turn IS NULL/);
  assert.match(q.sql, /last_activity_at > NOW\(\) - make_interval/);
  assert.match(q.sql, /LIMIT \$2/);
  assert.deepEqual(q.params, [7, 200]);
});

test('backfill: one failing session does not abort the sweep', async () => {
  const pool = makeBackfillPool({
    sessions: [{ id: 9, pr_number: 1, spec_md: null }, { id: 10, pr_number: 2, spec_md: null }],
    lastRows: {
      9: { id: 90, role: 'assistant', content: 'a', metadata: {} },
      10: { id: 100, role: 'assistant', content: 'b', metadata: {} },
    },
  });
  const realQuery = pool.query;
  pool.query = async (sql, params = []) => {
    if (/UPDATE chat_session_messages/i.test(String(sql)) && params[1] === 90) {
      pool.calls.push({ sql: String(sql), params, threw: true });
      throw new Error('boom');
    }
    return realQuery(sql, params);
  };
  backfillPool = pool;
  await restoreMissingQuickReplies({});
  const patched = pool.calls.filter((c) => /UPDATE chat_session_messages/i.test(c.sql));
  assert.equal(patched.length, 2, 'both sessions were attempted');
  assert.equal(patched[0].threw, true, 'the first session threw mid-write');
  assert.equal(patched[1].params[1], 100, 'the second session was still repaired');
});
