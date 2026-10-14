'use strict';

// The worker namespace's leftover sweep (services/check-retention.js): what
// it may delete, what it must never delete, and how it is bounded and run.
//
// On 7 Oct 2026 the namespace held 197 of its 200 Secrets: 130 ownerless
// check input Secrets and 7 more still named by finished check Pods whose
// Job was gone. Proposal checks then failed to start with "exceeded quota".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const kubernetes = require('../src/services/kubernetes');
const retention = require('../src/services/check-retention');

const NOW = Date.parse('2026-10-08T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const ago = (ms) => new Date(NOW - ms);
const MANAGED = { 'app.kubernetes.io/managed-by': 'social-vibecoding-runtime' };
const config = { captureRuntime: 'kubernetes', workerRuntime: 'kubernetes', kubernetes: { workerNamespace: 'social-workers' } };

let serial = 0;
function secret(name, over = {}) {
  serial += 1;
  return {
    metadata: { name, uid: `uid-${name}`, resourceVersion: String(serial), creationTimestamp: ago(3 * HOUR), labels: { ...MANAGED }, ...over.metadata },
    type: over.type ?? 'Opaque',
  };
}

function job(name, over = {}) {
  return { metadata: { name, uid: `job-uid-${name}`, labels: { ...MANAGED } }, spec: { template: { spec: over.spec || {} } }, status: over.status || {} };
}

function pod(name, jobName, over = {}) {
  serial += 1;
  return {
    metadata: {
      name, uid: `pod-uid-${name}`, resourceVersion: String(serial), creationTimestamp: ago(3 * HOUR),
      labels: { ...MANAGED, ...(jobName ? { 'job-name': jobName, 'batch.kubernetes.io/job-name': jobName } : {}) },
      ...over.metadata,
    },
    spec: over.spec || {},
    status: over.status || {
      phase: 'Succeeded',
      containerStatuses: [{ name: 'capture', state: { terminated: { exitCode: 0, finishedAt: ago(2 * HOUR) } } }],
    },
  };
}

const names = (entries) => entries.map((entry) => entry.name);

test('an ownerless check input Secret past the age floor that nothing names is deleted, oldest first', () => {
  const inventory = {
    jobs: [], pods: [],
    secrets: [
      secret('sv-unit-suite-s42-run-b-input', { metadata: { creationTimestamp: ago(5 * HOUR) } }),
      secret('sv-capture-s42-run-a-input', { metadata: { creationTimestamp: ago(30 * 24 * HOUR) } }),
      // main-watch's suite runs under `main-<appId>` rather than a session id.
      secret('sv-unit-suite-smain-7-mgp2x1-input', { metadata: { creationTimestamp: '2026-10-08T08:00:00Z' } }),
    ],
  };
  const { secrets, pods } = retention.select(inventory, NOW);
  assert.deepEqual(names(secrets), ['sv-capture-s42-run-a-input', 'sv-unit-suite-s42-run-b-input', 'sv-unit-suite-smain-7-mgp2x1-input']);
  assert.deepEqual(pods, []);
  assert.deepEqual(secrets[0].metadata, inventory.secrets[1].metadata, 'the delete carries the object it judged');
});

test('a worker env Secret, an owned Secret and anything young, referenced or not ours is never deleted', () => {
  const referencedByVolume = 'sv-capture-s1-a-input';
  const referencedByEnv = 'sv-unit-suite-s2-b-input';
  const referencedByEnvFrom = 'sv-unit-suite-s3-c-input';
  const referencedByJobOnly = 'sv-capture-s4-d-input';
  const inventory = {
    jobs: [
      // Admitted, but its Pod is not created yet (a CPU quota refusal, say):
      // the template still needs the Secret.
      job('sv-capture-s4-d', { spec: { volumes: [{ name: 'capture-input', secret: { secretName: referencedByJobOnly } }] } }),
    ],
    pods: [
      pod('sv-capture-s1-a-x1', null, { spec: { volumes: [{ name: 'capture-input', secret: { secretName: referencedByVolume } }] }, status: { phase: 'Running' } }),
      pod('sv-unit-suite-s2-b-x2', null, { spec: { containers: [{ name: 'unit-suite', env: [{ name: 'REPO_URL', valueFrom: { secretKeyRef: { name: referencedByEnv, key: 'REPO_URL' } } }] }] } }),
      pod('sv-unit-suite-s3-c-x3', null, { spec: { containers: [{ name: 'unit-suite', envFrom: [{ secretRef: { name: referencedByEnvFrom } }] }] } }),
    ],
    secrets: [
      // A dormant worker with a volume may still need its env Secret.
      secret('sv-worker-s12-env', { metadata: { creationTimestamp: ago(40 * 24 * HOUR) } }),
      secret('sv-capture-s5-e-input', { metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'sv-capture-s5-e', uid: 'gone-or-not' }] } }),
      secret('sv-capture-s6-f-input', { metadata: { creationTimestamp: ago(2 * HOUR - 1) } }),
      secret(referencedByVolume), secret(referencedByEnv), secret(referencedByEnvFrom), secret(referencedByJobOnly),
      secret('sv-capture-s7-g-input', { metadata: { labels: { 'app.kubernetes.io/managed-by': 'someone-else' } } }),
      secret('sv-capture-s8-h-input', { metadata: { labels: {} } }),
      secret('sv-capture-s9-i-input', { type: 'kubernetes.io/dockerconfigjson' }),
      secret('sv-capture-s10-j-input', { metadata: { deletionTimestamp: ago(1000) } }),
      secret('sv-capture-s11-k-input', { metadata: { creationTimestamp: undefined } }),
      secret('sv-capture-s13-env'),
      secret('sv-preview-12-s13-env'),
    ],
  };
  assert.deepEqual(retention.select(inventory, NOW).secrets, []);
});

test('a finished check Pod whose Job is gone is deleted once it finished a Job TTL ago', () => {
  const ttl = kubernetes.CHECK_JOB_TTL_SECONDS * 1000;
  assert.equal(ttl, HOUR, 'the Job TTL the floor follows (services/kubernetes.js)');
  const inventory = {
    jobs: [], secrets: [],
    pods: [
      // Orphaned outright: the Job was deleted without a policy and its owner stripped.
      pod('sv-capture-s42-run-a-abcde', 'sv-capture-s42-run-a'),
      // Its Job is gone, the owner reference dangling.
      pod('sv-unit-suite-s42-run-a-fghij', 'sv-unit-suite-s42-run-a', {
        metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'sv-unit-suite-s42-run-a', uid: 'deleted-uid' }] },
        status: { phase: 'Failed', containerStatuses: [{ name: 'unit-suite', state: { terminated: { exitCode: 1, finishedAt: ago(ttl) } } }] },
      }),
      // No finish recorded: aged from its creation, two hours.
      pod('sv-capture-s43-run-b-klmno', 'sv-capture-s43-run-b', { status: { phase: 'Failed' } }),
    ],
  };
  const { pods, secrets } = retention.select(inventory, NOW);
  assert.deepEqual(names(pods), ['sv-capture-s43-run-b-klmno', 'sv-capture-s42-run-a-abcde', 'sv-unit-suite-s42-run-a-fghij']);
  assert.deepEqual(secrets, []);
});

test('a running Pod, a Pod whose Job exists, a recent finish and anything not a check Pod is never deleted', () => {
  const live = job('sv-capture-s50-live');
  const inventory = {
    jobs: [live, job('sv-unit-suite-s51-named')],
    secrets: [],
    pods: [
      pod('sv-capture-s52-run-abcde', 'sv-capture-s52-run', { status: { phase: 'Running' } }),
      pod('sv-capture-s53-run-abcde', 'sv-capture-s53-run', { status: { phase: 'Pending' } }),
      pod('sv-capture-s50-live-abcde', 'sv-capture-s50-live', {
        metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'sv-capture-s50-live', uid: live.metadata.uid }] },
      }),
      // The Job's own TTL is about to take these two; they are its, not ours.
      pod('sv-capture-s50-renamed-abcde', 'sv-capture-s50-other', {
        metadata: { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'Job', name: 'sv-capture-s50-live', uid: live.metadata.uid }] },
      }),
      pod('sv-unit-suite-s51-named-abcde', 'sv-unit-suite-s51-named'),
      pod('sv-capture-s54-run-abcde', 'sv-capture-s54-run', {
        status: { phase: 'Succeeded', containerStatuses: [{ name: 'capture', state: { terminated: { finishedAt: ago(HOUR - 1) } } }] },
      }),
      pod('sv-capture-s55-run-abcde', 'sv-capture-s55-run', { metadata: { creationTimestamp: ago(2 * HOUR - 1) }, status: { phase: 'Failed' } }),
      pod('sv-worker-s12-abcde', null),
      pod('sv-worker-copy-1-2-abcde', 'sv-worker-copy-1-2-x'),
      pod('bk-12-s42-abcde', 'bk-12-s42'),
      pod('sv-capture-s56-run-abcde', 'sv-capture-s56-run', { metadata: { labels: { 'job-name': 'sv-capture-s56-run' } } }),
      pod('sv-capture-s57-run-abcde', 'sv-capture-s57-run', {
        metadata: { ownerReferences: [{ apiVersion: 'v1', kind: 'ReplicationController', name: 'x', uid: 'rc' }] },
      }),
      pod('sv-capture-s58-run-abcde', 'sv-capture-s58-run', { metadata: { deletionTimestamp: ago(1000) } }),
    ],
  };
  assert.deepEqual(retention.select(inventory, NOW).pods, []);
});

function fakeRuntime(inventory, { fail = {} } = {}) {
  const calls = { lists: 0, deletes: [] };
  return {
    calls,
    async listCheckLeftovers(cfg) {
      assert.equal(cfg, config);
      calls.lists += 1;
      return inventory;
    },
    async deleteCheckLeftover(cfg, kind, metadata) {
      assert.equal(cfg, config);
      calls.deletes.push(`${kind}/${metadata.name}`);
      if (fail[metadata.name]) throw fail[metadata.name];
    },
  };
}

test('a pass deletes at most MAX_DELETIONS, Secrets first, and reports what it did', async () => {
  const many = Array.from({ length: retention.MAX_DELETIONS + 5 }, (_, i) =>
    secret(`sv-capture-s${100 + i}-r-input`, { metadata: { creationTimestamp: ago(3 * HOUR + i * 1000) } }));
  const inventory = { jobs: [], pods: [pod('sv-capture-s9-r-abcde', 'sv-capture-s9-r')], secrets: many };
  const runtime = fakeRuntime(inventory);
  const result = await retention.sweep(config, { now: NOW, runtime });
  assert.equal(runtime.calls.deletes.length, retention.MAX_DELETIONS);
  assert.ok(runtime.calls.deletes.every((entry) => entry.startsWith('secret/')), 'the Secrets the quota counts go first');
  assert.equal(runtime.calls.deletes[0], `secret/sv-capture-s${100 + retention.MAX_DELETIONS + 4}-r-input`, 'oldest first');
  assert.deepEqual(result.deleted, runtime.calls.deletes);
  assert.deepEqual(result.eligible, { secrets: retention.MAX_DELETIONS + 5, pods: 1 });
  assert.deepEqual(result.examined, { jobs: 0, pods: 1, secrets: retention.MAX_DELETIONS + 5 });
});

test('an object already gone or changed since the read is skipped; any other refusal stops the pass', async () => {
  const inventory = {
    jobs: [], pods: [],
    secrets: [
      secret('sv-capture-s1-a-input', { metadata: { creationTimestamp: ago(6 * HOUR) } }),
      secret('sv-capture-s2-b-input', { metadata: { creationTimestamp: ago(5 * HOUR) } }),
      secret('sv-capture-s3-c-input', { metadata: { creationTimestamp: ago(4 * HOUR) } }),
      secret('sv-capture-s4-d-input', { metadata: { creationTimestamp: ago(3 * HOUR) } }),
    ],
  };
  const gone = Object.assign(new Error('not found'), { code: 404 });
  const changed = Object.assign(new Error('precondition failed'), { code: 409 });
  const forbidden = Object.assign(new Error('secrets is forbidden'), { code: 403 });
  const runtime = fakeRuntime(inventory, { fail: { 'sv-capture-s1-a-input': gone, 'sv-capture-s2-b-input': changed, 'sv-capture-s3-c-input': forbidden } });
  await assert.rejects(retention.sweep(config, { now: NOW, runtime }), /forbidden/);
  assert.deepEqual(runtime.calls.deletes, ['secret/sv-capture-s1-a-input', 'secret/sv-capture-s2-b-input', 'secret/sv-capture-s3-c-input']);
});

test('a dry run, a failed inventory and a runtime without Kubernetes delete nothing', async () => {
  const inventory = { jobs: [], pods: [], secrets: [secret('sv-capture-s1-a-input')] };
  const dry = fakeRuntime(inventory);
  const preview = await retention.sweep(config, { now: NOW, runtime: dry, dryRun: true });
  assert.deepEqual(preview.candidates, ['secret/sv-capture-s1-a-input']);
  assert.deepEqual(dry.calls.deletes, []);

  const broken = { listCheckLeftovers: async () => { throw new Error('pods is forbidden'); },
    deleteCheckLeftover: async () => assert.fail('nothing may be deleted without a complete inventory') };
  await assert.rejects(retention.sweep(config, { now: NOW, runtime: broken }), /forbidden/);

  const docker = { captureRuntime: 'docker', workerRuntime: 'docker', kubernetes: { workerNamespace: 'social-workers' } };
  const untouched = { listCheckLeftovers: async () => assert.fail('no cluster to read'), deleteCheckLeftover: async () => assert.fail('no cluster') };
  assert.deepEqual((await retention.sweep(docker, { now: NOW, runtime: untouched })).deleted, []);
});

test('the inventory reads every page, Secrets only the platform\'s own, and a bad page fails it whole', async (t) => {
  const requests = [];
  const paged = (kind, pages) => async (request) => {
    requests.push({ kind, ...request });
    const index = request._continue ? Number(request._continue) : 0;
    return { items: pages[index], metadata: { continue: index + 1 < pages.length ? String(index + 1) : undefined } };
  };
  kubernetes._setClientsForTest({
    batch: { listNamespacedJob: paged('jobs', [[{ metadata: { name: 'j1' } }], [{ metadata: { name: 'j2' } }]]) },
    core: {
      listNamespacedPod: paged('pods', [[{ metadata: { name: 'p1' } }]]),
      listNamespacedSecret: paged('secrets', [[{ metadata: { name: 's1' } }], [], [{ metadata: { name: 's2' } }]]),
    },
  });
  t.after(() => kubernetes._setClientsForTest(null));
  const inventory = await kubernetes.listCheckLeftovers(config);
  assert.deepEqual(names(inventory.jobs.map((j) => j.metadata)), ['j1', 'j2']);
  assert.deepEqual(names(inventory.pods.map((p) => p.metadata)), ['p1']);
  assert.deepEqual(names(inventory.secrets.map((s) => s.metadata)), ['s1', 's2']);
  assert.ok(requests.every((r) => r.namespace === 'social-workers' && r.limit === 500));
  assert.ok(requests.filter((r) => r.kind === 'secrets').every((r) => r.labelSelector === 'app.kubernetes.io/managed-by=social-vibecoding-runtime'));
  assert.ok(requests.filter((r) => r.kind !== 'secrets').every((r) => r.labelSelector === undefined),
    'every Job and Pod counts as a reference, whoever made it');

  kubernetes._setClientsForTest({
    batch: { listNamespacedJob: async () => ({ items: [] }) },
    core: { listNamespacedPod: async () => ({ kind: 'Status' }), listNamespacedSecret: async () => ({ items: [] }) },
  });
  await assert.rejects(kubernetes.listCheckLeftovers(config), /Invalid listNamespacedPod inventory/);
});

test('a delete names the exact object judged: its UID and resourceVersion as preconditions', async (t) => {
  const deleted = [];
  kubernetes._setClientsForTest({ core: {
    deleteNamespacedSecret: async (request) => { deleted.push(['secret', request]); },
    deleteNamespacedPod: async (request) => { deleted.push(['pod', request]); },
  } });
  t.after(() => kubernetes._setClientsForTest(null));
  await kubernetes.deleteCheckLeftover(config, 'secret', { name: 'sv-capture-s1-a-input', uid: 'u1', resourceVersion: '7' });
  await kubernetes.deleteCheckLeftover(config, 'pod', { name: 'sv-capture-s1-a-abcde', uid: 'u2', resourceVersion: '8' });
  assert.deepEqual(deleted, [
    ['secret', { name: 'sv-capture-s1-a-input', namespace: 'social-workers', body: { preconditions: { uid: 'u1', resourceVersion: '7' } } }],
    ['pod', { name: 'sv-capture-s1-a-abcde', namespace: 'social-workers', body: { preconditions: { uid: 'u2', resourceVersion: '8' } } }],
  ]);
  await assert.rejects(kubernetes.deleteCheckLeftover(config, 'secret', { name: 'x', uid: 'u' }), /UID and resourceVersion/);
  await assert.rejects(kubernetes.deleteCheckLeftover(config, 'job', { name: 'x', uid: 'u', resourceVersion: '1' }), /Unknown check leftover kind/);
});

test('the scheduler sweeps at once, then every interval, and nothing after stop', async (t) => {
  await retention.stop();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const list = t.mock.method(kubernetes, 'listCheckLeftovers', async () => ({ jobs: [], pods: [], secrets: [] }));
  const moduleId = require.resolve('../src/services/check-retention');
  const cached = require.cache[moduleId];
  delete require.cache[moduleId];
  const scheduler = require(moduleId);
  t.after(async () => { await scheduler.stop(); require.cache[moduleId] = cached; });
  scheduler.start({ ...config, captureRuntime: 'docker', workerRuntime: 'docker' });
  assert.equal(list.mock.callCount(), 0, 'no Kubernetes runtime, no sweep');
  scheduler.start(config);
  scheduler.start(config);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(list.mock.callCount(), 1, 'one pass at start, however often start is called');
  t.mock.timers.tick(scheduler.INTERVAL_MS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(list.mock.callCount(), 2);
  await scheduler.stop();
  t.mock.timers.tick(scheduler.INTERVAL_MS * 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(list.mock.callCount(), 2);
});

test('the sweep runs on the leader only and stops before leadership is handed over', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const leader = server.slice(server.indexOf('async function becomeLeader()'), server.indexOf('async function start()'));
  const boot = server.slice(server.indexOf('async function start()'), server.indexOf('// Boot only when run as the entry point'));
  assert.ok(leader.includes("require('./src/services/check-retention').start(config)"));
  assert.ok(!boot.includes('check-retention'), 'a follower serves HTTP; it never sweeps');
  const cleanup = server.slice(server.indexOf('async function cleanup()'));
  const stopAt = cleanup.indexOf("require('./src/services/check-retention').stop()");
  assert.ok(stopAt !== -1, 'cleanup stops the sweep');
  assert.ok(/Promise\.all\(\[[^\]]*checkRetentionStop[^\]]*\]\)/.test(cleanup), 'and waits for a pass in flight');
  assert.ok(stopAt < cleanup.lastIndexOf('leadership.stop()'), 'before the standby can promote');
});
