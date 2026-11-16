// Restart recovery of a coding worker nothing carries any more
// (services/turn-recovery.js adoptOrphanWorker, finalizeRecoveredTurn):
//
//   1. a gone Codex worker terminalizes its ledger attempt before the
//      durable cleanup clears the turn's only recovery pointer, and keeps
//      ownership when the ledger cannot be reached;
//   2. a recovered turn that committed nothing still writes the
//      outcome-aware completion card (#896);
//   3. on Kubernetes, a worker whose state cannot be read keeps its state
//      for a retry without falling back to Docker, and a missing worker
//      never enters legacy log recovery.
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
let kubernetesMode = false;
let runtimeState = 'running';
let executing = false;
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => kubernetesMode,
  getWorkerStatus: async () => { if (runtimeState instanceof Error) throw runtimeState; return runtimeState; },
  destroyWorker: async (name) => { workerCalls.push(['destroyWorker', name]); },
  adoptWarmWorker: (sessionId, name) => { workerCalls.push(['adoptWarmWorker', sessionId, name]); },
  isWorkerExecuting: async () => { workerCalls.push(['isWorkerExecuting']); return executing; },
  watchWorker: async (name) => { workerCalls.push(['watchWorker', name]); return {}; },
  stopTurn: async () => { workerCalls.push(['stopTurn']); return false; },
  clearActiveTurn: async (sessionId, args) => {
    workerCalls.push(['clearActiveTurn', sessionId, args]);
    return true;
  },
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
    verifyStagingEdge: async () => {},
  };
}

const SESSION = {
  id: 42, status: 'active', is_headless: false, user_id: 1, app_id: 1,
  username: 'alice', app_slug: 'my-app', app_name: 'My App',
  repo_url: 'https://github.com/owner/repo',
  branch_name: 'dev/alice-1700000000000',
  active_turn: { mode: 'build', journal: '/turns/turn-1.jsonl' },
  cc_session_id: 'cc-1',
};

test.beforeEach(() => { workerCalls.length = 0; });

test('gone Codex worker terminalizes its attempt before durable cleanup', async () => {
  const agentTurn = require('../src/services/agent-turn');
  const originalComplete = agentTurn.completeCodexAttempt;
  agentTurn.completeCodexAttempt = async (args) => {
    workerCalls.push(['completeCodexAttempt', args]);
    return { updated: true };
  };
  const activeTurn = {
    turnId: '00000000-0000-4000-8000-000000000042',
    turnUuid: '10000000-0000-4000-8000-000000000042',
    backend: 'codex_openrouter',
    phase: 'executing',
    journal: '/turns/turn-42.jsonl',
    tail: {},
  };
  const pool = makePool({
    ...SESSION,
    active_turn: activeTurn,
  });
  try {
    await adoptOrphanWorker(
      { name: 'usernode-worker-42', sessionId: 42, state: 'exited' },
      { config: {}, pool, staging: makeStaging(), ghub: {}, broadcastGlobal: () => {} },
    );

    const completeIndex = workerCalls.findIndex((call) => call[0] === 'completeCodexAttempt');
    const clearIndex = workerCalls.findIndex((call) => call[0] === 'clearActiveTurn');
    assert.ok(completeIndex >= 0 && completeIndex < clearIndex,
      'the ledger reaches a terminal state before its only recovery pointer is cleared');
    const completeArgs = workerCalls[completeIndex][1];
    assert.equal(completeArgs.turnUuid, activeTurn.turnUuid);
    assert.equal(completeArgs.status, 'failed');
    assert.equal(completeArgs.errorCode, 'recovery_abandoned');
    assert.deepEqual(workerCalls[clearIndex].slice(1), [42, {
      turnId: activeTurn.turnId,
      journal: activeTurn.journal,
    }]);
  } finally {
    agentTurn.completeCodexAttempt = originalComplete;
  }
});

test('gone Codex worker retains ownership when ledger terminalization is transiently unavailable', async () => {
  const agentTurn = require('../src/services/agent-turn');
  const originalComplete = agentTurn.completeCodexAttempt;
  const ledgerError = new Error('ledger database unavailable');
  agentTurn.completeCodexAttempt = async () => { throw ledgerError; };
  const activeTurn = {
    turnId: '00000000-0000-4000-8000-000000000043',
    turnUuid: '10000000-0000-4000-8000-000000000043',
    backend: 'codex_openrouter',
    phase: 'executing',
    journal: '/turns/turn-43.jsonl',
    tail: {},
  };
  const pool = makePool({
    ...SESSION,
    id: 43,
    active_turn: activeTurn,
  });
  try {
    await assert.rejects(
      adoptOrphanWorker(
        { name: 'usernode-worker-43', sessionId: 43, state: 'exited' },
        { config: {}, pool, staging: makeStaging(), ghub: {}, broadcastGlobal: () => {} },
      ),
      ledgerError,
    );
    assert.equal(ledgerError.retainActiveTurn, true);
    assert.ok(!workerCalls.some((call) => call[0] === 'clearActiveTurn'),
      'cleanup cannot erase the attempt pointer before a retry succeeds');
  } finally {
    agentTurn.completeCodexAttempt = originalComplete;
  }
});

test('finalizeRecoveredTurn writes the completion card for a turn that committed nothing', async () => {
  const pool = makePool(null);
  const staging = makeStaging();
  const emits = [];

  // No changes pushed → the early no-changes return.
  const ret = await finalizeRecoveredTurn({
    config: {}, pool, staging,
    session: { ...SESSION },
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
  assert.equal(ret, 'done');
});


for (const scenario of ['probe-failure', 'not-ready', 'api-failure']) {
  test(`Kubernetes orphan recovery retains state on ${scenario} without Docker fallback`, async (t) => {
    kubernetesMode = true;
    executing = scenario === 'probe-failure' ? null : false;
    runtimeState = scenario === 'not-ready' ? 'created' : scenario === 'api-failure' ? new Error('API unavailable') : 'running';
    t.after(() => { kubernetesMode = false; executing = false; runtimeState = 'running'; });
    workerCalls.length = 0;
    const pool = makePool({ ...SESSION, active_turn: null });
    const deps = { config: {}, pool, staging: makeStaging(), ghub: {}, broadcastGlobal: () => {} };
    const orphan = { name: 'sv-worker-s42', sessionId: 42, state: 'created' };
    await assert.rejects(adoptOrphanWorker(orphan, deps), error => error.retainActiveTurn && error.retryWorkerRecovery);
    assert.ok(!workerCalls.some(c => ['watchWorker', 'destroyWorker', 'clearActiveTurn', 'stopTurn'].includes(c[0])));
    assert.ok(!pool.calls.some(c => /UPDATE|INSERT|DELETE/.test(c.sql)));
    // The original startup snapshot remains 'created'; recovery must use
    // the fresh API state rather than retrying that stale snapshot forever.
    runtimeState = 'running'; executing = false;
    await adoptOrphanWorker(orphan, deps);
    assert.ok(workerCalls.some(c => c[0] === 'adoptWarmWorker'));
    assert.ok(!workerCalls.some(c => c[0] === 'watchWorker'));
  });
}

test('a missing Kubernetes worker never enters legacy log recovery', async (t) => {
  kubernetesMode = true; runtimeState = 'not_found';
  t.after(() => { kubernetesMode = false; runtimeState = 'running'; });
  workerCalls.length = 0;
  const pool = makePool({ ...SESSION, active_turn: null });
  await adoptOrphanWorker({ name: 'sv-worker-s42', sessionId: 42, state: 'created' },
    { config: {}, pool, staging: makeStaging(), ghub: {}, broadcastGlobal: () => {} });
  assert.ok(!workerCalls.some(c => c[0] === 'watchWorker'));
  assert.ok(!pool.calls.some(c => /INSERT/.test(c.sql)), 'do not invent a completed turn');
});
