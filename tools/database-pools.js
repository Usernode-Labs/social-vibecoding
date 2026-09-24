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
  if (positionals.length !== 1 || !['plan', 'reconcile', 'project-runtime'].includes(positionals[0]) || !values.kubeconfig || !values['expected-cluster-uid'] || (positionals[0] !== 'project-runtime' && !values.target)) {
    throw new Error('Usage: node tools/database-pools.js plan|reconcile|project-runtime --kubeconfig PATH --expected-cluster-uid UID --target ID');
  }
  const k8s = require('@kubernetes/client-node'), config = new k8s.KubeConfig();
  config.loadFromFile(values.kubeconfig);
  const core = config.makeApiClient(k8s.CoreV1Api);
  const ns = await core.readNamespace({ name: 'kube-system' });
  if (ns.metadata.uid !== values['expected-cluster-uid']) throw new Error('Kubernetes cluster identity mismatch');
  const cm = await core.readNamespacedConfigMap({ name: values['policy-configmap'], namespace: values.namespace });
  const policy = validatePolicy(JSON.parse(cm.data['policy.json']));
  if (!policy.operatorManaged || policy.namespace !== values.namespace || (positionals[0] !== 'project-runtime' && !policy.targets.some(t => t.id === values.target))) throw new Error('Target is not in the operator-managed registry');
  const store = createStore(config.makeApiClient(k8s.CustomObjectsApi));
  if (positionals[0] === 'project-runtime') { await projectRuntime(core, store, policy); console.log('Runtime credentials projected for registered pool identities.'); return; }
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
async function projectRuntime(core, store, policy) {
  const data = {}, targets = [];
  for (const t of policy.runtimeTargets || []) {
    const cluster = await store.getCluster(t.namespace,t.clusterName);
    if (cluster?.metadata?.uid !== t.uid || cluster.metadata.deletionTimestamp) throw Error('Cluster identity changed');
    const ca = await core.readNamespacedSecret({namespace:t.namespace,name:`${t.clusterName}-ca`});
    const admin = await core.readNamespacedSecret({namespace:t.namespace,name:`${t.clusterName}-superuser`});
    for (const s of [ca,admin]) if (!s.metadata.ownerReferences?.some(r=>r.kind==='Cluster' && r.uid===t.uid)) throw Error('Secret identity changed');
    const decode=k=>Buffer.from(admin.data[k] || '', 'base64').toString();
    if (!ca.data['ca.crt'] || !decode('username') || !decode('password')) throw Error('Credentials missing');
    const url=new URL(`postgresql://${t.clusterName}-rw.${t.namespace}.svc.cluster.local:5432/postgres`);
    url.username=decode('username');url.password=decode('password');
    url.searchParams.set('sslmode','verify-full');url.searchParams.set('sslrootcert',`/etc/sv-database-targets/${t.id}.crt`);
    targets.push({id:t.id,clusterUid:t.uid,adminUrl:url.toString()});data[`${t.id}.crt`]=ca.data['ca.crt'];
  }
  if (!targets.length) throw Error('No runtime targets');
  data['targets.json']=Buffer.from(JSON.stringify({targets})).toString('base64');
  const args={namespace:policy.namespace,name:'social-database-runtime-targets'};
  let existing;
  try {existing=await core.readNamespacedSecret(args);} catch(e) {if (Number(e.code || e.response?.statusCode)!==404) throw e;}
  if (existing) await core.replaceNamespacedSecret({...args,body:{...existing,data}});
  else await core.createNamespacedSecret({namespace:policy.namespace,body:{apiVersion:'v1',kind:'Secret',metadata:{name:args.name,namespace:args.namespace},type:'Opaque',data}});
}
if (require.main === module) main().catch(e => {
  // API errors can contain credentials or full resources. Only our own messages are public.
  console.error('Operator request failed; check arguments, cluster identity and resource status.');
  process.exitCode = 1;
});
module.exports = { main, projectRuntime };
