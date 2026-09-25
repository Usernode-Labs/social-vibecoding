'use strict';

// Worker state volumes and the worker namespace's volume quota.
//
// Change 4952 ("Work on request #16") could not start its coding agent: the
// namespace allowed 120 worker volume claims and held 120. Open changes keep
// their volume indefinitely and archived ones for the retention window, and
// visual-evidence runs on merged changes claimed fresh volumes the merge had
// already freed. So a new claim that the quota refuses now frees a few idle
// volumes and retries, the hourly sweep frees merged changes' volumes, and an
// evidence run no longer starts on a closed change.
//
// Run with: node --test tests/worker-volume-reclaim.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const reclaim = require('../src/services/worker-volume-reclaim');
const kubernetes = require('../src/services/kubernetes');
const orchestrator = require('../src/services/visual-evidence-orchestrator');

const NOW = Date.parse('2026-09-25T13:00:00Z');
const HOUR = 60 * 60 * 1000;
const at = (ms) => new Date(NOW - ms).toISOString();

function volume(sessionId, extra = {}) {
  return { name: `sv-worker-s${sessionId}-state`, sessionId, createdAt: at(24 * HOUR), terminating: false, attached: false, ...extra };
}

function recordingPool(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (/FROM chat_sessions WHERE id = ANY/.test(sql)) {
        return { rows: rows.filter((row) => params[0].includes(row.id)) };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function fakes({ volumes, busy = [] }) {
  const destroyed = [];
  return {
    destroyed,
    deps: {
      now: () => NOW,
      worker: {
        listWorkerVolumes: async () => volumes,
        destroyCcVolume: async (id) => { destroyed.push(id); },
      },
      activeWorkers: { isSessionBusy: (id) => busy.includes(id) },
    },
  };
}

const ROWS = [
  { id: 1, status: 'paused', last_activity_at: at(72 * HOUR) },
  { id: 2, status: 'merged', merged_at: at(2 * HOUR), last_activity_at: at(3 * HOUR) },
  { id: 3, status: 'archived', archived_at: at(48 * HOUR), last_activity_at: at(50 * HOUR) },
  { id: 4, status: 'merged', merged_at: at(96 * HOUR), last_activity_at: at(97 * HOUR) },
  { id: 5, status: 'active', last_activity_at: at(10 * 60 * 1000) },
  { id: 6, status: 'promoted', last_activity_at: at(5 * HOUR) },
  { id: 7, status: 'merging', last_activity_at: at(5 * HOUR) },
];

test('under pressure, merged changes\' volumes go first, then archived, then the idlest open ones', async () => {
  const volumes = ROWS.map((row) => volume(row.id));
  const pool = recordingPool(ROWS);
  const { deps, destroyed } = fakes({ volumes });
  const freed = await reclaim.reclaimWorkerVolumes({ pool, excludeSessionId: 9, limit: 10, deps });
  assert.deepEqual(destroyed, [4, 2, 3, 1, 6],
    'oldest merge first; a change active ten minutes ago and one mid-merge are left alone');
  assert.deepEqual(freed.map((item) => item.status), ['merged', 'merged', 'archived', 'paused', 'promoted']);
  const purged = pool.calls.filter((c) => /SET cc_purged = TRUE/.test(c.sql)).map((c) => c.params[0]);
  assert.deepEqual(purged, [4, 2, 3], 'only a closed change is marked purged; an open one just starts fresh');
});

test('a pressure reclaim frees a small batch, not every candidate', async () => {
  const { deps, destroyed } = fakes({ volumes: ROWS.map((row) => volume(row.id)) });
  await reclaim.reclaimWorkerVolumes({ pool: recordingPool(ROWS), deps });
  assert.equal(destroyed.length, reclaim.PRESSURE_BATCH);
});

test('a mounted, terminating, busy, requesting or unknown change\'s volume is never taken', async () => {
  const rows = [
    { id: 10, status: 'merged', merged_at: at(HOUR) },
    { id: 11, status: 'merged', merged_at: at(HOUR) },
    { id: 12, status: 'merged', merged_at: at(HOUR) },
    { id: 13, status: 'merged', merged_at: at(HOUR) },
  ];
  const volumes = [
    volume(10, { attached: true }),
    volume(11, { terminating: true }),
    volume(12),
    volume(13),
    volume(14),
  ];
  const { deps, destroyed } = fakes({ volumes, busy: [12] });
  const freed = await reclaim.reclaimWorkerVolumes({ pool: recordingPool(rows), excludeSessionId: 13, limit: 10, deps });
  assert.deepEqual(freed, []);
  assert.deepEqual(destroyed, [], 'change 14 has no row here: it may belong to another deployment');
});

test('the sweep frees only merged changes\' volumes', async () => {
  const { deps, destroyed } = fakes({ volumes: ROWS.map((row) => volume(row.id)) });
  await reclaim.reclaimWorkerVolumes({ pool: recordingPool(ROWS), mode: 'closed', limit: 50, deps });
  assert.deepEqual(destroyed, [4, 2]);
});

test('one volume that will not delete does not stop the rest', async () => {
  const { deps, destroyed } = fakes({ volumes: ROWS.map((row) => volume(row.id)) });
  deps.worker.destroyCcVolume = async (id) => {
    if (id === 4) throw new Error('api down');
    destroyed.push(id);
  };
  const freed = await reclaim.reclaimWorkerVolumes({ pool: recordingPool(ROWS), deps });
  assert.deepEqual(freed.map((item) => item.sessionId), [2, 3]);
});

// ── Kubernetes: the claim, the retry, the inventory ────────────────────

function config() {
  return {
    workerContractVersion: 'v6',
    kubernetes: {
      workerNamespace: 'social-workers', workerServiceAccount: 'social-worker',
      workerImage: 'ghcr.io/example/social-worker@sha256:cafe', workerStorageClass: 'openebs-lvm-retain',
      workerStorageSize: '5Gi',
    },
  };
}

function notFound() {
  return Object.assign(new Error('not found'), { code: 404 });
}

function quotaError() {
  return Object.assign(new Error('HTTP-Code: 403\nMessage: Forbidden\nBody: {"message":"persistentvolumeclaims '
    + '\\"sv-worker-s42-state\\" is forbidden: exceeded quota: social-vibecoding, requested: persistentvolumeclaims=1, '
    + 'used: persistentvolumeclaims=120, limited: persistentvolumeclaims=120"}'), { code: 403 });
}

function workerClients({ claim }) {
  const written = [];
  const record = (kind) => async ({ body }) => { written.push(kind); return body; };
  kubernetes._setClientsForTest({
    core: {
      createNamespacedPersistentVolumeClaim: async (args) => { await claim(); return record('PersistentVolumeClaim')(args); },
      readNamespacedSecret: async () => { throw notFound(); },
      createNamespacedSecret: record('Secret'),
      listNamespacedPod: async () => ({ items: [{
        metadata: { name: 'worker-pod', annotations: { 'social.usernode.io/env-checksum': kubernetes._envChecksumForTest({}) } },
        spec: { containers: [{ name: 'worker', image: config().kubernetes.workerImage }] },
        status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }],
          containerStatuses: [{ name: 'worker', ready: true, state: { running: {} } }] },
      }] }),
      readNamespacedPodLog: async () => '__USERNODE_PHASE__ warm-ready',
    },
    apps: {
      readNamespacedDeployment: async ({ name }) => {
        if (written.includes('Deployment')) {
          return { metadata: { name, generation: 1 }, status: { observedGeneration: 1, replicas: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 } };
        }
        throw notFound();
      },
      createNamespacedDeployment: record('Deployment'),
    },
  });
  return written;
}

test.afterEach(() => kubernetes._setClientsForTest(null));

test('a claim the quota refuses frees other volumes, then retries until the quota catches up', async () => {
  let attempts = 0;
  const written = workerClients({ claim: async () => { attempts += 1; if (attempts <= 2) throw quotaError(); } });
  const asked = [];
  const result = await kubernetes.ensureWorker(config(), {
    sessionId: 42, env: {}, retryDelayMs: 1,
    reclaimVolumes: async (args) => { asked.push(args); return 3; },
  });
  assert.deepEqual(asked, [{ sessionId: 42 }]);
  assert.equal(attempts, 3, 'the first retry can still see the old usage');
  assert.deepEqual(written, ['PersistentVolumeClaim', 'Secret', 'Deployment']);
  assert.equal(result.pvcName, 'sv-worker-s42-state');
});

test('the quota refusal stands when nothing could be freed, and other refusals are never retried', async () => {
  workerClients({ claim: async () => { throw quotaError(); } });
  await assert.rejects(
    kubernetes.ensureWorker(config(), { sessionId: 42, env: {}, retryDelayMs: 1, reclaimVolumes: async () => 0 }),
    /exceeded quota/
  );

  let reclaimed = 0;
  workerClients({ claim: async () => { throw Object.assign(new Error('HTTP-Code: 403\nMessage: Forbidden'), { code: 403 }); } });
  await assert.rejects(
    kubernetes.ensureWorker(config(), { sessionId: 42, env: {}, retryDelayMs: 1, reclaimVolumes: async () => { reclaimed += 1; return 3; } }),
    /Forbidden/
  );
  assert.equal(reclaimed, 0);
});

test('the volume inventory names each change\'s state claim and whether a worker still mounts it', async () => {
  let selector;
  kubernetes._setClientsForTest({
    core: {
      listNamespacedPersistentVolumeClaim: async (args) => {
        selector = args.labelSelector;
        return { items: [
          { metadata: { name: 'sv-worker-s1-state', labels: { 'social.usernode.io/session-id': '1' }, creationTimestamp: '2026-09-20T00:00:00Z' } },
          { metadata: { name: 'sv-worker-s2-state', labels: { 'social.usernode.io/session-id': '2' }, deletionTimestamp: '2026-09-25T00:00:00Z' } },
          { metadata: { name: 'sv-worker-copy-scratch', labels: { 'social.usernode.io/session-id': '3' } } },
        ] };
      },
    },
    apps: {
      listNamespacedDeployment: async () => ({ items: [{ metadata: { name: 'sv-worker-s1' } }] }),
    },
  });
  const volumes = await kubernetes.listWorkerVolumes(config());
  assert.match(selector, /social\.usernode\.io\/environment=worker/);
  assert.deepEqual(volumes, [
    { name: 'sv-worker-s1-state', sessionId: 1, createdAt: '2026-09-20T00:00:00Z', terminating: false, attached: true },
    { name: 'sv-worker-s2-state', sessionId: 2, createdAt: null, terminating: true, attached: false },
  ]);
});

// ── Visual evidence on a closed change ─────────────────────────────────

for (const status of ['merged', 'archived']) {
  test(`no evidence run starts on a ${status} change`, async () => {
    const created = [];
    const pool = {
      async query() {
        return { rows: [{ id: 4649, status, app_slug: 'rss', repo_url: 'https://github.com/o/r', visual_evidence_detail: { required: true, intent: {} } }] };
      },
    };
    const result = await orchestrator.scheduleForSession(
      { visualEvidence: { execute: true } },
      { pool, sessionId: 4649, headSha: 'a'.repeat(40), trigger: 'checks-harvested' },
      { state: { createRun: async (...args) => { created.push(args); return { run: {}, created: true }; } } }
    );
    assert.deepEqual(result, { scheduled: false, reason: 'closed' });
    assert.equal(created.length, 0);
  });
}
