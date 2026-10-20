'use strict';

// Where a new project's time goes, from Make it to running (#4895).
//
// A newcomer's first project took about 45 seconds to be ready (onboarding
// run, 12 Oct 2026), and nothing said which part of creation spent them: the
// admin Journey's creation path has the total (app_running's
// secondsFromCreation) and nothing under it. This keeps one stopwatch per
// creation attempt (services/app-creator.js createApp) and, once the attempt
// ends, whatever its outcome, writes what it measured twice:
//
//   * an `app_creation_timed` event (services/events.js), which the
//     Journey's creation path reads (services/journey.js creationPath);
//   * a `Creation timed` log line, so a failed attempt is there to read too.
//
// The stages, in the order creation reaches them. Each is its own wall
// clock: the database and the repository are made side by side, and the
// card wait sits inside the repository, so the stages do not add up to
// `totalMs`.
//
//   database    the project's Postgres database and its role
//   repository  its GitHub repository made and the starter committed (an
//               import: the scaffold and the create answers committed)
//   card        waiting for the first session's card, inside repository
//   checkout    the tree the build reads: the committed starter written
//               out, or a clone
//   lock        waiting to share the build-retention lock (Kubernetes)
//   manifest    dapp.json read and reconciled, required secrets checked
//   build       the image build; `build` beside it says which engine and
//               where its time went (BuildKit's slowest steps, kpack's
//               lifecycle phases). A ready-made app's is finding the image
//               already built for it (engine `prebuilt`, services/
//               starter-images.js), with any wait for it to finish
//   deploy      the runtime's objects applied: env, Service, Deployment,
//               Ingress (Docker: the container run)
//   rollout     waiting for the container to answer /health; on Kubernetes
//               `pod` beside it splits that from the Pod's own status into
//               placing it on a node, pulling and starting the image, and
//               booting until /health answered
//
// Never a reason creation fails or waits: nothing here throws, and the
// event is written fire-and-forget.

const events = require('./events');
const log = require('./logger');

const STAGES = Object.freeze([
  'database', 'repository', 'card', 'checkout', 'lock', 'manifest', 'build', 'deploy', 'rollout',
]);
const OUTCOMES = Object.freeze(['running', 'awaiting_secrets', 'error']);

const ms = (value) => Math.max(0, Math.round(value));

/**
 * A stopwatch for one creation attempt. `start`/`end` bracket a stage,
 * `time(stage, fn)` brackets an async step, `note` keeps a detail beside the
 * stages, `settle` names the outcome once (the first call wins), and
 * `snapshot` is the record as it stands.
 */
function stopwatch({ now = Date.now } = {}) {
  const startedAt = now();
  const stages = {};
  const open = new Map();
  const notes = {};
  const failed = new Set();
  let outcome = null;
  let failedIn = null;
  let endedAt = null;

  const start = (stage) => {
    if (STAGES.includes(stage)) open.set(stage, now());
  };
  const end = (stage) => {
    const at = open.get(stage);
    if (at == null) return;
    open.delete(stage);
    stages[stage] = (stages[stage] || 0) + ms(now() - at);
  };
  return {
    start,
    end,
    async time(stage, fn) {
      start(stage);
      try {
        return await fn();
      } catch (err) {
        failed.add(stage);
        throw err;
      } finally {
        end(stage);
      }
    },
    note(key, value) {
      if (value != null) notes[key] = value;
    },
    settle(result) {
      if (outcome) return;
      outcome = OUTCOMES.includes(result) ? result : 'error';
      endedAt = now();
      // Where it failed: a stage that threw, or one still running then.
      const where = [...new Set([...failed, ...open.keys()])];
      if (outcome === 'error' && where.length) failedIn = STAGES.filter((s) => where.includes(s));
    },
    get outcome() { return outcome; },
    snapshot() {
      return {
        outcome: outcome || 'error',
        totalMs: ms((endedAt ?? now()) - startedAt),
        stages: Object.fromEntries(STAGES.filter((s) => s in stages).map((s) => [s, stages[s]])),
        ...(failedIn ? { failedIn } : {}),
        ...notes,
      };
    },
  };
}

// A stopwatch that measures nothing, for a caller that passes none
// (app-forker's use of the shared deploy tail).
const IDLE = Object.freeze({
  start() {}, end() {}, async time(_stage, fn) { return fn(); }, note() {}, settle() {},
  outcome: null, snapshot: () => null,
});

// The image build's own account of its time, for the record: which engine
// built it, whether a finished image was reused, BuildKit's slowest steps
// or kpack's lifecycle phases, when BuildKit started solving (its Job
// before that: scheduled, the daemon checked, the source fetched), and how
// long its slowest base image (FROM) took, which is the pull when the node
// is busy. Also what happened to the layer cache: `done`, `skipped` or
// `failed`, or `background` when the image was handed over before the Job
// had uploaded it ("The image before the cache"), and which starter's
// shared cache the build read and whether it wrote it
// (services/kubernetes-buildkit.js, "The starter's shared cache").
const KEPT_BUILD_STEPS = 6;
function buildNote({ engine, result, solveStartMs = null } = {}) {
  const steps = (list) => (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s.name === 'string' && Number.isFinite(s.ms))
    .slice(0, KEPT_BUILD_STEPS)
    .map((s) => ({ name: s.name.slice(0, 60), ms: ms(s.ms) }));
  const note = { engine: engine || null };
  if (result?.reused) note.reused = true;
  const slowest = steps(result?.steps);
  if (slowest.length) note.steps = slowest;
  if (Number.isInteger(result?.cachedSteps)) note.cachedSteps = result.cachedSteps;
  const phases = steps(result?.phases);
  if (phases.length) note.phases = phases;
  if (Number.isFinite(solveStartMs)) note.solveStartMs = ms(solveStartMs);
  if (Number.isFinite(result?.baseImageMs)) note.baseImageMs = ms(result.baseImageMs);
  if (typeof result?.cacheUpload === 'string') note.cacheUpload = result.cacheUpload;
  // A ready-made app's prebuilt image (services/starter-images.js): which,
  // and how long creation waited for it to finish building.
  if (result?.prebuilt && typeof result.prebuilt.template === 'string') {
    note.prebuilt = {
      template: result.prebuilt.template,
      ...(typeof result.prebuilt.key === 'string' ? { key: result.prebuilt.key } : {}),
      ...(Number.isFinite(result.prebuilt.waitedMs) ? { waitedMs: ms(result.prebuilt.waitedMs) } : {}),
    };
  }
  if (result?.starterCache && typeof result.starterCache.starter === 'string') {
    note.starterCache = {
      starter: result.starterCache.starter,
      // Which shared cache: one per set of package files, not per starter.
      ...(typeof result.starterCache.key === 'string' ? { key: result.starterCache.key } : {}),
      export: Boolean(result.starterCache.export),
    };
  }
  return note;
}

/**
 * Write the attempt's record: the event and the log line. Resolves, never
 * rejects, and never throws.
 */
function record(pool, { appId, userId = null, slug = null, watch } = {}) {
  try {
    const metadata = watch && watch.snapshot();
    if (!metadata) return Promise.resolve();
    log.info('app-creator', 'Creation timed', { appId, slug, ...metadata });
    return events.record(pool, {
      type: events.EVENT_TYPES.APP_CREATION_TIMED, userId, appId, metadata,
    });
  } catch (err) {
    log.warn('app-creator', 'Creation timing not recorded', { appId, err: err && err.message });
    return Promise.resolve();
  }
}

module.exports = { STAGES, OUTCOMES, stopwatch, IDLE, buildNote, record, KEPT_BUILD_STEPS };
