// cc-progress-summary (#50) — pure helpers behind the dev-chat progress
// indicator for Claude Code runs. Two exports:
//
//   formatElapsed(ms)            → "42s", "3m 05s", "1h 12m"
//   formatCountdown(toMs, nowMs) → " · ~3m 00s left" / " · under a minute left"
//   summarizeCcProgress(log)     → { currentLabel, steps }
//
// The progress log lines come from src/services/worker.js (parseLine /
// applyStreamEvent), which emits a fixed vocabulary:
//   "Reading <path>" / "Writing <path>" / "Editing <path>"   tool_use
//   "$ <command>" / "Using <Tool>"                           tool_use
//   "… <first thinking line>"                                thinking
//   "  ⎿ <result summary>"                                   tool_result
//   "[<phase>]"                                              __USERNODE_PHASE__
//   anything else                                            plain log (git etc.)
//
// `currentLabel` is the most recent line worth showing in the collapsed
// summary ("what is it doing right now"); `steps` counts tool_use-shaped
// action lines only, so plain log noise and tool results don't inflate it.
//
// Loaded as a plain script before dev-chat.js (see public/index.html);
// the module.exports guard lets tests/cc-progress-summary.test.js require
// the REAL helpers the UI ships instead of mirroring their logic.

// Lines emitted for tool_use blocks — these are the "steps".
var CC_ACTION_RE = /^(Reading |Writing |Editing |\$ |Using )/;

function formatElapsed(ms) {
  var totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (totalSec < 60) return totalSec + 's';
  var totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    var sec = totalSec % 60;
    return totalMin + 'm ' + String(sec).padStart(2, '0') + 's';
  }
  var hours = Math.floor(totalMin / 60);
  var min = totalMin % 60;
  return hours + 'h ' + String(min).padStart(2, '0') + 'm';
}

// The countdown's display floor, in ms (#892). Mirrors
// MIN_DISPLAY_REMAINING_S in src/services/estimate-guard.js — the server
// floors the value it sends and the client floors again, so neither a stale
// target nor a reordered delivery can ever render as zero.
var COUNTDOWN_FLOOR_MS = 30000;

// Round a remaining-time value to a granularity the estimate can actually
// support (#892). Second-by-second precision implied an accuracy the
// estimator does not have — the measured median error is around three
// minutes — so the readout snaps to 30s under five minutes and to a whole
// minute above it, and never shows a seconds digit.
function roundCountdownMs(remainingMs) {
  var step = remainingMs < 300000 ? 30000 : 60000;
  return Math.round(remainingMs / step) * step;
}

// Live count-down readout for the experimental AI progress estimate
// (#359, recalibrated in #892).
//
// ALWAYS RETURNS A NUMERIC FORM. The old behaviour clamped at zero to a
// fixed at-zero label, which then FROZE there — sometimes for twenty
// more minutes — because a run that outlived its estimate had nothing else
// to show. That state is gone: the remaining time is floored at 30s, so an
// overrunning run reads "· under a minute left" for at most one estimator
// tick before the server's next guess extends the projection to a fresh,
// larger number. There is no at-zero freeze, no open-ended overrun copy,
// and no open-ended copy anywhere in this function — the interface always
// shows a time.
//
// Never negative, never a count-up (the elapsed ticker beside it already
// conveys how far a run has gone).
function formatCountdown(targetMs, nowMs) {
  var remaining = (Number(targetMs) || 0) - (Number(nowMs) || 0);
  if (!(remaining > COUNTDOWN_FLOOR_MS)) return ' · under a minute left';
  var rounded = roundCountdownMs(remaining);
  if (rounded < 60000) return ' · under a minute left';
  return ' · ~' + formatElapsed(rounded) + ' left';
}

// Population context for a running turn (#892), derived from the measured
// distribution of 880 real coding runs: p50 190s, p90 1029s, p99 2233s
// (22% run past 10 minutes, longest observed 6330s). Deliberately a
// statement about the POPULATION, not a prediction about this run, so it
// can never be individually wrong — it complements the countdown rather
// than replacing it, and it is the only time context a user without the
// estimator toggle gets at all.
//
// Monotonic by construction: it depends only on elapsed, which increases.
// These three thresholds share RUN_LENGTH_PRIORS_SNAPSHOT (in
// src/services/llm.js) as their refresh anchor — re-check them whenever the
// priors table is refreshed.
function runCohortHint(elapsedMs) {
  var ms = Number(elapsedMs) || 0;
  if (ms < 600000) return 'most runs finish in 2–10 min';
  if (ms < 1800000) return 'running longer than most — about 1 in 5 runs do';
  return 'this is a long one — some runs go 30 min+';
}

// Friendly names for the __USERNODE_PHASE__ markers run-cc.sh emits.
// Unknown phases (future markers, bootstrap states) fall back to the raw
// phase text so they're still informative rather than hidden.
function ccPhaseLabel(phase) {
  var p = String(phase || '').trim();
  if (/^claude\b/.test(p)) return 'Claude is working';
  if (/^sync/.test(p)) return 'Syncing with main';
  if (p === 'refresh') return 'Syncing branch';
  if (p === 'commit') return 'Committing';
  if (p === 'push') return 'Pushing';
  // Terminal markers: run-cc.sh emits done/push_failed at the end of a
  // turn, and the server appends done/push_failed/interrupted on the
  // recovery/error paths — so the collapsed progress card always ends
  // on a terminal label instead of freezing on "Pushing".
  if (p === 'done') return 'Finished';
  if (p === 'push_failed') return 'Push failed';
  if (p === 'interrupted') return 'Interrupted';
  return p;
}

// Truncate on a whitespace boundary so we don't slice through the middle
// of a path or word. Boundary only honored when it keeps a useful chunk.
function truncateCcLabel(s, max) {
  max = max || 60;
  if (s.length <= max) return s;
  var cut = s.slice(0, max);
  var bound = cut.lastIndexOf(' ');
  if (bound > max * 0.6) cut = cut.slice(0, bound);
  return cut + '…';
}

function summarizeCcProgress(progressLog) {
  var log = Array.isArray(progressLog) ? progressLog : [];
  var steps = 0;
  var currentLabel = '';
  var fallback = '';
  // #892: the deterministic stage readout. Derived from markers the run
  // genuinely emits, so unlike the AI guess beside it, it cannot be wrong.
  // Null until the run emits its first phase marker.
  var phaseLabel = null;

  for (var i = 0; i < log.length; i++) {
    var line = log[i] == null ? '' : String(log[i]);
    if (CC_ACTION_RE.test(line)) steps++;
  }

  for (var p = log.length - 1; p >= 0; p--) {
    var pm = (log[p] == null ? '' : String(log[p])).trim().match(/^\[([^\]]+)\]$/);
    if (pm) { phaseLabel = ccPhaseLabel(pm[1]); break; }
  }

  for (var j = log.length - 1; j >= 0; j--) {
    var raw = log[j] == null ? '' : String(log[j]);
    var trimmed = raw.trim();
    if (!trimmed) continue;
    if (!fallback) fallback = trimmed;
    // Tool results ("  ⎿ ok", "  ⎿ Read: 120 lines") describe the PREVIOUS
    // action's outcome, not what's happening now — skip them.
    if (trimmed.charAt(0) === '⎿') continue;
    var phaseMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (phaseMatch) {
      currentLabel = ccPhaseLabel(phaseMatch[1]);
      break;
    }
    if (CC_ACTION_RE.test(raw) || raw.indexOf('… ') === 0) {
      currentLabel = trimmed;
      break;
    }
  }

  // No action/phase/thinking line yet (e.g. bootstrap clone output) —
  // fall back to the last non-empty line so the summary is never blank
  // while output is flowing.
  if (!currentLabel) currentLabel = fallback;

  return {
    currentLabel: currentLabel ? truncateCcLabel(currentLabel, 60) : '',
    steps: steps,
    phaseLabel: phaseLabel,
  };
}

// Node (tests) — browsers just get the globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatElapsed, formatCountdown, summarizeCcProgress, ccPhaseLabel,
    truncateCcLabel, runCohortHint, roundCountdownMs, COUNTDOWN_FLOOR_MS,
  };
}
