'use strict';

// The preview machine's work handlers (src/workflow/preview/services.ts),
// with the build, the cluster and the databases stubbed: a build failure is
// a result the machine decides on, a cancelled attempt undoes what it
// created and reports nothing, a retried run collects what the earlier
// claim left on the cluster (or starts over under the same id, in the place
// in line the earlier claim had), the unit suite starts with the build, and a
// retirement closes only when nothing is left.

const test = require('node:test');
const assert = require('node:assert/strict');

const stub = (path, exports) => {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports, paths: [] };
};

const calls = [];
const state = { build: null, present: [], exists: new Set(), serving: new Set() };
const realStaging = require('../src/services/staging');
stub('../src/services/staging', {
  ...realStaging,
  async prepareAttempt(config, row, app, head, attempt) {
    calls.push(['prepare', head, attempt.n, attempt.dbName]);
    await attempt.checkpoint({ step: 'deploy', db: attempt.dbName });
    if (state.build instanceof Error) throw state.build;
    return state.build;
  },
  async verifyStagingEdge() { calls.push(['edge']); return { ok: true }; },
  // A probe that never ends: the prepare handler must not be waiting on it.
  verifyStagingEdgeAfterDeploy(row, hostname) { calls.push(['edge', hostname]); return new Promise(() => {}); },
});
stub('../src/services/db-manager', {
  async dropDatabase(name) { calls.push(['drop', name]); state.exists.delete(name); },
  async databaseExists(name) { return state.exists.has(name); },
});
const realK8s = require('../src/services/kubernetes');
stub('../src/services/kubernetes', {
  ...realK8s,
  async cancelPreviewChecks(config, sessionId, runId) { calls.push(['cancel-jobs', sessionId, runId ?? null]); },
  async deleteApplication(config, name, opts) { calls.push(['delete', name, opts.identity, opts.secrets]); },
  async previewResourcesPresent() { return state.present; },
  async deleteSecret(config, name) { calls.push(['delete-secret', name]); },
  async deleteRunCheckJobs(config, { previewRunId }) { calls.push(['delete-jobs', previewRunId]); return 0; },
  async previewServesAttempt(config, name, n) { return state.serving.has(n); },
  async restorePreviewAttempt(config, name, n, servingN) {
    calls.push(['restore', name, n, servingN]);
    if (servingN != null) { state.serving.delete(n); state.serving.add(servingN); }
    return 'restored';
  },
});
stub('../src/services/application-runtime', { ...require('../src/services/application-runtime'), mode: () => 'kubernetes' });
const syncs = [];
stub('../src/services/boot-failure-sync', {
  async afterBootFailure(o) { syncs.push(o.session.id); return { sync: false }; },
  explain: () => 'Main changed the schema.',
});
const collected = { next: null };
stub('../src/services/check-harvest', {
  ...require('../src/services/check-harvest'),
  async collectForWorkflow(config, pool, o) { calls.push(['collect', o.runKey]); return collected.next; },
});
stub('../src/services/check-runs', {
  ...require('../src/services/check-runs'),
  async finish(pool, runId) { calls.push(['finish', runId]); },
});
const suites = { launched: [], running: 0, jobs: new Set(), asked: [], reusable: null };
stub('../src/services/unit-suite', { ...require('../src/services/unit-suite'),
  isEnabled: () => true,
  async reusablePass(o) { suites.asked.push(o); return suites.reusable; },
  async maybeRunUnitSuite(o) { suites.launched.push(o); return null; } });
stub('../src/services/checks-queue', { ...require('../src/services/checks-queue'), maxConcurrentRuns: () => 2 });
const realVisuals = require('../src/services/visuals');
stub('../src/services/visuals', {
  ...realVisuals,
  async captureForSession(config, row, app, head, staging, opts) {
    calls.push(['capture', head, staging.runtimeName, opts.workflow.runId]);
    captured.push(opts.workflow);
    return { outcome: 'verdict', state: 'passing' };
  },
});

const captured = [];
const { previewServices } = require('../src/workflow/preview/services.ts');
const { WORK } = require('../src/workflow/preview/machine.ts');
const { LeaseLost } = require('../src/workflow/kernel/index.ts');

const work = { cancelled: true };
const runs = { rows: [] };
const pool = { async query(text) {
  if (/FROM wf_work WHERE id/.test(text)) return { rows: [{ cancelled: work.cancelled }] };
  if (/min\(queued_at\)/.test(text)) return { rows: [{ at: runs.queuedAt ?? null }] };
  if (/FROM wf_instances WHERE machine = 'preview'/.test(text)) return { rows: suites.preparing ? [{ '?column?': 1 }] : [] };
  if (/FROM check_runs WHERE session_id/.test(text)) return { rows: runs.rows };
  if (/FROM chat_sessions cs JOIN apps/.test(text)) return { rows: [{ id: 5, app_id: 2, app_slug: 'shop', repo_url: '' }] };
  if (/FROM apps WHERE id/.test(text)) return { rows: [{ id: 2, slug: 'shop', repo_url: 'https://github.com/acme/shop' }] };
  return { rows: [] };
} };
const handlers = previewServices({ config: { captureRuntime: 'kubernetes', kubernetes: {} }, pool });
const ctx = (input, extra = {}) => ({
  input, key: 'k', attempt: 1, resumeFrom: null, signal: new AbortController().signal,
  checkpoint: async () => {}, ...extra,
});
const head = 'b'.repeat(40);

test('a built attempt returns its receipt; a failed one returns why, for the machine to record', { timeout: 15000 }, async () => {
  calls.length = 0;
  state.build = { stagingUrl: 'https://shop--s5.apps', hostname: 'shop--s5.apps', runtimeKind: 'kubernetes',
    runtimeName: 'sv-preview-2-s5', containerId: null, imageRef: 'img@sha256:1', buildRef: 'b1' };
  const input = { sessionId: 5, appId: 2, n: 3, head, db: 'app_shop_staging_s5_abcdef' };
  assert.deepEqual(await handlers[WORK.prepare].run(ctx(input)), {
    ok: true, db: 'app_shop_staging_s5_abcdef', url: 'https://shop--s5.apps', runtimeKind: 'kubernetes', runtimeName: 'sv-preview-2-s5',
    containerId: null, imageRef: 'img@sha256:1', buildRef: 'b1',
  });
  assert.deepEqual(calls[0], ['prepare', head, 3, 'app_shop_staging_s5_abcdef']);
  assert.deepEqual(calls.filter((c) => c[0] === 'edge'), [['edge', 'shop--s5.apps']],
    'the public address is probed after the deploy, and the receipt does not wait for it');

  calls.length = 0;
  state.build = Object.assign(new Error('Deployment cannot start: CrashLoopBackOff'), { healthcheckFailed: true, servingRemoved: false });
  const failed = await handlers[WORK.prepare].run(ctx(input));
  assert.equal(failed.ok, false);
  assert.equal(typeof failed.detail, 'string');
  assert.equal(failed.aboutMain, 'Main changed the schema.');
  assert.equal(calls.filter((c) => c[0] === 'edge').length, 0, 'nothing deployed, nothing probed');
});

test('a build failure seen by a claim that is no longer live sets nothing off (no sync with main, no report)', async () => {
  calls.length = 0;
  syncs.length = 0;
  state.build = Object.assign(new Error('restore killed'), { healthcheckFailed: true });
  const input = { sessionId: 5, appId: 2, n: 5, head, db: 'app_shop_staging_s5_555555' };
  let step = 0;
  // The deploy checkpoint passes; by the failure the claim is gone.
  await assert.rejects(handlers[WORK.prepare].run(ctx(input, { workId: 'w5', checkpoint: async () => { if (++step > 1) throw new LeaseLost(); } })), LeaseLost);
  assert.equal(syncs.length, 0);
});

test('a cancelled attempt drops the database it was building and reports nothing', async () => {
  calls.length = 0;
  work.cancelled = true;
  const input = { sessionId: 5, appId: 2, n: 4, head, db: 'app_shop_staging_s5_444444' };
  await assert.rejects(handlers[WORK.prepare].run(ctx(input, { workId: 'w4', checkpoint: async () => { throw new LeaseLost(); } })), LeaseLost);
  assert.deepEqual(calls.filter((c) => c[0] === 'drop'), [['drop', 'app_shop_staging_s5_444444']]);
});

test('an attempt cancelled after its deploy gives the Deployment back before its database goes (review finding)', async () => {
  calls.length = 0;
  work.cancelled = true;
  state.build = { stagingUrl: 'https://shop--s5.apps', hostname: 'shop--s5.apps', runtimeKind: 'kubernetes',
    runtimeName: 'sv-preview-2-s5', containerId: null, imageRef: 'img@sha256:5', buildRef: 'b5' };
  state.serving = new Set([5]);   // its rollout went through: the live pods use attempt 5
  const input = { sessionId: 5, appId: 2, n: 5, head, db: 'app_shop_staging_s5_555555', serving: { n: 4 } };
  let seen = 0;
  const checkpoint = async () => { if (++seen > 1) throw new LeaseLost(); };   // cancelled during the rollout
  await assert.rejects(handlers[WORK.prepare].run(ctx(input, { workId: 'w5', checkpoint })), LeaseLost);
  const order = calls.filter((c) => c[0] === 'restore' || c[0] === 'drop').map((c) => c[0]);
  assert.deepEqual(order, ['restore', 'drop'], 'given back to attempt 4 first, then dropped');
  // Retiring an attempt that still serves (the give-back failed) drops nothing.
  calls.length = 0;
  state.serving = new Set([5]);
  await assert.rejects(handlers[WORK.retireAttempt].run(ctx({ sessionId: 5, appId: 2, appSlug: 'shop', n: 5, db: 'app_shop_staging_s5_555555' })),
    /still serves/);
  assert.deepEqual(calls.filter((c) => c[0] === 'drop'), []);
  state.serving = new Set();
});

test('a claim that only lost its lease deletes nothing: a retry of the same attempt may be using it (review finding)', async () => {
  calls.length = 0;
  work.cancelled = false;
  const input = { sessionId: 5, appId: 2, n: 4, head, db: 'app_shop_staging_s5_444444' };
  await assert.rejects(handlers[WORK.prepare].run(ctx(input, { workId: 'w4', checkpoint: async () => { throw new LeaseLost(); } })), LeaseLost);
  assert.deepEqual(calls.filter((c) => c[0] === 'drop'), []);
  work.cancelled = true;
});

test('each claim of a checks run has an id of its own; a retry collects what the earlier claim left, or starts over', async () => {
  const { claimRunId } = require('../src/workflow/preview/services.ts');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const first = claimRunId(5, 'run-1-7', 1);
  const second = claimRunId(5, 'run-1-7', 2);
  assert.match(first, UUID, 'a UUID: check_runs.run_id is one');
  assert.notEqual(first, second);
  assert.equal(claimRunId(5, 'run-1-7', 1), first, 'and the same for the same claim');
  const input = { sessionId: 5, appId: 2, n: 1, head, runId: 'run-1-7', trigger: 'commit-push',
    runtimeName: 'sv-preview-2-s5', runtimeKind: 'kubernetes', url: 'https://shop--s5.apps' };
  calls.length = 0;
  assert.deepEqual(await handlers[WORK.run].run(ctx(input)), { outcome: 'verdict', state: 'passing' });
  assert.deepEqual(calls, [['capture', head, 'sv-preview-2-s5', first]], 'a first claim runs under its own id');
  calls.length = 0;
  collected.next = { outcome: 'verdict', state: 'failing' };
  assert.deepEqual(await handlers[WORK.run].run(ctx(input, { attempt: 2 })), { outcome: 'verdict', state: 'failing' });
  assert.deepEqual(calls, [['collect', 'run-1-7']], 'its Jobs collected, nothing run again');
  calls.length = 0;
  collected.next = null;
  runs.rows = [{ run_id: first }];
  await handlers[WORK.run].run(ctx(input, { attempt: 2 }));
  assert.deepEqual(calls, [['collect', 'run-1-7'], ['cancel-jobs', 5, first], ['delete-jobs', first], ['finish', first],
    ['capture', head, 'sv-preview-2-s5', second]], 'nothing to read: what the earlier claim left goes, and it runs again');
  calls.length = 0;
  runs.rows = [{ run_id: first }, { run_id: second }];
  await handlers[WORK.cancel].run(ctx({ sessionId: 5, runId: 'run-1-7' }));
  assert.deepEqual(calls, [['cancel-jobs', 5, first], ['delete-jobs', first], ['finish', first],
    ['cancel-jobs', 5, second], ['delete-jobs', second], ['finish', second]], 'every claim of the run, never the session\'s others');
  runs.rows = [];
});

test('retiring an attempt drops its database and its own Secret', async () => {
  calls.length = 0;
  await handlers[WORK.retireAttempt].run(ctx({ sessionId: 5, appId: 2, appSlug: 'shop', n: 2, db: 'app_shop_staging_s5_222222' }));
  assert.deepEqual(calls, [['drop', 'app_shop_staging_s5_222222'], ['delete-secret', 'sv-preview-2-s5-env-a2']]);
});

test('a retirement deletes by identity and closes only when nothing is left', async () => {
  calls.length = 0;
  const input = { sessionId: 5, appId: 2, appSlug: 'shop', runtimeName: 'sv-preview-2-s5', runtimeKind: 'kubernetes',
    attempts: [{ n: 1, db: 'db1' }, { n: 2, db: 'db2' }], closeAfter: new Date(Date.now() - 1).toISOString() };
  state.present = ['sv-preview-2-s5'];
  await assert.rejects(handlers[WORK.retire].run(ctx(input)), /Still present after retirement: sv-preview-2-s5/);
  state.present = [];
  assert.deepEqual(await handlers[WORK.retire].run(ctx(input)), { closed: true });
  const del = calls.find((c) => c[0] === 'delete');
  assert.deepEqual(del, ['delete', 'sv-preview-2-s5', true, ['sv-preview-2-s5-env', 'sv-preview-2-s5-env-a1', 'sv-preview-2-s5-env-a2']]);
  assert.ok(calls.some((c) => c[0] === 'cancel-jobs' && c[2] === null), 'the session\'s check Jobs go with it');
});

test('a reclaimed build clones into its own claim\'s database, never the one a claim before it may have deployed (review finding)', async () => {
  calls.length = 0;
  state.build = { stagingUrl: 'https://shop--s5.apps', hostname: 'shop--s5.apps', runtimeKind: 'kubernetes',
    runtimeName: 'sv-preview-2-s5', containerId: null, imageRef: 'img@sha256:6', buildRef: 'b6' };
  const dbs = ['app_shop_staging_s5_aaaaaa', 'app_shop_staging_s5_bbbbbb', 'app_shop_staging_s5_cccccc'];
  const input = { sessionId: 5, appId: 2, n: 6, head, db: dbs[0], dbs };
  const out = await handlers[WORK.prepare].run(ctx(input, { attempt: 2 }));
  assert.deepEqual(calls.filter((c) => c[0] === 'prepare'), [['prepare', head, 6, dbs[1]]], 'the second claim\'s own database');
  assert.equal(out.db, dbs[1], 'and the receipt says which one serves');
});

test('no handler is left for the items an older release queued to hand a head or the bot\'s note on', () => {
  // The transitions tell the shots machine and the bot by message now.
  for (const old of ['preview.ready', 'verdict.followUps', 'preview.stopped']) {
    assert.equal(handlers[old], undefined, `${old} has no handler`);
  }
  assert.deepEqual(Object.keys(handlers).sort(), Object.values(WORK).sort(), 'every kind the machine queues has one');
});

test('the unit suite starts with the build, under the attempt\'s own id, unless it is off, joined or the cluster is full', async () => {
  const { unitEarlyRunId } = require('../src/workflow/preview/services.ts');
  const k8s = require('../src/services/kubernetes');
  k8s.findCheckJobs = async (config, { previewRunId }) => (suites.jobs.has(previewRunId)
    ? { unitSuites: [{ name: 'sv-unit-early-s5-x', state: 'running' }] } : { unitSuites: [] });
  k8s.countRunningUnitSuiteJobs = async () => suites.running;
  const workers = previewServices({ config: { captureRuntime: 'kubernetes', workerRuntime: 'kubernetes', kubernetes: {} }, pool });
  const input = { sessionId: 5, appId: 2, n: 3, head };
  const id = unitEarlyRunId(5, 3);
  assert.notEqual(id, unitEarlyRunId(5, 4), 'one per attempt');

  suites.launched.length = 0;
  assert.equal((await workers[WORK.unitEarly].run(ctx(input))).why, 'not_preparing',
    'not once its attempt serves, failed or was superseded: nothing would read it');
  assert.equal(suites.launched.length, 0);
  suites.preparing = true;
  assert.deepEqual(await workers[WORK.unitEarly].run(ctx(input)), { started: true, runId: id });
  assert.equal(suites.launched.length, 1);
  const o = suites.launched[0];
  assert.deepEqual([o.ref, o.previewRunId, o.jobNamePrefix, o.strict], [head, id, 'sv-unit-early', true],
    'the head itself, under the attempt\'s id and a Job name of its own');
  assert.equal(o.commitSha, head, 'its pass is recorded for reuse, for the commit it judged (services/unit-suite-reuse.js)');

  suites.jobs.add(id);
  assert.deepEqual(await workers[WORK.unitEarly].run(ctx(input)), { started: true, runId: id, joined: true },
    'a retry finds the Jobs it launched');
  suites.jobs.clear();
  suites.running = 2;
  assert.equal((await workers[WORK.unitEarly].run(ctx(input))).why, 'busy', 'not while the cluster runs as many as the queue admits');
  suites.running = 0;
  process.env.EARLY_UNIT_SUITE = '0';
  assert.equal((await workers[WORK.unitEarly].run(ctx(input))).why, 'off');
  delete process.env.EARLY_UNIT_SUITE;
  assert.equal((await handlers[WORK.unitEarly].run(ctx(input))).why, 'off', 'only where the worker runtime is Kubernetes');
  assert.equal(suites.launched.length, 1);

  // The checks run against the attempt is told where to find it; retiring
  // the attempt removes its Jobs.
  captured.length = 0;
  await workers[WORK.run].run(ctx({ ...input, runId: 'run-3-9', runtimeName: 'sv-preview-2-s5', url: 'https://shop--s5.apps' }));
  assert.equal(captured[0].unitRunId, id);
  calls.length = 0;
  await workers[WORK.retireAttempt].run(ctx({ sessionId: 5, appId: 2, appSlug: 'shop', n: 3, db: 'app_shop_staging_s5_333333' }));
  assert.ok(calls.some((c) => c[0] === 'delete-jobs' && c[1] === id), 'the attempt\'s early suite goes with it');
  calls.length = 0;
  await workers[WORK.retire].run(ctx({ sessionId: 5, appId: 2, appSlug: 'shop', runtimeName: 'sv-preview-2-s5', runtimeKind: 'kubernetes',
    attempts: [{ n: 3, db: 'db3' }] }));
  assert.ok(calls.some((c) => c[0] === 'delete-jobs' && c[1] === id), 'and with the whole preview');
});

// services/unit-suite-reuse.js: a head whose suite already passed under the
// same conditions, when nobody asked for a fresh run, has its pass copied by
// the checks run, so no early Jobs are started for it.
test('the unit suite does not start with the build for a head whose pass the checks run will copy', async () => {
  const k8s = require('../src/services/kubernetes');
  k8s.findCheckJobs = async () => ({ unitSuites: [] });
  k8s.countRunningUnitSuiteJobs = async () => 0;
  const workers = previewServices({ config: { captureRuntime: 'kubernetes', workerRuntime: 'kubernetes', kubernetes: {} }, pool });
  suites.preparing = true;
  suites.launched.length = 0;
  suites.asked.length = 0;
  suites.reusable = { reused: { runId: 'run-a', sessionId: 4, passedAt: new Date().toISOString() } };
  const input = { sessionId: 5, appId: 2, n: 7, head, trigger: 'stuck-sweep' };
  assert.deepEqual(await workers[WORK.unitEarly].run(ctx(input)), { started: false, why: 'reused' });
  assert.equal(suites.launched.length, 0);
  assert.deepEqual([suites.asked[0].commitSha, suites.asked[0].trigger, suites.asked[0].sessionId, suites.asked[0].appId],
    [head, 'stuck-sweep', 5, 2], 'asked with the head, the trigger of the run it is for, and the proposal');
  // Nothing to copy (a person's request among the reasons): the suite starts.
  suites.reusable = null;
  assert.equal((await workers[WORK.unitEarly].run(ctx({ ...input, trigger: 'manual-recheck' }))).started, true);
  assert.equal(suites.asked[1].trigger, 'manual-recheck');
  assert.equal(suites.launched.length, 1);
  suites.preparing = false;
});

test('a run claimed again asks for its checks slot as of the place the earlier claim had', async () => {
  const input = { sessionId: 5, appId: 2, n: 1, head, runId: 'run-1-8', trigger: 'commit-push',
    runtimeName: 'sv-preview-2-s5', runtimeKind: 'kubernetes', url: 'https://shop--s5.apps' };
  collected.next = null;
  runs.queuedAt = '2026-10-15T12:00:00.000Z';
  captured.length = 0;
  await handlers[WORK.run].run(ctx(input, { attempt: 2 }));
  assert.equal(captured[0].queuedSince, '2026-10-15T12:00:00.000Z');
  captured.length = 0;
  await handlers[WORK.run].run(ctx(input));
  assert.equal(captured[0].queuedSince, null, 'a first claim joins the back of the line');
  delete runs.queuedAt;
});
