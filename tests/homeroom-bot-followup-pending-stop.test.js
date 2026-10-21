'use strict';

// A stop left pending by an earlier turn never skips a Homeroom bot
// follow-up (#937's pending stop; #4579 did the same for reads).
//
// Change 7490 (9 Oct 2026): a person wrote to the bot twice. The first
// follow-up ran out its 20-minute budget and was stopped; the stop stayed
// pending on the proposal's session, and the second follow-up, three seconds
// later, was skipped the moment it started ("Dispatch skipped — stop
// requested during spin-up"). Its record was then left behind as well
// (worker.releaseSkippedDispatch, tests/worker-stop-turn.test.js), and the
// proposal read as running for good.
//
// The follow-up used to clear that flag itself before it dispatched. Its
// turn is now a durable step of its look, and its dispatch names the work
// item that runs it (`owner`). For such a turn the worker never reads this
// process's pending-stop flag (worker.execInWorker): a Stop is an event to
// its machine, stamped on the durable record. So the follow-up clears
// nothing, and the flag cannot skip it.
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

const OWNER = Object.freeze({ machine: 'bot-request', key: 'request:1:4554', kind: 'bot.look' });

function harness({ taken = false } = {}) {
  const order = [];
  const worker = {
    async ensureWorkerImage() {},
    async ensureWorker() { return 'usernode-worker-7490'; },
    clearPendingStop: (id) => order.push(['clear', id]),
    async execInWorker(id, opts) { order.push(['exec', id, opts.owner || null]); return { exitCode: 0, execExitSeen: true }; },
    async stopTurn() {},
  };
  const deps = {
    worker,
    sessionTaken: async () => taken,
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
    owner: OWNER,
  });
  return { order, run };
}

test('a follow-up dispatches as its look\'s work item, so no leftover stop can skip it, and it clears nothing', async () => {
  const { order, run } = harness();
  const out = await run();
  assert.ok(!out.routed?.error, JSON.stringify(out.routed));
  assert.deepEqual(order, [['exec', 7490, OWNER]],
    'the dispatch names its owner (the worker reads no pending-stop flag for it), and no flag is touched');
});

test('a follow-up waits, and clears nothing, while somebody else works on the proposal', async () => {
  const { order, run } = harness({ taken: true });
  const out = await run();
  assert.equal(out.routed?.error, 'session_busy');
  assert.deepEqual(order, [], 'nothing is dispatched and a stop aimed at the running turn is left alone');
});
