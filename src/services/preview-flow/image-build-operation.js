'use strict';

const { isDeepStrictEqual } = require('node:util');
const { buildManifest, BUILD_OWNER } = require('./image-build-intent');

function statusCode(error) {
  return error?.code ?? error?.response?.statusCode ?? error?.response?.status;
}

function sameRecipe(build, expected) {
  if (build.apiVersion !== expected.apiVersion || build.kind !== expected.kind
      || build.metadata?.name !== expected.metadata.name
      || build.metadata?.namespace !== expected.metadata.namespace
      || !build.metadata.uid || build.metadata.deletionTimestamp
      || build.metadata.ownerReferences?.length) return false;
  for (const [key, value] of Object.entries(expected.metadata.labels)) {
    if (build.metadata.labels?.[key] !== value) return false;
  }
  // Reject extra behavior-bearing recipe fields. Empty defaults may be added
  // by kpack admission, but services/source paths/run-image overrides may not.
  for (const [key, value] of Object.entries(build.spec || {})) {
    if (!Object.hasOwn(expected.spec, key)
        && value !== null && value !== ''
        && !(Array.isArray(value) && value.length === 0)
        && !(typeof value === 'object' && Object.keys(value).length === 0)) return false;
  }
  return Object.entries(expected.spec).every(([key, value]) => isDeepStrictEqual(build.spec?.[key], value));
}

function failureKind(pod) {
  if (['Evicted', 'DeadlineExceeded', 'NodeLost', 'Shutdown'].includes(pod?.status?.reason)) {
    return 'infrastructure';
  }
  const states = [...(pod?.status?.initContainerStatuses || []), ...(pod?.status?.containerStatuses || [])];
  if (states.some(state => ['OOMKilled', 'ContainerCannotRun'].includes(state.state?.terminated?.reason))) {
    return 'infrastructure';
  }
  const failed = states.find(state => state.state?.terminated?.exitCode > 0);
  if (failed && ['detect', 'build'].includes(failed.name)
      && failed.state.terminated.reason === 'Error') return 'build';
  return 'unknown';
}

function createImageBuildOperations({
  clients = () => require('../kubernetes')._getClients(),
  requestTimeoutMs = 10000,
  onObservation = async () => {},
} = {}) {
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60000) {
    throw new Error('Invalid image-build API timeout');
  }

  async function call(api, method, request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const { middleware } = require('@kubernetes/client-node').createConfiguration({
        promiseMiddleware: [{
          async pre(context) {
            context.setSignal(controller.signal);
            return context;
          },
          async post(context) {
            return context;
          },
        }],
      });
      // Client-node awaits the aborted HTTP request. No detached Promise.race;
      // remote creation may still finish, so submission was checkpointed first.
      return await api[method](request, {
        middlewareMergeStrategy: 'append',
        middleware,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  function apiParams(expected) {
    return {
      group: 'kpack.io',
      version: 'v1alpha2',
      plural: 'builds',
      namespace: expected.metadata.namespace,
      name: expected.metadata.name,
    };
  }

  async function inspect(intent, { uid = intent.buildOperation.receipt?.uid } = {}) {
    const expected = buildManifest(intent);
    let build;
    try {
      build = await call(clients().custom, 'getNamespacedCustomObject', apiParams(expected));
    } catch (error) {
      if (statusCode(error) === 404) return { status: 'absent' };
      throw error;
    }
    if (!sameRecipe(build, expected) || (uid && build.metadata.uid !== uid)) {
      return { status: 'uncertain', reason: 'ownership_conflict' };
    }
    const identity = {
      uid: build.metadata.uid,
      buildRef: `${expected.metadata.namespace}/${expected.metadata.name}`,
    };
    const condition = build.status?.conditions?.find(value => value.type === 'Succeeded');
    const terminal = condition?.status === 'True' || condition?.status === 'False';
    if (!terminal) return { status: 'running', ...identity };
    if (build.status.observedGeneration !== build.metadata.generation) {
      return { status: 'uncertain', reason: 'stale_status', ...identity };
    }
    if (condition.status === 'False') {
      let classification = 'unknown';
      if (build.status.podName) {
        let pod;
        try {
          pod = await call(clients().core, 'readNamespacedPod', {
            namespace: expected.metadata.namespace,
            name: build.status.podName,
          });
        } catch (error) {
          if (statusCode(error) !== 404) throw error;
        }
        // The Build's name is not enough to borrow another object's failure.
        if (pod?.metadata?.ownerReferences?.some(owner => owner.uid === build.metadata.uid && owner.controller)) {
          classification = failureKind(pod);
        }
      }
      return { status: 'failed', failureKind: classification, ...identity };
    }
    const imageRef = build.status.latestImage;
    const repository = intent.buildOperation.repository;
    if (typeof imageRef !== 'string' || !imageRef.startsWith(`${repository}@sha256:`)
        || !/^[a-f0-9]{64}$/.test(imageRef.slice(`${repository}@sha256:`.length))) {
      return { status: 'uncertain', reason: 'output_unverified', ...identity };
    }
    if (intent.buildOperation.receipt && intent.buildOperation.receipt.imageRef !== imageRef) {
      return { status: 'uncertain', reason: 'ownership_conflict', ...identity };
    }
    return { status: 'succeeded', imageRef, ...identity };
  }

  async function prepare(intent, { submitted = false, uid, checkpoint }) {
    let observed = await inspect(intent, { uid });
    if (observed.status === 'absent') {
      if (submitted || intent.buildOperation.receipt) {
        return { status: 'uncertain', reason: 'submitted_resource_missing' };
      }
      const saved = await checkpoint({ submitted: true });
      if (saved.lostClaim) return { status: 'uncertain', reason: 'claim_lost' };
      const body = buildManifest(intent);
      try {
        await call(clients().custom, 'createNamespacedCustomObject', { ...apiParams(body), body });
      } catch (error) {
        // 409 and lost replies both require observation of the same identity.
        // Other API errors propagate to the shared retry/backoff owner.
        if (statusCode(error) !== 409) throw error;
      }
      await onObservation('created', intent);
      observed = await inspect(intent, { uid });
      if (observed.status === 'absent') {
        return { status: 'uncertain', reason: 'submitted_resource_missing' };
      }
    }
    if (observed.uid) {
      const saved = await checkpoint({ submitted: true, uid: observed.uid });
      if (saved.lostClaim) return { status: 'uncertain', reason: 'claim_lost' };
    }
    await onObservation(observed.status, intent);
    return observed;
  }

  async function retire(intent) {
    // An unsubmitted recipe has no Build yet. A delayed earlier creator may
    // still arrive; the recurring platform tombstone must keep checking it.
    if (!Object.hasOwn(intent.buildOperation, 'runScript')) return { status: 'retained' };
    const observed = await inspect(intent);
    if (observed.status === 'absent' || observed.status === 'succeeded' || observed.status === 'failed') {
      return { status: 'retained' };
    }
    return { status: 'pending', reason: observed.reason || 'build_running' };
  }

  return { inspect, prepare, retire };
}

module.exports = { createImageBuildOperations, BUILD_OWNER };
