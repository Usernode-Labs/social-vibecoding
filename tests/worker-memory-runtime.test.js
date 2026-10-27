'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const kubernetes = require('../src/services/kubernetes');
const docker = require('../src/services/docker');
const runtime = require('../src/services/worker-memory-runtime');
const { copyIdentity, COPY_LABEL } = require('../src/workflow/worker-memory-copy/identity.ts');

const CONFIG = { kubernetes: { workerNamespace: 'workers', workerServiceAccount: 'worker', workerImage: 'synthetic-worker', workerStorageSize: '1Gi' } };
const missing = () => Object.assign(new Error('not found'), { code: 404 });
const options = () => ({ requestId: randomUUID(), proceed: async () => true, renew: async () => {}, timeoutMs: 2000, pollMs: 1 });
test.beforeEach(t => {
  const role = process.env.PROCESS_ROLE; process.env.PROCESS_ROLE = 'conductor';
  t.after(() => { if (role === undefined) delete process.env.PROCESS_ROLE; else process.env.PROCESS_ROLE = role; });
});

function cluster(t, { beforeStart = null, afterCreate = null, failed = false } = {}) {
  const source = 'sv-worker-s31-state'; const target = 'sv-worker-s32-state';
  const objects = new Map([[`PersistentVolumeClaim/${source}`, { apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: source, uid: 'source-uid' }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '2Gi' } }, storageClassName: 'test' } }]]);
  const calls = [];
  const api = kinds => Object.fromEntries(kinds.flatMap(kind => [
    [`readNamespaced${kind}`, async ({ name }) => {
      if (!objects.has(`${kind}/${name}`)) throw missing(); return structuredClone(objects.get(`${kind}/${name}`));
    }],
    [`createNamespaced${kind}`, async ({ body }) => {
      const key = `${kind}/${body.metadata.name}`;
      if (objects.has(key)) throw Object.assign(new Error('exists'), { code: 409 });
      const obj = structuredClone(body); obj.metadata.uid = `${kind}-uid`; obj.metadata.resourceVersion = '1';
      objects.set(key, obj); calls.push(['create', kind, structuredClone(obj)]);
      if (afterCreate) await afterCreate(kind, objects);
      return structuredClone(obj);
    }],
    [`deleteNamespaced${kind}`, async ({ name, body }) => {
      const obj = objects.get(`${kind}/${name}`); calls.push(['delete', kind, name, body]);
      if (!obj) throw missing();
      if (obj.metadata.uid !== body.preconditions.uid) throw Object.assign(new Error('conflict'), { code: 409 });
      objects.delete(`${kind}/${name}`);
    }],
  ]));
  const core = { ...api(['PersistentVolumeClaim']), listNamespacedPod: async () => ({ items: [{ spec: { nodeName: 'source-node' } }] }) };
  const batch = { ...api(['Job']), listNamespacedJob: async () => ({ items: [...objects].filter(([key]) => key.startsWith('Job/')).map(([, obj]) => structuredClone(obj)) }),
    replaceNamespacedJob: async ({ name, body }) => {
    if (beforeStart) await beforeStart(objects, name);
    const obj = objects.get(`Job/${name}`);
    if (!obj || obj.metadata.uid !== body.metadata.uid || obj.metadata.resourceVersion !== body.metadata.resourceVersion) {
      throw Object.assign(new Error('conflict'), { code: 409 });
    }
    calls.push(['start', structuredClone(body)]); obj.spec.suspend = false;
    obj.status = failed ? { failed: 1 } : { succeeded: 1 }; return structuredClone(obj);
  } };
  kubernetes._setClientsForTest({ core, batch }); t.after(() => kubernetes._setClientsForTest(null));
  return { objects, calls, target };
}

test('Kubernetes copies only to a fresh owned PVC, starts a suspended Job by version, and removes its completed Job', async t => {
  const { objects, calls, target } = cluster(t); const o = options();
  await kubernetes.cloneWorkerVolume(CONFIG, 31, 32, o);
  const job = calls.find(c => c[0] === 'create' && c[1] === 'Job')[2];
  assert.equal(job.spec.suspend, true); assert.equal(job.metadata.labels[COPY_LABEL], o.requestId);
  assert.equal(calls.find(c => c[0] === 'start')[1].metadata.resourceVersion, '1');
  assert.equal(job.spec.template.spec.serviceAccountName, 'worker');
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(job.spec.template.spec.nodeName, 'source-node');
  assert.equal(job.spec.template.spec.volumes[0].persistentVolumeClaim.readOnly, true);
  assert.equal(objects.get(`PersistentVolumeClaim/${target}`).metadata.labels[COPY_LABEL], o.requestId);
  assert.equal([...objects.keys()].some(k => k.startsWith('Job/')), false);
  assert.equal(calls.some(c => c[0] === 'delete' && c[2] === 'sv-worker-s31-state'), false);
});

test('Kubernetes refuses an existing destination and cleanup never removes another request’s resources', async t => {
  const { objects, calls, target } = cluster(t); const o = options();
  objects.set(`PersistentVolumeClaim/${target}`, { metadata: { uid: 'existing', labels: { [COPY_LABEL]: randomUUID() } } });
  await assert.rejects(kubernetes.cloneWorkerVolume(CONFIG, 31, 32, o), /already exists/);
  await kubernetes.cleanupWorkerVolumeClone(CONFIG, 31, 32, o);
  assert.equal(objects.get(`PersistentVolumeClaim/${target}`).metadata.uid, 'existing');
  assert.deepEqual(calls, []);
});

test('a changed PVC or revoked permission after creation never starts the suspended Job; cleanup removes only its partial destination', async t => {
  for (const changed of ['volume', 'permission']) await t.test(changed, async t => {
    let allowed = true;
    const { objects, calls, target } = cluster(t, { afterCreate: (kind, objects) => {
      if (kind === 'Job') {
        if (changed === 'volume') objects.get('PersistentVolumeClaim/sv-worker-s31-state').metadata.uid = 'new-source';
        else allowed = false;
      }
    } });
    const o = { ...options(), proceed: async () => allowed };
    await assert.rejects(kubernetes.cloneWorkerVolume(CONFIG, 31, 32, o), /target changed/);
    await kubernetes.cleanupWorkerVolumeClone(CONFIG, 31, 32, o);
    assert.equal(calls.some(c => c[0] === 'start'), false);
    assert.equal(objects.has(`PersistentVolumeClaim/${target}`), false);
    assert.equal(objects.has('PersistentVolumeClaim/sv-worker-s31-state'), true);
  });
});

test('a delayed Kubernetes start/delete cannot affect a replacement Job', async t => {
  const { calls, objects } = cluster(t, { beforeStart: (objects, name) => {
    const job = objects.get(`Job/${name}`); job.metadata.uid = 'replacement'; job.metadata.labels[COPY_LABEL] = 'another-request';
  } });
  const o = options(); await assert.rejects(kubernetes.cloneWorkerVolume(CONFIG, 31, 32, o), /conflict/);
  await kubernetes.cleanupWorkerVolumeClone(CONFIG, 31, 32, o);
  assert.equal(calls.some(c => c[0] === 'start'), false);
  assert.equal(objects.get(`Job/${copyIdentity(31, 32, o.requestId).job}`).metadata.uid, 'replacement');
  assert.ok(calls.filter(c => c[0] === 'delete' && c[1] === 'Job').every(c => c[3].preconditions.uid === 'Job-uid'));
});

function daemon(t, { exitCode = 0, onCreate = null } = {}) {
  const volumes = new Map([['usernode-cc-31', { Name: 'usernode-cc-31', Labels: {} }]]);
  const containers = new Map(); const calls = [];
  t.mock.method(docker, 'execFileAsync', async (_cmd, args) => {
    calls.push(args);
    const value = obj => ({ stdout: JSON.stringify([obj]) });
    const absent = what => { throw Object.assign(new Error(`No such ${what}`), { stderr: `No such ${what}` }); };
    if (args[0] === 'volume' && args[1] === 'inspect') return volumes.has(args[2]) ? value(volumes.get(args[2])) : absent('volume');
    if (args[0] === 'ps') return { stdout: [...containers.keys()].join('\n') };
    if (args[0] === 'volume' && args[1] === 'create') {
      volumes.set(args.at(-1), { Name: args.at(-1), Labels: { [COPY_LABEL]: args[3].split('=')[1] } }); return { stdout: args.at(-1) };
    }
    if (args[0] === 'create') {
      const obj = { Id: 'container-id', Name: args[2], Config: { Labels: { [COPY_LABEL]: args[4].split('=')[1] } }, State: { Running: false, ExitCode: 0 } };
      containers.set(obj.Id, obj); if (onCreate) await onCreate(); return { stdout: obj.Id };
    }
    if (args[0] === 'start') { const obj = containers.get(args[2]); assert.ok(obj); obj.State.ExitCode = exitCode; return { stdout: '' }; }
    if (args[0] === 'inspect') { const obj = [...containers.values()].find(c => c.Id === args[1] || c.Name === args[1]); return obj ? value(obj) : absent('container'); }
    if (args[0] === 'rm') { containers.delete(args[2]); return { stdout: '' }; }
    if (args[0] === 'volume' && args[1] === 'rm') { assert.equal(containers.size, 0); volumes.delete(args[2]); return { stdout: '' }; }
    throw new Error(`Unexpected Docker call ${args}`);
  });
  return { volumes, containers, calls };
}
test('Docker starts by captured id and checks the copy’s exit status, cleaning failed partial data', async t => {
  for (const exitCode of [0, 17]) await t.test(String(exitCode), async t => {
    const { containers, volumes, calls } = daemon(t, { exitCode }); const o = options();
    const copied = runtime.copy(31, 32, o, { config: null, image: 'synthetic-worker' });
    if (exitCode) { await assert.rejects(copied, /container failed/); await runtime.cleanup(31, 32, o, { config: null }); }
    else await copied;
    assert.equal(containers.size, 0);
    assert.deepEqual(calls.find(c => c[0] === 'start'), ['start', '--attach', 'container-id']);
    assert.equal(volumes.has('usernode-cc-32'), exitCode === 0);
    assert.equal(volumes.has('usernode-cc-31'), true);
    assert.ok(calls.find(c => c[0] === 'create').includes('usernode-cc-31:/from:ro'));
  });
});
test('a delayed Docker create losing authority never starts a container', async t => {
  let allowed = true; const { calls } = daemon(t, { onCreate: () => { allowed = false; } });
  const o = { ...options(), proceed: async () => allowed };
  await assert.rejects(runtime.copy(31, 32, o, { config: null, image: 'synthetic-worker' }), /target changed/);
  await runtime.cleanup(31, 32, o, { config: null });
  assert.equal(calls.some(c => c[0] === 'start'), false);
});
test('web cannot perform a copy or cleanup on either runtime', async t => {
  process.env.PROCESS_ROLE = 'web';
  t.mock.method(docker, 'execFileAsync', () => { throw new Error('privileged web Docker call'); });
  t.mock.method(kubernetes, 'cloneWorkerVolume', () => { throw new Error('privileged web Kubernetes call'); });
  for (const config of [null, CONFIG]) {
    await assert.rejects(runtime.copy(31, 32, options(), { config, image: 'synthetic-worker' }), /requires a workflow process/);
    await assert.rejects(runtime.cleanup(31, 32, options(), { config }), /requires a workflow process/);
    await assert.rejects(runtime.sweep({}, { config }), /requires a workflow process/);
  }
});

test('the periodic sweep removes late inert copy resources, sparing live requests and recent creates', async t => {
  for (const mode of ['docker', 'kubernetes']) await t.test(mode, async t => {
    const live = randomUUID(); const orphan = randomUUID(); const young = randomUUID();
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const pool = { query: async () => ({ rows: [{ request_id: live }] }) };
    if (mode === 'docker') {
      const { containers, calls } = daemon(t);
      for (const requestId of [live, orphan, young]) containers.set(requestId, { Id: requestId,
        Config: { Labels: { [COPY_LABEL]: requestId } }, Created: requestId === young ? new Date().toISOString() : old });
      assert.equal(await runtime.sweep(pool, { config: null }), 1);
      assert.ok(containers.has(live)); assert.ok(containers.has(young)); assert.equal(containers.has(orphan), false);
      assert.equal(calls.some(c => c[0] === 'volume' && c[1] === 'rm'), false);
    } else {
      const { objects } = cluster(t);
      for (const requestId of [live, orphan, young]) objects.set(`Job/${requestId}`, {
        metadata: { name: requestId, uid: requestId, labels: { [COPY_LABEL]: requestId },
          creationTimestamp: requestId === young ? new Date().toISOString() : old }, spec: { suspend: true } });
      assert.equal(await runtime.sweep(pool, { config: CONFIG }), 1);
      assert.ok(objects.has(`Job/${live}`)); assert.ok(objects.has(`Job/${young}`)); assert.equal(objects.has(`Job/${orphan}`), false);
    }
  });
});
