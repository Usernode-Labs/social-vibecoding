'use strict';

// An opt-in admission boundary around the existing central database adapter.
// External placement is deliberately rejected until every copy/cleanup path
// has a destination-aware implementation. Missing metadata never means central.
const fs = require('node:fs');
const { createStore, GROUP, VERSION } = require('./database-control-plane');
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const LABEL = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/;
const BINDINGS = 'appdatabasebindings';
const validLabel = (value) => typeof value === 'string' && LABEL.test(value);

function fail() {
  const error = new Error('Database placement is unavailable or unsupported; operation blocked');
  error.code = 'DATABASE_PLACEMENT_BLOCKED';
  return error;
}

function loadSelection(env = process.env) {
  if (env.SV_DATABASE_BINDINGS_ENABLED !== 'true') return null;
  try {
    const policy = JSON.parse(fs.readFileSync(env.SV_DATABASE_POLICY_FILE, 'utf8'));
    if (!validLabel(policy.namespace) || !Array.isArray(policy.bindingTargets)) throw fail();
    const ids = new Set();
    const names = new Set();
    const databases = new Set();
    for (const target of policy.bindingTargets) {
      if (!Number.isSafeInteger(target.appId) || target.appId < 1
        || !validLabel(target.bindingName) || typeof target.slug !== 'string'
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target.slug)
        || target.database !== `app_${target.slug.replace(/-/g, '_')}`
        || !IDENT.test(`${target.database}_owner`)
        || ids.has(target.appId) || names.has(target.bindingName) || databases.has(target.database)
        || !target.clusterRef || !validLabel(target.clusterRef.namespace)
        || !validLabel(target.clusterRef.name) || typeof target.clusterRef.uid !== 'string'
        || !target.clusterRef.uid) throw fail();
      ids.add(target.appId); names.add(target.bindingName); databases.add(target.database);
    }
    return policy;
  } catch { throw fail(); }
}

// These are the existing naming families, including PostgreSQL's bounded
// evidence names. A binding covers its app's current central-only lifecycle;
// independent preview placement is not enabled by this first binding version.
function ownsDatabase(target, name) {
  if (typeof name !== 'string') return false;
  if (name === target.database) return true;
  const db = name.endsWith('_owner') ? name.slice(0, -6) : name;
  const primary = target.database;
  const evidencePrefix = `app_${target.slug.replace(/-/g, '_').slice(0, 57 - 4 - '_evidence_123456789abc_b'.length)}_evidence_`;
  const preparedPrefix = `${primary.slice(0, 63 - '_evsrc_123456789abc'.length)}_evsrc_`;
  return db === primary || db.startsWith(`${primary}_staging_`)
    || db === `${primary}_stgtmpl` || db === `${primary}_stgtmpl_next`
    || (db.startsWith(evidencePrefix) && /^[a-f0-9]{12}_[bh]$/.test(db.slice(evidencePrefix.length)))
    || (db.startsWith(preparedPrefix) && /^[a-f0-9]{12}$/.test(db.slice(preparedPrefix.length)));
}

let reader;
function defaultReader() {
  if (!reader) {
    const k8s = require('@kubernetes/client-node');
    const config = new k8s.KubeConfig(); config.loadFromCluster();
    const api = config.makeApiClient(k8s.CustomObjectsApi);
    const store = createStore(api);
    reader = {
      binding: (namespace, name) => store.get(BINDINGS, namespace, name),
      cluster: (namespace, name) => api.getNamespacedCustomObject({
        group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters', namespace, name,
      }, { promiseMiddleware: [{ pre: async (context) => {
        context.setSignal(AbortSignal.timeout(15000)); return context;
      }, post: async (context) => context }] }),
    };
  }
  return reader;
}

async function assertCentralPlacement(databaseNames, { all = false, env = process.env,
  policy = loadSelection(env), getReader = defaultReader } = {}) {
  if (!policy) return [];
  const targets = policy.bindingTargets.filter((target) => all
    || databaseNames.some((name) => ownsDatabase(target, name)));
  if (!targets.length) return []; // Non-selected apps do not make API requests.
  try {
    const central = new URL(env.DB_ADMIN_URL || env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(central.protocol)) throw fail();
    const records = [];
    const api = getReader();
    for (const target of targets) {
      const binding = await api.binding(policy.namespace, target.bindingName);
      const spec = binding?.spec;
      if (!spec || binding.metadata.deletionTimestamp || spec.appId !== target.appId
        || spec.slug !== target.slug || spec.environment !== 'production'
        || spec.placement !== 'central' || spec.database !== target.database
        || spec.owner !== `${target.database}_owner`
        || spec.credentialRef?.source !== 'platform-app' || spec.credentialRef.appId !== target.appId
        || spec.endpoint?.host !== central.hostname || spec.endpoint.port !== Number(central.port || 5432)
        || ['namespace', 'name', 'uid'].some((key) => spec.clusterRef?.[key] !== target.clusterRef[key])) throw fail();
      const cluster = await api.cluster(target.clusterRef.namespace, target.clusterRef.name);
      if (cluster?.metadata?.uid !== spec.clusterRef.uid || cluster.metadata.deletionTimestamp) throw fail();
      records.push({ name: target.bindingName, ...spec });
    }
    return records;
  } catch { throw fail(); } // Never emit URLs, API bodies or credentials.
}

async function assertRetirementAllowed(databaseNames, options) {
  const bindings = await assertCentralPlacement(databaseNames, options);
  if (bindings.some((binding) => databaseNames.includes(binding.database))) {
    const error = fail();
    error.message = 'Retiring or replacing a bound app database is not supported yet';
    throw error;
  }
}

module.exports = { assertRetirementAllowed, BINDINGS, GROUP, VERSION, loadSelection, ownsDatabase, assertCentralPlacement };
