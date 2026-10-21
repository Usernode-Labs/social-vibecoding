// New repositories one at a time, and a wait instead of a failure when
// GitHub refuses one for coming too fast (services/app-creator.js
// seedStarter, a new project's repository step).
//
// On 21 Oct 2026 fourteen projects made together asked GitHub for their
// repositories within two seconds and pushed their first commits within the
// next three, every call on the bot's token. GitHub's secondary limit
// ("temporarily blocked from content creation") refused the four whose
// create came at the peak, and their setups failed with GitHub's own text.
// Two creates three seconds later went through. A Retry 24 minutes later
// was refused again, and one 77 minutes later was not. GitHub asks for
// writes on one account to be made one after another, a second apart.
//
// inLine(pool, task) runs `task` (one repository's create and first push)
// alone:
// - one at a time in this process (a promise chain);
// - one at a time across the platform's processes (a transaction-scoped
//   advisory lock, which the chain lets at most one task per process wait
//   for, so it holds at most one pooled client per process);
// - then GAP_MS, still under the lock, before the next one starts.
//
// withRetries(pool, task, { signal }) is inLine with a wait: when GitHub
// refuses with its secondary limit, it waits (GitHub's Retry-After, else
// FIRST_WAIT_MS, doubling to at most MAX_WAIT_MS) and tries again, for at
// most WAIT_BUDGET_MS of waiting. The setup's own limit is 15 minutes
// (TIME_LIMIT_MS in workflow/app-creation/machine.ts). Stopping short of it
// means the failure is this one, which deploy-failure says plainly, not a
// time-out. The wait is outside the line, so a refused task does not hold
// up the others, and the setup's signal ends it at once.

const log = require('./logger');
const githubBudget = require('./github-budget');

const LOCK_KEY = 'github:repo-create';
const GAP_MS = 1000;
const FIRST_WAIT_MS = 30 * 1000;
const MAX_WAIT_MS = 4 * 60 * 1000;
const WAIT_BUDGET_MS = 10 * 60 * 1000;

let timing = { gapMs: GAP_MS, firstWaitMs: FIRST_WAIT_MS, maxWaitMs: MAX_WAIT_MS, budgetMs: WAIT_BUDGET_MS };

// The last task in this process's line, settled either way.
let tail = Promise.resolve();

function aborted(signal) {
  return signal?.reason || new Error('aborted');
}

function pause(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted(signal));
    const onAbort = () => { clearTimeout(timer); reject(aborted(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// The lock is a session lock on the process's lock connection
// (src/db/session-locks.js), not a transaction held open on a pooled one: a
// task takes seconds of GitHub, and a process waiting its turn held a pooled
// connection all that time. Giving it back lets the next process's task go.
// The key is the one an older release takes in a transaction, so the two
// exclude each other.
async function underLock(pool, task) {
  return require('../db/session-locks').withSessionLock(pool, { extended: LOCK_KEY }, async () => {
    try {
      return await task();
    } finally {
      await pause(timing.gapMs);
    }
  });
}

function inLine(pool, task) {
  const run = tail.then(() => underLock(pool, task));
  tail = run.catch(() => {});
  return run;
}

async function withRetries(pool, task, { signal = null, label = {} } = {}) {
  let waited = 0;
  let next = timing.firstWaitMs;
  for (;;) {
    try {
      // A setup cancelled while it waited in line does not start its task.
      return await inLine(pool, () => {
        if (signal?.aborted) throw aborted(signal);
        return task();
      });
    } catch (err) {
      if (signal?.aborted || !githubBudget.isSecondaryRateLimitError(err)) throw err;
      const ms = githubBudget.secondaryRetryAfterMs(err) ?? next;
      if (waited + ms > timing.budgetMs) throw err;
      log.warn('repo-create-queue', 'GitHub asked for new repositories to slow down; trying again', { ...label, waitMs: ms, waitedMs: waited });
      await pause(ms, signal);
      waited += ms;
      next = Math.min(timing.maxWaitMs, next * 2);
    }
  }
}

module.exports = {
  inLine,
  withRetries,
  _forTest: {
    LOCK_KEY, GAP_MS, FIRST_WAIT_MS, MAX_WAIT_MS, WAIT_BUDGET_MS,
    setTiming(overrides) { timing = { ...timing, ...overrides }; },
    resetTiming() { timing = { gapMs: GAP_MS, firstWaitMs: FIRST_WAIT_MS, maxWaitMs: MAX_WAIT_MS, budgetMs: WAIT_BUDGET_MS }; },
  },
};
