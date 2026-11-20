'use strict';

// The cluster's own ceilings, measured for the platform limits area and its
// alerts (services/platform-limit-alerts.js, platform-limits-view.js,
// limit-texts.js). Three kinds, each a limit with a stored level, bell
// notices and texts like the counted ones:
//
//   db_disk       the shared Postgres server's volume: bytes used against the
//                 claim's capacity, for the fullest of its instances' data
//                 and WAL claims. Full, Postgres stops accepting writes and
//                 every app with it. Read from Prometheus (the kubelet's
//                 volume stats), at the address the checks pool already
//                 reads (CHECK_POOL_METRICS_URL); the claims are found from
//                 DATABASE_URL's host, a CloudNativePG service
//                 (<cluster>-rw.<namespace>.svc).
//   quota_apps,   each runtime namespace's ResourceQuota (apps, coding
//   quota_workers, workers and checks, image builds): the tightest resource
//   quota_builds  it bounds (pods, CPU or memory requests, claims, Jobs, …)
//                 as a share of its hard value. At it, Kubernetes refuses the
//                 next pod or object: an app cannot start, a session or a
//                 check waits, a build fails. Read through the Kubernetes API
//                 with the get/list the platform already has on quotas
//                 (kubernetes.listNamespaceCapacity, the status screen's).
//   node_pool     the worker nodes' local volume pool (OpenEBS LVM, volume
//                 group openebs-vg): the fullest node's space taken against
//                 the group's size. Full, new worker and preview volumes fail
//                 to mount. Read from the LVMNode objects in `openebs`, which
//                 need their own read grant (Usernode-Labs/infra#103). Until
//                 it exists the API answers 403, and the row stays hidden
//                 rather than saying "couldn't check" every five minutes.
//
// Each measure answers { used, cap, detail } in whole numbers (MiB for
// volumes; for a quota, the tightest resource in thousandths of its hard
// value, cap 1000, so a level stays about how full the namespace is whichever
// resource is tightest), or null when the limit does not apply here: off
// Kubernetes, in a staging preview (no authority over the parent's cluster),
// with no quota, or before the read grant exists. A read that fails throws,
// so the limit's figure grows old and its row says it could not be checked.
//
// What one LVMNode reports is the volume group's size and unallocated space.
// A thin pool inside it (the openebs-lvm class) can fill before the group
// does; that fill is LVM's own figure and is not in the object.

const log = require('./logger');

const MiB = 1024 * 1024;
const VOLUME_GROUP = 'openebs-vg';
const QUOTA_NAMESPACES = Object.freeze({
  quota_apps: 'appNamespace',
  quota_workers: 'workerNamespace',
  quota_builds: 'buildNamespace',
});
// listNamespaceCapacity's names for the resources a quota bounds, and the
// plain ones the rows and texts use.
const RESOURCE_NAMES = Object.freeze({
  pods: 'pods',
  requestsCpu: 'cpu',
  requestsMemory: 'memory',
  limitsCpu: 'cpu_limits',
  limitsMemory: 'memory_limits',
  requestsEphemeralStorage: 'scratch',
  limitsEphemeralStorage: 'scratch_limits',
  requestsStorage: 'storage',
  persistentVolumeClaims: 'volumes',
  services: 'services',
  secrets: 'secrets',
  configMaps: 'config_maps',
  jobs: 'jobs',
  builds: 'builds',
});
// One read of every namespace's quota serves the three quota limits of one
// sweep (and one area read), not three.
const QUOTA_HOLD_MS = 10 * 1000;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

function isStaging(env = process.env) {
  return env.USERNODE_ENV === 'staging';
}

function onKubernetes(config, env = process.env) {
  if (isStaging(env)) return false;
  const runtime = config?.appRuntime || env.APP_RUNTIME || 'docker';
  return runtime === 'kubernetes';
}

/**
 * The CloudNativePG cluster and namespace DATABASE_URL points at, from a
 * service host such as social-postgres-rw.social-data.svc.cluster.local, or
 * null for any other host (a pooler, an outside server, a local one). Pure.
 */
function databaseCluster(databaseUrl) {
  let host;
  try { host = new URL(String(databaseUrl || '')).hostname; } catch { return null; }
  const m = /^([a-z0-9-]+)-(rw|ro|r)\.([a-z0-9-]+)\.svc(\.cluster\.local)?$/.exec(host);
  if (!m || !DNS_LABEL.test(m[1]) || !DNS_LABEL.test(m[3])) return null;
  return { cluster: m[1], namespace: m[3] };
}

function metricsBase(config) {
  const raw = config?.kubernetes?.checkPoolMetricsUrl || '';
  if (!raw) return null;
  try {
    const url = new URL('/api/v1/query', raw);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch { return null; }
}

/** Whether a limit of this module applies on this deploy. No I/O. */
function enabled(config, key, env = process.env) {
  if (!onKubernetes(config, env)) return false;
  if (key === 'db_disk') return !!metricsBase(config) && !!databaseCluster(config?.databaseUrl);
  if (key === 'node_pool') return true;
  const field = QUOTA_NAMESPACES[key];
  if (!field) return false;
  const namespace = config?.kubernetes?.[field];
  if (!namespace) return false;
  // Two roles in one namespace are one quota: the first role names it.
  const earlier = Object.entries(QUOTA_NAMESPACES).find(([, f]) => config.kubernetes[f] === namespace);
  return earlier[0] === key;
}

// ── db_disk ─────────────────────────────────────────────────────────────

async function promQuery(base, query, fetchImpl) {
  const url = new URL(base);
  url.searchParams.set('query', query);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`Prometheus answered ${response.status}`);
  const data = await response.json();
  if (data.status !== 'success' || data.data?.resultType !== 'vector' || !Array.isArray(data.data.result)) {
    throw new Error('Prometheus gave no vector');
  }
  return data.data.result;
}

/**
 * Pair used and capacity samples by claim and pick the fullest. Pure.
 * Returns { used, cap, detail: { volume } } in MiB, or null when no claim
 * has both figures.
 */
function fullestVolume(usedSamples, capacitySamples) {
  const caps = new Map();
  for (const s of capacitySamples || []) {
    const claim = s?.metric?.persistentvolumeclaim;
    const bytes = Number(s?.value?.[1]);
    if (claim && Number.isFinite(bytes) && bytes > 0) caps.set(claim, bytes);
  }
  let best = null;
  for (const s of usedSamples || []) {
    const claim = s?.metric?.persistentvolumeclaim;
    const used = Number(s?.value?.[1]);
    const cap = caps.get(claim);
    if (!claim || !cap || !Number.isFinite(used) || used < 0) continue;
    const share = used / cap;
    if (!best || share > best.share) best = { claim, used, cap, share };
  }
  if (!best) return null;
  return {
    used: Math.ceil(best.used / MiB),
    cap: Math.max(1, Math.floor(best.cap / MiB)),
    detail: { volume: best.claim },
  };
}

async function dbDisk(config, deps = {}) {
  const env = deps.env || process.env;
  if (!enabled(config, 'db_disk', env)) return null;
  const { cluster, namespace } = databaseCluster(config.databaseUrl);
  const base = metricsBase(config);
  // The instances' data claims are <cluster>-<n>, their WAL claims
  // <cluster>-<n>-wal (CloudNativePG's names). Both names are DNS labels,
  // checked above, so nothing here can widen the selector.
  const selector = `namespace="${namespace}",persistentvolumeclaim=~"${cluster}-[0-9]+(-wal)?"`;
  const fetchImpl = deps.fetch || fetch;
  const [used, capacity] = await Promise.all([
    promQuery(base, `max by (persistentvolumeclaim) (kubelet_volume_stats_used_bytes{${selector}})`, fetchImpl),
    promQuery(base, `max by (persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes{${selector}})`, fetchImpl),
  ]);
  const out = fullestVolume(used, capacity);
  if (!out) throw new Error(`no volume figures for ${namespace}/${cluster}`);
  return out;
}

// ── quotas ──────────────────────────────────────────────────────────────

let heldQuotas = null;

async function namespaceQuotas(config, deps) {
  const now = Date.now();
  if (!deps.kubernetes && heldQuotas && heldQuotas.config === config && now - heldQuotas.at < QUOTA_HOLD_MS) {
    return heldQuotas.value;
  }
  const value = (deps.kubernetes || require('./kubernetes')).listNamespaceCapacity(config);
  if (!deps.kubernetes) heldQuotas = { config, at: now, value };
  try {
    return await value;
  } catch (err) {
    if (heldQuotas && heldQuotas.value === value) heldQuotas = null;
    throw err;
  }
}

/**
 * The tightest resource in one namespace's quota, from what
 * listNamespaceCapacity answers for it. Pure. Returns { used, cap, detail }
 * (used in thousandths of the hard value, cap 1000), or null when the
 * namespace has no quota with any bounded resource.
 */
function tightestQuota(entry) {
  if (!entry || !entry.resources) return null;
  let best = null;
  for (const [name, metric] of Object.entries(entry.resources)) {
    if (!metric || !Number.isFinite(metric.percent)) continue;
    if (!best || metric.percent > best.metric.percent) best = { name, metric };
  }
  if (!best) return null;
  return {
    // Clamped to four digits (a quota ten times over), so the widest notice
    // token, "quota_workers_full:9999:1000", stays inside 32 characters.
    used: Math.min(9999, Math.max(0, Math.round(best.metric.percent * 10))),
    cap: 1000,
    detail: {
      namespace: entry.namespace,
      resource: RESOURCE_NAMES[best.name] || best.name,
      used: String(best.metric.used),
      hard: String(best.metric.hard),
    },
  };
}

async function quota(config, key, deps = {}) {
  const env = deps.env || process.env;
  if (!enabled(config, key, env)) return null;
  const namespace = config.kubernetes[QUOTA_NAMESPACES[key]];
  const all = await namespaceQuotas(config, deps);
  const entry = (all || []).find((n) => n && n.namespace === namespace);
  if (!entry || entry.unavailable) throw new Error(`the ${namespace} quota could not be read`);
  return tightestQuota(entry);
}

// ── node_pool ───────────────────────────────────────────────────────────

/**
 * The fullest node's volume group, from LVMNode objects. Pure. Returns
 * { used, cap, detail: { node } } in MiB, or null when no node reports the
 * group.
 */
function fullestPool(items, group = VOLUME_GROUP) {
  const quantity = require('./check-pool').quantity;
  let best = null;
  for (const item of items || []) {
    const node = item?.metadata?.name;
    const vg = (item?.volumeGroups || []).find((g) => g && g.name === group);
    if (!node || !vg) continue;
    const size = quantity(vg.size);
    const free = quantity(vg.free);
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(free) || free < 0) continue;
    const used = Math.max(0, size - free);
    const share = used / size;
    if (!best || share > best.share) best = { node, used, size, share };
  }
  if (!best) return null;
  return {
    used: Math.ceil(best.used / MiB),
    cap: Math.max(1, Math.floor(best.size / MiB)),
    detail: { node: best.node },
  };
}

let toldForbidden = false;

async function nodePool(config, deps = {}) {
  const env = deps.env || process.env;
  if (!enabled(config, 'node_pool', env)) return null;
  const kubernetes = deps.kubernetes || require('./kubernetes');
  let items;
  try {
    items = await kubernetes.listVolumePools();
  } catch (err) {
    const code = err?.code ?? err?.response?.statusCode ?? err?.response?.status;
    // No read grant yet (infra#103), or no OpenEBS LVM here at all.
    if (code === 403 || code === 404) {
      if (!toldForbidden) {
        toldForbidden = true;
        log.info('platform-capacity', 'The volume pools cannot be read here; the row stays hidden', { status: code });
      }
      return null;
    }
    throw err;
  }
  const out = fullestPool(items);
  if (!out) throw new Error(`no node reports the ${VOLUME_GROUP} volume group`);
  return out;
}

/** Measure one of this module's limits. */
function measure(config, key, deps = {}) {
  if (key === 'db_disk') return dbDisk(config, deps);
  if (key === 'node_pool') return nodePool(config, deps);
  if (QUOTA_NAMESPACES[key]) return quota(config, key, deps);
  return Promise.reject(new Error(`unknown capacity limit: ${key}`));
}

/** Tests only: forget the held quota read and the 403 note. */
function resetForTests() {
  heldQuotas = null;
  toldForbidden = false;
}

module.exports = {
  KEYS: Object.freeze(['db_disk', 'quota_apps', 'quota_workers', 'quota_builds', 'node_pool']),
  VOLUME_GROUP,
  RESOURCE_NAMES,
  databaseCluster,
  enabled,
  fullestVolume,
  tightestQuota,
  fullestPool,
  measure,
  resetForTests,
};
