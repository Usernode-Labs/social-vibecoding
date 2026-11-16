'use strict';

// What restart recovery says when a coding turn could not be resumed
// (services/turn-recovery.js adoptOrphanWorker): one breadcrumb, persisted
// and broadcast, in words that never name the restart (#896); the shape it
// came from is kept in metadata for operators. And a sync turn an older
// release dispatched is handed back to the merge queue rather than told
// about in chat.
//
// server.js only boots under the require.main guard, so requiring it here
// exposes adoptOrphanWorker without starting servers. worker and ws are
// stubbed via require.cache BEFORE the require so server.js binds the stubs.
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
// config.load() requires the four separated platform keys (REQUIRED_PROD).
require('./platform-keys').setPlatformKeys();

// ── worker stub ─────────────────────────────────────────────────────────
// isWorkerExecuting returns `true` so adoptOrphanWorker takes the mid-exec
// "kill the orphan exec" branch; flipped per-test where needed.
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
  clearActiveTurn: async () => true,
};

// ── ws stub (the breadcrumb's status event goes out on it) ──────────────
const broadcasts = [];
const wsPath = require.resolve('../src/services/ws');
const realWs = require(wsPath);
require.cache[wsPath].exports = {
  ...realWs,
  broadcastGlobal: (msg) => { broadcasts.push(msg); },
};

// ── db/pool stub: nothing here reads the shared pool ────────────────────
const poolPath = require.resolve('../src/db/pool');
const realPool = require(poolPath);
require.cache[poolPath].exports = {
  ...realPool,
  getPool: () => null,
};

const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let adoptOrphanWorker;
try {
  ({ adoptOrphanWorker } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

const SERVER_SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')
  // With what a turn's recovery runs, moved out of server.js unchanged
  // (services/turn-recovery.js).
  + fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'turn-recovery.js'), 'utf8');

// The one sentence every unresumable shape shows (turn-recovery.js
// TURN_UNFINISHED_BREADCRUMB).
const TURN_UNFINISHED = "That coding turn didn't finish. Please send your request again.";

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

test('a turn killed mid-exec leaves one breadcrumb, persisted and broadcast', async () => {
  workerExecuting = true;
  const pool = makeAdoptPool({ ...SESSION });
  await adoptOrphanWorker(
    { name: 'usernode-worker-77', sessionId: 77, state: 'running' },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: (m) => broadcasts.push(m) }
  );

  const rows = insertedRows(pool.calls);
  assert.equal(rows.length, 1, 'one breadcrumb posted');
  assert.equal(rows[0].content, TURN_UNFINISHED);
  // #896: same user-facing text for every unresumable shape; the shape
  // itself is preserved in metadata for operators.
  assert.equal(rows[0].metadata.recoveredReason, 'mid_exec_killed');
  assert.equal(rows[0].metadata.recovered, true);

  const status = broadcasts.find((b) => b.event === 'status');
  assert.ok(status, 'a status event was broadcast');
  assert.equal(status.text, TURN_UNFINISHED, 'the live tab reads it without a reload');
});

test('a turn whose worker is gone leaves the same breadcrumb', async () => {
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
  const gone = rows.find((r) => r.metadata.recoveredReason === 'worker_gone');
  assert.ok(gone, 'the worker-gone breadcrumb was posted');
  assert.equal(gone.content, TURN_UNFINISHED);
  assert.equal(gone.metadata.recovered, true);
});

// ── 2. resumeDetachedTurnInner (source-invariant) ──────────────────────
//
// It lives behind boot-only code that would need the journal transport and
// the notification stack stubbed to drive end to end; assert the wiring at
// the source level instead, which is what would regress.

// #896: a sync turn is system work with no reply in chat. What it does owe
// is the follow-through of the older release's merge-queue pass that
// dispatched it and died with that process: take back the 'integrating'
// that pass recorded, and ask the app's merge queue (the workflow machine)
// to look again so the merge attempt happens. (A sync the proposal machine
// ran is followed by its own work item and never reaches this branch.)
// Without that, the card said "bringing up to date with main" until an
// unrelated trigger came by, and a proposal whose verdict carried onto the
// merged head had no trigger left at all.
test('a recovered sync turn says nothing in chat, and hands back to the integration queue', () => {
  assert.match(SERVER_SRC, /recoveryActiveTurn\.mode === 'sync'/,
    'sync mode is branched explicitly, not lumped in with build');
  const start = SERVER_SRC.indexOf("recoveryActiveTurn.mode === 'sync'");
  const branch = SERVER_SRC.slice(start, SERVER_SRC.indexOf('} else {', start));
  assert.match(branch, /Recovered an older release\\'s sync turn; asking the merge queue to look again/,
    'the sync branch is logged rather than surfaced in chat');
  assert.doesNotMatch(branch, /INSERT INTO chat_session_messages/, 'and writes no chat row');
  assert.match(branch, /setBlockReasons\(pool, sessionId, \[\]\)/,
    "the dead pass's 'integrating' is taken back");
  assert.match(branch, /wantMerge\(\{ appId: session\.app_id, sessionId, reason: 'recovered-sync' \}\)/,
    'and the app\'s merge queue is asked so the merge attempt follows the sync');
});

// The whole point of #896: the restart stops being something the user
// reads about. It survives in logs and in metadata.recovered instead.
test('no user-facing recovery string names the restart', () => {
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  const files = {
    'server.js': SERVER_SRC,
    'src/services/staging-recovery.js': fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'staging-recovery.js'), 'utf8'),
  };
  for (const [name, src] of Object.entries(files)) {
    const code = stripComments(src);
    for (const banned of [/recovered after/i, /after a platform restart/i, /after restart/i]) {
      assert.doesNotMatch(code, banned,
        `${name} still ships the pre-#896 restart wording — chat rows must not mention it`);
    }
  }
});
