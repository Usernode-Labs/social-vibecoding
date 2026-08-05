'use strict';

// #937: pure policy for "did the stop actually land?".
//
// Background (issue #937, production session 2974): POST /stop used to
// fire ONE `worker.stopTurn()` and assume it worked. During worker
// spin-up there is nothing to kill yet — the container may not exist, or
// it exists with no run-cc.sh/claude process — so the in-container
// TERM/KILL walk matched nothing and exited 0, while the log still said
// "Stop signal sent". The agent then ran for another 17m51s with the
// button frozen on "Stopping…".
//
// The route now CONFIRMS the stop instead: probe the container, re-issue
// the kill while a turn process is still (or newly) there, and stop
// probing on a definite idle, on running out of attempts, or on the
// deadline. That loop needs docker; the decision it makes does not — so
// the decision lives here, pure and unit-testable, same pattern as
// services/turn-watchdog.js.

// How often the confirm loop probes the container.
const STOP_PROBE_INTERVAL_MS = 2000;

// How long the confirm loop may keep probing. Past this the stop is
// declared unconfirmed and the user's Force stop is the remaining path.
const STOP_CONFIRM_TIMEOUT_MS = 30000;

// How many kill signals one stop request may send in total (the initial
// one plus re-issues). Bounded so a container that is wedged at the
// docker-daemon level can't have execs piled onto it forever.
const STOP_MAX_KILL_ATTEMPTS = 3;

// Decide what the confirm loop does after one probe.
//
//   executing  — worker.isWorkerExecuting() tri-state: true (a turn
//                process is present), false (definitely idle), null
//                (probe failed / unobservable).
//   attempts   — kill signals sent so far for this stop request (the
//                initial stopTurn counts as 1).
//   elapsedMs  — ms since the stop was requested.
//
// Returns 'confirmed' (the turn process is gone — stop probing),
// 'retry' (re-issue the kill and keep probing), or 'giveup' (out of
// attempts or past the deadline — stop probing, log it).
//
// Note the ordering: a definite idle wins over both bounds, so a stop
// that lands on the very last probe is still recorded as confirmed
// rather than as a give-up.
function classifyStopProbe({ executing, attempts, elapsedMs }) {
  if (executing === false) return 'confirmed';
  if (!(elapsedMs < STOP_CONFIRM_TIMEOUT_MS)) return 'giveup';
  if (!(attempts < STOP_MAX_KILL_ATTEMPTS)) return 'giveup';
  // true = a turn process is running (the kill missed it, or it started
  // after the kill); null = unobservable, which after a stop request is
  // more likely a wedged container than a healthy one. Both re-issue.
  return 'retry';
}

// #937: the pre-dispatch gate. A stop handle whose `stopped` flag is set
// means the user has already asked for this turn to end, so no further
// dispatch work may happen — not the worker image pull, not ensureWorker's
// cold clone, and above all not the exec that starts the agent.
//
// Deliberately tolerant of a missing handle: headless turns run without
// one and must never be gated by an absent object.
function stopPendingFor(stopHandle) {
  return !!(stopHandle && stopHandle.stopped);
}

// What POST /api/sessions/:id/stop should do with one request. Pure so the
// branching — which now has a force path folded into it — is reviewable
// and testable in one place instead of read off four `if`s in the handler.
//
//   handle — the session's stop handle, or null/undefined when no turn is
//            in flight.
//   force  — the client asked for the force escape hatch.
//
// Returns one of:
//   'no_active_turn'        — nothing to stop; answer politely.
//   'force_orphan'          — force with no handle: the turn already ended
//                             but its bookkeeping may not have; clean up.
//   'force_without_stop'    — refuse. Force is strictly SECOND-order: it
//                             tears the container down, so it may only
//                             follow an ordinary stop that failed to land.
//   'wrap_up_not_stoppable' — phase-2 is stop-proof by design (the commit,
//                             PR and staging already exist; killing the
//                             summary would leave the user without context
//                             for changes that are real).
//   'force'                 — do the ordinary stop, then force.
//   'stop'                  — do the ordinary stop.
function classifyStopRequest({ handle, force = false }) {
  if (!handle) return force ? 'force_orphan' : 'no_active_turn';
  if (force && !stopPendingFor(handle)) return 'force_without_stop';
  if (handle.phase === 'mayor2') return 'wrap_up_not_stoppable';
  return force ? 'force' : 'stop';
}

// Whether a stop in this phase should drive the in-container kill (and so
// stamp the pending-stop record the dispatch gates read).
//
// #937: this used to be `phase === 'cc'` only. `setPhase('cc')` happens
// immediately before the tool call, but real awaited work sits between the
// end of the Mayor's stream and there — spend recording, the busy-worker
// guard, a GitHub PR round trip, attachment loads. A stop landing in that
// window matched NEITHER the cc branch nor the legacy container branch, so
// only the abort ran — and the abort is inert outside the Anthropic
// stream. The build then dispatched with `stopped === true`.
//
// Killing early is harmless: there is nothing to kill yet, and the point
// of the call is the pending-stop stamp.
function killsWorkerInPhase(phase) {
  return phase === 'cc' || phase === 'mayor1';
}

module.exports = {
  STOP_PROBE_INTERVAL_MS,
  STOP_CONFIRM_TIMEOUT_MS,
  STOP_MAX_KILL_ATTEMPTS,
  classifyStopProbe,
  classifyStopRequest,
  killsWorkerInPhase,
  stopPendingFor,
};
