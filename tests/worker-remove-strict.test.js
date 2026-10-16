'use strict';

// The proposal machine's teardown work removes a session's worker and CC
// volume through worker.removeWorker / removeCcVolume
// (src/workflow/proposal/services.ts). Unlike the best-effort destroyWorker,
// they throw when the runtime refuses, so the durable work item is tried
// again instead of reporting a removal that did not happen.

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

test('removeWorker throws when Kubernetes refuses the deletion', async (t) => {
  runtime('kubernetes', t);
  swap(kubernetes, 'deleteWorker', async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); }, t);
  await assert.rejects(worker.removeWorker(41), /ECONNREFUSED/);
});

test('removeWorker asks Kubernetes to delete the worker, keeping its volume', async (t) => {
  runtime('kubernetes', t);
  const calls = [];
  swap(kubernetes, 'deleteWorker', async (config, id, opts) => { calls.push([id, opts]); }, t);
  await worker.removeWorker(41);
  assert.deepEqual(calls, [[41, { deleteVolume: false }]]);
});

test('removeWorker throws when the container survives its removal (Docker)', async (t) => {
  runtime('docker', t);
  swap(docker, 'stopAndRemove', async () => ({ removed: false }), t);
  await assert.rejects(worker.removeWorker(41), /worker_removal_failed/);
});

test('removeCcVolume throws on a Docker failure other than "no such volume", and is quiet when it is gone', async (t) => {
  runtime('docker', t);
  swap(docker, 'execFileAsync', async () => { throw Object.assign(new Error('failed'), { stderr: 'Cannot connect to the Docker daemon' }); }, t);
  await assert.rejects(worker.removeCcVolume(41), /volume_removal_failed/);
  docker.execFileAsync = async () => { throw Object.assign(new Error('failed'), { stderr: 'Error: No such volume: cc-41' }); };
  await worker.removeCcVolume(41);
});
