'use strict';

// Terminal progress-line helpers (sessions 2391/2386 incident): a turn's
// progress card ends on a marker, so its collapsed label is never frozen on
// an in-progress verb. (The stale-turn watchdog this module's policy once
// served is gone: a turn's record is its work item's, src/workflow/turn/,
// and one no item holds is recovered by services/turn-leftovers.js.)
//
// Pure by design (no docker, no pg).

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
  TERMINAL_PROGRESS_LINES,
  appendTerminalLine,
};
