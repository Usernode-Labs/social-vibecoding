'use strict';

const log = require('./logger');
const MAX_LOG_BYTES = 16 * 1024;

function boundedText(text, maxBytes = MAX_LOG_BYTES) {
  const bytes = Buffer.from(log.redactString(String(text || '')));
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start).toString('utf8');
}

function conditionDetails(conditions = []) {
  return (conditions || []).filter(c => c.type === 'ReplicaFailure' ? c.status === 'True' : c.status === 'False')
    .map(c => [c.type, c.reason, c.message].filter(Boolean).join(': '));
}

// Read before deleting failed resources. Bound both the total work and each
// request, preserve partial evidence, and never let diagnostics mask failure.
// No Secret values or Pod environment/command fields are copied into errors.
async function collectPodDiagnostics(core, {
  namespace, runtimeName, podName, imageRef, environmentChecksum, container = 'app',
  timeoutMs = 10000, maxBytes = MAX_LOG_BYTES,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const details = [];
  const unavailable = [];
  const chunks = [];
  let truncated = false;
  let infrastructure = false;
  const read = async fn => {
    if (Date.now() >= deadline) { truncated = true; return null; }
    let timer;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('diagnostic read timed out')), Math.min(2000, deadline - Date.now()));
      })]);
    } catch (err) {
      unavailable.push(boundedText(err.message || String(err), 200));
      return null;
    } finally { clearTimeout(timer); }
  };
  let pods;
  if (podName) {
    const pod = await read(() => core.readNamespacedPod({ name: podName, namespace }));
    pods = pod ? [pod] : [];
  } else {
    const result = await read(() => core.listNamespacedPod({ namespace,
      labelSelector: `social.usernode.io/runtime-name=${runtimeName}` }));
    pods = (result?.items || []).filter(pod => !pod.metadata?.deletionTimestamp
      && (!imageRef || pod.spec?.containers?.some(c => c.name === container && c.image === imageRef))
      && (!environmentChecksum || pod.metadata?.annotations?.['social.usernode.io/env-checksum'] === environmentChecksum));
    pods.sort((a, b) => new Date(b.metadata?.creationTimestamp || 0) - new Date(a.metadata?.creationTimestamp || 0));
  }
  if (pods.length > 3) truncated = true;
  for (const pod of pods.slice(0, 3)) {
    details.push(...conditionDetails(pod.status?.conditions));
    if (pod.status?.conditions?.some(c => c.type === 'PodScheduled' && c.status === 'False')) infrastructure = true;
    const statuses = [...(pod.status?.initContainerStatuses || []), ...(pod.status?.containerStatuses || [])];
    const names = container ? [container] : [...new Set([
      ...(pod.spec?.initContainers || []).map(c => c.name), ...(pod.spec?.containers || []).map(c => c.name),
    ])];
    for (const name of names) {
      if (Date.now() >= deadline) { truncated = true; break; }
      const status = statuses.find(c => c.name === name);
      for (const state of [status?.state?.waiting, status?.state?.terminated, status?.lastState?.terminated]) {
        if (state) details.push(`${name}: ${[state.reason, state.message,
          state.exitCode != null ? `exit=${state.exitCode}` : null].filter(Boolean).join(': ')}`);
      }
      const previous = status?.lastState?.terminated ? [true, false] : [false];
      for (const prior of previous) {
        const output = await read(() => core.readNamespacedPodLog({ namespace, name: pod.metadata.name,
          container: name, previous: prior, tailLines: 200, limitBytes: maxBytes }));
        if (output) chunks.push(`[${pod.metadata.name}/${name}${prior ? ' previous' : ''}]\n${boundedText(output, maxBytes)}`);
      }
    }
  }
  if (truncated) unavailable.push('Diagnostics collection bounded; additional evidence may be omitted');
  return { logs: boundedText(chunks.join('\n'), maxBytes), details: boundedText(details.join('\n'), 4096),
    unavailable: boundedText(unavailable.join('\n'), 1024), infrastructure };
}

module.exports = { collectPodDiagnostics, conditionDetails, boundedText };
