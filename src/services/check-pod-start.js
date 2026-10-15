'use strict';

// Did a check Job's Pod ever start its container? (#5054, part 2)
//
// A checks run whose Pod never ran a line of the proposal's code was still
// stored as the proposal's "couldn't run" error, and spent the proposal's six
// automatic retries (staging-recovery CHECK_MAX_AUTO_RETRIES) before waiting
// for a person. On 12 Oct 2026 one browser-check shard of PR #4883's run was
// scheduled within a minute and then sat in ContainerCreating for thirteen
// minutes; its run was stored as an error after 779 s, with 459 of 733 checks
// reported, and the re-run two minutes later passed in 150 s. The unit suite
// already counted a Job Kubernetes refused as the platform's fault
// (unit-suite-row isPlatformNotRun); neither half counted a Pod that never
// started.
//
// So the runner (kubernetes.runCheckJob, collectCheckJob) reads its Pod's
// start state while it waits, and keeps it on what it returns and throws as
// `podStart`. This module reads that state and says, in the words the card
// shows, why nothing ran:
//
//   readPodStart(pod, container)  one reading of a Pod, or null for none;
//   mergePodStart(prev, next)     a run of readings: once the container has
//                                 started it stays started, otherwise the
//                                 latest reading wins;
//   podStartCause(state)          { lead: 'start' | 'run', cause } for a Pod
//                                 that never started its container, or that
//                                 was evicted; null otherwise, and always
//                                 null for one that started and then failed,
//                                 ran out of time or of memory, which may be
//                                 the proposal's own doing;
//   checkStartFault(err)          the same for what the runner threw: a Job
//                                 or Secret the API refused (checkJobNotCreated),
//                                 an API lost after the create (checkJobApiLost),
//                                 or its `podStart`.
//
// A Pod whose state is unknown (it was gone and nothing was remembered) gives
// null: Homeroom never guesses that it was at fault.

// The lead of check_error_detail's sentence for the browser checks, as
// unit-suite-row NOT_RUN_LEAD is for the unit suite.
const BROWSER_NOT_RUN_LEAD = Object.freeze({
  start: 'The browser checks could not start',
  run: 'The browser checks could not run',
});

const PULL_REASONS = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'ErrImageNeverPull']);
const CONFIG_REASONS = new Set(['CreateContainerConfigError', 'CreateContainerError', 'RunContainerError']);

function timeOf(value) {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
}

// One reading of `pod` (a V1Pod as the API returns it) for its `container`.
// `waitedMs` is how long the Pod has existed, as of `now`.
function readPodStart(pod, container, now = Date.now()) {
  if (!pod || typeof pod !== 'object') return null;
  const status = pod.status || {};
  const scheduledCondition = (status.conditions || []).find((c) => c && c.type === 'PodScheduled');
  const scheduled = scheduledCondition
    ? scheduledCondition.status === 'True'
    : !!(pod.spec && pod.spec.nodeName);
  const statuses = status.containerStatuses || [];
  const own = statuses.find((c) => c && c.name === container) || (statuses.length === 1 ? statuses[0] : null);
  const state = (own && own.state) || {};
  const started = !!((state.running && state.running.startedAt)
    || (state.terminated && state.terminated.startedAt));
  const created = timeOf(pod.metadata && pod.metadata.creationTimestamp);
  return {
    scheduled,
    started,
    waitingReason: (state.waiting && state.waiting.reason) || null,
    evicted: status.reason === 'Evicted',
    waitedMs: created == null ? null : Math.max(0, now - created),
  };
}

function mergePodStart(prev, next) {
  if (!next) return prev || null;
  if (!prev) return next;
  const evicted = !!(prev.evicted || next.evicted);
  if (prev.started || next.started) {
    return { ...next, scheduled: true, started: true, waitingReason: null, evicted };
  }
  return { ...next, evicted };
}

function forMinutes(ms) {
  const minutes = Math.max(1, Math.round((Number(ms) || 0) / 60000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

function podStartCause(state) {
  if (!state || typeof state !== 'object') return null;
  if (state.evicted) return { lead: 'run', cause: 'its test pod was evicted' };
  if (state.started) return null;
  const reason = state.waitingReason || null;
  const known = state.waitedMs != null;
  if (!state.scheduled) {
    return {
      lead: 'start',
      cause: known
        ? `a test pod was not scheduled onto a node within ${forMinutes(state.waitedMs)}`
        : 'a test pod was not scheduled onto a node',
    };
  }
  if (reason && PULL_REASONS.has(reason)) return { lead: 'start', cause: `a test pod could not pull its image (${reason})` };
  if (reason && CONFIG_REASONS.has(reason)) {
    return { lead: 'start', cause: `a test pod's container could not be configured (${reason})` };
  }
  return {
    lead: 'start',
    cause: known
      ? `a test pod waited ${forMinutes(state.waitedMs)} for its container to start`
      : 'a test pod\'s container never started',
  };
}

function checkStartFault(err) {
  if (!err || typeof err !== 'object') return null;
  const { runnerCause } = require('./unit-suite');
  if (err.checkJobNotCreated === true) return { lead: 'start', cause: runnerCause(err, { creating: true }) };
  const pod = podStartCause(err.podStart);
  if (pod) return pod;
  if (err.checkJobApiLost === true) return { lead: 'run', cause: runnerCause(err) };
  return null;
}

// The sentence check_error_detail stores for a browser-check fault.
function browserNotRunSentence(fault) {
  if (!fault) return null;
  const { notRunSentence } = require('./unit-suite');
  return notRunSentence(BROWSER_NOT_RUN_LEAD[fault.lead] || BROWSER_NOT_RUN_LEAD.start, fault.cause);
}

module.exports = {
  BROWSER_NOT_RUN_LEAD,
  readPodStart,
  mergePodStart,
  podStartCause,
  checkStartFault,
  browserNotRunSentence,
};
