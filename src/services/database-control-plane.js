'use strict';

// Intent is stored in Kubernetes; neither the web process nor this module
// owns PostgreSQL pods. Keep credentials out of intent and status objects.
const fs = require('node:fs');
const GROUP = 'database.social.usernode.io';
const VERSION = 'v1alpha1';
const REQUESTS = 'databaseclusterrequests';
const CLUSTERS = 'appdatabaseclusters';
const RETAINED_CLUSTERS = 'retainedappdatabaseclusters';
const PROFILES = { preview: { plural: CLUSTERS, kind: 'AppDatabaseCluster', composition: 'sv-preview-cluster' },
  retained: { plural: RETAINED_CLUSTERS, kind: 'RetainedAppDatabaseCluster', composition: 'sv-retained-cluster' } };
const OWNER_LABEL = `${GROUP}/request-uid`;
const NAME = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/;
const validName = (value) => typeof value === 'string' && NAME.test(value);

function validatePolicy(policy) {
  if (!policy || !validName(policy.namespace) || !Array.isArray(policy.targets)) {
    throw new Error('Invalid database control-plane policy');
  }
  const ids = new Set();
  const destinations = new Set();
  for (const target of policy.targets) {
    if (!target || !validName(target.id) || !validName(target.namespace)
      || !target.namespace.startsWith('sv-db-') || target.namespace === policy.namespace
      || !validName(target.clusterName) || !Object.hasOwn(PROFILES, target.profile)
      || target.composition !== PROFILES[target.profile].composition) {
      throw new Error('Only explicitly configured database profiles are supported');
    }
    if (target.displayName !== undefined && (typeof target.displayName !== 'string'
      || !target.displayName.trim() || target.displayName.length > 80)) {
      throw new Error('Invalid database target display name');
    }
    const destination = `${target.namespace}/${target.clusterName}`;
    if (ids.has(target.id) || destinations.has(destination)) throw new Error('Duplicate database target');
    ids.add(target.id);
    destinations.add(destination);
  }
  require('./database-pools').validatePools(policy);
  require('./database-allocation').validate(policy);
  return policy;
}

function loadPolicy(env = process.env) {
  if (env.SV_DATABASE_CONTROL_PLANE_ENABLED !== 'true') return null;
  if (!env.SV_DATABASE_POLICY_FILE) throw new Error('SV_DATABASE_POLICY_FILE is required');
  return validatePolicy(JSON.parse(fs.readFileSync(env.SV_DATABASE_POLICY_FILE, 'utf8')));
}

function statusCode(error) {
  return error?.code || error?.response?.statusCode || error?.response?.status;
}

function createStore(custom) {
  const args = (plural, namespace, name) => ({ group: GROUP, version: VERSION, plural, namespace, ...(name ? { name } : {}) });
  const options = { promiseMiddleware: [{
    pre: async (context) => { context.setSignal(AbortSignal.timeout(15000)); return context; },
    post: async (context) => context,
  }] };
  return {
    async get(plural, namespace, name) {
      try { return await custom.getNamespacedCustomObject(args(plural, namespace, name), options); }
      catch (error) { if (statusCode(error) === 404) return null; throw error; }
    },
    async getCluster(namespace, name) {
      try { return await custom.getNamespacedCustomObject({ group: 'postgresql.cnpg.io', version: 'v1', plural: 'clusters', namespace, name }, options); }
      catch (error) { if (statusCode(error) === 404) return null; throw error; }
    },
    async list(namespace) {
      const items = [];
      let cursor;
      do {
        const page = await custom.listNamespacedCustomObject({ ...args(REQUESTS, namespace), limit: 100, ...(cursor ? { _continue: cursor } : {}) }, options);
        items.push(...page.items);
        cursor = page.metadata?.continue;
      } while (cursor);
      return items;
    },
    create(plural, namespace, body) {
      return custom.createNamespacedCustomObject({ ...args(plural, namespace), body }, options);
    },
    setStatus(request, status) {
      return custom.replaceNamespacedCustomObjectStatus({
        ...args(REQUESTS, request.metadata.namespace, request.metadata.name),
        body: { apiVersion: `${GROUP}/${VERSION}`, kind: 'DatabaseClusterRequest',
          metadata: { name: request.metadata.name, namespace: request.metadata.namespace,
            resourceVersion: request.metadata.resourceVersion }, status },
      }, options);
    },
  };
}

function findTarget(policy, id) {
  return policy.targets.find((target) => target.id === id);
}

async function submitRequest(store, policy, targetId, requestedBy) {
  if (!findTarget(policy, targetId)) throw new Error('Unknown database target');
  const existing = await store.get(REQUESTS, policy.namespace, targetId);
  if (existing) {
    if (existing.spec.target !== targetId) throw new Error('Conflicting database request');
    return existing;
  }
  try {
    return await store.create(REQUESTS, policy.namespace, {
      apiVersion: `${GROUP}/${VERSION}`, kind: 'DatabaseClusterRequest',
      metadata: { name: targetId, namespace: policy.namespace },
      spec: { target: targetId, requestedBy: String(requestedBy) },
    });
  } catch (error) {
    if (statusCode(error) !== 409) throw error;
    const winner = await store.get(REQUESTS, policy.namespace, targetId);
    if (!winner || winner.spec.target !== targetId) throw new Error('Conflicting database request');
    return winner;
  }
}

function publicRequest(request) {
  return { id: request.metadata.name, target: request.spec.target,
    requestedBy: request.spec.requestedBy, createdAt: request.metadata.creationTimestamp,
    phase: request.status?.phase || 'Pending', reason: request.status?.reason || 'AwaitingWorker',
    destination: request.status?.destination || null };
}

async function reconcileRequest(store, policy, request) {
  if (request.metadata.deletionTimestamp) return;
  const target = findTarget(policy, request.spec.target);
  const previous = request.status || {};
  async function report(phase, reason, extra = {}) {
    const next = { ...previous, phase, reason, observedGeneration: request.metadata.generation, ...extra };
    // Preserve the transition time and avoid writing unchanged objects each poll.
    if (JSON.stringify({ ...next, lastTransitionTime: undefined })
      === JSON.stringify({ ...previous, lastTransitionTime: undefined })) return;
    next.lastTransitionTime = previous.phase === phase && previous.reason === reason
      ? previous.lastTransitionTime : new Date().toISOString();
    await store.setStatus(request, next);
  }
  if (!target || request.metadata.name !== target.id) return report('Blocked', 'TargetNotAllowed');
  const destination = `${target.namespace}/${target.clusterName}`;
  // Changes to installation policy must never move an existing request.
  if (previous.destination && previous.destination !== destination) return report('Blocked', 'DestinationChanged');
  const profile = PROFILES[target.profile];
  if (!profile || target.composition !== profile.composition) return report('Blocked', 'ProfileNotAllowed');
  let composite = await store.get(profile.plural, target.namespace, target.clusterName);
  if (!composite) {
    if (previous.compositeUid) return report('RecoveryRequired', 'CompositeMissing');
    // Persist the reservation before creating infrastructure. Retrying after a
    // process crash uses the same target and deterministic composite name.
    if (!previous.destination) return report('Provisioning', 'DestinationReserved', { destination });
    try {
      composite = await store.create(profile.plural, target.namespace, {
        apiVersion: `${GROUP}/${VERSION}`, kind: profile.kind,
        metadata: { name: target.clusterName, namespace: target.namespace,
          labels: { [OWNER_LABEL]: request.metadata.uid } },
        spec: { profile: target.profile, crossplane: { compositionRef: { name: target.composition } } },
      });
    } catch (error) {
      if (statusCode(error) !== 409) throw error;
      composite = await store.get(profile.plural, target.namespace, target.clusterName);
    }
  }
  if (!composite || composite.metadata.labels?.[OWNER_LABEL] !== request.metadata.uid
    || (previous.compositeUid && previous.compositeUid !== composite.metadata.uid)
    || composite.spec.profile !== target.profile
    || composite.spec.crossplane?.compositionRef?.name !== target.composition) {
    return report('Blocked', 'ResourceOwnershipConflict');
  }
  if (composite.metadata.deletionTimestamp) return report('RecoveryRequired', 'CompositeDeleting');
  // Retained children are never silently substituted. Admission also blocks
  // Crossplane CREATE after this UID is recorded, independently of this worker.
  let cnpgUid;
  if (target.profile === 'retained') {
    const child = await store.getCluster(target.namespace, target.clusterName);
    if (!child) return report(previous.cnpgUid ? 'RecoveryRequired' : 'Provisioning',
      previous.cnpgUid ? 'DatabaseClusterMissing' : 'AwaitingDatabaseCluster', { destination, compositeUid: composite.metadata.uid });
    if (previous.cnpgUid && child.metadata.uid !== previous.cnpgUid) return report('RecoveryRequired', 'DatabaseClusterReplaced');
    if (child.metadata.deletionTimestamp) return report('RecoveryRequired', 'DatabaseClusterDeleting');
    if (child.metadata.labels?.[OWNER_LABEL] !== request.metadata.uid
      || !child.metadata.ownerReferences?.some((owner) => owner.uid === composite.metadata.uid && owner.controller === true)) {
      return report('Blocked', 'DatabaseClusterOwnershipConflict');
    }
    cnpgUid = child.metadata.uid;
    // Persist identity before declaring Ready, including across worker restarts.
    if (!previous.cnpgUid) return report('Provisioning', 'DatabaseClusterObserved', {
      destination, compositeUid: composite.metadata.uid, cnpgUid,
    });
  }
  const conditions = composite.status?.conditions || [];
  const current = (type) => conditions.some((condition) => condition.type === type && condition.status === 'True'
    && condition.observedGeneration === composite.metadata.generation);
  const ready = current('Ready') && current('Synced');
  await report(ready ? 'Ready' : 'Provisioning', ready ? 'ClusterReady' : 'AwaitingCrossplane', {
    destination, compositeUid: composite.metadata.uid, ...(cnpgUid ? { cnpgUid } : {}),
  });
}

module.exports = { GROUP, VERSION, REQUESTS, CLUSTERS, RETAINED_CLUSTERS, OWNER_LABEL, validatePolicy, loadPolicy,
  createStore, statusCode, submitRequest, publicRequest, reconcileRequest };
