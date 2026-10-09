'use strict';

// The web side of the session-activity machine
// (src/workflow/session-activity/): whatever uses a chat session asks first,
// and holds what it was granted for as long as it runs.
//
//   await sessionActivity.run(sessionId, 'turn', { label }, async (activity) => { ... });
//
// With WF_SESSION_ACTIVITY_ENABLED off this only calls `fn`, and the
// in-memory registries (active-workers.js, worker.js) decide as on [main].
// With it on, the machine is asked as well, so another process's activity
// refuses this one, and a refusal throws SessionBusyError before `fn` runs.
//
// One activity per thing, not per step. A step of an activity this process
// is running on the same session (a sync with main's own turn, the Mayor's
// dispatch running the coding turn) joins it instead of asking again, so an
// activity never refuses itself; the activity lasts until every part of it
// has ended. What `fn` calls, awaited or not, is part of it
// (AsyncLocalStorage). A step the activity does not cover asks with the
// activity as its parent: a screenshot run's turn inside its hold.
//
// The holder renews the activity's lease while it runs. A holder whose
// renewals keep failing stops counting on it (`alive()`, `signal`) before
// the lease can run out, and one whose lease ran out is told so.
//
// What this module keeps in memory is this process's own handles (their
// renewal timers and abort signals), like the kernel's running work items:
// nothing another process needs, and nothing a restart has to restore,
// since a lease that is not renewed runs out.

const os = require('os');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const log = require('./logger');

const platform = () => require('../workflow/platform.ts');

// Who holds an activity: this process, as the machine records it.
const HOLDER = `${os.hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;

// A step joins the activity it runs inside only when it is of the same
// kind: a sync with main's own turn, the Mayor's dispatch running the coding
// turn. A step of another kind (a branch move inside a turn, a screenshot
// run's hold started from a turn's tail) is an activity of its own, with the
// one it runs inside as its parent, which never keeps it out: what it
// claims then lasts as long as it does, not as long as its parent.

// The longest an activity is renewed: one its code never ended stops
// blocking the session after this, and says so in the log.
const MAX_LIFETIME_MS = 12 * 60 * 60 * 1000;

class SessionBusyError extends Error {
  constructor(reason, sessionId) {
    super(reason === 'unavailable'
      ? 'Session activity could not be checked; try again'
      : reason === 'busy_turn'
        ? `Session ${sessionId} is busy: a turn is already in flight`
        : `Session ${sessionId} is busy (${reason})`);
    this.name = 'SessionBusyError';
    // Refused by a turn: the code a turn already in flight in this process
    // gives (worker.js execInWorker), which callers already handle.
    this.code = reason === 'busy_turn' ? 'TURN_IN_FLIGHT' : 'session_busy';
    this.reason = reason;
    // busy_turn → 'turn'; 'retiring', 'unavailable' as they are.
    this.blockedBy = String(reason).replace(/^busy_/, '');
    this.sessionId = Number(sessionId);
    // A refusal changes nothing durable: a recovery that was refused keeps
    // its turn's record and is retried (recovery-retry.js).
    this.retainActiveTurn = true;
  }
}

const scope = new AsyncLocalStorage();
// activityId -> handle, this process's own.
const handles = new Map();
let stopHandler = null;

// Whether this process asks the machine (WF_SESSION_ACTIVITY_ENABLED), set
// at boot. On, a process whose workflow runtime did not start refuses to
// start anything on a session rather than decide from its memory alone.
let configured = false;
function configure(config) {
  configured = !!config?.wfSessionActivityEnabled;
}
function wanted() {
  return configured;
}
function enabled() {
  try { return platform().sessionActivityEnabled(); } catch { return false; }
}

function touch(sessionId) {
  try { require('./session-state').touch(sessionId); } catch { /* best effort */ }
}

// The activity this code runs inside for `sessionId`, if any (innermost).
function current(sessionId) {
  for (let h = scope.getStore(); h; h = h.parentHandle) {
    if (h.sessionId === Number(sessionId) && !h.ended) return h;
  }
  return null;
}

function makeHandle({ id, sessionId, kind, label, turnId, parentHandle, leaseMs, renewMs }) {
  const abort = new AbortController();
  const h = {
    id, sessionId, kind, label, turnId, parentHandle,
    startedAt: Date.now(),
    refs: 1,
    ended: false,
    lost: false,
    lastRenewedAt: Date.now(),
    leaseMs,
    signal: abort.signal,
    stop: null,
    stopDelivered: null,
    // Whether this holder may still act on its grant: its lease can not
    // have run out yet. A renewal a quarter of the lease late counts as
    // gone, so the holder stops before anyone else could be granted.
    alive() {
      return !h.ended && !h.lost && Date.now() - h.lastRenewedAt < h.leaseMs - renewMs;
    },
    _abort: abort,
  };
  h.timer = setInterval(() => { renew(h).catch(() => {}); }, renewMs);
  h.timer.unref?.();
  return h;
}

async function renew(h) {
  if (h.ended || h.lost) return;
  if (Date.now() - h.startedAt > MAX_LIFETIME_MS) {
    // Its code never ended it: stop keeping the session from everyone else.
    h.lost = true;
    clearInterval(h.timer);
    log.error('session-activity', 'An activity was never ended; its lease is left to run out', {
      sessionId: h.sessionId, activityId: h.id, kind: h.kind, label: h.label,
    });
    h._abort.abort(new SessionBusyError('lease_lost', h.sessionId));
    return;
  }
  let r;
  try {
    r = await platform().renewActivity(h.id);
  } catch (err) {
    log.warn('session-activity', 'Lease renewal failed', { sessionId: h.sessionId, activityId: h.id, err: err.message });
    if (!h.alive()) h._abort.abort(new SessionBusyError('lease_lost', h.sessionId));
    return;
  }
  if (!r.held) {
    h.lost = true;
    clearInterval(h.timer);
    log.warn('session-activity', 'Activity lease ran out while it was running', { sessionId: h.sessionId, activityId: h.id, kind: h.kind });
    h._abort.abort(new SessionBusyError('lease_lost', h.sessionId));
    return;
  }
  h.lastRenewedAt = Date.now();
  if (r.stop) deliverStop(h, r.stop);
}

// A Stop the machine sent this process's turn: run the local stop for it
// (routes/sessions.js registers how). Until it lands, every renewal tries
// again, so a Stop that arrives before the turn registered its stop handle
// is not lost.
function deliverStop(h, stop) {
  h.stop = stop;
  // Each Stop is numbered (a forced one after a first is a second Stop).
  const n = stop.n ?? stop.at;
  if (!stopHandler || h.stopDelivered === n || h.stopDelivering) return;
  h.stopDelivering = true;
  Promise.resolve()
    .then(() => stopHandler(h.sessionId, stop))
    .then((applied) => { if (applied) h.stopDelivered = n; })
    .catch((err) => log.warn('session-activity', 'Forwarded stop failed', { sessionId: h.sessionId, err: err.message }))
    .finally(() => { h.stopDelivering = false; });
}

// The push that carries a Stop to the process holding the turn
// (services/ws.js, bus kind `session_stop`). Every process hears it.
function stopArrived({ sessionId, activityId, stop } = {}) {
  const h = handles.get(activityId);
  if (!h || h.ended || h.sessionId !== Number(sessionId) || !stop) return false;
  deliverStop(h, stop);
  return true;
}

function setStopHandler(fn) {
  stopHandler = typeof fn === 'function' ? fn : null;
}

async function release(h, outcome) {
  h.refs -= 1;
  if (h.refs > 0 || h.ended) return;
  h.ended = true;
  clearInterval(h.timer);
  handles.delete(h.id);
  if (!h.lost) {
    // A lease that is not renewed runs out anyway; ending it frees the session
    // now. A lost one has nothing left to end.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await platform().endActivity(h.sessionId, h.id, outcome);
        break;
      } catch (err) {
        if (attempt === 3) log.warn('session-activity', 'Could not end an activity; its lease will run out', { sessionId: h.sessionId, activityId: h.id, err: err.message });
        else await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
  }
  touch(h.sessionId);
}

// Ask for an activity. Resolves the handle, or throws SessionBusyError.
async function acquire(sessionId, kind, { label = null, turnId = null, stoppable = false } = {}) {
  const id = Number(sessionId);
  const inside = current(id);
  if (inside && inside.kind === kind) {
    inside.refs += 1;
    return { handle: inside, joined: true };
  }
  if (!enabled()) throw new SessionBusyError('unavailable', id);
  const activityId = crypto.randomUUID();
  let outcome;
  try {
    outcome = await platform().requestActivity({
      sessionId: id, activityId, kind, holder: HOLDER, label, turnId, parent: inside ? inside.id : null, stoppable,
    });
  } catch (err) {
    log.warn('session-activity', 'Asking for an activity failed', { sessionId: id, kind, err: err.message });
    throw new SessionBusyError('unavailable', id);
  }
  if (outcome.status === 'rejected') throw new SessionBusyError(outcome.reason || 'busy', id);
  if (outcome.status !== 'accepted' && outcome.status !== 'replayed') {
    // Not answered in time, or the machine faulted: refuse, and cancel the
    // request in case it is granted later.
    if (outcome.status === 'pending') platform().endActivity(id, activityId, 'cancelled').catch(() => {});
    log.warn('session-activity', 'Activity request not answered', { sessionId: id, kind, status: outcome.status });
    throw new SessionBusyError('unavailable', id);
  }
  const reply = outcome.reply || {};
  const handle = makeHandle({
    // The whole chain it runs inside, other sessions' activities included.
    id: activityId, sessionId: id, kind, label, turnId, parentHandle: scope.getStore() || null,
    leaseMs: reply.leaseMs || 90000, renewMs: reply.renewMs || 15000,
  });
  handles.set(activityId, handle);
  touch(id);
  return { handle, joined: false };
}

// Run `fn` as an activity of `kind` on the session (see the header).
// `fn` gets the handle, or null with the flag off.
async function run(sessionId, kind, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  if (!wanted()) return fn(null);
  const { handle } = await acquire(sessionId, kind, opts || {});
  let outcome = 'done';
  try {
    return await scope.run(handle, () => fn(handle));
  } catch (err) {
    outcome = 'failed';
    throw err;
  } finally {
    await release(handle, outcome);
  }
}

// For an activity whose start and end are not one call: the caller ends it.
// Resolves an object with enter() and end(), or null with the flag off.
// enter() makes what the caller runs next part of the activity; it has to
// be called by the caller itself (AsyncLocalStorage is per call chain).
async function begin(sessionId, kind, opts = {}) {
  if (!wanted()) return null;
  const { handle } = await acquire(sessionId, kind, opts);
  let done = false;
  return {
    handle,
    enter: () => scope.enterWith(handle),
    // Keep the activity on for work that outlives the caller (a detached
    // pipeline): it ends once that work's release and end() have both run.
    retain: () => {
      handle.refs += 1;
      let kept = true;
      return () => { if (kept) { kept = false; release(handle, 'done').catch(() => {}); } };
    },
    end: (outcome = 'done') => {
      if (done) return Promise.resolve();
      done = true;
      return release(handle, outcome);
    },
  };
}

// For a gate that answers "busy" itself: { activity } (null with the flag
// off), or { refused } with the SessionBusyError to answer with.
async function tryBegin(sessionId, kind, opts = {}) {
  try {
    return { activity: await begin(sessionId, kind, opts), refused: null };
  } catch (err) {
    if (err instanceof SessionBusyError) return { activity: null, refused: err };
    throw err;
  }
}

// What every process reads: per session, its live activities
// ({ id, kind, stopping }), oldest first. Empty with the flag off.
async function read(sessionIds) {
  const ids = [...new Set((sessionIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length || !wanted() || !enabled()) return new Map();
  try {
    return await platform().readSessionActivities(ids);
  } catch (err) {
    log.warn('session-activity', 'Reading session activity failed', { err: err.message });
    return new Map();
  }
}

// The sessions among these that something uses, by what every process
// reads. A Mayor chat turn alone does not count, and neither does what the
// caller itself runs inside (a sweep's step asking whether anything ELSE
// uses the session). Empty with the flag off.
async function busyIds(sessionIds) {
  const out = new Set();
  for (const [id, list] of await read(sessionIds)) {
    const own = new Set();
    for (let h = scope.getStore(); h; h = h.parentHandle) if (h.sessionId === id) own.add(h.id);
    if (list.some((a) => a.kind !== 'chat' && !own.has(a.id))) out.add(id);
  }
  return out;
}

async function isBusy(sessionId) {
  return (await busyIds([sessionId])).has(Number(sessionId));
}

// What screens show beside this process's memory: whether a turn or an
// operation runs on the session somewhere, and whether a stop is on its way
// to it. { busy, stopping } per session id.
async function liveStates(sessionIds) {
  const out = new Map();
  for (const [id, list] of await read(sessionIds)) {
    out.set(id, {
      busy: list.some((a) => a.kind !== 'chat'),
      stopping: list.some((a) => a.stopping),
    });
  }
  return out;
}

// The worker can go once nothing uses the session (the machine waits), or
// with the flag off as [main] did: now, unless this process holds it.
async function retire(sessionId, by, workerApi = null) {
  if (wanted() && enabled()) {
    await platform().retireSession(Number(sessionId), by);
    return { deferred: 'session-activity' };
  }
  return (workerApi || require('./worker')).retireWorker(sessionId);
}

// A Stop for a turn this process does not run. Resolves true when the
// machine sent it to the process that runs it.
async function forwardStop(sessionId, stop) {
  if (!wanted() || !enabled()) return false;
  try {
    const outcome = await platform().stopSessionTurn(Number(sessionId), stop);
    return outcome.status === 'accepted' && !!outcome.reply?.holder;
  } catch (err) {
    log.warn('session-activity', 'Forwarding a stop failed', { sessionId, err: err.message });
    return false;
  }
}

// Shutdown: this process's activities, after the drain.
function heldCount() {
  return handles.size;
}
async function endAll(outcome = 'shutdown') {
  await Promise.all([...handles.values()].map((h) => { h.refs = 1; return release(h, outcome); }));
}

module.exports = {
  HOLDER,
  configure,
  SessionBusyError,
  run,
  begin,
  tryBegin,
  read,
  busyIds,
  isBusy,
  liveStates,
  retire,
  forwardStop,
  stopArrived,
  setStopHandler,
  heldCount,
  endAll,
  wanted,
};
