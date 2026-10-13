'use strict';

// A Homeroom bot follow-up clears a stop left pending by an earlier turn
// before it dispatches (#937's pending stop; #4579 did the same for reads).
//
// Change 7490 (9 Oct 2026): a person wrote to the bot twice. The first
// follow-up ran out its 20-minute budget and was stopped; the stop stayed
// pending on the proposal's session, and the second follow-up, three seconds
// later, was skipped the moment it started ("Dispatch skipped — stop
// requested during spin-up"). Its record was then left behind as well
// (worker.releaseSkippedDispatch, tests/worker-stop-turn.test.js), and the
// proposal read as running for good.
//
// Run with: node --test tests/homeroom-bot-followup-pending-stop.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

function stub(id, exports) {
  const original = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: original ? original.paths : [] };
}
const noop = () => {};
stub(require.resolve('../src/services/logger'), { info: noop, warn: noop, error: noop, debug: noop });
const followup = require('../src/services/homeroom-bot-followup');

function harness({ inFlight = false } = {}) {
  const order = [];
  const worker = {
    async ensureWorkerImage() {},
    async ensureWorker() { return 'usernode-worker-7490'; },
    isInFlight: () => inFlight,
    clearPendingStop: (id) => order.push(['clear', id]),
    async execInWorker(id) { order.push(['exec', id]); return { exitCode: 0, execExitSeen: true }; },
    async stopTurn() {},
  };
  const deps = {
    worker,
    activeWorkers: new Set(),
    shotsRunFor: () => null,
    agentTurn: { resolveCodexRuntimeContext: async () => ({}) },
    sessions: {
      async runCodexAttemptLoop({ dispatchOnce }) {
        const result = await dispatchOnce({ logicalTurnId: 'turn-7490' });
        return { result };
      },
    },
  };
  const pool = { async query() { return { rows: [], rowCount: 0 }; } };
  const run = () => followup.runFollowUpTurn({
    pool, config: {}, bot: { id: 1 }, repo: { owner: 'o', repo: 'r' },
    session: { id: 7490, branch_name: 'dev/homeroom_bot-7490', agent_model: 'glm' },
    prompt: 'answer them', mode: 'build', issueNumber: 4554, turnBudgetMs: 60_000, model: 'glm', deps,
  });
  return { order, run };
}

test('a follow-up clears a leftover stop before it dispatches', async () => {
  const { order, run } = harness();
  const out = await run();
  assert.ok(!out.routed?.error, JSON.stringify(out.routed));
  assert.deepEqual(order, [['clear', 7490], ['exec', 7490]],
    'the stop pending from the turn before is cleared first, so this turn is not skipped');
});

test('a follow-up waits, and clears nothing, while a turn runs on the proposal', async () => {
  const { order, run } = harness({ inFlight: true });
  const out = await run();
  assert.equal(out.routed?.error, 'session_busy');
  assert.deepEqual(order, [], 'a stop aimed at the running turn is left alone');
});
