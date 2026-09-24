#!/usr/bin/env node
'use strict';
// Operator-local CLI. Uses the supplied kubeconfig, never the platform identity.
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { validatePolicy, createStore, submitRequest, reconcileRequest, publicRequest, REQUESTS } = require('../src/services/database-control-plane');
async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    kubeconfig: { type: 'string' }, 'expected-cluster-uid': { type: 'string' }, target: { type: 'string' },
    namespace: { type: 'string', default: 'social-platform' }, 'policy-configmap': { type: 'string', default: 'social-database-policy' },
  } });
  if (positionals.length !== 1 || !['plan', 'reconcile'].includes(positionals[0]) || !values.kubeconfig || !values['expected-cluster-uid'] || !values.target) {
    throw new Error('Usage: node tools/database-pools.js plan|reconcile --kubeconfig PATH --expected-cluster-uid UID --target ID');
  }
  const k8s = require('@kubernetes/client-node'), config = new k8s.KubeConfig();
  config.loadFromFile(values.kubeconfig);
  const core = config.makeApiClient(k8s.CoreV1Api);
  const ns = await core.readNamespace({ name: 'kube-system' });
  if (ns.metadata.uid !== values['expected-cluster-uid']) throw new Error('Kubernetes cluster identity mismatch');
  const cm = await core.readNamespacedConfigMap({ name: values['policy-configmap'], namespace: values.namespace });
  const policy = validatePolicy(JSON.parse(cm.data['policy.json']));
  if (!policy.operatorManaged || policy.namespace !== values.namespace || !policy.targets.some(t => t.id === values.target)) throw new Error('Target is not in the operator-managed registry');
  const store = createStore(config.makeApiClient(k8s.CustomObjectsApi));
  let request = await store.get(REQUESTS, policy.namespace, values.target);
  if (positionals[0] === 'plan') {
    const target = policy.targets.find(t => t.id === values.target);
    console.log(JSON.stringify({ action: request ? 'Reconcile existing request; preserve observed identities' : 'Create approved pool request',
      target: target.id, namespace: target.namespace, clusterName: target.clusterName, profile: target.profile,
      request: request ? publicRequest(request) : null }, null, 2));
    return;
  }
  request ||= await submitRequest(store, policy, values.target, 'infra-operator');
  let last;
  for (let attempt = 0; attempt < 150; attempt++) {
    // Always reconcile once: an old Ready status alone does not prove live resources exist.
    await reconcileRequest(store, policy, request);
    request = await store.get(REQUESTS, policy.namespace, values.target);
    const result = publicRequest(request), summary = JSON.stringify(result);
    if (summary !== last) { console.log(summary); last = summary; }
    if (result.phase === 'Ready') return;
    if (['Blocked', 'RecoveryRequired'].includes(result.phase)) throw new Error('Pool requires explicit operator recovery');
    await delay(2000);
  }
  throw new Error('Provisioning remains pending; rerun reconcile to continue the same request');
}
if (require.main === module) main().catch(e => {
  // API errors can contain credentials or full resources. Only our own messages are public.
  console.error('Operator request failed; check arguments, cluster identity and resource status.');
  process.exitCode = 1;
});
module.exports = { main };
