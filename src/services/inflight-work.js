'use strict';

// Background work in flight that the shutdown drain waits for.
//
// cleanup() (server.js) used to wait for two things only: busy worker
// containers and before & after shots runs. Everything else this process
// had started was invisible to it — the merge a vote set off after
// answering, a sweeper's pass halfway through its rows, a write a handler
// made after its response — so on a pod with no worker busy the drain
// returned at once and process.exit(0) cut all of it, with most of the
// Kubernetes grace period still unused.
//
// This is the registry such work joins so the drain can see it.
// `track(name, work)` hands the caller its promise back unchanged and holds
// an entry until it settles; `waitIdle` resolves once nothing is held (or
// the deadline passes); `snapshot` names what still is, for the line the
// drain logs when it gives up. One entry per call, so the same name may be
// held more than once (two apps' merge passes).
//
// What belongs here is work worth a few seconds of a rollout to let finish:
// a merge pass, a sweep, a write after the answer. Not a turn running in a
// worker (restart recovery adopts those), and not anything open-ended — a
// stream, a poll loop, a wait for a person — which would only hold every
// shutdown to its deadline. Nothing here refuses new work: whoever starts
// work checks lifecycle.isShuttingDown() (services/leader-timers.js does it
// for every timer tick), and the drain is bounded by its own deadline.

const entries = new Map(); // id → { name, startedAt }
let nextId = 1;
const wakers = new Set();

function wakeIfIdle() {
  if (entries.size) return;
  for (const wake of [...wakers]) wake();
}

/**
 * Hold an entry named `name` until `work` settles. `work` is a promise, or a
 * function returning one (called now; a synchronous throw rejects). Returns
 * the work's own promise, so a rejection still reaches the caller exactly as
 * it would have untracked; the registry's own bookkeeping never surfaces one.
 */
function track(name, work) {
  const promise = typeof work === 'function'
    ? new Promise((resolve) => { resolve(work()); })
    : Promise.resolve(work);
  const id = nextId++;
  entries.set(id, { name: String(name || 'work'), startedAt: Date.now() });
  const settle = () => {
    entries.delete(id);
    wakeIfIdle();
  };
  promise.then(settle, settle);
  return promise;
}

/** How many entries are held now. */
function size() {
  return entries.size;
}

/** What is held now, oldest first: [{ name, ageMs }]. */
function snapshot(now = Date.now()) {
  return [...entries.values()]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((e) => ({ name: e.name, ageMs: Math.max(0, now - e.startedAt) }));
}

/**
 * Resolve true once nothing is held and `also()` (when given) is true, or
 * false once `timeoutMs` has passed first. Wakes the moment the last entry
 * settles; `also` (the drain's count of open HTTP handlers, which has no
 * event of its own) is polled every `pollMs`.
 */
function waitIdle({ timeoutMs = 0, also = null, pollMs = 100 } = {}) {
  const idle = () => entries.size === 0 && (!also || also());
  if (idle()) return Promise.resolve(true);
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  return new Promise((resolve) => {
    let timer = null;
    const finish = (value) => {
      wakers.delete(check);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    function check() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (idle()) return finish(true);
      const left = deadline - Date.now();
      if (left <= 0) return finish(false);
      timer = setTimeout(check, Math.min(pollMs, left));
      return undefined;
    }
    wakers.add(check);
    check();
  });
}

module.exports = { track, size, snapshot, waitIdle };
