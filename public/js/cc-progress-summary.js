// cc-progress-summary (#50) — pure helpers behind the dev-chat progress
// indicator for Claude Code runs. Two exports:
//
//   formatElapsed(ms)            → "42s", "3m 05s", "1h 12m"
//   formatCountdown(toMs, nowMs) → " · ~3m 05s left" / " · due now"
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

// Live count-down readout for the experimental AI progress estimate
// (#359). Mirrors the "· ~Xm Ys left" wording the old static suffix used,
// but recomputed from an absolute target end-timestamp so the shared 1s
// elapsed ticker can drive it second-by-second. Clamps at zero to a fixed
// "· due now" label — never negative, never a second count-up (the elapsed
// ticker beside it already conveys how far past the estimate a run has gone).
function formatCountdown(targetMs, nowMs) {
  var remaining = (Number(targetMs) || 0) - (Number(nowMs) || 0);
  if (remaining > 0) return ' · ~' + formatElapsed(remaining) + ' left';
  return ' · due now';
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

  for (var i = 0; i < log.length; i++) {
    var line = log[i] == null ? '' : String(log[i]);
    if (CC_ACTION_RE.test(line)) steps++;
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
  };
}

// Node (tests) — browsers just get the globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatElapsed, formatCountdown, summarizeCcProgress, ccPhaseLabel, truncateCcLabel };
}
