'use strict';

// Read-only observations. They do not reserve capacity or authorize placement.
// All pool identities and metric endpoints come from operator-owned policy.
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
function validatePools(policy) {
  if (policy.operatorManaged !== undefined && typeof policy.operatorManaged !== 'boolean') throw new Error('Invalid pool ownership policy');
  const pools = policy.pools || [];
  if (!Array.isArray(pools) || pools.length > 32) throw new Error('Invalid pool registry');
  const ids = new Set();
  for (const pool of pools) {
    const target = policy.targets.find(t => t.id === pool.id && t.profile === 'retained');
    if (!target || ids.has(pool.id) || typeof pool.uid !== 'string' || !pool.uid
      || typeof pool.acceptingNewApps !== 'boolean') throw new Error('Invalid registered pool');
    ids.add(pool.id);
  }
  if (policy.capacity && Object.keys(policy.capacity).length) {
    const c = policy.capacity, u = new URL(c.prometheusUrl);
    if (u.protocol !== 'http:' || !u.hostname.endsWith('.svc.cluster.local') || u.username || u.password
      || u.pathname !== '/' || u.search || u.hash || !Number.isInteger(c.maxSampleAgeSeconds)
      || c.maxSampleAgeSeconds < 30 || c.maxSampleAgeSeconds > 300
      || !(c.warningRatio > 0 && c.warningRatio < c.stopRatio && c.stopRatio <= 1)) throw new Error('Invalid capacity policy');
  }
  return policy;
}
function quantity(value) {
  const m = String(value ?? '').match(/^(\d+(?:\.\d+)?)(m|Ki|Mi|Gi|Ti|K|M|G|T)?$/);
  if (!m) return NaN;
  return Number(m[1]) * ({ m: .001, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
    K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] || 1);
}
const cache = new Map();
async function query(base, expression) {
  const url = new URL('/api/v1/query', base); url.searchParams.set('query', expression);
  const key = url.href, previous = cache.get(key);
  if (previous && Date.now() - previous.at < 10000) return previous.promise;
  const promise = (async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!r.ok) throw new Error('Metrics unavailable');
    const d = await r.json();
    if (d.status !== 'success' || d.data?.resultType !== 'vector') throw new Error('Metrics unavailable');
    return d.data.result;
  })();
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > 512) cache.delete(cache.keys().next().value);
  try { return await promise; } catch (e) { cache.delete(key); throw e; }
}
function samples(rows, label, expected) {
  const map = new Map();
  for (const row of rows) {
    const name = row.metric?.[label], value = Number(row.value?.[1]);
    if (typeof name !== 'string' || !Number.isFinite(value) || value < 0 || map.has(name)) throw new Error('Incomplete metrics');
    map.set(name, value);
  }
  if (map.size !== expected) throw new Error('Incomplete metrics');
  return map;
}
async function observe(target, cluster, config, queryMetrics = query, now = Date.now()) {
  if (!config?.prometheusUrl || !NAME.test(target.namespace) || !NAME.test(target.clusterName)) throw new Error('Metrics unavailable');
  const n = cluster.spec.instances, primary = cluster.status?.currentPrimary;
  // WAL/tablespace capacity needs additional accounting before it is supported.
  if (!Number.isInteger(n) || n < 1 || !primary || cluster.spec.walStorage || cluster.spec.tablespaces?.length) throw new Error('Unsupported capacity layout');
  const cpuBudget = quantity(cluster.spec.resources?.requests?.cpu), memoryBudget = quantity(cluster.spec.resources?.requests?.memory);
  if (!(cpuBudget > 0 && memoryBudget > 0)) throw new Error('Capacity budget missing');
  const selector = `namespace="${target.namespace}",pod=~"${target.clusterName}-[0-9]+",container="postgres"`;
  const pvc = `namespace="${target.namespace}",persistentvolumeclaim=~"${target.clusterName}-[0-9]+"`;
  const expressions = [
    `max by (pod) (rate(container_cpu_usage_seconds_total{${selector}}[5m]))`,
    `max by (pod) (avg_over_time(container_memory_working_set_bytes{${selector}}[5m]))`,
    `max by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{${pvc}})`,
    `max by (persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes{${pvc}})`,
    `min by (pod) (timestamp(container_cpu_usage_seconds_total{${selector}}))`,
    `min by (pod) (timestamp(container_memory_working_set_bytes{${selector}}))`,
    `min by (persistentvolumeclaim) (timestamp(kubelet_volume_stats_used_bytes{${pvc}}))`,
    `min by (persistentvolumeclaim) (timestamp(kubelet_volume_stats_capacity_bytes{${pvc}}))`,
  ];
  const raw = await Promise.all(expressions.map(q => queryMetrics(config.prometheusUrl, q)));
  const maps = raw.map((r, i) => samples(r, [0, 1, 4, 5].includes(i) ? 'pod' : 'persistentvolumeclaim', n));
  const names = [...maps[0].keys()];
  if (!names.includes(primary) || maps.some(m => names.some(name => !m.has(name)))) throw new Error('Instance metrics changed');
  const observedAt = Math.min(...maps.slice(4).flatMap(m => [...m.values()])) * 1000;
  if (now - observedAt > config.maxSampleAgeSeconds * 1000 || observedAt > now + 10000) throw new Error('Stale metrics');
  const cpu = Math.max(...maps[0].values()) / cpuBudget;
  const memory = Math.max(...maps[1].values()) / memoryBudget;
  const storage = Math.max(...names.map(name => {
    if (!(maps[3].get(name) > 0)) throw new Error('Missing disk capacity');
    return maps[2].get(name) / maps[3].get(name);
  }));
  const ratios = { cpu, memory, storage };
  const limitingResource = Object.keys(ratios).sort((a, b) => ratios[b] - ratios[a])[0];
  const worst = ratios[limitingResource];
  return { state: worst >= config.stopRatio ? 'full' : worst >= config.warningRatio ? 'warning' : 'available',
    observedAt: new Date(observedAt).toISOString(), ratios, limitingResource,
    cpuBudgetCores: cpuBudget, memoryBudgetBytes: memoryBudget,
    storageCapacityBytes: Math.min(...maps[3].values()),
    message: worst >= config.warningRatio ? `Operator action: review ${limitingResource} capacity; resize or add a shared pool.` : 'Within configured observation thresholds.' };
}
async function inventory(policy, store, options = {}) {
  validatePools(policy);
  return Promise.all((policy.pools || []).map(async registered => {
    const target = policy.targets.find(t => t.id === registered.id);
    const result = { id: target.id, displayName: target.displayName || target.id,
      acceptingNewApps: registered.acceptingNewApps, phase: 'Unavailable',
      capacity: { state: 'unknown', message: 'Capacity unavailable; operator review required.' } };
    try {
      const cluster = await store.getCluster(target.namespace, target.clusterName);
      if (!cluster || cluster.metadata.deletionTimestamp || cluster.metadata.uid !== registered.uid) {
        return { ...result, phase: 'RecoveryRequired' };
      }
      result.instances = cluster.spec.instances;
      const ready = cluster.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True');
      if (!ready || cluster.status?.readyInstances !== cluster.spec.instances) return result;
      result.phase = registered.acceptingNewApps ? 'Ready' : 'Closed to new apps';
      result.capacity = await observe(target, cluster, policy.capacity, options.queryMetrics, options.now);
    } catch { /* Unknown is explicit; never advertise missing telemetry as free capacity. */ }
    return result;
  }));
}
module.exports = { validatePools, quantity, observe, inventory };
