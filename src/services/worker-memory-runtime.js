'use strict';

const docker = require('./docker');
const kubernetes = require('./kubernetes');
const { copyIdentity, COPY_LABEL } = require('../workflow/worker-memory-copy/identity.ts');

function workflowOnly() {
  const role = require('./process-role');
  if (!role.runsWorkflow(role.processRole())) throw new Error('Worker memory copying requires a workflow process');
}
async function inspect(kind, name) {
  try {
    const { stdout } = await docker.execFileAsync('docker', kind === 'volume'
      ? ['volume', 'inspect', name] : ['inspect', name], { timeout: 5000 });
    return JSON.parse(stdout)[0];
  } catch (err) {
    if (/no such (volume|container|object)/i.test(String(err.stderr || err.message))) return null;
    throw err;
  }
}
async function removeContainer(id) {
  try { await docker.execFileAsync('docker', ['rm', '-f', id], { timeout: 15000 }); }
  catch (err) { if (!/no such (container|object)/i.test(String(err.stderr || err.message))) throw err; }
}

async function copy(sourceId, sessionId, options, { config, image }) {
  workflowOnly();
  const id = copyIdentity(sourceId, sessionId, options.requestId);
  if (config) return kubernetes.cloneWorkerVolume(config, sourceId, sessionId, options);
  const { proceed, renew, signal, timeoutMs } = options;
  if (!(await inspect('volume', id.sourceVolume))) throw new Error('Source memory volume is missing');
  if (await inspect('volume', id.targetVolume)) throw new Error('Destination memory volume already exists');
  if (!(await proceed())) throw new Error('Memory copy target changed');
  await docker.execFileAsync('docker', ['volume', 'create', '--label', `${COPY_LABEL}=${id.requestId}`, id.targetVolume], { timeout: 10000 });
  await renew();
  if (!(await proceed())) throw new Error('Memory copy target changed');
  // Create, then start by immutable id. A delayed create from a dead
  // conductor leaves an inert container, never a late write into a new turn.
  const { stdout } = await docker.execFileAsync('docker', [
    'create', '--name', id.container, '--label', `${COPY_LABEL}=${id.requestId}`, '--user', '0:0',
    '-v', `${id.sourceVolume}:/from:ro`, '-v', `${id.targetVolume}:/to`, '--entrypoint', 'sh', image,
    '-c', 'cp -a /from/. /to/',
  ], { timeout: 10000 });
  const containerId = stdout.trim();
  if (!containerId) throw new Error('Memory copy container has no identity');
  try {
    if (!(await proceed())) throw new Error('Memory copy target changed');
    await docker.execFileAsync('docker', ['start', '--attach', containerId], { timeout: Math.min(60000, timeoutMs), signal });
    const ended = await inspect('container', containerId);
    if (!ended || ended.State?.Running !== false || ended.State?.ExitCode !== 0) throw new Error('Memory copy container failed');
    if (!(await proceed())) throw new Error('Memory copy target changed');
  } finally {
    // Removal by id stops a failed/timed-out copy before cleanup can
    // release the destination for a fresh turn.
    await removeContainer(containerId);
  }
}

async function cleanup(sourceId, sessionId, { requestId, renew }, { config }) {
  workflowOnly(); const id = copyIdentity(sourceId, sessionId, requestId);
  if (config) return kubernetes.cleanupWorkerVolumeClone(config, sourceId, sessionId, { requestId, renew });
  const container = await inspect('container', id.container);
  if (container?.Config?.Labels?.[COPY_LABEL] === requestId) {
    await renew();
    await removeContainer(container.Id);
    if (await inspect('container', container.Id)) throw new Error('Memory copy container is still present');
  }
  const volume = await inspect('volume', id.targetVolume);
  if (volume?.Labels?.[COPY_LABEL] === requestId) {
    await renew();
    try { await docker.execFileAsync('docker', ['volume', 'rm', id.targetVolume], { timeout: 15000 }); }
    catch (err) { if (!/no such volume/i.test(String(err.stderr || err.message))) throw err; }
    const current = await inspect('volume', id.targetVolume);
    if (current?.Labels?.[COPY_LABEL] === requestId) throw new Error('Partial memory copy is still present');
  }
}

// A create can arrive after its process died and cleanup found nothing. Such
// resources cannot start copying (create/start are separate), but still need GC.
async function sweep(pool, { config }) {
  workflowOnly();
  let resources;
  if (config) resources = await kubernetes.listMemoryCopyJobs(config);
  else {
    const { stdout } = await docker.execFileAsync('docker', ['ps', '--all', '--filter', `label=${COPY_LABEL}`, '--format', '{{.ID}}'], { timeout: 10000 });
    resources = [];
    for (const id of stdout.trim().split(/\s+/).filter(Boolean)) {
      const obj = await inspect('container', id);
      if (obj) resources.push({ id: obj.Id, requestId: obj.Config?.Labels?.[COPY_LABEL], createdAt: obj.Created });
    }
  }
  resources = resources.filter(r => r.requestId && Date.parse(r.createdAt) < Date.now() - 10 * 60 * 1000);
  if (!resources.length) return 0;
  const { rows } = await pool.query(`SELECT data->'target'->>'requestId' AS request_id FROM wf_instances
    WHERE machine = 'worker-memory-copy' AND state IN ('copying', 'cleaning', 'waiting_cleanup')
      AND data->'target'->>'requestId' = ANY($1::text[])`, [resources.map(r => r.requestId)]);
  const active = new Set(rows.map(r => r.request_id)); let removed = 0;
  for (const resource of resources.filter(r => !active.has(r.requestId)).slice(0, 20)) {
    if (config) await kubernetes.removeMemoryCopyJob(config, resource);
    else await removeContainer(resource.id);
    removed += 1;
  }
  return removed;
}

module.exports = { copy, cleanup, sweep };
