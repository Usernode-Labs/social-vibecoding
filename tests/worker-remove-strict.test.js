'use strict';

// The proposal machine's teardown work removes a session's worker (and, for
// a close that asks, its CC volume) through worker.removeWorker /
// removeCcVolume (src/workflow/proposal/services.ts). Unlike the
// best-effort destroyWorker they are strict (a refused removal throws, and
// the work is tried again), fenced (only the resources read by identity
// before `proceed()` agreed are deleted, so a stalled call never removes a
// worker the session made after coming back) and finished (they answer once
// the resources are gone, not when the delete is accepted).

const test = require('node:test');
const assert = require('node:assert/strict');

const docker = require('../src/services/docker');
const kubernetes = require('../src/services/kubernetes');
const worker = require('../src/services/worker');

function swap(mod, name, fn, t) {
  const before = mod[name];
  mod[name] = fn;
  t.after(() => { mod[name] = before; });
}
function runtime(mode, t) {
  const before = process.env.WORKER_RUNTIME;
  process.env.WORKER_RUNTIME = mode;
  t.after(() => { if (before == null) delete process.env.WORKER_RUNTIME; else process.env.WORKER_RUNTIME = before; });
}
const NO_WAIT = { pollMs: 1 };

test('legacy Docker Stop targets the captured id and retains the stopped container and volume', async t => {
  runtime('docker', t); const calls = []; const queries = [];
  t.mock.method(require('../src/db/pool'), 'getPool', () => ({ query: async sql => { queries.push(sql); return { rows: [] }; } }));
  worker.adoptWarmWorker(41, 'usernode-worker-41'); worker.noteStopPending(41);
  const pending = worker.getPendingStop(41);
  swap(docker, 'execFileAsync', async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'inspect') return { stdout: 'captured-container-id\n' };
    assert.deepEqual(args, ['stop', 'captured-container-id']); return { stdout: '' };
  }, t);
  swap(docker, 'stopAndRemove', async () => { throw new Error('ordinary Docker Stop must retain the container'); }, t);
  swap(docker, 'getContainerStatus', async id => { assert.equal(id, 'captured-container-id'); return 'exited'; }, t);
  assert.deepEqual(await worker.stopWorkerByIdentity(41, { ...NO_WAIT, proceed: async () => true }), { stopped: true });
  assert.equal(calls.some(args => ['rm', 'volume'].includes(args[0])), false);
  assert.equal(worker.getPendingStop(41), pending, 'the spin-up gate survives a Docker stop');
  assert.ok(worker.warmRegistrySnapshot().some(e => e.sessionId === 41), 'the stopped container remains tracked');
  assert.equal(queries.some(sql => /DELETE FROM session_workers/.test(sql)), false, 'the sweeper can still find the container');
});

// ── worker.js, against the Kubernetes helpers ──────────────────────────

test('removeWorker reads the worker by identity, asks to proceed, deletes those, and answers once they are gone', async (t) => {
  runtime('kubernetes', t);
  const calls = [];
  const ids = { deployment: 'uid-d', secret: 'uid-s', pvc: null };
  let polls = 0;
  swap(kubernetes, 'workerIdentity', async (c, id, o) => { calls.push(['identity', id, o.volume]); return ids; }, t);
  swap(kubernetes, 'deleteWorkerIdentity', async (c, id, read) => { calls.push(['delete', id, read]); }, t);
  swap(kubernetes, 'workerIdentityGone', async () => { polls += 1; return polls >= 3; }, t);
  let renewed = 0;
  const out = await worker.removeWorker(41, {
    ...NO_WAIT, proceed: async () => { calls.push(['proceed']); return true; }, renew: async () => { renewed += 1; },
  });
  assert.deepEqual(out, { removed: true });
  assert.deepEqual(calls, [['identity', 41, false], ['proceed'], ['delete', 41, ids]], 'read, then asked, then deleted by identity');
  assert.equal(polls, 3, 'not done while the resources are still terminating');
  assert.equal(renewed, 2, 'the claim is checked while it waits');
});

test('removeWorker deletes nothing when proceed says no (the session came back, or the claim is gone)', async (t) => {
  runtime('kubernetes', t);
  let deleted = false;
  swap(kubernetes, 'workerIdentity', async () => ({ deployment: 'uid-d', secret: null, pvc: null }), t);
  swap(kubernetes, 'deleteWorkerIdentity', async () => { deleted = true; }, t);
  assert.deepEqual(await worker.removeWorker(41, { proceed: async () => false }), { skipped: true });
  await assert.rejects(worker.removeWorker(41, { proceed: async () => { throw new Error('lease lost'); } }), /lease lost/);
  assert.equal(deleted, false);
});

test('removeWorker finishes its last-use cleanup before a new worker can take the session lock', async t => {
  runtime('kubernetes', t);
  swap(kubernetes, 'workerIdentity', async () => ({ deployment: 'old-d', secret: null, pvc: null }), t);
  swap(kubernetes, 'deleteWorkerIdentity', async () => {}, t);
  swap(kubernetes, 'workerIdentityGone', async () => true, t);
  let resolveDelete; let reached;
  const started = new Promise(resolve => { reached = resolve; });
  const deleted = new Promise(resolve => { resolveDelete = resolve; });
  t.mock.method(require('../src/db/pool'), 'getPool', () => ({ query: async () => { reached(); return deleted; } }));
  let finished = false;
  const removing = worker.removeWorker(41).then(result => { finished = true; return result; });
  try {
    await started; assert.equal(finished, false);
    resolveDelete({ rows: [] }); assert.deepEqual(await removing, { removed: true });
  } finally { resolveDelete({ rows: [] }); await removing; }
});

test('removeWorker throws when the resources outlast its wait, or when Kubernetes refuses the deletion', async (t) => {
  runtime('kubernetes', t);
  swap(kubernetes, 'workerIdentity', async () => ({ deployment: 'uid-d', secret: null, pvc: null }), t);
  swap(kubernetes, 'deleteWorkerIdentity', async () => {}, t);
  swap(kubernetes, 'workerIdentityGone', async () => false, t);
  await assert.rejects(worker.removeWorker(41, { waitMs: 5, pollMs: 1 }), /worker_removal_pending/);
  kubernetes.deleteWorkerIdentity = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  await assert.rejects(worker.removeWorker(41, NO_WAIT), /ECONNREFUSED/);
});

test('removeCcVolume reads and removes the state volume too', async (t) => {
  runtime('kubernetes', t);
  const seen = [];
  swap(kubernetes, 'workerIdentity', async (c, id, o) => { seen.push(o.volume); return { deployment: null, secret: null, pvc: 'uid-p' }; }, t);
  swap(kubernetes, 'deleteWorkerIdentity', async (c, id, read) => { seen.push(read.pvc); }, t);
  swap(kubernetes, 'workerIdentityGone', async () => true, t);
  assert.deepEqual(await worker.removeCcVolume(41, NO_WAIT), { removed: true });
  assert.deepEqual(seen, [true, 'uid-p']);
});

// ── kubernetes.js: the fence and the absence ───────────────────────────

function fakeCluster(t, objects) {
  const deletes = [];
  const api = (kinds) => Object.fromEntries(kinds.flatMap((kind) => [
    [`readNamespaced${kind}`, async ({ name }) => {
      const o = objects.get(`${kind}/${name}`);
      if (!o) throw Object.assign(new Error('not found'), { code: 404 });
      return { metadata: { name, uid: o.uid } };
    }],
    [`deleteNamespaced${kind}`, async ({ name, body }) => {
      deletes.push({ kind, name, body });
      const o = objects.get(`${kind}/${name}`);
      if (!o) throw Object.assign(new Error('not found'), { code: 404 });
      if (body?.preconditions?.uid && body.preconditions.uid !== o.uid) throw Object.assign(new Error('precondition'), { code: 409 });
      o.terminating = true;
    }],
  ]));
  kubernetes._setClientsForTest({ apps: api(['Deployment']), core: api(['Secret', 'PersistentVolumeClaim']) });
  t.after(() => kubernetes._setClientsForTest(null));
  return deletes;
}
const CONFIG = { kubernetes: { workerNamespace: 'workers' } };

test('a fenced delete carries each uid it read, and leaves a newer worker of the same name alone', async (t) => {
  const objects = new Map([
    ['Deployment/sv-worker-s41', { uid: 'old-d' }],
    ['Secret/sv-worker-s41-env', { uid: 'old-s' }],
    ['PersistentVolumeClaim/sv-worker-s41-state', { uid: 'old-p' }],
  ]);
  const deletes = fakeCluster(t, objects);
  const ids = await kubernetes.workerIdentity(CONFIG, 41, { volume: false });
  assert.deepEqual(ids, { deployment: 'old-d', secret: 'old-s', pvc: null }, 'the volume is read only for a removal that takes it');
  // The session came back meanwhile: a new worker under the same name.
  objects.set('Deployment/sv-worker-s41', { uid: 'new-d' });
  await kubernetes.deleteWorkerIdentity(CONFIG, 41, ids);
  assert.deepEqual(deletes.map((d) => [d.kind, d.body.preconditions.uid]), [['Deployment', 'old-d'], ['Secret', 'old-s']]);
  assert.equal(deletes[0].body.propagationPolicy, 'Foreground');
  assert.equal(objects.get('Deployment/sv-worker-s41').terminating, undefined, 'the newer worker is untouched');
  assert.equal(objects.get('PersistentVolumeClaim/sv-worker-s41-state').terminating, undefined);
});

test('gone means absent or replaced, never merely accepted for deletion', async (t) => {
  const objects = new Map([['Deployment/sv-worker-s41', { uid: 'old-d' }]]);
  fakeCluster(t, objects);
  const ids = { deployment: 'old-d', secret: null, pvc: null };
  await kubernetes.deleteWorkerIdentity(CONFIG, 41, ids);
  assert.equal(await kubernetes.workerIdentityGone(CONFIG, 41, ids), false, 'still terminating');
  objects.delete('Deployment/sv-worker-s41');
  assert.equal(await kubernetes.workerIdentityGone(CONFIG, 41, ids), true);
  objects.set('Deployment/sv-worker-s41', { uid: 'new-d' });
  assert.equal(await kubernetes.workerIdentityGone(CONFIG, 41, ids), true, 'a newer one is not the one removed');
});

// ── worker.js on Docker ────────────────────────────────────────────────

test('on Docker the container is removed by the id read before proceeding, and its removal verified', async (t) => {
  runtime('docker', t);
  const calls = [];
  swap(docker, 'execFileAsync', async (cmd, args) => { calls.push(args.join(' ')); return { stdout: 'abc123\n' }; }, t);
  swap(docker, 'stopAndRemove', async (id) => { calls.push(`stopAndRemove ${id}`); return { removed: true }; }, t);
  swap(docker, 'getContainerStatus', async () => 'not_found', t);
  assert.deepEqual(await worker.removeWorker(41, { ...NO_WAIT, proceed: async () => { calls.push('proceed'); return true; } }), { removed: true });
  assert.deepEqual(calls, ['inspect --format {{.Id}} usernode-worker-41', 'proceed', 'stopAndRemove abc123']);
  docker.stopAndRemove = async () => ({ removed: false });
  await assert.rejects(worker.removeWorker(41, NO_WAIT), /worker_removal_failed/);
});

test('on Docker a volume removal failure other than "no such volume" throws', async (t) => {
  runtime('docker', t);
  swap(docker, 'execFileAsync', async (cmd, args) => {
    if (args[0] === 'inspect') throw Object.assign(new Error('x'), { stderr: 'Error: No such object: usernode-worker-41' });
    throw Object.assign(new Error('failed'), { stderr: 'Cannot connect to the Docker daemon' });
  }, t);
  await assert.rejects(worker.removeCcVolume(41, NO_WAIT), /volume_removal_failed/);
});
