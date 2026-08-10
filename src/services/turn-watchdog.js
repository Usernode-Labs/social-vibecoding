'use strict';

// Stale active_turn watchdog policy + terminal progress-line helpers.
//
// Background (sessions 2391/2386 incident): a chat_sessions.active_turn
// record is written when a detached turn is dispatched and cleared when
// its consumer finishes. If the platform dies between boot-adoption and
// finalize (or a future bookkeeping bug leaks a row), the record is
// orphaned: no in-process consumer owns it, so nothing will ever clear
// it and the UI shows a working state forever. The session sweeper in
// server.js reaps such rows using the pure policy below.
//
// Pure by design (no docker, no pg) so the reap/skip decision is
// unit-testable — same pattern as worker.js's recordWatchdogProbe.

// Minimum age before an active_turn row can even be considered stale.
// Covers boot races (recoverSessions adopts within seconds of start)
// and dispatch races (dispatch persists the row just before setting the
// in-process inFlight flag).
const STALE_TURN_MIN_AGE_MS = 5 * 60 * 1000;

// Decide what to do with one active_turn row.
//
//   activeTurn — the parsed chat_sessions.active_turn jsonb (object).
//   nowMs      — Date.now() at sweep time.
//   busy       — the shared busy predicate (activeWorkers ∪ inFlight):
//                true means a live consumer owns the turn right now.
//   executing  — worker.isWorkerExecuting() tri-state: true (turn
//                process present in the container), false (definitely
//                idle), null (probe failed / unobservable). Callers may
//                pass false for the cheap pre-filter and probe only
//                when that pre-filter says 'reap'.
//
// Returns 'skip_no_turn' | 'skip_quarantined' | 'skip_fresh' | 'skip_busy' |
//         'skip_executing' | 'reap'.
function classifyStaleTurn({ activeTurn, nowMs, busy, executing }) {
  if (!activeTurn) return 'skip_no_turn';
  if (activeTurn.phase === 'quarantined') return 'skip_quarantined';
  const startedMs = Date.parse(activeTurn.startedAt || '');
  // An unparsable/missing startedAt can't prove freshness — treat it as
  // old and let the busy/executing gates decide.
  if (Number.isFinite(startedMs) && nowMs - startedMs < STALE_TURN_MIN_AGE_MS) {
    return 'skip_fresh';
  }
  if (busy) return 'skip_busy';
  // true = a live detached exec (boot recovery or the next dispatch will
  // consume it); null = unobservable — be conservative either way.
  if (executing === true || executing === null) return 'skip_executing';
  return 'reap';
}

// Terminal markers the progress card understands (ccPhaseLabel in
// public/js/cc-progress-summary.js maps them to Finished / Push failed /
// Interrupted). Once one of these is the log's last line, the collapsed
// card label can no longer be frozen on an in-progress verb.
const TERMINAL_PROGRESS_LINES = ['[done]', '[push_failed]', '[interrupted]'];

// Append `line` to a progress-lines array unless it's already the last
// line (journals from new worker images emit their own [done] /
// [push_failed], so server-side appends would otherwise duplicate it).
// Returns true when the line was appended.
function appendTerminalLine(lines, line) {
  if (!Array.isArray(lines)) return false;
  if (lines.length && lines[lines.length - 1] === line) return false;
  lines.push(line);
  return true;
}

module.exports = {
  STALE_TURN_MIN_AGE_MS,
  TERMINAL_PROGRESS_LINES,
  classifyStaleTurn,
  appendTerminalLine,
};
