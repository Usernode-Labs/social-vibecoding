'use strict';

// Test transport only; production authorization, manifests and observation stay real.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

function createInjectedRuntimeApi() {
  const objects = new Map();
  const creates = [];
  const deployments = new Map();
  const deletes = [];
  let version = 0;
  const clients = { core: {}, apps: {} };

  for (const [kind, suffix] of [['secret', 'Secret'], ['service', 'Service'], ['deployment', 'Deployment']]) {
    const api = kind === 'deployment' ? clients.apps : clients.core;
    api[`readNamespaced${suffix}`] = async ({ name }) => {
      const object = objects.get(`${kind}/${name}`);
      if (!object) throw { code: 404 };
      return structuredClone(object);
    };

    api[`createNamespaced${suffix}`] = async ({ body }) => {
      const key = `${kind}/${body.metadata.name}`;
      if (objects.has(key)) throw { code: 409 };
      const object = structuredClone(body);
      object.metadata = {
        ...object.metadata,
        uid: randomUUID(),
        resourceVersion: String(++version),
        generation: 1,
      };
      if (kind === 'deployment') {
        object.status = { observedGeneration: 1, updatedReplicas: 1, readyReplicas: 1, availableReplicas: 1 };
      }
      objects.set(key, object);
      if (kind === 'deployment') deployments.set(`${body.metadata.namespace}/${body.metadata.name}`, object);
      creates.push(kind);
      return structuredClone(object);
    };

    api[`deleteNamespaced${suffix}`] = async ({ name, body }) => {
      const key = `${kind}/${name}`;
      const object = objects.get(key);
      if (!object) throw { code: 404 };
      if (kind === 'deployment') assert.equal(body.propagationPolicy, 'Foreground');
      assert.equal(body.preconditions.uid, object.metadata.uid);
      assert.equal(body.preconditions.resourceVersion, object.metadata.resourceVersion);
      deletes.push(kind);
      objects.delete(key);
      if (kind === 'deployment') deployments.delete(`${object.metadata.namespace}/${name}`);
    };
  }

  function selectedDeployment({ namespace, labelSelector }) {
    const labels = (labelSelector || '').split(',').filter(Boolean).map(value => value.split('='));
    return [...deployments.values()].find(deployment => deployment.metadata.namespace === namespace
      && labels.every(([key, value]) => deployment.metadata.labels[key] === value));
  }

  clients.apps.listNamespacedReplicaSet = async request => {
    const deployment = selectedDeployment(request);
    return { items: deployment ? [{ metadata: {
      uid: 'owned-rs',
      ownerReferences: [{ controller: true, uid: deployment.metadata.uid }],
    } }] : [] };
  };

  clients.core.listNamespacedPod = async request => {
    const deployment = selectedDeployment(request);
    return { items: deployment ? [{
      metadata: {
        uid: 'owned-pod',
        labels: deployment.spec.template.metadata.labels,
        ownerReferences: [{ controller: true, uid: 'owned-rs' }],
      },
      spec: deployment.spec.template.spec,
      status: { conditions: [{ type: 'Ready', status: 'True' }] },
    }] : [] };
  };

  clients.core.readNamespacedEndpoints = async () => ({
    subsets: [{ addresses: [{ targetRef: { uid: 'owned-pod' } }] }],
  });

  return { objects, creates, deletes, clients, deployments };
}

module.exports = { createInjectedRuntimeApi };
