'use strict';

// The bot's builds and the bench's trials as durable builds
// (src/services/build-runs.js, docs/plans/bot-build-workflow.md): the legacy
// side of the bot-build machine. Without the workflow runtime a build runs
// in this process, unkept, as builds always ran; the machine's handlers run
// a target's pipeline on durable steps over the work item, report nothing
// once the work is no longer this process's, and record a build that failed
// for good where it is read.
//
// Run with: node --test tests/build-runs.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const buildRuns = require('../src/services/build-runs');
const durableSteps = require('../src/services/durable-steps');

// The targets' own modules are stood in for, one test at a time.
function withTarget(name, impl, fn) {
  const was = buildRuns.TARGETS[name];
  buildRuns.TARGETS[name] = impl;
  return Promise.resolve().then(fn).finally(() => { buildRuns.TARGETS[name] = was; });
}

test('a build\'s key is its run or its trial, and what tells two builds of one apart', () => {
  assert.equal(buildRuns.keyOf('live', 12), 'run:12');
  assert.equal(buildRuns.keyOf('shadow', 12, 'a2'), 'run:12@a2');
  assert.equal(buildRuns.keyOf('trial', '7', 'c1.x9'), 'trial:7@c1.x9');
  assert.equal(buildRuns.keyOf('trial', 7, 'not a nonce!'), 'trial:7', 'a nonce that could not be a key part is left out');
});

test('with no workflow runtime a build runs here, unkept, and resolves what it did', async () => {
  let handed = null;
  await withTarget('live', {
    run: async (args) => { handed = args; return { ok: true }; },
    lost: async () => {},
  }, async () => {
    const out = await buildRuns.start({ pool: {}, config: {}, target: 'live', id: 5, input: { args: { a: 1 } }, deps: { bot: 'b' } });
    assert.deepEqual(out, { ok: true });
  });
  assert.equal(handed.id, 5);
  assert.deepEqual(handed.input, { args: { a: 1 } });
  assert.equal(handed.steps.active, false, 'the inert context: every step simply runs');
  assert.equal(handed.deps.bot, 'b', 'the caller\'s deps reach a build run here');
});

test('a build that runs here announces its end to anyone waiting for it', async () => {
  const key = buildRuns.keyOf('shadow', 9, 'a1');
  const waited = buildRuns.whenEnded(key, { pollMs: 60 * 60 * 1000 });
  await withTarget('shadow', { run: async () => ({ built: true }), lost: async () => {} }, () => buildRuns.start({
    pool: {}, config: {}, target: 'shadow', id: 9, nonce: 'a1', input: {},
  }));
  assert.equal(await waited, null, 'ended here, unkept: there is no state to report');
});

test('an unknown target is refused for good', async () => {
  await assert.rejects(buildRuns.start({ pool: {}, config: {}, target: 'nope', id: 1 }), /not a build target/);
});

test('the machine\'s run hands the target durable steps over the work item, owned by the build', async () => {
  const saves = [];
  let steps = null;
  const key = buildRuns.keyOf('trial', 3, 'c1');
  const heard = buildRuns.whenEnded(key, { pollMs: 60 * 60 * 1000 });
  const out = await withTarget('trial', {
    run: async (args) => {
      steps = args.steps;
      assert.deepEqual(args.deps, {}, 'nothing of the caller\'s process reaches the machine\'s handler');
      await args.steps.once('triage', async () => ({ verdict: 'ready' }));
      return { status: 'ok', at: new Date('2026-10-14T00:00:00Z') };
    },
    lost: async () => {},
  }, () => buildRuns.run({
    input: { target: 'trial', id: 3, nonce: 'c1' }, resumeFrom: null, attempt: 1, lostAttempts: 0,
    checkpoint: async (v) => { saves.push(v); }, signal: new AbortController().signal,
  }, { config: {}, pool: {} }));
  assert.equal(steps.active, true);
  assert.equal(steps.owner, 'bot-build/trial:3@c1', 'what its sessions carry, so restart recovery leaves them alone');
  assert.deepEqual(saves, [{ triage: { verdict: 'ready' } }]);
  assert.deepEqual(out, { status: 'ok', at: '2026-10-14T00:00:00.000Z' }, 'its result is JSON');
  assert.deepEqual(await heard, { state: 'done', result: out });
});

test('the next attempt carries the build on from what the last one saved', async () => {
  let ran = 0;
  await withTarget('live', {
    run: async ({ steps }) => {
      const spec = await steps.once('spec', async () => { ran += 1; return 'a new plan'; });
      return { spec, resumed: steps.resumed, lost: steps.lostAttempts };
    },
    lost: async () => {},
  }, async () => {
    const out = await buildRuns.run({
      input: { target: 'live', id: 8 }, resumeFrom: { spec: 'the kept plan' }, attempt: 2, lostAttempts: 1,
      checkpoint: async () => {}, signal: new AbortController().signal,
    }, { config: {}, pool: {} });
    assert.deepEqual(out, { spec: 'the kept plan', resumed: true, lost: 1 });
  });
  assert.equal(ran, 0, 'the spec turn is not run again');
});

test('a build whose work stopped being this process\'s reports nothing, even when a step swallowed the stop', async () => {
  const ac = new AbortController();
  const key = buildRuns.keyOf('live', 4);
  let announced = false;
  const listener = () => { announced = true; };
  buildRuns._ended.on(key, listener);
  try {
    await withTarget('live', {
      run: async ({ steps }) => {
        ac.abort();
        // Much of the pipeline fails open: the stop is caught here.
        try { await steps.once('post', async () => 'said'); } catch { /* swallowed */ }
        return { ok: false, error: 'it would record a failure' };
      },
      lost: async () => {},
    }, async () => {
      await assert.rejects(buildRuns.run({
        input: { target: 'live', id: 4 }, resumeFrom: null, attempt: 1,
        checkpoint: async () => {}, signal: ac.signal,
      }, { config: {}, pool: {} }), (err) => durableSteps.isStopped(err));
    });
  } finally {
    buildRuns._ended.removeListener(key, listener);
  }
  assert.equal(announced, false, 'its next owner carries it on and ends it');
});

test('a build that failed for good is recorded where it is read, and its end announced', async () => {
  let recorded = null;
  const key = buildRuns.keyOf('shadow', 6, 'a3');
  const heard = buildRuns.whenEnded(key, { pollMs: 60 * 60 * 1000 });
  await withTarget('shadow', {
    run: async () => {},
    lost: async (args) => { recorded = args; },
  }, async () => {
    const out = await buildRuns.lost({ input: { target: 'shadow', id: 6, nonce: 'a3', error: { message: 'kept throwing' } } }, { config: {}, pool: {} });
    assert.deepEqual(out, { recorded: true });
  });
  assert.equal(recorded.id, 6);
  assert.deepEqual(recorded.error, { message: 'kept throwing' });
  assert.deepEqual(await heard, { state: 'failed' });
});

test('with no workflow runtime there are no builds under way to hold slots for', async () => {
  assert.deepEqual(await buildRuns.underWay('trial'), []);
});
