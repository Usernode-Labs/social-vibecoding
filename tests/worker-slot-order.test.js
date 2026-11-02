'use strict';

// B15's race, in the other two flows that run a bot turn on a session of
// their own (overnight audit, 1 Nov 2026; runTriage's own order is pinned in
// tests/homeroom-bot.test.js). A session put back at rest owes its worker's
// removal as durable work (the proposal machine's worker.destroy). A flow
// that ensured the worker before taking the slot took a worker still up as
// warm, then lost it to that removal: "execInWorker: no warm worker
// registered". Taking the slot first cancels a removal still owed and waits
// for one under way, so each flow takes the slot, then ensures its worker,
// and a worker that cannot start puts the session back at rest.

const test = require('node:test');
const assert = require('node:assert/strict');

const sessionLifecycle = require('../src/services/session-lifecycle');
const live = require('../src/services/homeroom-bot-live');

function record(t) {
  const moves = [];
  const { takeSlot, restSession } = sessionLifecycle;
  const ensure = live.ensureBuildWorker;
  t.after(() => {
    sessionLifecycle.takeSlot = takeSlot;
    sessionLifecycle.restSession = restSession;
    live.ensureBuildWorker = ensure;
  });
  sessionLifecycle.takeSlot = async ({ sessionId }) => { moves.push(['takeSlot', sessionId]); return true; };
  sessionLifecycle.restSession = async ({ sessionId }) => { moves.push(['restSession', sessionId]); return true; };
  const failing = async ({ session }) => { moves.push(['ensureWorker', session.id]); throw new Error('quota'); };
  live.ensureBuildWorker = failing;
  return { moves, failing };
}

test('a bench trial\'s turn takes its slot, then ensures its worker, and rests when the worker cannot start', async (t) => {
  const { moves } = record(t);
  const { runTurn } = require('../src/services/bench/runner');
  const out = await runTurn({
    pool: { query: async () => { throw new Error('no query before the worker'); } },
    config: {}, user: { id: 1 }, session: { id: 41, branch_name: 'bench/t1' }, repo: { owner: 'o', repo: 'r' },
    prompt: 'x', mode: 'build', model: 'm', budgetMs: 1000, deps: { worker: {}, sessions: {}, agentTurn: {} },
  });
  assert.deepEqual(moves, [['takeSlot', 41], ['ensureWorker', 41], ['restSession', 41]]);
  assert.equal(out.infra, true);
  assert.match(out.routed.error, /^worker: quota/);
});

test('a look takes its slot, then ensures its worker, and rests when the worker cannot start', async (t) => {
  const { moves, failing } = record(t);
  const { lookInto } = require('../src/services/homeroom-bot-thread-tools/look-into');
  const pool = {
    async query(sql) {
      if (/FROM homeroom_bot_look_sessions l/.test(sql)) return { rows: [{ id: 77, branch_name: 'main', status: 'paused' }] };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const out = await lookInto(pool, {}, {
    user: { id: 5 }, app: { id: 9, slug: 'rota', name: 'Rota', repo_url: 'https://github.com/o/rota.git' }, question: 'Why?',
    deps: {
      bot: { id: 900 }, settings: {}, model: 'm', worker: {}, agentTurn: {}, sessions: {},
      live: { recipeHarness: () => 'auto', ensureBuildWorker: failing },
    },
  });
  assert.deepEqual(moves, [['takeSlot', 77], ['ensureWorker', 77], ['restSession', 77]]);
  assert.equal(out.ok, false);
  assert.equal(out.code, 'worker');
});
