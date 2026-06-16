// Tests for the recovery push-heal fix (chat 510 / issue #295).
//
// When a coding turn commits locally but its worker's usernode-push
// callback never lands the branch on GitHub (push_ok=0 — e.g. the
// platform was mid-restart when the worker POSTed
// /api/internal/sessions/:id/push), finalizeRecoveredTurn must re-push
// the branch (while the worker container still exists) BEFORE
// applyPrMetadata's createPR. Otherwise createPR 422s ("No commits
// between main and <branch>") and, once the worker is evicted, the only
// copy of the commit is lost.
//
// server.js only boots under the require.main guard, so requiring it here
// exposes finalizeRecoveredTurn without starting servers. worker and
// pr-metadata are stubbed via require.cache BEFORE the require so
// server.js (and its inline require of pr-metadata) bind the stubs.
//
// Run with: node --test tests/recovered-turn-push-heal.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';

// ── worker stub ─────────────────────────────────────────────────────────
// pushBehavior is mutated per-test to drive success vs failure.
const workerCalls = [];
let pushBehavior = { mode: 'ok', sha: 'newpushedsha0001' };
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  execPushFromWorker: async (sessionId, branch) => {
    workerCalls.push(['execPushFromWorker', sessionId, branch]);
    if (pushBehavior.mode === 'throw') throw new Error('push proxy failed: container gone');
    return { sha: pushBehavior.sha };
  },
};

// ── pr-metadata stub (inline-required by finalizeRecoveredTurn) ──────────
const prMetadataCalls = [];
const prMetadataPath = require.resolve('../src/services/pr-metadata');
const realPrMetadata = require(prMetadataPath);
require.cache[prMetadataPath].exports = {
  ...realPrMetadata,
  applyPrMetadata: async (args) => {
    prMetadataCalls.push(args);
    return { prNumber: 7, prUrl: 'https://example/pr/7', prTitle: 'Recovered change' };
  },
};

// Auto-unref any housekeeping timers scheduled during the require.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...a) => { const t = origSetInterval(...a); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...a) => { const t = origSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
let finalizeRecoveredTurn;
try {
  ({ finalizeRecoveredTurn } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

function makePool() {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql: String(sql), params });
      // The recovered-user-message lookup feeds the PR title helper.
      if (/SELECT content FROM chat_session_messages/i.test(String(sql)) && /role = 'user'/i.test(String(sql))) {
        return { rows: [{ content: 'okay do it' }] };
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
  };
}

const SESSION = {
  id: 510, status: 'active', is_headless: false, user_id: 1, app_id: 1,
  username: 'evan', app_slug: 'usernode-2d5619', app_name: 'Usernode',
  repo_url: 'https://github.com/Usernode-Labs/social-vibecoding',
  branch_name: 'dev/evan-1781527910307',
  cc_session_id: 'cc-1',
};

const sysMsgInserted = (pool) =>
  pool.calls.some((c) => /INSERT INTO chat_session_messages/i.test(c.sql) &&
    /could not be pushed/i.test(String(c.params[1] || '')));

test.beforeEach(() => {
  workerCalls.length = 0;
  prMetadataCalls.length = 0;
  pushBehavior = { mode: 'ok', sha: 'newpushedsha0001' };
});

test('re-pushes an un-pushed recovered branch before creating the PR', async () => {
  const pool = makePool();
  const staging = makeStaging();
  const emits = [];

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'localonlysha12345', pushOk: false, lastResultText: 'done', sessionId: 'cc-2' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-510',
    keepWorker: true,
  });

  // The branch is re-pushed first, with the session's canonical branch.
  assert.deepEqual(
    workerCalls.find((c) => c[0] === 'execPushFromWorker'),
    ['execPushFromWorker', 510, 'dev/evan-1781527910307']
  );
  // Then the normal PR + staging tail runs.
  assert.equal(prMetadataCalls.length, 1);
  assert.equal(staging.calls.length, 1);
  // No "could not push" warning when the re-push succeeds.
  assert.ok(!sysMsgInserted(pool));
});

test('skips PR creation and warns the user when the re-push fails', async () => {
  pushBehavior = { mode: 'throw' };
  const pool = makePool();
  const staging = makeStaging();
  const emits = [];

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'localonlysha12345', pushOk: false, lastResultText: 'done', sessionId: 'cc-2' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: (event, data) => emits.push({ event, data }),
    containerName: 'usernode-worker-510',
    keepWorker: false,
  });

  // Push was attempted, but the doomed createPR is NOT.
  assert.ok(workerCalls.some((c) => c[0] === 'execPushFromWorker'));
  assert.equal(prMetadataCalls.length, 0);
  assert.equal(staging.calls.length, 0);
  // The user is told the truth, and the worker is reaped (keepWorker:false).
  assert.ok(sysMsgInserted(pool));
  assert.ok(emits.some((e) => e.event === 'status' && /could not push/i.test(e.data.text)));
  assert.ok(workerCalls.some((c) => c[0] === 'destroyWorker'));
});

test('does not re-push when the turn already pushed (pushOk:true)', async () => {
  const pool = makePool();
  const staging = makeStaging();

  await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
    sessionId: 510,
    result: { ahead: 1, sha: 'pushedsha000123', pushOk: true, lastResultText: 'done', sessionId: 'cc-2' },
    repoOwner: 'Usernode-Labs', repoName: 'social-vibecoding',
    emit: () => {},
    containerName: 'usernode-worker-510',
    keepWorker: true,
  });

  assert.ok(!workerCalls.some((c) => c[0] === 'execPushFromWorker'));
  assert.equal(prMetadataCalls.length, 1);
  assert.equal(staging.calls.length, 1);
});
