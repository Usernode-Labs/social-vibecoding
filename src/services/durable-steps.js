'use strict';

// Durable steps: what a long pipeline (a Homeroom bot build, an App bench
// trial) keeps as it goes, so that the same code, run again after a restart,
// carries on from the last step it finished instead of starting over or
// being finished by recovery code of its own (docs/plans/bot-build-workflow.md).
//
// A context is made over a workflow work item's checkpoint
// (src/workflow/bot-build/services.ts): `resumeFrom` is what the last attempt
// saved, `checkpoint(value)` saves it under the item's lease, and `signal`
// aborts when the lease is lost or the process stops. Everything a step keeps
// is JSON in that one object, keyed by step:
//
//   once(key, fn)   a step that has run returns what it saved, and is not run
//                   again; one that has not runs, and what it resolves is saved
//   get / set       state a step keeps as it goes (a review's loop state)
//   scope(prefix)   a child context whose keys are its own (a second try)
//   fence()         throws once the work is no longer this process's
//   race(promise)   the promise, or the stop, whichever comes first
//   listen / tell   what the pipeline's own watchers are told as it goes (a
//                   turn starting, or a turn a restart caught being
//                   followed: a bench trial's watch recounts its looks)
//
// The stop is sticky: once the signal has aborted, every later step throws
// it again, so a stop that one `catch` swallows on the way out (much of the
// pipeline fails open on purpose) is thrown by the next step instead of
// letting a process that lost the build archive its session or post its
// failure. A step whose work was under way when a process began stopping is
// still saved (the kernel takes a checkpoint for as long as the process
// holds the lease), and the stop is thrown once it is: what it did is not
// done again by the next process. Only a lost lease refuses the save.
//
// Code not run by the kernel (tests, a person's own dev chat) gets the inert
// context, `none()`: every step simply runs, nothing is kept, nothing fences.

const log = require('./logger');

// A checkpoint write that failed for another reason than a lost lease (the
// database blinked) is tried again this many times, this far apart.
const SAVE_RETRY_MS = Object.freeze([500, 2000, 5000]);

function leaseLost(err) {
  return !!err && (err.constructor?.name === 'LeaseLost' || err.message === 'work lease lost');
}

/** The error a fenced step throws. `stopped` tells it from a step's own failure. */
class StepsStopped extends Error {
  constructor(why = 'the build is no longer this process\'s to run') {
    super(why);
    this.code = 'steps_stopped';
    this.stopped = true;
  }
}

function isStopped(err) {
  return !!(err && (err.stopped === true || err.code === 'steps_stopped'));
}

// What a step's value is kept as: JSON data, nothing else. A Date becomes its
// ISO string, undefined is left out (null in an array), a function is dropped.
function plain(value) {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value));
}

// `owner` names the work these steps belong to ('bot-build/run:12'): what a
// session or a turn record carries so recovery elsewhere leaves it alone.
function durable({ resumeFrom = null, checkpoint, signal = null, attempt = 1, lostAttempts = 0, owner = null } = {}) {
  if (typeof checkpoint !== 'function') throw new Error('durable: a checkpoint function is required');
  const state = resumeFrom && typeof resumeFrom === 'object' && !Array.isArray(resumeFrom) ? { ...resumeFrom } : {};
  let stopped = !!signal?.aborted;
  let writes = Promise.resolve();
  const listeners = [];
  const markStopped = () => { stopped = true; };
  if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', markStopped, { once: true });

  const fence = () => {
    if (stopped || signal?.aborted) {
      stopped = true;
      throw new StepsStopped();
    }
  };
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const write1 = async (snapshot) => {
    for (let i = 0; ; i += 1) {
      try {
        return await checkpoint(snapshot);
      } catch (err) {
        if (leaseLost(err) || isStopped(err) || i >= SAVE_RETRY_MS.length) throw err;
        log.warn('durable', 'Could not save a step; trying again', { owner, err: err.message });
        await wait(SAVE_RETRY_MS[i]);
      }
    }
  };
  // One write at a time, each with everything kept so far: a later write
  // never lands under an earlier one.
  const save = () => {
    const snapshot = plain(state);
    const write = writes.then(() => write1(snapshot));
    writes = write.catch(() => {});
    return write.catch((err) => {
      // The kernel's checkpoint throws only when the claim is gone.
      stopped = true;
      throw isStopped(err) ? err : Object.assign(new StepsStopped(`could not save the step: ${err.message}`), { cause: err });
    });
  };

  const make = (prefix) => {
    const k = (key) => (prefix ? `${prefix}/${key}` : String(key));
    const ctx = {
      active: true,
      resumed: !!resumeFrom,
      attempt,
      lostAttempts,
      owner,
      signal,
      get stopped() { return stopped || !!signal?.aborted; },
      has(key) { return Object.prototype.hasOwnProperty.call(state, k(key)); },
      // A copy: a caller that changes what it was handed (a build's result
      // it adds a cost to) changes nothing kept, and the next save cannot
      // carry the change in.
      get(key) { return Object.prototype.hasOwnProperty.call(state, k(key)) ? plain(state[k(key)]) : undefined; },
      // The key as it is kept, scope included: what a row a step writes
      // carries so the step finds it again (a session it opened).
      path(key) { return k(key); },
      // Saved even once the process is stopping, while it holds the lease:
      // state a step keeps as it goes is what the next process reads.
      async set(key, value) {
        if (value === undefined) delete state[k(key)];
        else state[k(key)] = plain(value);
        await save();
      },
      async merge(key, patch) {
        const prior = ctx.get(key);
        await ctx.set(key, { ...(prior && typeof prior === 'object' ? prior : {}), ...(patch || {}) });
      },
      async once(key, fn) {
        fence();
        if (ctx.has(key)) return ctx.get(key);
        const value = await fn();
        // Its work is done: kept, even if the process began stopping
        // meanwhile, and then the stop is thrown.
        await ctx.set(key, value === undefined ? null : value);
        fence();
        return ctx.get(key);
      },
      fence,
      race(promise) {
        if (!signal) return Promise.resolve(promise);
        return new Promise((resolve, reject) => {
          // Checked first: a listener added to a signal that has already
          // aborted is never called.
          if (stopped || signal.aborted) { stopped = true; reject(new StepsStopped()); return; }
          const onAbort = () => { stopped = true; reject(new StepsStopped()); };
          signal.addEventListener('abort', onAbort, { once: true });
          Promise.resolve(promise).then(
            (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
            (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
          );
        });
      },
      scope(child) { return make(k(child)); },
      // Every write made so far is saved (the handler's last act).
      async flush() { await writes; },
      listen(fn) { if (typeof fn === 'function') listeners.push(fn); },
      // A watcher that throws is logged; a stop it causes is the next step's.
      async tell(event = {}) {
        const told = { ...event, key: event.key != null ? k(event.key) : null };
        for (const fn of listeners) {
          // eslint-disable-next-line no-await-in-loop
          try { await fn(told); } catch (err) {
            log.warn('durable', 'A watcher of the steps failed', { kind: told.kind, key: told.key, err: err.message });
          }
        }
      },
    };
    return ctx;
  };
  return make('');
}

// The context of a pipeline nobody keeps: every step runs.
function none() {
  const ctx = {
    active: false,
    resumed: false,
    attempt: 1,
    lostAttempts: 0,
    owner: null,
    signal: null,
    stopped: false,
    has: () => false,
    get: () => undefined,
    path: (key) => String(key),
    set: async () => {},
    merge: async () => {},
    once: async (key, fn) => fn(),
    fence: () => {},
    race: (promise) => Promise.resolve(promise),
    scope: () => ctx,
    flush: async () => {},
    listen: () => {},
    tell: async () => {},
  };
  return ctx;
}

/** The context in `deps`, or the inert one: how pipeline code reads it. */
function of(deps) {
  const d = deps && deps.durable;
  return d && typeof d.once === 'function' ? d : none();
}

/** Logs and rethrows a stop; anything else is the caller's to handle. */
function rethrowStop(err, where) {
  if (isStopped(err)) {
    log.info('durable', 'A step stopped: the work is no longer this process\'s', { where });
    throw err;
  }
}

module.exports = { durable, none, of, isStopped, rethrowStop, StepsStopped, plain };
