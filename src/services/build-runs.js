'use strict';

// The Homeroom bot's builds and the App bench's trials, run by the workflow
// kernel's bot-build machine (src/workflow/bot-build/,
// docs/plans/bot-build-workflow.md). This is the legacy side of it:
//
//   start()      what the bot's dispatch and the bench lane call to build;
//                resolves once the build has ended, wherever it ran, so the
//                caller's slot is held for as long as the build is
//   whenEnded()  the same wait for a build already under way (a slot taken
//                again after a restart)
//   run()        the machine's `build.run` handler: the build's own pipeline
//                on a durable context over the work item's checkpoint
//   lost()       its `build.lost` handler: a build that failed for good is
//                recorded where it is read
//   holdsSession() whether a build under way owns a session, wherever it
//                runs: its worker is kept for it (worker.js ensureWorker)
//
// A build is a target (live, shadow, trial) and an id (the run, or the
// trial). What each target runs is its own module's: homeroom-bot.js for a
// run, bench/lane.js for a trial. Without the workflow runtime (it failed to
// start), a build runs here, in this process, on the inert context, as
// builds always ran before: nothing is kept, and a restart loses it.

const { EventEmitter } = require('node:events');
const log = require('./logger');
const durableSteps = require('./durable-steps');

// How often a wait reads the build's state when no end is heard here (it
// ended in another process, or its end was missed).
const POLL_MS = 30 * 1000;

const ended = new EventEmitter();
ended.setMaxListeners(0);

function platform() {
  return require('../workflow/platform.ts');
}

function shuttingDown() {
  try { return !!require('./lifecycle').isShuttingDown(); } catch { return false; }
}

/**
 * What start() throws in a process that has begun stopping: a build started
 * now would run here unkept and be lost with the process. The caller leaves
 * the build asked for, for the next leader to start.
 */
function notStarted() {
  return Object.assign(new Error('the platform is stopping: the build was not started'), { code: 'not_started', notStarted: true });
}

// The instance key (src/workflow/bot-build/machine.ts buildKey): the run or
// the trial, and what tells two builds of one run apart.
function keyOf(target, id, nonce = null) {
  const base = target === 'trial' ? `trial:${Number(id)}` : `run:${Number(id)}`;
  return nonce && /^[A-Za-z0-9_.-]{1,40}$/.test(String(nonce)) ? `${base}@${nonce}` : base;
}

// What each target runs, resolved lazily: both modules load half the platform.
const TARGETS = {
  live: {
    run: (args) => require('./homeroom-bot').runLiveBuild(args),
    lost: (args) => require('./homeroom-bot').recordLostLiveBuild(args),
  },
  shadow: {
    run: (args) => require('./homeroom-bot').runShadowBuild(args),
    lost: (args) => require('./homeroom-bot').recordLostShadowBuild(args),
  },
  trial: {
    run: (args) => require('./bench/lane').runTrial(args),
    lost: (args) => require('./bench/lane').recordLostTrial(args),
  },
};

function targetOf(name) {
  const t = TARGETS[name];
  if (!t) throw Object.assign(new Error(`not a build target: ${name}`), { permanent: true });
  return t;
}

function announce(key, outcome) {
  ended.emit(key, outcome || null);
}

// A build asked for but not yet created (its Requested event waits for a
// pipeline slot) reads as no instance: it is waited for this long.
const UNBORN_MS = 10 * 60 * 1000;

/**
 * Resolves once the build `key` has ended: heard here (its handler, or its
 * loss, ran in this process: the instance moves to its end a moment later)
 * or read from its state (it ended elsewhere). Resolves its result, or null.
 * Never rejects.
 */

function whenEnded(key, { pollMs = POLL_MS } = {}) {
  const since = Date.now();
  return new Promise((resolve) => {
    let timer = null;
    let done = false;
    let seen = false;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      ended.removeListener(key, finish);
      resolve(outcome ?? null);
    };
    ended.on(key, finish);
    const look = async () => {
      if (done) return;
      try {
        const state = await platform().buildState(key);
        if (state) seen = true;
        if (state && (state.state === 'done' || state.state === 'failed')) {
          finish({ state: state.state, ...(state.data?.result ? { result: state.data.result } : {}) });
          return;
        }
        // Gone (purged), or never made: nothing is under way to wait for.
        if (!state && (seen || Date.now() - since > UNBORN_MS)) {
          finish(null);
          return;
        }
      } catch (err) {
        log.warn('build-runs', 'Could not read a build\'s state', { key, err: err.message });
      }
      timer = setTimeout(look, pollMs);
      if (typeof timer.unref === 'function') timer.unref();
    };
    // Looked at once: a build that ended already (asked for again) is not
    // waited for a whole poll.
    timer = setTimeout(look, 0);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Build `id` of `target`. `input` is what the target's run needs from its
 * caller (JSON: it is the work item's input). Resolves once the build has
 * ended, with what its run resolved (or null when it ended elsewhere).
 * `deps` reach a build run in this process only (no runtime, or a test).
 */
async function start({ pool, config, target, id, nonce = null, appId = null, input = {}, deps = {} }) {
  const t = targetOf(target);
  const key = keyOf(target, id, nonce);
  let running = false;
  try { running = platform().botBuildsRunning(); } catch { running = false; }
  if (!running || deps.inProcess) {
    if (!deps.inProcess && shuttingDown()) throw notStarted();
    // No runtime here: the build runs as it always did, unkept.
    try {
      const out = await t.run({ pool, config, id: Number(id), input, steps: durableSteps.none(), deps });
      return out ?? null;
    } finally {
      announce(key, null);
    }
  }
  const wait = whenEnded(key);
  await platform().requestBuild({ target, id: Number(id), nonce, appId, input: durableSteps.plain(input) });
  return wait;
}

/**
 * How many more tries the kernel gives a build if this attempt throws: its
 * `maxAttempts` less the tries so far, an attempt that ended with its
 * process not being one (the kernel's `resumable` rule). 0 when the handler
 * was not told its `maxAttempts`.
 */
function triesLeftOf(ctx, maxAttempts) {
  const max = Number(maxAttempts);
  if (!Number.isInteger(max) || max <= 0) return 0;
  const tries = (Number(ctx.attempt) || 1) - (Number(ctx.lostAttempts) || 0);
  return Math.max(0, max - tries);
}

/**
 * The machine's `build.run` handler (src/workflow/bot-build/services.ts),
 * told the handler's `maxAttempts` so its steps know whether a try is left
 * (durable-steps.js triesLeft).
 */
async function run(ctx, { config, pool, maxAttempts = null }) {
  const { target, id, nonce } = ctx.input || {};
  const t = targetOf(target);
  const key = keyOf(target, id, nonce);
  const steps = durableSteps.durable({
    resumeFrom: ctx.resumeFrom, checkpoint: ctx.checkpoint, signal: ctx.signal,
    attempt: ctx.attempt, lostAttempts: ctx.lostAttempts || 0, owner: `bot-build/${key}`,
    triesLeft: triesLeftOf(ctx, maxAttempts),
  });
  // The build's turns are this work item's (durable-turn reads it off the
  // steps and the turn's record names it): its lease is their presence, and
  // a Stop is an event to the bot-build instance.
  steps.turnOwner = { machine: 'bot-build', key, kind: ctx.kind || 'build.run', workKey: ctx.key || 'run', workId: ctx.workId || null };
  if (ctx.resumeFrom) {
    log.info('build-runs', 'Carrying a build on from its last saved step', {
      key, attempt: ctx.attempt, lost: ctx.lostAttempts || 0, steps: Object.keys(ctx.resumeFrom).length,
    });
  }
  const out = await t.run({ pool, config, id: Number(id), input: ctx.input, steps, deps: {} });
  await steps.flush();
  // A stop that a step swallowed on the way out is still a stop: nothing is
  // reported, and the next claim carries the build on.
  steps.fence();
  const result = durableSteps.plain(out ?? null);
  announce(key, { state: 'done', result });
  return result;
}

/** The machine's `build.lost` handler: a build whose run failed for good. */
async function lost(ctx, { config, pool }) {
  const { target, id, nonce, error } = ctx.input || {};
  const t = targetOf(target);
  const key = keyOf(target, id, nonce);
  log.warn('build-runs', 'A build failed for good; recording it as lost', { key, error: error?.message || null });
  try {
    await t.lost({ pool, config, id: Number(id), error: error || null });
  } finally {
    announce(key, { state: 'failed' });
  }
  return { recorded: true };
}

/**
 * Whether a durable build under way owns session `sessionId`, wherever it
 * runs: the session carries the build that opened it
 * (chat_sessions.workflow_owner, `bot-build/<key>`) and that build's
 * instance is still building. It holds the session for its whole run, its
 * turns and the time between them (a review, its captures, its proposal).
 * The same question server.js's restart recovery asks of a worker it would
 * adopt. Resolves false when it cannot be read; never throws.
 */
async function holdsSession(pool, sessionId) {
  if (!pool || typeof pool.query !== 'function' || !(Number(sessionId) > 0)) return false;
  try {
    const { rows: [row] = [] } = await pool.query(
      `SELECT (cs.workflow_owner IS NOT NULL AND EXISTS (
                SELECT 1 FROM wf_instances w
                 WHERE w.machine = split_part(cs.workflow_owner, '/', 1)
                   AND w.key = substr(cs.workflow_owner, length(split_part(cs.workflow_owner, '/', 1)) + 2)
                   AND w.state = 'building')) AS held
         FROM chat_sessions cs WHERE cs.id = $1`,
      [Number(sessionId)],
    );
    return row?.held === true;
  } catch (err) {
    log.warn('build-runs', 'Could not read whether a durable build holds a session', { sessionId, err: err.message });
    return false;
  }
}

/** The builds under way of `target`, for slots taken again after a restart. */
async function underWay(target) {
  try {
    if (!platform().botBuildsRunning()) return [];
    return await platform().buildsUnderWay(target);
  } catch (err) {
    log.warn('build-runs', 'Could not read the builds under way', { target, err: err.message });
    return [];
  }
}

module.exports = {
  start, whenEnded, run, lost, underWay, keyOf, notStarted, triesLeftOf, holdsSession, TARGETS, _ended: ended,
};
