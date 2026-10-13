'use strict';

const { boundedText, collectPodDiagnostics, conditionDetails } = require('./kubernetes-diagnostics');

// Waits the kubelet reports while it cannot even start the container. None
// of them clears inside a setup window, so waiting out the full timeout only
// delays the same answer. Each maps to a typed reason the route layer words
// for the user; the Kubernetes name stays in the logged message.
const STUCK_WAITING_REASONS = Object.freeze({
  ImagePullBackOff: 'image_unavailable',
  ErrImagePull: 'image_unavailable',
  InvalidImageName: 'image_unavailable',
  CreateContainerConfigError: 'config_error',
});
// Short graces, not zero: a registry blip can show ErrImagePull once, the
// Secret written just before the Deployment can briefly read as a config
// error, and a fresh volume can leave a Pod unschedulable for a few seconds.
const STUCK_WAITING_GRACE_MS = 30 * 1000;
const UNSCHEDULABLE_GRACE_MS = 60 * 1000;

function workerCouldNotStart(reason, detail) {
  const err = new Error(`worker could not start (${detail})`);
  Object.defineProperty(err, 'bootstrapReason', { value: reason, configurable: true, writable: true });
  return err;
}

// Observe setup while the readiness probe is still false. Waiting for the
// Deployment first hides clone failures and all setup progress until timeout.
async function waitForWorkerBootstrap(core, apps, {
  namespace, name, imageRef, environmentChecksum, generation = 0,
  onProgress, timeoutMs,
}) {
  if (!(timeoutMs > 0)) timeoutMs = 5 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let phase = null;
  let recent = [];
  let podName = null;
  let lastReadError = null;
  let stuck = null;
  const warnings = new Set();
  const emit = text => { try { onProgress?.(text); } catch { /* observer only */ } };
  const read = async fn => {
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Worker setup observation timed out')),
          Math.max(1, Math.min(5000, deadline - Date.now())));
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    while (Date.now() < deadline) {
      let deployment, pods;
      try {
        [deployment, pods] = await Promise.all([
          read(() => apps.readNamespacedDeployment({ namespace, name })),
          read(() => core.listNamespacedPod({ namespace, labelSelector: `social.usernode.io/runtime-name=${name}` })),
        ]);
      } catch (err) {
        lastReadError = boundedText(err.message, 500);
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }
      const candidates = (pods.items || []).filter(pod => !pod.metadata?.deletionTimestamp
        && pod.metadata?.annotations?.['social.usernode.io/env-checksum'] === environmentChecksum
        && pod.spec?.containers?.some(c => c.name === 'worker' && c.image === imageRef));
      candidates.sort((a, b) => new Date(b.metadata?.creationTimestamp || 0) - new Date(a.metadata?.creationTimestamp || 0));
      const pod = candidates[0];
      if (pod) {
        podName = pod.metadata.name;
        let output = '';
        try {
          output = await read(() => core.readNamespacedPodLog({ namespace, name: podName,
            container: 'worker', tailLines: 200, limitBytes: 16384 }));
        } catch (err) { lastReadError = boundedText(err.message, 500); }
        const lines = boundedText(output).split('\n').filter(Boolean);
        recent = lines.slice(-20);
        // A cumulative log snapshot may repeat earlier phases. Publish only
        // its latest phase, so polling never replays clone -> checkout -> clone.
        const phases = lines.filter(line => line.startsWith('__USERNODE_PHASE__ '));
        const nextPhase = phases.at(-1)?.replace('__USERNODE_PHASE__ ', '').trim();
        if (nextPhase && nextPhase !== phase) { phase = nextPhase; emit(`[${phase}]`); }
        for (const line of lines.filter(line => line.startsWith('__USERNODE_WARN__ '))) {
          if (!warnings.has(line)) { warnings.add(line); emit(`⚠ ${line.replace('__USERNODE_WARN__ ', '')}`); }
        }
        const fatal = lines.find(line => line.startsWith('__USERNODE_ERROR__ '));
        if (fatal) throw new Error(fatal.replace('__USERNODE_ERROR__ ', '').trim());
        const worker = pod.status?.containerStatuses?.find(c => c.name === 'worker');
        if (worker?.state?.terminated || worker?.state?.waiting?.reason === 'CrashLoopBackOff') {
          throw new Error(`warm wrapper exited before warm-ready (${worker.state.terminated?.reason || worker.state.waiting.reason})`);
        }
        const waiting = worker?.state?.waiting?.reason;
        const unschedulable = pod.status?.conditions?.some(c => c.type === 'PodScheduled'
          && c.status === 'False' && c.reason === 'Unschedulable');
        const stuckKey = STUCK_WAITING_REASONS[waiting] ? `${podName}/${waiting}`
          : (unschedulable ? `${podName}/Unschedulable` : null);
        if (!stuckKey) stuck = null;
        else if (stuck?.key !== stuckKey) stuck = { key: stuckKey, since: Date.now() };
        else if (Date.now() - stuck.since >= (unschedulable && !STUCK_WAITING_REASONS[waiting]
          ? UNSCHEDULABLE_GRACE_MS : STUCK_WAITING_GRACE_MS)) {
          throw STUCK_WAITING_REASONS[waiting]
            ? workerCouldNotStart(STUCK_WAITING_REASONS[waiting], waiting)
            : workerCouldNotStart('unschedulable', 'Unschedulable');
        }
        const status = deployment.status || {};
        if (!deployment.metadata?.deletionTimestamp && status.observedGeneration >= generation
            && status.updatedReplicas === 1 && status.replicas === 1 && status.availableReplicas >= 1
            && pod.status?.phase === 'Running' && worker?.ready && worker.state?.running
            && pod.status?.conditions?.some(c => c.type === 'Ready' && c.status === 'True')) {
          if (phase !== 'warm-ready') emit('[warm-ready]');
          return;
        }
      }
      const failure = deployment.status?.conditions?.find(c => c.type === 'ReplicaFailure' && c.status === 'True');
      if (failure) throw new Error(`Worker setup failed: ${conditionDetails([failure]).join('; ')}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`warm-ready timeout for ${name}`);
  } catch (err) {
    const diagnostics = await collectPodDiagnostics(core, {
      namespace, runtimeName: name, podName, imageRef, environmentChecksum, container: 'worker',
    });
    err.message = boundedText(err.message, 2000);
    const context = { bootstrapFailed: true, bootstrapPhase: phase, bootstrapContainerName: name,
      bootstrapLog: boundedText([recent.join('\n'), diagnostics.details, diagnostics.logs,
        diagnostics.unavailable, lastReadError].filter(Boolean).join('\n')).split('\n') };
    for (const [key, value] of Object.entries(context)) {
      Object.defineProperty(err, key, { value, configurable: true, writable: true });
    }
    throw err;
  }
}

module.exports = { waitForWorkerBootstrap, STUCK_WAITING_REASONS, STUCK_WAITING_GRACE_MS, UNSCHEDULABLE_GRACE_MS };
