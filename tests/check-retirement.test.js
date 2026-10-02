'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kubernetes = require('../src/services/kubernetes');
const checkRuns = require('../src/services/check-runs');
const retirement = require('../src/services/check-retirement');

const config = { kubernetes: { workerNamespace: 'workers' } };
const missing = () => { throw Object.assign(new Error('missing'), { code: 404 }); };
const labels = {
  'app.kubernetes.io/managed-by': 'social-vibecoding-runtime',
  'social.usernode.io/session-id': '42',
  'social.usernode.io/preview-run-id': 'old',
};

function resources(t, { terminal = false, kind = 'unit-suite' } = {}) {
  let job = { metadata: { name: `sv-${kind}-s42-old`, uid: 'job-uid', labels },
    status: terminal ? { succeeded: 1 } : {} };
  let input = { metadata: { name: `sv-${kind}-s42-old-input`, uid: 'input-uid', labels } };
  let busy = false;
  let journal = null;
  let failure = null;
  const events = [];
  const batch = {
    listNamespacedJob: async () => ({ items: job ? [job] : [] }),
    readNamespacedJob: async () => job || missing(),
    async deleteNamespacedJob(request) {
      assert.equal(journal.jobs[0].stage, 'deleting-job');
      assert.equal(request.body.preconditions.uid, job.metadata.uid);
      events.push('delete-job');
      job = null;
      if (failure === 'job') throw new Error('Lost Job deletion reply');
    },
  };
  const core = {
    readNamespacedSecret: async () => input || missing(),
    listNamespacedPod: async () => ({ items: busy ? [{ status: { phase: 'Running' } }] : [] }),
    async deleteNamespacedSecret(request) {
      assert.equal(journal.jobs[0].stage, 'deleting-input');
      assert.equal(request.body.preconditions.uid, input.metadata.uid);
      events.push('delete-input');
      input = null;
      if (failure === 'input') throw new Error('Lost input deletion reply');
    },
  };
  kubernetes._setClientsForTest({ batch, core });
  t.after(() => kubernetes._setClientsForTest(null));
  async function run() {
    return kubernetes.retireCheckResources(config, 42, 'old', {
      journal,
      async persist(next) {
        if (failure === 'before-intent' && next.jobs.some(item => item.stage === 'deleting-job')) {
          throw new Error('Journal unavailable');
        }
        if (failure === 'before-input-intent' && next.jobs.some(item => item.stage === 'deleting-input')) {
          throw new Error('Input journal unavailable');
        }
        journal = structuredClone(next);
        events.push(`persist-${next.jobs[0]?.stage}`);
        if (failure === 'stopped' && next.jobs.some(item => item.stage === 'stopped')) {
          throw new Error('Lost consumer-stop commit reply');
        }
      },
    });
  }
  return {
    run, events, batch, core,
    fail(value) { failure = value; },
    replaceJob() { job = { metadata: { name: `sv-${kind}-s42-old`, uid: 'successor', labels } }; },
    replaceInput() { input = { metadata: { name: `sv-${kind}-s42-old-input`, uid: 'successor', labels } }; },
    setBusy(value) { busy = value; },
    journal: () => journal,
  };
}

for (const kind of ['capture', 'unit-suite']) {
  for (const phase of ['job', 'stopped', 'input']) {
    test(`C11 lost ${kind} ${phase} reply resumes from persisted identities`, async t => {
      const f = resources(t, { kind });
      f.fail(phase);
      await assert.rejects(f.run(), /Lost/);
      const identity = structuredClone(f.journal().jobs[0]);
      assert.equal(identity.job.uid, 'job-uid');
      assert.equal(identity.input.uid, 'input-uid');
      f.fail(null);
      const completed = await f.run();
      assert.equal(completed.jobs[0].stage, 'released');
      assert.equal(f.events.filter(event => event === 'delete-job').length, 1);
      assert.equal(f.events.filter(event => event === 'delete-input').length, 1);
    });
  }
}

test('C11 failed write before deletion authorizes no mutation', async t => {
  const f = resources(t);
  f.fail('before-intent');
  await assert.rejects(f.run(), /Journal unavailable/);
  assert.equal(f.events.some(event => event.startsWith('delete-')), false);
  f.fail(null);
  assert.equal((await f.run()).jobs[0].stage, 'released');
});

for (const resource of ['Job', 'Input']) {
  test(`C11 conflicting ${resource} UID preserves a successor during retry`, async t => {
    const f = resources(t);
    f.fail(resource === 'Job' ? 'job' : 'stopped');
    await assert.rejects(f.run());
    f.fail(null);
    f[`replace${resource}`]();
    await assert.rejects(f.run(), /ownership|identity/);
    assert.equal(f.events.filter(event => event === 'delete-input').length, 0);
    assert.equal(f.events.filter(event => event === 'delete-job').length, 1);
  });
}

test('C11 resumed stop receipt rechecks consumers before input deletion', async t => {
  const f = resources(t);
  f.fail('stopped');
  await assert.rejects(f.run());
  f.fail(null);
  f.core.listNamespacedPod = async () => { throw new Error('Consumer inspection unavailable'); };
  await assert.rejects(f.run(), /Consumer inspection/);
  assert.equal(f.events.includes('delete-input'), false);
});

test('C11 unexplained disappearance before deletion intent remains unresolved', async t => {
  const f = resources(t);
  f.fail('before-intent');
  await assert.rejects(f.run());
  f.batch.listNamespacedJob = async () => ({ items: [] });
  f.batch.readNamespacedJob = async () => missing();
  f.fail(null);
  await assert.rejects(f.run(), /disappeared before retirement/);
  assert.equal(f.events.includes('delete-input'), false);
});

test('C11 terminal Jobs retain their logs and release inputs through the journal', async t => {
  const f = resources(t, { terminal: true });
  await f.run();
  assert.equal(f.events.includes('delete-job'), false);
  assert.equal(f.events.includes('delete-input'), true);
});

test('C11 released capture cannot close an unconfirmed unit submission', async t => {
  const originalRead = checkRuns.read;
  const originalRetire = kubernetes.retireCheckResources;
  t.after(() => { checkRuns.read = originalRead; kubernetes.retireCheckResources = originalRetire; });
  checkRuns.read = async () => ({ manifest: {
    durableCli: true, launched: true, unitSuite: { version: 1, state: 'submitted' },
  } });
  kubernetes.retireCheckResources = async () => ({ jobs: [{ kind: 'capture', stage: 'released' }] });
  const result = await retirement.retire(config, {}, 42, 'old');
  assert.equal(result.complete, false);
  assert.equal(result.why, 'unit-suite creation unconfirmed');
});


test('C11 failed input-intent write preserves the input and remains retryable', async t => {
  const f = resources(t, { terminal: true });
  f.fail('before-input-intent');
  await assert.rejects(f.run(), /Input journal unavailable/);
  assert.equal(f.journal().jobs[0].stage, 'stopped');
  assert.equal(f.events.includes('delete-input'), false);
  f.fail(null);
  assert.equal((await f.run()).jobs[0].stage, 'released');
});

test('C11 late companion retirement retains the already released capture receipt', async t => {
  const f = resources(t, { kind: 'capture', terminal: true });
  await f.run();
  const captureReceipt = structuredClone(f.journal().jobs[0]);
  const readCapture = f.batch.readNamespacedJob;
  const late = { metadata: { name: 'sv-unit-suite-s42-old', uid: 'late-unit', labels }, status: { succeeded: 1 } };
  f.batch.listNamespacedJob = async () => ({ items: [await readCapture(), late] });
  f.batch.readNamespacedJob = async ({ name }) => name === late.metadata.name ? late : readCapture();
  let input = { metadata: { name: 'sv-unit-suite-s42-old-input', uid: 'late-input', labels } };
  f.core.readNamespacedSecret = async ({ name }) => name === input?.metadata.name ? input : missing();
  f.core.deleteNamespacedSecret = async request => {
    assert.equal(f.journal().jobs[1].stage, 'deleting-input');
    assert.equal(request.body.preconditions.uid, 'late-input');
    input = null;
  };
  await f.run();
  assert.deepEqual(f.journal().jobs[0], captureReceipt);
  assert.equal(f.journal().jobs[1].job.uid, 'late-unit');
  assert.equal(f.journal().jobs[1].stage, 'released');
});

for (const manifest of [
  { durableCli: true, launched: false },
  { durableCli: true, launched: true, reconstruction: 'unknown-launch' },
]) {
  test(`unknown launch retains its locator after visible resources retire: ${JSON.stringify(manifest)}`, async t => {
    t.mock.method(checkRuns, 'read', async () => ({ manifest }));
    t.mock.method(kubernetes, 'retireCheckResources', async () => ({ jobs: [
      { kind: 'capture', stage: 'released' }, { kind: 'unit-suite', stage: 'released' },
    ] }));
    assert.equal((await retirement.retire(config, {}, 42, 'old')).complete, false);
  });
}
