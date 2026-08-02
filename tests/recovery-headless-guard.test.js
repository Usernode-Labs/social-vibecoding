// Tests for #183 — restart recovery must leave headless auto sessions to
// resumeHeadlessRuns for ALL container states:
//
//   1. adoptOrphanWorker with an EXITED headless worker container returns
//      without scraping logs, without clearing active_turn (the journal
//      pointer the cc_running resume needs), without posting the "please
//      retry" message, and without destroying the container.
//   2. adoptOrphanWorker with a RUNNING headless container still registers
//      it warm (pre-existing behavior, now hoisted above the state branch).
//   3. finalizeRecoveredTurn no-ops on a headless session row even when the
//      recovered result pushed a commit — no PR metadata, no staging build,
//      no system message (the belt-and-braces guard for future transports).
//
// server.js only boots when run as the entry point (require.main guard),
// so requiring it here exposes the two recovery internals without starting
// servers or sweepers. The worker module is stubbed via require.cache
// BEFORE the require so server.js binds the stub.
//
// Run with: node --test tests/recovery-headless-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

// loadConfig() (module level in server.js) hard-exits when these are
// missing — provide dummies before the require below.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
// config.load() requires the four separated platform keys (REQUIRED_PROD).
require('./platform-keys').setPlatformKeys();

// ── worker stub (must be in place before server.js is required) ─────────

const workerCalls = [];
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  adoptWarmWorker: (sessionId, name) => { workerCalls.push(['adoptWarmWorker', sessionId, name]); },
  isWorkerExecuting: async () => { workerCalls.push(['isWorkerExecuting']); return false; },
  watchWorker: async (name) => { workerCalls.push(['watchWorker', name]); return {}; },
  stopTurn: async () => { workerCalls.push(['stopTurn']); return false; },
  clearActiveTurn: async (sessionId) => { workerCalls.push(['clearActiveTurn', sessionId]); },
};

// Module-level code in server.js's require graph schedules a couple of
// housekeeping timers (e.g. the auth-rate-limit sweep) without unref —
// harmless in production, but they'd keep this test process alive forever.
// Auto-unref anything scheduled during the require.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let adoptOrphanWorker;
let finalizeRecoveredTurn;
try {
  ({ adoptOrphanWorker, finalizeRecoveredTurn } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

// ── helpers ─────────────────────────────────────────────────────────────

function makePool(sessionRow) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      if (/SELECT cs\.\*/i.test(String(sql)) && /FROM chat_sessions cs/i.test(String(sql))) {
        return { rows: sessionRow ? [sessionRow] : [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeStaging() {
  const calls = [];
  return {
    calls,
    buildAndDeployStaging: async (...args) => {
      calls.push(args);
      return { containerId: 'c', stagingUrl: 'https://x.example', hostname: 'x.example' };
    },
    warmStagingCert: async () => {},
  };
}

const HEADLESS_SESSION = {
  id: 42, status: 'active', is_headless: true, user_id: 1, app_id: 1,
  username: 'alice', app_slug: 'my-app', app_name: 'My App',
  repo_url: 'https://github.com/owner/repo',
  branch_name: 'dev/auto-issue-5-1700000000000',
  active_turn: { mode: 'build', journal: '/turns/turn-1.jsonl' },
  cc_session_id: 'cc-1',
};

test.beforeEach(() => { workerCalls.length = 0; });

// ── 1. exited headless container is left alone ──────────────────────────

test('adoptOrphanWorker leaves an exited headless container to resumeHeadlessRuns', async () => {
  const pool = makePool({ ...HEADLESS_SESSION });
  const staging = makeStaging();
  const broadcasts = [];

  await adoptOrphanWorker(
    { name: 'usernode-worker-42', sessionId: 42, state: 'exited' },
    {
      config: {}, pool, staging, ghub: {},
      broadcastGlobal: (msg) => broadcasts.push(msg),
    }
  );

  // No scrape, no active_turn clear, no container touch — the journal
  // pointer survives for resumeHeadlessRuns' cc_running step.
  assert.deepEqual(workerCalls, []);
  // No "please retry" message and no recovered-turn tail ran.
  assert.ok(!pool.calls.some((c) => /INSERT INTO chat_session_messages/i.test(c.sql)));
  assert.equal(staging.calls.length, 0);
  assert.equal(broadcasts.length, 0);
});

// ── 2. running headless container is still adopted warm ─────────────────

test('adoptOrphanWorker registers a running headless container warm and stops there', async () => {
  const pool = makePool({ ...HEADLESS_SESSION });
  const staging = makeStaging();

  await adoptOrphanWorker(
    { name: 'usernode-worker-42', sessionId: 42, state: 'running' },
    { config: {}, pool, staging, ghub: {}, broadcastGlobal: () => {} }
  );

  assert.deepEqual(workerCalls, [['adoptWarmWorker', 42, 'usernode-worker-42']]);
  assert.equal(staging.calls.length, 0);
  assert.ok(!pool.calls.some((c) => /INSERT INTO chat_session_messages/i.test(c.sql)));
});

// ── 3. finalizeRecoveredTurn guard ──────────────────────────────────────

test('finalizeRecoveredTurn no-ops on headless sessions even when the turn pushed a commit', async () => {
  const pool = makePool(null);
  const staging = makeStaging();
  const emits = [];

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...HEADLESS_SESSION },
    sessionId: 42,
    result: { ahead: 1, sha: 'abcdef1234567890', lastResultText: 'done', sessionId: 'cc-2' },
    repoOwner: 'owner', repoName: 'repo',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-42',
    keepWorker: true,
  });

  // Nothing happened: no PR tail, no staging, no messages, no broadcasts,
  // not even the cc_session_id persist — resumeHeadlessRuns owns the row.
  assert.equal(pool.calls.length, 0);
  assert.equal(staging.calls.length, 0);
  assert.deepEqual(emits, []);
  assert.deepEqual(workerCalls, []);
});

test('finalizeRecoveredTurn still runs the tail for non-headless sessions (guard is scoped)', async () => {
  const pool = makePool(null);
  const staging = makeStaging();
  const emits = [];

  // No changes pushed → the early no-changes return; proves the function
  // proceeds past the headless guard for ordinary sessions.
  const ret = await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...HEADLESS_SESSION, is_headless: false },
    sessionId: 42,
    result: { ahead: 0, sha: null, lastResultText: 'Nothing needed changing.' },
    repoOwner: 'owner', repoName: 'repo',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-42',
    keepWorker: true,
  });

  // #896: the no-changes case now persists the live path's outcome-aware
  // completion row instead of an emit-only "Recovered session produced no
  // changes." that vanished on reload.
  assert.equal(emits.length, 1);
  assert.equal(emits[0].event, 'status');
  assert.equal(emits[0].data.text, 'Claude Code made no changes');
  assert.equal(emits[0].data.ccOutcome, 'no_changes');
  assert.match(ret.summary, /finished without committing any changes/);
});
