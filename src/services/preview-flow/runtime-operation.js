'use strict';

const { isDeepStrictEqual } = require('node:util');
const { RESOURCE_KINDS, runtimeManifests } = require('./runtime-intent');

function absent(error) {
  return (error?.code ?? error?.statusCode ?? error?.response?.statusCode ?? error?.response?.status) === 404;
}

function matchesResource(kind, actual, expected, uid, { retiring = false } = {}) {
  const metadata = actual.metadata;
  if (!metadata?.uid || (uid && metadata.uid !== uid) || metadata.ownerReferences?.length
      || (!retiring && metadata.deletionTimestamp)
      || metadata.name !== expected.metadata.name || metadata.namespace !== expected.metadata.namespace) return false;
  if (!Object.entries(expected.metadata.labels).every(([key, value]) => metadata.labels?.[key] === value)) return false;
  if (kind === 'secret') {
    return actual.immutable === true && actual.type === 'Opaque' && isDeepStrictEqual(actual.data, expected.data);
  }

  const spec = structuredClone(actual.spec);
  if (!spec || typeof spec !== 'object') return false;
  if (kind === 'service') {
    // Allocated addresses/defaults are API-owned; selector and behavior remain
    // exact. Headless/external services and extra ports/policies are not adopted.
    for (const [key, value] of Object.entries({ sessionAffinity: 'None', internalTrafficPolicy: 'Cluster', ipFamilyPolicy: 'SingleStack' })) {
      if (spec[key] !== undefined && spec[key] !== value) return false;
      delete spec[key];
    }
    if (spec.clusterIP && spec.clusterIP === 'None') return false;
    delete spec.clusterIP;
    delete spec.clusterIPs;
    delete spec.ipFamilies;
  } else {
    const template = spec.template;
    if (!template?.metadata || !Array.isArray(template.spec?.containers)) return false;
    if (template.metadata?.creationTimestamp === null) delete template.metadata.creationTimestamp;
    if (template.spec.serviceAccount === expected.spec.template.spec.serviceAccountName) delete template.spec.serviceAccount;
    for (const container of template.spec.containers) {
      for (const probe of [container.startupProbe, container.readinessProbe, container.livenessProbe]) {
        if (probe?.initialDelaySeconds === 0) delete probe.initialDelaySeconds;
      }
    }
  }
  return isDeepStrictEqual(spec, expected.spec);
}

function createRuntimeOperations({
  clients = () => require('../kubernetes')._getClients(),
  dataKey,
  probe = require('../application-runtime').probeHealth,
  requestTimeoutMs = 10000,
  onObservation = async () => {},
} = {}) {
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) {
    throw new Error('Invalid runtime API timeout');
  }

  async function call(api, method, request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const { middleware } = require('@kubernetes/client-node').createConfiguration({
        promiseMiddleware: [{
          async pre(context) { context.setSignal(controller.signal); return context; },
          async post(context) { return context; },
        }],
      });
      return await api[method](request, { middlewareMergeStrategy: 'append', middleware });
    } finally {
      clearTimeout(timer);
    }
  }

  function operations(kind) {
    const suffix = { secret: 'Secret', service: 'Service', deployment: 'Deployment' }[kind];
    return {
      api: kind === 'deployment' ? clients().apps : clients().core,
      read: `readNamespaced${suffix}`,
      create: `createNamespaced${suffix}`,
      remove: `deleteNamespaced${suffix}`,
    };
  }

  async function inventory(intent, { retiring = false } = {}) {
    const manifests = runtimeManifests(intent, dataKey);
    const resources = {};
    for (const kind of RESOURCE_KINDS) {
      const expected = manifests[kind];
      const api = operations(kind);
      try {
        const object = await call(api.api, api.read, { namespace: intent.namespace, name: expected.metadata.name });
        const progress = intent.runtimeOperation.resources[kind];
        if (!progress?.submitted || !matchesResource(kind, object, expected, progress.uid, { retiring })) {
          return { status: 'uncertain', reason: 'ownership_conflict' };
        }
        resources[kind] = object;
      } catch (error) {
        if (!absent(error)) throw error;
        resources[kind] = null;
      }
    }
    return { status: 'inspected', resources, manifests };
  }

  async function verifyConsumers(intent, deployment) {
    const selector = `social.usernode.io/runtime-name=${intent.runtimeName}`;
    const replicaSets = await call(clients().apps, 'listNamespacedReplicaSet', { namespace: intent.namespace, labelSelector: selector });
    const owned = replicaSets.items.filter(set => set.metadata.ownerReferences?.some(owner => owner.controller && owner.uid === deployment.metadata.uid));
    const pods = await call(clients().core, 'listNamespacedPod', { namespace: intent.namespace, labelSelector: selector });
    const endpoints = await call(clients().core, 'readNamespacedEndpoints', { namespace: intent.namespace, name: intent.runtimeName });
    const addresses = (endpoints.subsets || []).flatMap(subset => subset.addresses || []);
    if (!addresses.length) return { status: 'waiting', reason: 'endpoints_not_ready' };
    const expectedLabels = deployment.spec.template.metadata.labels;
    const valid = addresses.every(address => {
      const pod = pods.items.find(candidate => candidate.metadata.uid === address.targetRef?.uid);
      if (!pod || pod.metadata.deletionTimestamp) return false;
      const ready = pod.status?.conditions?.some(condition => condition.type === 'Ready' && condition.status === 'True');
      const labelsMatch = Object.entries(expectedLabels).every(([key, value]) => pod.metadata.labels?.[key] === value);
      const imageMatch = pod.spec?.containers?.find(container => container.name === 'app')?.image === intent.runtimeOperation.desired.imageRef;
      const ownedByDeployment = pod.metadata.ownerReferences?.some(owner => owner.controller && owned.some(set => set.metadata.uid === owner.uid));
      return ready && labelsMatch && imageMatch && ownedByDeployment;
    });
    return valid ? { status: 'verified' } : { status: 'uncertain', reason: 'ownership_conflict' };
  }

  async function inspect(config, intent) {
    const checked = await inventory(intent);
    if (checked.status !== 'inspected') return checked;
    for (const kind of RESOURCE_KINDS) {
      if (!checked.resources[kind]) {
        const progress = intent.runtimeOperation.resources[kind];
        return { status: progress?.submitted ? 'uncertain' : 'partial', reason: progress?.submitted ? 'submitted_resource_missing' : 'unsubmitted_resource' };
      }
    }
    const deployment = checked.resources.deployment;
    const status = deployment.status;
    const current = status?.observedGeneration === deployment.metadata.generation
      && status.updatedReplicas === 1 && status.readyReplicas === 1 && status.availableReplicas === 1;
    if (!current) return { status: 'waiting', reason: 'not_healthy' };
    const consumers = await verifyConsumers(intent, deployment);
    if (consumers.status !== 'verified') return consumers;
    if (!await probe(config, intent)) return { status: 'waiting', reason: 'not_healthy' };
    const verified = await inventory(intent);
    if (verified.status !== 'inspected') return verified;
    const same = RESOURCE_KINDS.every(kind => verified.resources[kind]?.metadata.uid === checked.resources[kind].metadata.uid
      && verified.resources[kind]?.metadata.resourceVersion === checked.resources[kind].metadata.resourceVersion);
    if (!same) return { status: 'waiting', reason: 'observation_changed' };
    return {
      status: 'healthy',
      uids: Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, checked.resources[kind].metadata.uid])),
      physicalId: deployment.metadata.uid,
    };
  }

  async function prepare(config, initialIntent, { read, authorize, observe, signal }) {
    let intent = initialIntent;
    for (const kind of RESOURCE_KINDS) {
      if (signal.aborted) return { status: 'waiting', reason: 'claim_lost' };
      intent = await read();
      const checked = await inventory(intent);
      if (checked.status !== 'inspected') return checked;
      const object = checked.resources[kind];
      if (object) {
        if (!await observe(kind, object.metadata.uid)) return { status: 'waiting', reason: 'observation_rejected' };
        continue;
      }
      if (intent.runtimeOperation.resources[kind]?.submitted) {
        return { status: 'uncertain', reason: 'submitted_resource_missing' };
      }
      const permitted = await authorize(kind);
      if (!permitted || signal.aborted) return { status: 'waiting', reason: 'creation_not_authorized' };
      const api = operations(kind);
      const body = runtimeManifests(permitted, dataKey)[kind];
      await call(api.api, api.create, { namespace: intent.namespace, body }).catch(error => {
        if ((error.code ?? error.response?.statusCode) !== 409) throw error;
      });
      await onObservation(`created_${kind}`, permitted);
      // Persist UID only after a full read verifies recipe/owner. Lost creation
      // replies retry observation, never POST; the domain already marked it.
      intent = await read();
      const created = await inventory(intent);
      if (created.status !== 'inspected') return created;
      if (!created.resources[kind]) return { status: 'uncertain', reason: 'submitted_resource_missing' };
      if (!await observe(kind, created.resources[kind].metadata.uid)) return { status: 'waiting', reason: 'observation_rejected' };
    }
    intent = await read();
    const healthy = await inspect(config, intent);
    await onObservation(healthy.status, intent);
    return healthy;
  }

  async function retire(intent, { observe }) {
    const checked = await inventory(intent, { retiring: true });
    if (checked.status !== 'inspected') return checked;
    // Record a late object's UID even after retirement; this does not authorize
    // a subsequent creation step or candidate completion.
    for (const kind of RESOURCE_KINDS) {
      const object = checked.resources[kind];
      if (object && !await observe(kind, object.metadata.uid)) return { status: 'uncertain', reason: 'observation_rejected' };
    }
    const order = ['deployment', 'service', 'secret'];
    for (const kind of order) {
      const object = checked.resources[kind];
      if (kind === 'service') {
        const pods = await call(clients().core, 'listNamespacedPod', {
          namespace: intent.namespace, labelSelector: `social.usernode.io/runtime-name=${intent.runtimeName}`,
        });
        if (pods.items.length) return { status: 'waiting', reason: 'consumers_terminating' };
      }
      if (!object) continue;
      if (object.metadata.deletionTimestamp) return { status: 'waiting', reason: 'resources_terminating' };
      const api = operations(kind);
      await call(api.api, api.remove, {
        namespace: intent.namespace, name: object.metadata.name,
        body: { preconditions: { uid: object.metadata.uid, resourceVersion: object.metadata.resourceVersion } },
        ...(kind === 'deployment' ? { propagationPolicy: 'Foreground' } : {}),
      }).catch(error => {
        if (!absent(error)) throw error;
      });
      if (kind === 'deployment') return { status: 'waiting', reason: 'consumers_terminating' };
    }
    const pods = await call(clients().core, 'listNamespacedPod', {
      namespace: intent.namespace, labelSelector: `social.usernode.io/runtime-name=${intent.runtimeName}`,
    });
    if (pods.items.length) return { status: 'waiting', reason: 'consumers_terminating' };
    const after = await inventory(intent, { retiring: true });
    if (after.status !== 'inspected') return after;
    if (RESOURCE_KINDS.some(kind => after.resources[kind])) return { status: 'waiting', reason: 'resources_remaining' };
    // A submitted Deployment may have a late controller consumer. C5 retains
    // its DB clone until a subsequent checkpoint demonstrates consumer closure.
    if (intent.runtimeOperation.resources.deployment?.submitted) return { status: 'waiting', reason: 'dependency_retained' };
    return { status: 'removed' };
  }

  return { prepare, inspect, inventory, retire };
}

module.exports = { createRuntimeOperations, matchesResource };
