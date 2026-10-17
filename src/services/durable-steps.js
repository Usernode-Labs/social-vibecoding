'use strict';

// Durable steps for the code not run by the kernel itself: what a long
// pipeline (a Homeroom bot build, an App bench trial, a sync, a shots turn)
// is handed as its `steps`, whoever runs it (docs/plans/bot-build-workflow.md).
//
// The steps that are kept are the kernel's: a work item's checkpoint is
// where they live, and a work handler gets them as `ctx.steps()`
// (src/workflow/kernel/steps.ts, which says what each step does). `durable`
// here is the same thing for a handler that builds them from its context
// itself (services/build-runs.js). Code not run by the kernel (tests, a
// person's own dev chat) gets the inert context, `none()`: every step simply
// runs, nothing is kept, nothing fences.

const log = require('./logger');
const kernelSteps = require('../workflow/kernel/steps.ts');

const { StepsStopped, isStopped, plain } = kernelSteps;

function durable(options = {}) {
  return kernelSteps.steps({ ...options, log });
}

// The context of a pipeline nobody keeps: every step runs.
function none() {
  const ctx = {
    active: false,
    resumed: false,
    attempt: 1,
    lostAttempts: 0,
    triesLeft: 0,
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
