'use strict';

// ── A restart waits for the bot's builds to reach a saved point ──────────
//
// Releases restart the platform server 60 to 80 times a day. A bot build's
// agent turn survives a restart (it runs detached in its worker, with a
// journal and a chat_sessions.active_turn record the next leader adopts),
// but the steps around its turns (the worker's cold start, the plan's
// publish, the push, the nudge, the review rounds, the proposal) live only
// in this process. A SIGTERM between two steps lost them: with no plan
// saved the request went back to be triaged, with one it was built again.
//
// So the bot's in-process pipelines are tracked here, and shutdown
// (server.js cleanup) waits, up to a deadline, until each one has either
// finished or is parked inside a detached turn whose record is saved:
//
//   run(info, work)        a pipeline: `work` runs inside an async context
//                          of its own, so every worker turn it opens, however
//                          deep, is attributed to it without threading a
//                          handle through the build code.
//   noteTurnDispatched()   called by worker.execInWorker once the turn's
//   noteTurnEnded()        record is saved and its process dispatched, and
//                          when the turn is over.
//   holdAfterTurn()        true while shutting down inside a pipeline: the
//                          turn has ended, and the pipeline must not go on
//                          into its next step. execInWorker then leaves the
//                          turn's record and journal in place and never
//                          returns, so the next leader adopts the finished
//                          turn as it would one still running.
//   waitForSafePoint()     resolves once every pipeline is safe, or at the
//                          deadline with the ones still mid-step.
//   recordMidStep()        one build_interrupted incident per such build.
//
// Nothing new starts once shutdown has begun (refusing(); the bot's loops
// are stopped too). A turn a pipeline opens on its way to its next safe
// point is allowed: being parked in a turn is the point it is waiting for.

const { AsyncLocalStorage } = require('node:async_hooks');
const lifecycle = require('./lifecycle');
const log = require('./logger');

const als = new AsyncLocalStorage();

// id → { id, kind, runId, trialId, appId, issueNumber, startedAt, turns, step, held }
const pipelines = new Map();
let nextId = 1;

// How long shutdown waits on Kubernetes. The Pod gets
// terminationGracePeriodSeconds 90 (platform.yaml), the preStop sleep takes
// 5 of it, and the rest of cleanup (marks, pool close, the leader lock) a
// few more: tests/homeroom-bot-drain.test.js pins the sum below the grace.
const K8S_DEADLINE_MS = 75000;
// Anything longer from the environment is clamped to this.
const MAX_DEADLINE_MS = 75000;
// Elsewhere (docker compose: a 10s stop_grace_period) the wait runs beside
// the handler drain and takes no longer than it.
const DEFAULT_DEADLINE_MS = 5000;

/**
 * How long cleanup waits for the bot's pipelines: HOMEROOM_BOT_DRAIN_TIMEOUT_MS
 * when set (clamped to 0..MAX_DEADLINE_MS), else K8S_DEADLINE_MS on Kubernetes
 * and `fallbackMs` elsewhere. Pure but for `env`.
 */
function deadlineMs(env = process.env, { fallbackMs = DEFAULT_DEADLINE_MS } = {}) {
  const raw = env.HOMEROOM_BOT_DRAIN_TIMEOUT_MS;
  if (raw != null && String(raw).trim() !== '' && Number.isFinite(Number(raw))) {
    return Math.min(Math.max(0, Math.floor(Number(raw))), MAX_DEADLINE_MS);
  }
  return env.KUBERNETES_SERVICE_HOST ? K8S_DEADLINE_MS : fallbackMs;
}

// The pipeline this code runs in. A timer a pipeline set (a wake) runs in its
// context after it has ended, so only a pipeline still registered counts.
function current() {
  const p = als.getStore();
  return p && pipelines.get(p.id) === p ? p : null;
}

function shuttingDown() {
  return lifecycle.isShuttingDown();
}

/** True once shutdown has begun: start no new pipeline. */
function refusing() {
  return shuttingDown();
}

function describe(p) {
  return {
    id: p.id, kind: p.kind, runId: p.runId, trialId: p.trialId, appId: p.appId,
    issueNumber: p.issueNumber, startedAt: p.startedAt, step: p.step,
    parked: p.turns.size > 0, held: p.held,
  };
}

/**
 * Run `work` as a tracked pipeline. `info`: { kind, runId, trialId, appId,
 * issueNumber }, all optional. Resolves (or rejects) as `work` does. The
 * turns opened inside are this pipeline's, even when it was started from
 * another's context (a pass a wake inside a build scheduled).
 */
function run(info, work) {
  const p = {
    id: nextId++,
    kind: info?.kind || 'work',
    runId: info?.runId != null ? Number(info.runId) : null,
    trialId: info?.trialId != null ? Number(info.trialId) : null,
    appId: info?.appId != null ? Number(info.appId) : null,
    issueNumber: info?.issueNumber != null ? Number(info.issueNumber) : null,
    startedAt: new Date().toISOString(),
    turns: new Set(),
    step: 'its first step',
    held: false,
  };
  pipelines.set(p.id, p);
  return als.run(p, () => Promise.resolve().then(work)).finally(() => {
    pipelines.delete(p.id);
  });
}

/** Name the step the current pipeline is in, for the incident a deadline writes. */
function step(name) {
  const p = current();
  if (p && name) p.step = String(name);
}

/** worker.execInWorker: the turn's record is saved and its process dispatched. */
function noteTurnDispatched(sessionId, { mode = null } = {}) {
  const p = current();
  if (!p) return;
  p.turns.add(String(sessionId));
  p.step = `its ${mode || 'agent'} turn`;
}

/** worker.execInWorker: the turn is over (or never ran). */
function noteTurnEnded(sessionId, { mode = null } = {}) {
  const p = current();
  if (!p || !p.turns.delete(String(sessionId))) return;
  p.step = `the step after its ${mode || 'agent'} turn`;
}

/**
 * True when the turn that just ended is a pipeline's and shutdown has begun:
 * the caller stops there (see the header). Marks the pipeline held, which
 * counts as safe: what it would do next is the next leader's.
 */
function holdAfterTurn() {
  const p = current();
  if (!p || !shuttingDown()) return false;
  p.held = true;
  return true;
}

/** Every pipeline running in this process, as plain objects. */
function snapshot() {
  return [...pipelines.values()].map(describe);
}

function unsafe() {
  return [...pipelines.values()].filter((p) => !p.held && p.turns.size === 0);
}

/**
 * Wait until every pipeline has finished, is parked in a saved turn, or is
 * held after one, or until `timeoutMs`. Resolves { safe, waitedMs, midStep,
 * parked } where `midStep` lists the pipelines still between steps.
 */
async function waitForSafePoint({ timeoutMs = deadlineMs(), intervalMs = 250 } = {}) {
  const startedMs = Date.now();
  const deadline = startedMs + Math.max(0, timeoutMs);
  while (unsafe().length && Date.now() < deadline) {
    // Not unref'd: this wait is what keeps cleanup going to its exit, and
    // the deadline bounds it.
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(intervalMs, Math.max(1, deadline - Date.now())));
    });
  }
  const midStep = unsafe().map(describe);
  const parked = snapshot().filter((p) => p.parked || p.held);
  return { safe: midStep.length === 0, waitedMs: Date.now() - startedMs, midStep, parked };
}

/**
 * The deadline passed: one build_interrupted incident for each pipeline
 * still mid-step that is a build (it has a run or a trial), so admins see
 * what the restart cut short. Never throws.
 */
async function recordMidStep(pool, midStep, { incidents = null } = {}) {
  if (!pool || !midStep?.length) return 0;
  const svc = incidents || require('./platform-incidents');
  const writes = midStep.filter((p) => p.runId != null || p.trialId != null).map((p) => svc.record(pool, {
    kind: svc.KINDS.BUILD_INTERRUPTED,
    appId: p.appId,
    detail: {
      runId: p.runId, trialId: p.trialId, issueNumber: p.issueNumber, pipeline: p.kind,
      why: `shutdown deadline passed during ${p.step}`, outcome: 'exited_mid_step',
    },
  }));
  const settled = await Promise.allSettled(writes);
  const failed = settled.filter((s) => s.status === 'rejected').length;
  if (failed) log.warn('homeroom-bot', 'Could not record every build a shutdown cut mid-step', { failed });
  return settled.length - failed;
}

module.exports = {
  K8S_DEADLINE_MS,
  MAX_DEADLINE_MS,
  DEFAULT_DEADLINE_MS,
  deadlineMs,
  refusing,
  run,
  step,
  noteTurnDispatched,
  noteTurnEnded,
  holdAfterTurn,
  snapshot,
  waitForSafePoint,
  recordMidStep,
  __resetForTests() { pipelines.clear(); nextId = 1; },
};
