'use strict';

// Remove what check runs leave in the worker namespace when nothing else will.
//
// A run's capture and unit-suite Jobs each read an input Secret that the Job
// owns, so the Job's TTL collects it (services/kubernetes.js runCheckJob).
// Two things defeat that ownership:
//   * a batch/v1 Job deleted without a propagation policy ORPHANS its
//     dependents: its Pods stay forever once they finish, and its Secret
//     loses its owner. cancelPreviewChecks deleted Jobs that way before
//     this sweep existed, and by 7 Oct 2026 the ownerless input Secrets
//     (130 of them) had filled the namespace's Secret quota, 197 of 200;
//   * a platform process that dies between creating a Job and writing the
//     owner onto its Secret.
// Nothing collects either. The garbage collector follows owners only, and
// Pod GC keeps finished Pods until thousands have piled up.
//
// Each pass reads the namespace's Jobs, Pods and managed Secrets in full,
// then deletes at most MAX_DELETIONS, oldest first:
//   * a check input Secret (sv-capture-…-input, sv-unit-suite-…-input) with
//     no owner, older than SECRET_MIN_AGE_MS, that no Pod or Job references;
//   * a finished check Pod whose Job is gone, finished at least the Job TTL
//     ago (no harvest reads a Pod without its Job).
// It never touches a worker's env Secret (a dormant worker with a volume may
// still need it), anything with an owner, or anything a live Job owns. Every
// delete carries the object's UID and resourceVersion, so one that changed
// after the inventory was read stays. Leader-only (server.js becomeLeader).

const kubernetes = require('./kubernetes');
const log = require('./logger');

const INTERVAL_MS = 15 * 60 * 1000;
const MAX_DELETIONS = 50;
// Far past every check Job's activeDeadlineSeconds (770 s for a capture, 600 s
// for a unit suite by default), so a run still being created or still running
// never loses its input here, whatever its Pods are doing.
const SECRET_MIN_AGE_MS = 2 * 60 * 60 * 1000;
const CHECK_INPUT_SECRET = /^sv-(?:capture|unit-suite)-s[a-z0-9][a-z0-9-]*-input$/;
const CHECK_JOB = /^sv-(?:capture|unit-suite)-s[a-z0-9]/;
const FINISHED = new Set(['Succeeded', 'Failed']);

function enabled(config) {
  return !!config?.kubernetes?.workerNamespace
    && [config.captureRuntime, config.workerRuntime].includes('kubernetes');
}

// The client hands timestamps back as Dates; fixtures may use strings.
function millis(value) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

// Every Secret a Pod spec can name, into `names`.
function addSecretReferences(spec, names) {
  for (const volume of spec?.volumes || []) {
    if (volume?.secret?.secretName) names.add(volume.secret.secretName);
    for (const source of volume?.projected?.sources || []) {
      if (source?.secret?.name) names.add(source.secret.name);
    }
  }
  for (const container of [...(spec?.initContainers || []), ...(spec?.containers || []), ...(spec?.ephemeralContainers || [])]) {
    for (const entry of container?.env || []) {
      if (entry?.valueFrom?.secretKeyRef?.name) names.add(entry.valueFrom.secretKeyRef.name);
    }
    for (const source of container?.envFrom || []) {
      if (source?.secretRef?.name) names.add(source.secretRef.name);
    }
  }
  for (const pull of spec?.imagePullSecrets || []) {
    if (pull?.name) names.add(pull.name);
  }
}

function jobNameOf(pod) {
  const labels = pod?.metadata?.labels || {};
  return labels['batch.kubernetes.io/job-name'] || labels['job-name'] || '';
}

function finishedAt(pod) {
  let latest = null;
  for (const status of [...(pod?.status?.initContainerStatuses || []), ...(pod?.status?.containerStatuses || [])]) {
    const at = millis(status?.state?.terminated?.finishedAt);
    if (at !== null && (latest === null || at > latest)) latest = at;
  }
  return latest;
}

// What a pass may delete, from complete inventories: `{ secrets, pods }`,
// each `[{ kind, name, at, metadata }]` oldest first.
function select({ jobs = [], pods = [], secrets = [] } = {}, now = Date.now()) {
  const liveJobs = new Set();
  const liveJobNames = new Set();
  const referenced = new Set();
  for (const job of jobs) {
    if (job?.metadata?.uid) liveJobs.add(job.metadata.uid);
    if (job?.metadata?.name) liveJobNames.add(job.metadata.name);
    addSecretReferences(job?.spec?.template?.spec, referenced);
  }
  for (const pod of pods) addSecretReferences(pod?.spec, referenced);

  const chosenSecrets = [];
  for (const secret of secrets) {
    const meta = secret?.metadata;
    if (!meta?.name || !meta.uid || !meta.resourceVersion || meta.deletionTimestamp) continue;
    if (!CHECK_INPUT_SECRET.test(meta.name) || secret.type !== 'Opaque'
      || meta.labels?.['app.kubernetes.io/managed-by'] !== kubernetes.MANAGED_BY) continue;
    if (meta.ownerReferences?.length || referenced.has(meta.name)) continue;
    const created = millis(meta.creationTimestamp);
    if (created === null || now - created < SECRET_MIN_AGE_MS) continue;
    chosenSecrets.push({ kind: 'secret', name: meta.name, at: created, metadata: meta });
  }

  const ttlMs = kubernetes.CHECK_JOB_TTL_SECONDS * 1000;
  const chosenPods = [];
  for (const pod of pods) {
    const meta = pod?.metadata;
    const jobName = jobNameOf(pod);
    if (!meta?.name || !meta.uid || !meta.resourceVersion || meta.deletionTimestamp) continue;
    if (meta.labels?.['app.kubernetes.io/managed-by'] !== kubernetes.MANAGED_BY || !CHECK_JOB.test(jobName)) continue;
    if (!FINISHED.has(pod.status?.phase)) continue;
    // Its Job is gone: no Job carries its name, and it has no owner but a
    // Job that no longer exists.
    if (liveJobNames.has(jobName)
      || (meta.ownerReferences || []).some((ref) => ref?.kind !== 'Job' || liveJobs.has(ref.uid))) continue;
    // Aged from its finish. A Pod with none recorded is aged from its
    // creation instead, which precedes the finish by at most its deadline.
    const finished = finishedAt(pod);
    const created = millis(meta.creationTimestamp);
    const old = finished !== null ? now - finished >= ttlMs : created !== null && now - created >= SECRET_MIN_AGE_MS;
    if (!old) continue;
    chosenPods.push({ kind: 'pod', name: meta.name, at: finished ?? created, metadata: meta });
  }

  const oldestFirst = (a, b) => a.at - b.at || a.name.localeCompare(b.name);
  return { secrets: chosenSecrets.sort(oldestFirst), pods: chosenPods.sort(oldestFirst) };
}

async function sweep(config, { dryRun = false, now = Date.now(), runtime = kubernetes, shouldStop = () => false } = {}) {
  const result = { dryRun, examined: { jobs: 0, pods: 0, secrets: 0 }, eligible: { secrets: 0, pods: 0 }, candidates: [], deleted: [] };
  if (!enabled(config)) return result;
  // listCheckLeftovers fails rather than return a partial inventory.
  const inventory = await runtime.listCheckLeftovers(config);
  result.examined = { jobs: inventory.jobs.length, pods: inventory.pods.length, secrets: inventory.secrets.length };
  const { secrets, pods } = select(inventory, now);
  result.eligible = { secrets: secrets.length, pods: pods.length };
  // Secrets first: they are what the quota counts, and deleting a Pod needs
  // a grant the platform uses nowhere else.
  const chosen = [...secrets, ...pods].slice(0, MAX_DELETIONS);
  result.candidates = chosen.map((entry) => `${entry.kind}/${entry.name}`);
  if (dryRun) return result;
  for (const entry of chosen) {
    if (shouldStop()) break;
    try {
      await runtime.deleteCheckLeftover(config, entry.kind, entry.metadata);
      result.deleted.push(`${entry.kind}/${entry.name}`);
      log.info('check-retention', entry.kind === 'secret'
        ? 'Deleted an ownerless check input Secret' : 'Deleted a finished check Pod whose Job is gone',
      { name: entry.name, at: new Date(entry.at).toISOString() });
    } catch (err) {
      const status = err?.code || err?.response?.statusCode || err?.response?.status;
      if (status !== 404 && status !== 409) throw err;
      // Already gone, or changed since the read: leave it.
    }
  }
  return result;
}

let timer = null;
let inFlight = null;
function start(config) {
  if (timer || !enabled(config)) return;
  const run = () => {
    if (inFlight) return inFlight;
    inFlight = sweep(config, { shouldStop: () => timer === null })
      .then((result) => {
        if (result.candidates.length) log.info('check-retention', 'Check leftover sweep', result);
      })
      .catch((err) => log.warn('check-retention', 'Check leftover sweep stopped', { err: err.message }))
      .finally(() => { inFlight = null; });
    return inFlight;
  };
  timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  // Releases often replace the leader before its first tick, so the first
  // pass runs now rather than a quarter of an hour into the term.
  run();
}

async function stop() {
  clearInterval(timer);
  timer = null;
  await inFlight;
}

module.exports = { sweep, select, start, stop, MAX_DELETIONS, SECRET_MIN_AGE_MS, INTERVAL_MS };
