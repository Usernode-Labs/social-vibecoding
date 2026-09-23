// Restart recovery must END an orphaned visual-evidence turn, never resume
// it. The turn's MCP bridge calls back to the pod that dispatched it and
// answers to a run that only existed in that process, so a resumed turn
// retries dead tool calls forever while holding the session busy.
//
// server.js only boots when run as the entry point (require.main guard),
// so requiring it here exposes adoptOrphanWorker without starting servers
// or sweepers. The worker module is stubbed via require.cache BEFORE the
// require so server.js binds the stub.
//
// Run with: node --test tests/evidence-turn-recovery.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5/test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session';
process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt';
require('./platform-keys').setPlatformKeys();

// ── worker stub (must be in place before server.js is required) ─────────

const calls = [];
let kubernetesMode = true;
let runtimeState = 'running';
let executingAfterStop = false;
let inFlightMode = null;
const workerPath = require.resolve('../src/services/worker');
const realWorker = require(workerPath);
require.cache[workerPath].exports = {
  ...realWorker,
  usesKubernetesWorkers: () => kubernetesMode,
  getWorkerStatus: async () => runtimeState,
  getActiveTurnMode: () => inFlightMode,
  adoptWarmWorker: (sessionId, name) => { calls.push(['adoptWarmWorker', sessionId, name]); },
  stopTurn: async (sessionId) => { calls.push(['stopTurn', sessionId]); },
  clearPendingStop: (sessionId) => { calls.push(['clearPendingStop', sessionId]); },
  isWorkerExecuting: async (name) => { calls.push(['isWorkerExecuting', name]); return executingAfterStop; },
  finishTurn: async (sessionId, args) => { calls.push(['finishTurn', sessionId, args]); return true; },
  clearActiveTurn: async (sessionId, args) => { calls.push(['clearActiveTurn', sessionId, args]); return true; },
  destroyWorker: async (name) => { calls.push(['destroyWorker', name]); },
  resumeTurnFromJournal: async () => { calls.push(['resumeTurnFromJournal']); throw new Error('must not resume'); },
  watchWorker: async () => { calls.push(['watchWorker']); throw new Error('must not scrape'); },
};

const agentTurn = require('../src/services/agent-turn');
agentTurn.completeCodexAttempt = async (args) => {
  calls.push(['completeCodexAttempt', args]);
  return { updated: true };
};

// Module-level code in server.js's require graph schedules housekeeping
// timers without unref; unref anything scheduled during the require so
// this test process can exit.
const origSetInterval = global.setInterval;
const origSetTimeout = global.setTimeout;
global.setInterval = (...args) => { const t = origSetInterval(...args); if (t && t.unref) t.unref(); return t; };
global.setTimeout = (...args) => { const t = origSetTimeout(...args); if (t && t.unref) t.unref(); return t; };
let adoptOrphanWorker;
try {
  ({ adoptOrphanWorker } = require('../server'));
} finally {
  global.setInterval = origSetInterval;
  global.setTimeout = origSetTimeout;
}

// ── helpers ─────────────────────────────────────────────────────────────

function makePool(sessionRow) {
  const queries = [];
  return {
    queries,
    query: async (sql, params = []) => {
      queries.push({ sql: String(sql), params });
      if (/SELECT cs\.\*/i.test(String(sql)) && /FROM chat_sessions cs/i.test(String(sql))) {
        return { rows: [sessionRow] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const CODEX_EVIDENCE_TURN = {
  turnId: '00000000-0000-4000-8000-000000004738',
  turnUuid: '10000000-0000-4000-8000-000000004738',
  backend: 'codex_openrouter',
  mode: 'evidence',
  phase: 'executing',
  journal: '/home/node/.claude/turn-1.log',
};

function sessionWith(activeTurn) {
  return {
    id: 4738, status: 'active', is_headless: false, user_id: 1, app_id: 1,
    username: 'alice', app_slug: 'rss-reader', app_name: 'RSS Reader',
    repo_url: 'https://github.com/owner/repo',
    branch_name: 'dev/feature', cc_session_id: 'thread-1',
    active_turn: activeTurn,
  };
}

async function adopt(pool, state) {
  await adoptOrphanWorker(
    { name: 'sv-worker-s4738', sessionId: 4738, state },
    { config: {}, pool, staging: {}, ghub: {}, broadcastGlobal: () => { calls.push(['broadcast']); } },
  );
}

const names = () => calls.map((call) => call[0]);
const noChatRows = (pool) => !pool.queries.some((q) => /INSERT INTO chat_session_messages/i.test(q.sql));

test.beforeEach(() => {
  calls.length = 0;
  kubernetesMode = true;
  runtimeState = 'running';
  executingAfterStop = false;
  inFlightMode = null;
});

test('a running orphaned evidence turn is stopped and terminalized instead of resumed', async () => {
  const pool = makePool(sessionWith(CODEX_EVIDENCE_TURN));
  await adopt(pool, 'running');

  assert.deepEqual(names(), [
    'adoptWarmWorker', 'stopTurn', 'clearPendingStop', 'isWorkerExecuting',
    'completeCodexAttempt', 'finishTurn',
  ]);
  const ledger = calls.find((call) => call[0] === 'completeCodexAttempt')[1];
  assert.equal(ledger.turnUuid, CODEX_EVIDENCE_TURN.turnUuid);
  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.errorCode, 'recovery_abandoned');
  assert.deepEqual(calls.find((call) => call[0] === 'finishTurn').slice(1), [4738, {
    turnId: CODEX_EVIDENCE_TURN.turnId,
    journal: CODEX_EVIDENCE_TURN.journal,
  }]);
  assert.ok(noChatRows(pool), 'evidence turns never narrate into the chat');
});

test('an unconfirmed stop retains the evidence turn for a recovery retry', async () => {
  for (const probe of [true, null]) {
    calls.length = 0;
    executingAfterStop = probe;
    const pool = makePool(sessionWith(CODEX_EVIDENCE_TURN));
    await assert.rejects(adopt(pool, 'running'),
      (error) => error.retainActiveTurn === true && error.retryWorkerRecovery === true);
    assert.ok(!names().some((name) => ['completeCodexAttempt', 'finishTurn', 'clearActiveTurn'].includes(name)),
      'the only pointer to a possibly live agent survives');
  }
});

for (const scenario of [
  { label: 'a missing Kubernetes worker', kubernetes: true, state: 'not_found' },
  { label: 'an exited Docker worker', kubernetes: false, state: 'exited' },
]) {
  test(`${scenario.label} with an evidence turn is cleared without a scrape or narration`, async () => {
    kubernetesMode = scenario.kubernetes;
    runtimeState = scenario.state;
    const claudeTurn = { turnId: 'turn-7', mode: 'evidence', journal: '/home/node/.claude/turn-7.log' };
    const pool = makePool(sessionWith(claudeTurn));
    await adopt(pool, scenario.state);

    assert.deepEqual(names(), ['clearActiveTurn', 'destroyWorker']);
    assert.deepEqual(calls[0].slice(1), [4738, { turnId: 'turn-7', journal: claudeTurn.journal }]);
    assert.ok(noChatRows(pool));
  });
}

test('an evidence turn this process is still executing is left to its own run', async () => {
  inFlightMode = 'evidence';
  const pool = makePool(sessionWith(CODEX_EVIDENCE_TURN));
  await adopt(pool, 'running');

  assert.deepEqual(calls, []);
  assert.ok(noChatRows(pool));
});
