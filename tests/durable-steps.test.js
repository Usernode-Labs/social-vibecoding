'use strict';

// Durable steps (src/services/durable-steps.js): what a bot build or a bench
// trial keeps as it goes, so the same code run again after a restart carries
// on from the last step it finished (docs/plans/bot-build-workflow.md).
//
// Each test plays the work item's part: `checkpoint` keeps what was saved,
// and a second context made over it (`resumeFrom`) is the next attempt.
//
// Run with: node --test tests/durable-steps.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const durableSteps = require('../src/services/durable-steps');

function item() {
  const saves = [];
  return {
    saves,
    last: () => (saves.length ? saves[saves.length - 1] : null),
    checkpoint: async (value) => { saves.push(value); },
  };
}

test('a step runs once: the next attempt takes what it saved and does not run it again', async () => {
  const w = item();
  let runs = 0;
  const first = durableSteps.durable({ checkpoint: w.checkpoint });
  assert.equal(first.resumed, false);
  assert.deepEqual(await first.once('branch', async () => { runs += 1; return { base: 'abc' }; }), { base: 'abc' });
  assert.deepEqual(await first.once('branch', async () => { runs += 1; return { base: 'other' }; }), { base: 'abc' });
  const next = durableSteps.durable({ resumeFrom: w.last(), checkpoint: w.checkpoint });
  assert.equal(next.resumed, true);
  assert.deepEqual(await next.once('branch', async () => { runs += 1; return { base: 'later' }; }), { base: 'abc' },
    'the branch is not cut again on the next attempt');
  assert.equal(runs, 1);
});

// A step nobody waits on (a build's last look) runs beside the others: it
// is saved only once it is done, and the handler's flush waits for it, so a
// restart before it ended runs it again rather than losing it.
test('a step beside the others is saved once done, waited for by flush, run once', async () => {
  const w = item();
  const steps = durableSteps.durable({ checkpoint: w.checkpoint });
  let release;
  let runs = 0;
  const look = () => { runs += 1; return new Promise((r) => { release = () => r({ fixed: 1 }); }); };
  steps.beside('look', look);
  steps.beside('look', look);
  assert.equal(await steps.once('next', async () => 'went on'), 'went on', 'the steps after it do not wait');
  assert.equal(steps.has('look'), false, 'not saved before it is done');
  const flushed = steps.flush();
  release();
  await flushed;
  assert.deepEqual(w.last().look, { fixed: 1 });
  assert.equal(runs, 1, 'asked again while it runs, it is not run twice');
  const next = durableSteps.durable({ resumeFrom: w.last(), checkpoint: w.checkpoint });
  next.beside('look', look);
  await next.flush();
  assert.equal(runs, 1, 'nor once it is saved');
  // One that fails is not saved: a later ask runs it again.
  const failing = durableSteps.durable({ checkpoint: w.checkpoint });
  failing.beside('look', async () => { throw new Error('no reviewer'); });
  await failing.flush();
  assert.equal(failing.has('look'), false);
});

test('a step that throws saves nothing, so the next attempt runs it', async () => {
  const w = item();
  const first = durableSteps.durable({ checkpoint: w.checkpoint });
  await assert.rejects(first.once('spec', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(first.has('spec'), false);
  const next = durableSteps.durable({ resumeFrom: w.last(), checkpoint: w.checkpoint });
  assert.equal(await next.once('spec', async () => 'written'), 'written');
});

test('what a step keeps is JSON: a Date is its string, undefined is null', async () => {
  const w = item();
  const steps = durableSteps.durable({ checkpoint: w.checkpoint });
  const at = new Date('2026-10-14T00:00:00Z');
  assert.equal(await steps.once('at', async () => at), '2026-10-14T00:00:00.000Z');
  assert.equal(await steps.once('nothing', async () => undefined), null);
  assert.equal(steps.has('nothing'), true, 'a step that resolved nothing has still run');
  assert.deepEqual(durableSteps.plain({ a: undefined, b: [undefined, 1] }), { b: [null, 1] });
});

test('every save holds everything kept so far, written one after another', async () => {
  const saves = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  let calls = 0;
  const steps = durableSteps.durable({
    checkpoint: async (value) => {
      calls += 1;
      // The first write is slow: the second must not land under it.
      if (calls === 1) await gate;
      saves.push(value);
    },
  });
  const a = steps.set('a', 1);
  const b = steps.set('b', 2);
  release();
  await Promise.all([a, b]);
  assert.deepEqual(saves, [{ a: 1 }, { a: 1, b: 2 }]);
});

test('a scope keeps its keys apart, and get/set/merge keep state as it goes', async () => {
  const w = item();
  const steps = durableSteps.durable({ checkpoint: w.checkpoint });
  const build = steps.scope('build');
  await build.once('branch', async () => 'build-branch');
  await steps.once('branch', async () => 'trial-branch');
  await build.merge('review', { round: 1 });
  await build.merge('review', { verdict: 'ok' });
  assert.deepEqual(w.last(), {
    'build/branch': 'build-branch', branch: 'trial-branch', 'build/review': { round: 1, verdict: 'ok' },
  });
  assert.deepEqual(build.get('review'), { round: 1, verdict: 'ok' });
  await build.set('review', undefined);
  assert.equal(build.has('review'), false);
});

test('a stop is sticky: once the signal aborts, every step throws, even after a catch swallowed one', async () => {
  const w = item();
  const ac = new AbortController();
  const steps = durableSteps.durable({ checkpoint: w.checkpoint, signal: ac.signal });
  await steps.once('one', async () => 1);
  ac.abort();
  assert.equal(steps.stopped, true);
  let caught = null;
  try { steps.fence(); } catch (err) { caught = err; }
  assert.ok(durableSteps.isStopped(caught), 'a fenced step throws a stop');
  assert.equal(caught.code, 'steps_stopped');
  // Swallowed on the way out; the next step throws it again, and runs nothing.
  let ran = false;
  await assert.rejects(steps.once('two', async () => { ran = true; return 2; }), (err) => durableSteps.isStopped(err));
  assert.equal(ran, false);
  assert.deepEqual(w.last(), { one: 1 }, 'nothing new is started after the stop');
});

test('a step whose work was under way when the process began stopping is saved, and then the stop is thrown', async () => {
  const w = item();
  const ac = new AbortController();
  const steps = durableSteps.durable({ checkpoint: w.checkpoint, signal: ac.signal });
  // The kernel takes a checkpoint for as long as the process holds the
  // lease: what the step did is not done again by the next process.
  await assert.rejects(steps.once('comment', async () => { ac.abort(); return { posted: 7 }; }), (err) => durableSteps.isStopped(err));
  assert.deepEqual(w.last(), { comment: { posted: 7 } });
  const next = durableSteps.durable({ resumeFrom: w.last(), checkpoint: w.checkpoint });
  let again = false;
  assert.deepEqual(await next.once('comment', async () => { again = true; return { posted: 8 }; }), { posted: 7 });
  assert.equal(again, false);
});

test('state a step keeps as it goes is saved while the process is stopping', async () => {
  const w = item();
  const ac = new AbortController();
  const steps = durableSteps.durable({ checkpoint: w.checkpoint, signal: ac.signal });
  ac.abort();
  await steps.set('review_state', { round: 2 });
  assert.deepEqual(w.last(), { review_state: { round: 2 } });
});

test('a save the database refuses for a moment is tried again; a lost lease is not', async () => {
  const saves = [];
  let refusals = 2;
  const steps = durableSteps.durable({
    checkpoint: async (v) => {
      if (refusals > 0) { refusals -= 1; throw new Error('connection terminated unexpectedly'); }
      saves.push(v);
    },
  });
  await steps.once('a', async () => 1);
  assert.deepEqual(saves, [{ a: 1 }], 'saved on the third try, the build going on');
  assert.equal(steps.stopped, false);
  class LeaseLost extends Error { constructor() { super('work lease lost'); } }
  let tries = 0;
  const lost = durableSteps.durable({ checkpoint: async () => { tries += 1; throw new LeaseLost(); } });
  await assert.rejects(lost.once('a', async () => 1), (err) => durableSteps.isStopped(err));
  assert.equal(tries, 1, 'the claim is gone: no point trying again');
});

test('race resolves the promise, or rejects with the stop, even one that came first', async () => {
  const ac = new AbortController();
  const steps = durableSteps.durable({ checkpoint: async () => {}, signal: ac.signal });
  assert.equal(await steps.race(Promise.resolve(5)), 5);
  const never = new Promise(() => {});
  const raced = steps.race(never);
  ac.abort();
  await assert.rejects(raced, (err) => durableSteps.isStopped(err));
  // Already aborted: a listener added now would never be called.
  await assert.rejects(steps.race(never), (err) => durableSteps.isStopped(err));
});

test('a checkpoint that cannot be written stops the steps: the claim is gone', async () => {
  const steps = durableSteps.durable({ checkpoint: async () => { throw new Error('lease lost'); } });
  await assert.rejects(steps.once('a', async () => 1), (err) => durableSteps.isStopped(err) && /lease lost/.test(err.message));
  assert.equal(steps.stopped, true);
  assert.throws(() => steps.fence(), (err) => durableSteps.isStopped(err));
});

test('rethrowStop rethrows a stop and lets anything else through', () => {
  assert.throws(() => durableSteps.rethrowStop(new durableSteps.StepsStopped(), 'here'), (err) => durableSteps.isStopped(err));
  assert.doesNotThrow(() => durableSteps.rethrowStop(new Error('a step\'s own failure'), 'here'));
});

test('watchers hear what the steps tell them, keyed as the scope keys, and one that throws stops nothing', async () => {
  const steps = durableSteps.durable({ checkpoint: async () => {} });
  const heard = [];
  steps.listen(() => { throw new Error('a broken watcher'); });
  steps.listen((e) => { heard.push(e); });
  await steps.scope('build').tell({ kind: 'turn_start', key: 'turn:build' });
  assert.deepEqual(heard, [{ kind: 'turn_start', key: 'build/turn:build' }]);
});

test('the inert context runs every step, keeps nothing and never fences', async () => {
  const steps = durableSteps.none();
  let runs = 0;
  assert.equal(steps.active, false);
  assert.equal(await steps.once('a', async () => { runs += 1; return 1; }), 1);
  assert.equal(await steps.once('a', async () => { runs += 1; return 2; }), 2);
  assert.equal(runs, 2);
  assert.equal(steps.get('a'), undefined);
  assert.doesNotThrow(() => steps.fence());
  assert.equal(steps.scope('x'), steps);
  assert.equal(await steps.race(Promise.resolve(3)), 3);
});

test('of(deps) is the context a pipeline is handed, or the inert one', () => {
  const steps = durableSteps.durable({ checkpoint: async () => {} });
  assert.equal(durableSteps.of({ durable: steps }), steps);
  assert.equal(durableSteps.of({}).active, false);
  assert.equal(durableSteps.of(null).active, false);
  assert.equal(durableSteps.of({ durable: {} }).active, false, 'something that is not a context is not taken for one');
});
