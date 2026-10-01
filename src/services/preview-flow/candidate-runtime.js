'use strict';

const docker = require('../docker');
const kubernetes = require('../kubernetes');
const { FLOW_LABEL } = require('./cleanup');
const HEAD_LABEL = 'social.usernode.io/preview-head';

function absent(error) {
  return error.code === 404 || error.statusCode === 404 || error.response?.statusCode === 404;
}

async function inspectDocker(intent) {
  try {
    const { stdout } = await docker.execFileAsync('docker', [
      'inspect', '--format', '{{json .}}', intent.runtimeName,
    ], { timeout: 5000 });
    const container = JSON.parse(stdout);
    return { uid: container.Id, labels: container.Config.Labels || {}, imageRef: container.Config.Image };
  } catch (error) {
    if (/no such (container|object)/i.test(error.stderr || error.message)) return null;
    throw error;
  }
}

// Observation never treats a transport failure as absence or infers a head
// from the request. The creator labels the actual runtime with its built head.
async function observePreparedCandidate(config, intent, flowId, headSha) {
  let object;
  if (intent.runtimeKind === 'docker') {
    object = await inspectDocker(intent);
  } else {
    try {
      const deployment = await kubernetes._getClients().apps.readNamespacedDeployment({
        name: intent.runtimeName,
        namespace: intent.namespace,
      });
      object = {
        uid: deployment.metadata.uid,
        labels: deployment.metadata.labels || {},
        imageRef: deployment.spec.template.spec.containers.find(container => container.name === 'app')?.image,
      };
    } catch (error) {
      if (!absent(error)) throw error;
      object = null;
    }
  }
  if (!object) return { present: false, receipt: null };
  if (object.labels[FLOW_LABEL] !== flowId || object.labels[HEAD_LABEL] !== headSha || !object.uid) {
    throw Object.assign(new Error('Candidate ownership cannot be established'), { permanent: true });
  }
  if (!object.imageRef || !await require('../application-runtime').probeHealth(config, intent)) {
    return { present: true, receipt: null };
  }
  return {
    present: true,
    receipt: {
      commitSha: headSha,
      stagingUrl: require('../application-runtime').appOrigin(config, intent),
      runtimeKind: intent.runtimeKind,
      runtimeName: intent.runtimeName,
      containerId: intent.runtimeKind === 'docker' ? intent.runtimeName : null,
      imageRef: object.imageRef,
      buildRef: null,
      physicalId: object.uid,
      attemptId: intent.attemptId,
    },
  };
}

async function verifyCandidate(config, intent, flowId, receipt) {
  if (!receipt || receipt.runtimeName !== intent.runtimeName || receipt.attemptId !== intent.attemptId) {
    throw new Error('Candidate receipt does not identify the reserved resources');
  }
  if (intent.runtimeOperation?.desired) {
    const observed = await require('./runtime-operation').createRuntimeOperations({ dataKey: config.dataEncryptionKey }).inspect(config, intent);
    if (observed.status !== 'healthy' || observed.physicalId !== receipt.physicalId) {
      throw new Error('Prepared candidate resources or health changed');
    }
    return;
  }
  let object;
  if (intent.runtimeKind === 'docker') {
    object = await inspectDocker(intent);
  } else {
    const deployment = await kubernetes._getClients().apps.readNamespacedDeployment({
      name: intent.runtimeName,
      namespace: intent.namespace,
    });
    object = { uid: deployment.metadata.uid, labels: deployment.metadata.labels || {} };
  }
  if (!object || object.uid !== receipt.physicalId || object.labels[FLOW_LABEL] !== flowId) {
    throw new Error('Prepared candidate identity or ownership changed');
  }
  if (!await require('../application-runtime').probeHealth(config, intent)) {
    throw new Error('Prepared candidate is not healthy');
  }
}

async function removeCandidate(config, intent, flowId, receipt) {
  if (intent.runtimeKind === 'docker') {
    const container = await inspectDocker(intent);
    if (!container) return { removed: true };
    if (container.labels[FLOW_LABEL] !== flowId || (receipt && receipt.physicalId !== container.uid)) {
      throw new Error('Candidate container ownership changed');
    }
    const result = await docker.stopAndRemove(container.uid, { stopTimeoutSec: docker.STAGING_STOP_GRACE_SEC });
    if (!result?.removed) throw new Error(result?.error || 'Candidate container removal is unconfirmed');
    return result;
  }

  const { apps, core } = kubernetes._getClients();
  const resources = [
    {
      api: apps,
      read: 'readNamespacedDeployment',
      remove: 'deleteNamespacedDeployment',
      name: intent.runtimeName,
    },
    {
      api: core,
      read: 'readNamespacedService',
      remove: 'deleteNamespacedService',
      name: intent.runtimeName,
    },
    {
      api: core,
      read: 'readNamespacedSecret',
      remove: 'deleteNamespacedSecret',
      name: kubernetes.withSuffix(intent.runtimeName, 'env'),
    },
  ];
  const observed = [];

  for (const resource of resources) {
    try {
      const object = await resource.api[resource.read]({ name: resource.name, namespace: intent.namespace });
      if (!object.metadata.uid) throw new Error('Candidate object has no deletion precondition');
      if (object.metadata.labels?.[FLOW_LABEL] !== flowId) throw new Error('Candidate Kubernetes ownership changed');
      if (resource.api === apps && receipt && receipt.physicalId !== object.metadata.uid) {
        throw new Error('Candidate Deployment identity changed');
      }
      observed.push({ ...resource, uid: object.metadata.uid });
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }

  for (const resource of observed) {
    await resource.api[resource.remove]({
      name: resource.name,
      namespace: intent.namespace,
      body: { preconditions: { uid: resource.uid } },
      ...(resource.api === apps ? { propagationPolicy: 'Foreground' } : {}),
    }).catch(error => {
      if (!absent(error)) throw error;
    });
  }

  // Deleting the Deployment is not itself evidence that its consumers stopped.
  const deadline = Date.now() + 60000;
  for (;;) {
    const pods = await core.listNamespacedPod({
      namespace: intent.namespace,
      labelSelector: `social.usernode.io/runtime-name=${intent.runtimeName}`,
    });
    if (!pods.items?.length) break;
    if (Date.now() >= deadline) throw new Error('Candidate Pods have not terminated');
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  // An absent Pod list is insufficient if a delayed creator replaced an object.
  for (const resource of resources) {
    try {
      await resource.api[resource.read]({ name: resource.name, namespace: intent.namespace });
      throw new Error('Candidate resource deletion is not confirmed');
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  return { removed: true };
}

// Images are artifacts, not serving bindings. Drop only this attempt's Docker
// tag without force; Docker protects any remaining container references.
async function removeCandidateImage(intent) {
  if (intent.runtimeKind !== 'docker' || !intent.imageName) return;
  try {
    await docker.execFileAsync('docker', ['image', 'rm', intent.imageName], { timeout: 15000 });
  } catch (error) {
    if (!/no such image/i.test(error.stderr || error.message)) throw error;
  }
}

module.exports = { HEAD_LABEL, observePreparedCandidate, removeCandidate, verifyCandidate, removeCandidateImage };
