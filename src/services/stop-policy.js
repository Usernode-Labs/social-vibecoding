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
// The local pending flag gates dispatch. If Stop crosses an exec already
// in flight, that dispatcher signals and queues durable confirmation for
// its own recorded turn. The conductor probes and re-signals within the
// attempt/deadline budget in workflow/rules/worker-interrupt.ts.

// #937: the pre-dispatch gate. A stop handle whose `stopped` flag is set
// means the user has already asked for this turn to end, so no further
// dispatch work may happen — not the worker image pull, not ensureWorker's
// cold clone, and above all not the exec that starts the agent.
//
// Deliberately tolerant of a missing handle: a turn that runs without one
// must never be gated by an absent object.
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
//   'force'                 — do the ordinary stop, then force.
//   'stop'                  — do the ordinary stop.
function classifyStopRequest({ handle, force = false }) {
  if (!handle) return force ? 'force_orphan' : 'no_active_turn';
  if (force && !stopPendingFor(handle)) return 'force_without_stop';
  return force ? 'force' : 'stop';
}

module.exports = {
  classifyStopRequest,
  stopPendingFor,
};
