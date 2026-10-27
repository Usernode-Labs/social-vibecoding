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
// The local pending-stop stamp precedes admission, even before a process
// exists to signal.
function killsWorkerInPhase(phase) {
  return phase === 'cc' || phase === 'mayor1';
}

module.exports = {
  classifyStopRequest,
  killsWorkerInPhase,
  stopPendingFor,
};
