'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inventory, observe, validatePools } = require('../src/services/database-pools');
const now = 1800000000000;
const target = { id: 'shared', namespace: 'sv-db-shared', clusterName: 'shared', profile: 'retained' };
const config = { prometheusUrl: 'http://prometheus.monitoring.svc.cluster.local:9090', maxSampleAgeSeconds: 180, warningRatio: .75, stopRatio: .9 };
const cluster = { metadata: { uid: 'original' }, spec: { instances: 1, resources: { requests: { cpu: '500m', memory: '1Gi' } } },
  status: { currentPrimary: 'shared-1', readyInstances: 1, conditions: [{ type: 'Ready', status: 'True' }] } };
const policy = { targets: [target], pools: [{ id: 'shared', uid: 'original', acceptingNewApps: true }], operatorManaged: true, capacity: config };
function metrics({ cpu = .1, memory = 100e6, storage = 1e9, time = now / 1000 - 10, missing = -1, invalid = -1 } = {}) {
  const values = [cpu, memory, storage, 10e9, time, time, time, time];let index = 0;
  return async () => {
    const i = index++;
    return i === missing ? [] : [{ metric: { [[0, 1, 4, 5].includes(i) ? 'pod' : 'persistentvolumeclaim']: 'shared-1' }, value: [now / 1000, i === invalid ? 'NaN' : String(values[i])] }];
  };
}
test('pool capacity uses measured pressure and configured warning/stop thresholds', async () => {
  let r = await observe(target, cluster, config, metrics(), now);
  assert.equal(r.state, 'available');assert.equal(r.ratios.cpu, .2);assert.equal(r.ratios.storage, .1);
  r = await observe(target, cluster, config, metrics({ cpu: .4 }), now);
  assert.equal(r.state, 'warning');assert.equal(r.limitingResource, 'cpu');
  r = await observe(target, cluster, config, metrics({ storage: 9.5e9 }), now);
  assert.equal(r.state, 'full');assert.equal(r.limitingResource, 'storage');
});
test('missing, stale, invalid and mismatched instance samples never imply spare capacity', async () => {
  for (const option of [{ time: now / 1000 - 181 }, { missing: 5 }, { invalid: 0 }]) {
    await assert.rejects(observe(target, cluster, config, metrics(option), now));
  }
  await assert.rejects(observe(target, { ...cluster, spec: { ...cluster.spec, instances: 2 } }, config, metrics(), now));
  await assert.rejects(observe(target, { ...cluster, status: { ...cluster.status, currentPrimary: 'shared-2' } }, config, metrics(), now));
  await assert.rejects(observe(target, { ...cluster, spec: { ...cluster.spec, walStorage: {} } }, config, metrics(), now));
});
test('pool inventory refuses changed identity and reports telemetry failure without secrets', async () => {
  let r = await inventory(policy, { getCluster: async () => ({ ...cluster, metadata: { uid: 'replacement' } }) }, { now, queryMetrics: metrics() });
  assert.equal(r[0].phase, 'RecoveryRequired');assert.equal(r[0].capacity.state, 'unknown');
  r = await inventory(policy, { getCluster: async () => cluster }, { now, queryMetrics: async () => { throw Error('private diagnostic'); } });
  assert.equal(r[0].capacity.state, 'unknown');assert.doesNotMatch(JSON.stringify(r), /private diagnostic/);
  r = await inventory({ ...policy, pools: [{ ...policy.pools[0], acceptingNewApps: false }] }, { getCluster: async () => cluster }, { now, queryMetrics: metrics() });
  assert.equal(r[0].phase, 'Closed to new apps');assert.equal(r[0].acceptingNewApps, false);
});
test('registry rejects unknown/preview pools and unsafe metric endpoints', () => {
  assert.equal(validatePools(policy), policy);
  assert.doesNotThrow(() => validatePools({ targets: [], capacity: {} }));
  for (const p of [{ ...policy, targets: [{ ...target, profile: 'preview' }] },
    { ...policy, pools: [...policy.pools, ...policy.pools] },
    { ...policy, capacity: { ...config, prometheusUrl: 'http://external.example/' } },
    { ...policy, capacity: { ...config, warningRatio: .95 } },
    { ...policy, pools: [{ ...policy.pools[0], uid: '' }] }]) assert.throws(() => validatePools(p));
});
