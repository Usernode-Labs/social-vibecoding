'use strict';

// The cluster's own ceilings (src/services/platform-capacity.js): the
// database's disk from Prometheus, each namespace's quota and the nodes'
// volume pools from the Kubernetes API. Every read is stubbed at its edge
// (fetch, the kubernetes module); the parsing and the choices are real.

const test = require('node:test');
const assert = require('node:assert/strict');

const capacity = require('../src/services/platform-capacity');

const K8S = {
  appRuntime: 'kubernetes',
  databaseUrl: 'postgres://homeroom:secret@social-postgres-refresh-20260909-rw.social-refresh.svc.cluster.local:5432/social',
  kubernetes: {
    appNamespace: 'social-apps',
    workerNamespace: 'social-workers',
    buildNamespace: 'social-builds',
    checkPoolMetricsUrl: 'http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090',
  },
};
const ENV = { env: {} };
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

test('the database cluster is read off a CloudNativePG service host, and nothing else', () => {
  assert.deepEqual(capacity.databaseCluster(K8S.databaseUrl),
    { cluster: 'social-postgres-refresh-20260909', namespace: 'social-refresh' });
  assert.deepEqual(capacity.databaseCluster('postgres://u:p@social-postgres-ro.data.svc:5432/x'),
    { cluster: 'social-postgres', namespace: 'data' });
  assert.equal(capacity.databaseCluster('postgres://u:p@localhost:5432/x'), null);
  assert.equal(capacity.databaseCluster('postgres://u:p@db.example.com:5432/x'), null);
  assert.equal(capacity.databaseCluster('postgres://u:p@pooler-rw.data.svc.example.com/x'), null);
  assert.equal(capacity.databaseCluster(''), null);
});

test('the limits apply only on Kubernetes, never in a staging preview', () => {
  for (const key of capacity.KEYS) {
    assert.equal(capacity.enabled(K8S, key, {}), true, `${key} on Kubernetes`);
    assert.equal(capacity.enabled({ ...K8S, appRuntime: 'docker' }, key, {}), false, `${key} off Kubernetes`);
    assert.equal(capacity.enabled(K8S, key, { USERNODE_ENV: 'staging' }), false, `${key} in a preview`);
  }
  const noMetrics = { ...K8S, kubernetes: { ...K8S.kubernetes, checkPoolMetricsUrl: '' } };
  assert.equal(capacity.enabled(noMetrics, 'db_disk', {}), false, 'no Prometheus, no disk figure');
  assert.equal(capacity.enabled({ ...K8S, databaseUrl: 'postgres://u:p@localhost/x' }, 'db_disk', {}), false);
  const shared = { ...K8S, kubernetes: { ...K8S.kubernetes, buildNamespace: 'social-workers' } };
  assert.equal(capacity.enabled(shared, 'quota_workers', {}), true);
  assert.equal(capacity.enabled(shared, 'quota_builds', {}), false, 'one namespace is one quota');
});

test('the database disk is the fullest of its instances\' data and WAL claims, in MiB', async () => {
  const asked = [];
  const sample = (claim, value) => ({ metric: { persistentvolumeclaim: claim }, value: [1, String(value)] });
  const fetch = async (url) => {
    const query = url.searchParams.get('query');
    asked.push({ host: url.host, path: url.pathname, query });
    const used = /used_bytes/.test(query);
    return {
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'vector', result: used
        ? [sample('social-postgres-refresh-20260909-1', 30 * GiB), sample('social-postgres-refresh-20260909-1-wal', 9 * GiB)]
        : [sample('social-postgres-refresh-20260909-1', 50 * GiB), sample('social-postgres-refresh-20260909-1-wal', 10 * GiB)] } }),
    };
  };
  const out = await capacity.measure(K8S, 'db_disk', { ...ENV, fetch });
  assert.deepEqual(out, { used: 9 * 1024, cap: 10 * 1024, detail: { volume: 'social-postgres-refresh-20260909-1-wal' } },
    'the WAL claim is 90% full, the data claim 60%: the WAL claim is the figure');
  assert.equal(asked.length, 2);
  assert.ok(asked.every((a) => a.host === 'kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090' && a.path === '/api/v1/query'));
  assert.ok(asked.every((a) => a.query.includes(
    'namespace="social-refresh",persistentvolumeclaim=~"social-postgres-refresh-20260909-[0-9]+(-wal)?"')));
});

test('a disk read that answers nothing, or badly, throws so the row says it could not check', async () => {
  const empty = async () => ({ ok: true, json: async () => ({ status: 'success', data: { resultType: 'vector', result: [] } }) });
  await assert.rejects(capacity.measure(K8S, 'db_disk', { ...ENV, fetch: empty }), /no volume figures/);
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(capacity.measure(K8S, 'db_disk', { ...ENV, fetch: down }), /Prometheus answered 503/);
});

test('a namespace\'s quota is its tightest resource, in thousandths, with that resource\'s own figures', () => {
  const out = capacity.tightestQuota({ namespace: 'social-workers', resources: {
    pods: { used: '30', hard: '120', percent: 25 },
    requestsCpu: { used: '44', hard: '48', percent: 91.7 },
    requestsMemory: { used: '150Gi', hard: '192Gi', percent: 78.1 },
    secrets: null,
  } });
  assert.deepEqual(out, { used: 917, cap: 1000, detail: { namespace: 'social-workers', resource: 'cpu', used: '44', hard: '48' } });
  assert.equal(capacity.tightestQuota({ namespace: 'x', resources: null }), null, 'no quota, no row');
  assert.equal(capacity.tightestQuota({ namespace: 'x', resources: { pods: null } }), null);
  assert.equal(capacity.tightestQuota({ namespace: 'x', resources: { pods: { used: '9', hard: '1', percent: 5000 } } }).used, 9999,
    'clamped so its notice token fits');
});

test('the three quotas share one read, and an unreadable namespace throws', async () => {
  capacity.resetForTests();
  let reads = 0;
  const kubernetes = {
    listNamespaceCapacity: async () => {
      reads += 1;
      return [
        { namespace: 'social-apps', resources: { pods: { used: '340', hard: '360', percent: 94.4 } } },
        { namespace: 'social-workers', resources: null },
        { namespace: 'social-builds', unavailable: true, resources: null },
      ];
    },
  };
  const apps = await capacity.measure(K8S, 'quota_apps', { ...ENV, kubernetes });
  assert.equal(apps.used, 944);
  assert.equal(await capacity.measure(K8S, 'quota_workers', { ...ENV, kubernetes }), null, 'no quota there');
  await assert.rejects(capacity.measure(K8S, 'quota_builds', { ...ENV, kubernetes }), /social-builds quota could not be read/);
  assert.equal(reads, 3, 'an injected kubernetes is read each time (the held read is for the real one)');
});

test('the node pool is the fullest node\'s openebs-vg, and a 403 hides it until the grant exists', async () => {
  capacity.resetForTests();
  const items = [
    { metadata: { name: 'fsn1-worker-1' }, volumeGroups: [{ name: 'openebs-vg', size: '1000Gi', free: '600Gi' }] },
    { metadata: { name: 'hel1-worker-2' }, volumeGroups: [{ name: 'other', size: '10Gi', free: '0' },
      { name: 'openebs-vg', size: '500Gi', free: '50Gi' }] },
    { metadata: { name: 'no-vg' }, volumeGroups: [] },
  ];
  const out = await capacity.measure(K8S, 'node_pool', { ...ENV, kubernetes: { listVolumePools: async () => items } });
  assert.deepEqual(out, { used: 450 * 1024, cap: 500 * 1024, detail: { node: 'hel1-worker-2' } });
  const forbidden = Object.assign(new Error('lvmnodes.local.openebs.io is forbidden'), { code: 403 });
  assert.equal(await capacity.measure(K8S, 'node_pool', { ...ENV, kubernetes: { listVolumePools: async () => { throw forbidden; } } }), null);
  const missing = Object.assign(new Error('not found'), { response: { statusCode: 404 } });
  assert.equal(await capacity.measure(K8S, 'node_pool', { ...ENV, kubernetes: { listVolumePools: async () => { throw missing; } } }), null);
  const boom = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
  await assert.rejects(capacity.measure(K8S, 'node_pool', { ...ENV, kubernetes: { listVolumePools: async () => { throw boom; } } }), /refused/);
  await assert.rejects(capacity.measure(K8S, 'node_pool', { ...ENV, kubernetes: { listVolumePools: async () => [items[2]] } }),
    /no node reports the openebs-vg volume group/);
});

test('the LVMNode read is a plain list in openebs, and the module never writes to the cluster', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const k8s = fs.readFileSync(path.join(__dirname, '..', 'src/services/kubernetes.js'), 'utf8');
  const body = k8s.slice(k8s.indexOf('async function listVolumePools()'), k8s.indexOf('// `onStdoutLine(line)`'));
  assert.match(body, /group: 'local\.openebs\.io', version: 'v1alpha1', namespace: 'openebs', plural: 'lvmnodes'/);
  assert.doesNotMatch(body, /create|replace|patch|delete/i);
  const own = fs.readFileSync(path.join(__dirname, '..', 'src/services/platform-capacity.js'), 'utf8');
  assert.doesNotMatch(own, /\.(create|replace|patch|delete)Namespaced/);
});
