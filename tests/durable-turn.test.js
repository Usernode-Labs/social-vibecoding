'use strict';

// A coding turn as a durable step (src/services/durable-turn.js): attach to
// it, or start it (docs/plans/bot-build-workflow.md, "Turns: attach or
// start"). A turn keeps going in its worker while nobody watches, so the
// step's next attempt, after a restart, must follow the turn it caught
// rather than start a second one, take the result it kept, read a turn that
// landed with its record lost off the branch, and start the turn again only
// when nothing says it ran.
//
// The worker, the ledger and the session row are stubbed; each test plays
// the work item's part (`checkpoint` keeps what was saved).
//
// Run with: node --test tests/durable-turn.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const durableSteps = require('../src/services/durable-steps');
const durableTurn = require('../src/services/durable-turn');

const SESSION = { id: 41, branch_name: 'dev/bot-41' };

// `again()` is the next attempt: a new claim, with its own signal.
function item(resumeFrom = null) {
  const saves = [];
  const ac = new AbortController();
  const make = (from, signal) => durableSteps.durable({
    resumeFrom: from, signal, checkpoint: async (v) => { saves.push(v); },
  });
  return {
    saves, ac, steps: make(resumeFrom, ac.signal), last: () => saves[saves.length - 1] || null,
    again: () => make(saves[saves.length - 1] || null, new AbortController().signal),
  };
}

// A session row whose active_turn is `turn` (null: no record).
function pool(turn = null) {
  const queries = [];
  return {
    queries,
    turn,
    async query(sql, params) {
      queries.push(sql);
      if (/SELECT active_turn FROM chat_sessions/.test(sql)) return { rows: [{ active_turn: this.turn }] };
      if (/'\{restarts\}'/.test(sql)) return { rows: this.turn ? [{ restarts: (Number(this.turn.restarts) || 0) + 1 }] : [] };
      if (/SUM\(estimated_cost_usd\)/.test(sql)) return { rows: [{ cost: null }] };
      throw new Error(`unexpected query: ${sql.slice(0, 60)} ${JSON.stringify(params)}`);
    },
  };
}

function fakeWorker(journalResult = {}) {
  const calls = [];
  return {
    calls,
    async resumeTurnFromJournal(sessionId, opts) { calls.push(['resume', sessionId, opts.turnId]); return journalResult; },
    async markTurnTail(sessionId) { calls.push(['tail', sessionId]); },
    async finishTurn(sessionId, ids) { calls.push(['finish', sessionId, ids.turnId]); return true; },
    async execPushFromWorker(sessionId, branch) { calls.push(['push', sessionId, branch]); return { sha: 'pushed' }; },
  };
}

const agentTurn = {
  async persistRecoveredAgentThread() {},
  async settleRecoveredAgentAttempt() { return { estimatedCost: { estimatedCostUsd: 0.25 } }; },
  async completeCodexAttempt() {},
};

test('with the inert context the turn is dispatched and timed as before, and nothing is kept', async () => {
  let asked = null;
  const out = await durableTurn.runTurn(durableSteps.none(), 'build', {
    pool: pool(), session: SESSION, mode: 'build', budgetMs: 1000,
    dispatch: async (extra) => { asked = extra; return { result: { pushOk: true } }; },
    deps: { worker: fakeWorker() },
  });
  assert.deepEqual(asked, {}, 'no record is held: the dispatch is as it always was');
  assert.deepEqual(out, { routed: { result: { pushOk: true } }, stopped: false, followed: false });
});

test('the clock stops a turn that runs past its budget', async () => {
  let stops = 0;
  const out = await durableTurn.runTurn(durableSteps.none(), 'build', {
    pool: pool(), session: SESSION, mode: 'build', budgetMs: 10,
    stop: () => { stops += 1; },
    dispatch: () => new Promise((resolve) => { setTimeout(() => resolve({ result: {} }), 60); }),
    deps: { worker: fakeWorker() },
  });
  assert.equal(stops, 1);
  assert.equal(out.stopped, true);
});

test('a durable turn is saved as started, then with its record, then done, and only then is its record released', async () => {
  const w = item();
  const worker = fakeWorker();
  const heard = [];
  w.steps.listen((e) => { heard.push(e.kind); });
  const out = await durableTurn.runTurn(w.steps, 'build', {
    pool: pool(), session: SESSION, mode: 'build', budgetMs: 60000,
    head: async () => 'base-sha',
    dispatch: async (extra) => {
      assert.equal(extra.holdTurnRecord, true, 'the record is held for the step to release');
      await extra.onTurnRecord({ turnId: 't-1', journal: '/j/1' });
      assert.equal(worker.calls.length, 0, 'not released while the turn runs');
      return { result: { pushOk: true, sha: 'new', ahead: 1, lastResultText: 'built' }, estimatedCostUsd: 0.5 };
    },
    deps: { worker },
  });
  assert.equal(out.followed, false);
  assert.equal(out.routed.result.sha, 'new');
  const phases = w.saves.map((s) => s['turn:build']?.phase);
  assert.deepEqual(phases, ['started', 'started', 'done']);
  assert.equal(w.saves[0]['turn:build'].headBefore, 'base-sha');
  assert.ok(w.saves[0]['turn:build'].deadlineAt > Date.now(), 'its deadline is kept');
  assert.deepEqual(w.saves[1]['turn:build'].record, { turnId: 't-1', journal: '/j/1' });
  assert.deepEqual(worker.calls, [['finish', 41, 't-1']], 'released once its result was saved');
  assert.deepEqual(heard, ['turn_start']);
});

test('the next attempt takes a kept result as it is and releases the record again', async () => {
  const w = item();
  await durableTurn.runTurn(w.steps, 'spec', {
    pool: pool(), session: SESSION, mode: 'scout', budgetMs: 60000,
    dispatch: async (extra) => { await extra.onTurnRecord({ turnId: 't-2', journal: '/j/2' }); return { result: { lastResultText: 'the plan' } }; },
    deps: { worker: fakeWorker() },
  });
  const worker = fakeWorker();
  let dispatched = false;
  const out = await durableTurn.runTurn(w.again(), 'spec', {
    pool: pool(), session: SESSION, mode: 'scout', budgetMs: 60000,
    dispatch: async () => { dispatched = true; return {}; },
    deps: { worker },
  });
  assert.equal(dispatched, false, 'no second turn');
  assert.equal(out.kept, true);
  assert.equal(out.routed.result.lastResultText, 'the plan');
  assert.deepEqual(worker.calls, [['finish', 41, 't-2']]);
});

test('a turn a restart caught is followed through its journal, not started again', async () => {
  // The first attempt: its record saved, then the restart.
  const w = item();
  const first = durableTurn.runTurn(w.steps, 'build', {
    pool: pool(), session: SESSION, mode: 'build', budgetMs: 60000,
    dispatch: async (extra) => {
      await extra.onTurnRecord({ turnId: 't-3', journal: '/j/3' });
      return new Promise(() => {});
    },
    deps: { worker: fakeWorker() },
  });
  await new Promise((r) => { setImmediate(r); });
  w.ac.abort();
  await assert.rejects(first, (err) => durableSteps.isStopped(err), 'the stop leaves the turn to the next owner');
  assert.equal(w.last()['turn:build'].phase, 'started');

  const turn = { turnId: 't-3', journal: '/j/3', mode: 'build', phase: 'executing', startedAt: new Date().toISOString() };
  const worker = fakeWorker({ pushOk: true, sha: 'landed', ahead: 2, lastResultText: 'done', exitCode: 0, providerDispatched: true });
  const next = w.again();
  const heard = [];
  next.listen((e) => { heard.push(`${e.kind} ${e.key}`); });
  let dispatched = false;
  const out = await durableTurn.runTurn(next, 'build', {
    pool: pool(turn), session: SESSION, mode: 'build', budgetMs: 60000,
    dispatch: async () => { dispatched = true; return {}; },
    deps: { worker, agentTurn },
  });
  assert.equal(dispatched, false, 'the turn was not dispatched a second time');
  assert.equal(out.followed, true);
  assert.equal(out.routed.result.sha, 'landed');
  assert.equal(out.routed.estimatedCostUsd, 0.25, 'its ledger attempt is settled');
  assert.deepEqual(worker.calls.map((c) => c[0]), ['resume', 'tail', 'finish']);
  assert.deepEqual(heard, ['turn_follow turn:build', 'turn_followed turn:build']);
  assert.equal(w.last()['turn:build'].phase, 'done');
});

test('a followed build turn whose commit the restart kept from being pushed is pushed from its worker', async () => {
  const w = item({ 'turn:build': { phase: 'started', mode: 'build', deadlineAt: Date.now() + 60000, headBefore: 'base', record: { turnId: 't-4', journal: '/j/4' } } });
  const turn = { turnId: 't-4', journal: '/j/4', mode: 'build', phase: 'executing' };
  const worker = fakeWorker({ pushOk: false, sha: 'local', ahead: 1, exitCode: 0, providerDispatched: true });
  const out = await durableTurn.runTurn(w.steps, 'build', {
    pool: pool(turn), session: SESSION, mode: 'build', budgetMs: 60000,
    dispatch: async () => { throw new Error('not dispatched'); },
    deps: { worker, agentTurn },
  });
  assert.equal(out.routed.result.pushOk, true);
  assert.equal(out.routed.result.sha, 'pushed');
  assert.equal(out.routed.result.repushed, true);
  assert.ok(worker.calls.some((c) => c[0] === 'push' && c[2] === 'dev/bot-41'));
});

test('a record that is another step\'s is not followed: a turn that landed with its record lost is read off the branch', async () => {
  const w = item({ 'turn:build': { phase: 'started', mode: 'build', deadlineAt: Date.now() + 60000, headBefore: 'base', record: { turnId: 't-5', journal: '/j/5' } } });
  // The session's record now is a different turn (the next step's).
  const other = { turnId: 't-9', journal: '/j/9', mode: 'build', phase: 'executing' };
  const worker = fakeWorker();
  let dispatched = false;
  const out = await durableTurn.runTurn(w.steps, 'build', {
    pool: pool(other), session: SESSION, mode: 'build', budgetMs: 60000,
    head: async () => 'tip',
    observe: async ({ headBefore, tip }) => ({ result: { pushOk: true, sha: tip, ahead: 1, from: headBefore } }),
    dispatch: async () => { dispatched = true; return {}; },
    deps: { worker },
  });
  assert.equal(dispatched, false);
  assert.equal(out.observed, true);
  assert.deepEqual(out.routed.result, { pushOk: true, sha: 'tip', ahead: 1, from: 'base' });
  assert.equal(worker.calls.filter((c) => c[0] === 'resume').length, 0, 'another step\'s turn is left alone');
});

test('with no record and a branch that did not move, the turn is started again on what is left of its clock', async () => {
  const deadlineAt = Date.now() + 5 * 60 * 1000;
  const w = item({ 'turn:build': { phase: 'started', mode: 'build', deadlineAt, headBefore: 'base', record: null } });
  const heard = [];
  w.steps.listen((e) => { heard.push(e.kind); });
  let asked = null;
  const out = await durableTurn.runTurn(w.steps, 'build', {
    pool: pool(null), session: SESSION, mode: 'build', budgetMs: 60 * 60 * 1000,
    head: async () => 'base',
    observe: async () => { throw new Error('nothing landed'); },
    dispatch: async (extra, clock) => { asked = { ...extra, clock }; return { result: { pushOk: true, sha: 'again' } }; },
    deps: { worker: fakeWorker() },
  });
  assert.equal(asked.holdTurnRecord, true);
  assert.ok(asked.clock.budgetMs <= 5 * 60 * 1000 && asked.clock.budgetMs > 4 * 60 * 1000,
    'started on what is left of its clock, which a checks gate takes for its deadline');
  assert.equal(out.routed.result.sha, 'again');
  assert.equal(w.saves[0]['turn:build'].deadlineAt, deadlineAt, 'its deadline is the first one, not a fresh hour');
  assert.deepEqual(heard, ['turn_start']);
});

test('a record whose turn never started is released, and the turn is started', async () => {
  const w = item({ 'turn:spec': { phase: 'started', mode: 'scout', deadlineAt: Date.now() + 60000, headBefore: null, record: { turnId: 't-6', journal: '/j/6' } } });
  const turn = { turnId: 't-6', journal: '/j/6', mode: 'scout', phase: 'dispatch_pending' };
  const worker = fakeWorker({ providerDispatched: false });
  let dispatched = 0;
  const out = await durableTurn.runTurn(w.steps, 'spec', {
    pool: pool(turn), session: SESSION, mode: 'scout', budgetMs: 60000,
    dispatch: async () => { dispatched += 1; return { result: { lastResultText: 'plan' } }; },
    deps: { worker, agentTurn },
  });
  assert.equal(dispatched, 1);
  assert.equal(out.routed.result.lastResultText, 'plan');
  assert.ok(worker.calls.some((c) => c[0] === 'finish' && c[2] === 't-6'), 'the never-dispatched record goes');
});

test('a dispatch that fails is the step\'s result: the next attempt reads the same failure instead of starting the turn again', async () => {
  const w = item();
  const out = await durableTurn.runTurn(w.steps, 'build', {
    pool: pool(), session: SESSION, mode: 'build', budgetMs: 60000,
    dispatch: async () => { throw new Error('worker refused'); },
    deps: { worker: fakeWorker() },
  });
  assert.equal(out.routed.error, 'dispatch: worker refused');
  let dispatched = false;
  const again = await durableTurn.runTurn(w.again(), 'build', {
    pool: pool(), session: SESSION, mode: 'build', budgetMs: 60000,
    dispatch: async () => { dispatched = true; return {}; },
    deps: { worker: fakeWorker() },
  });
  assert.equal(dispatched, false);
  assert.equal(again.routed.error, 'dispatch: worker refused');
});

test('a journal that cannot be followed is the turn failing, its record released', async () => {
  const w = item({ 'turn:build': { phase: 'started', mode: 'build', deadlineAt: Date.now() + 60000, headBefore: 'base', record: { turnId: 't-7', journal: '/j/7' } } });
  const turn = { turnId: 't-7', journal: '/j/7', mode: 'build', phase: 'executing' };
  const worker = fakeWorker();
  worker.resumeTurnFromJournal = async () => { throw new Error('worker gone'); };
  const out = await durableTurn.runTurn(w.steps, 'build', {
    pool: pool(turn), session: SESSION, mode: 'build', budgetMs: 60000,
    dispatch: async () => { throw new Error('not dispatched'); },
    deps: { worker, agentTurn },
  });
  assert.match(out.routed.error, /could not be followed after a restart \(worker gone\)/);
  assert.ok(worker.calls.some((c) => c[0] === 'finish' && c[2] === 't-7'));
});

test('each restart that reaches a turn gives it two minutes back, up to ten', () => {
  assert.equal(durableTurn.allowanceMs(0), 0);
  assert.equal(durableTurn.allowanceMs(1), durableTurn.RESTART_ALLOWANCE_MS);
  assert.equal(durableTurn.allowanceMs(3), 3 * durableTurn.RESTART_ALLOWANCE_MS);
  assert.equal(durableTurn.allowanceMs(50), durableTurn.MAX_RESTARTS_ALLOWED * durableTurn.RESTART_ALLOWANCE_MS);
  assert.equal(durableTurn.allowanceMs('x'), 0);
});

test('a kept result is JSON with its long texts clipped', () => {
  const kept = durableTurn.keptRouted({
    result: { lastResultText: 'x'.repeat(30000), answerParts: Array.from({ length: 60 }, (_, i) => `part ${i}`), ahead: 2 },
    error: new Error('boom'),
    estimatedCostUsd: 0.1,
  });
  assert.equal(kept.result.lastResultText.length, 20000);
  assert.equal(kept.result.answerParts.length, 40);
  assert.equal(kept.result.answerParts[39], 'part 59', 'the last parts are kept');
  assert.equal(kept.error, 'boom');
  assert.equal(kept.estimatedCostUsd, 0.1);
});
