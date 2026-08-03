// cc-progress-summary (#50) — pure helpers behind the dev-chat progress
// indicator for Claude Code runs. Two exports:
//
//   formatElapsed(ms)            → "42s", "3m 05s", "1h 12m"
//   formatCountdown(toMs, nowMs) → " · ~3m 00s left" / " · under a minute left"
//   baselineCountdownText(ms, k) → the same, from elapsed time alone (#906)
//   summarizeCcProgress(log)     → { currentLabel, steps, phaseLabel, phaseKey }
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
// can never be individually wrong.
//
// #906: the old first bucket ("most runs finish in 2–10 min") is GONE. It
// was a range where a time should have been, and because it rendered from
// the first second of every run it was the only time statement most users
// ever saw. baselineCountdownText below now occupies that slot with a real
// countdown, so this helper is reduced to what it is actually good at:
// LONG-run context that a countdown alone cannot convey. Under ten minutes
// it returns '' — the countdown is the whole time story there.
//
// Monotonic by construction: it depends only on elapsed, which increases.
// These thresholds share RUN_LENGTH_PRIORS_SNAPSHOT (in
// src/services/llm.js) as their refresh anchor — re-check them whenever the
// priors table is refreshed.
function runCohortHint(elapsedMs) {
  var ms = Number(elapsedMs) || 0;
  if (ms < 600000) return '';
  if (ms < 1800000) return 'running longer than most — about 1 in 5 runs do';
  return 'this is a long one — some runs go 30 min+';
}

// ── #906: the always-present baseline estimate ──────────────────────────
//
// THE PROBLEM. A concrete ETA only ever existed on the opt-in AI-estimator
// path, and even with that toggle ON the first guess cannot arrive before
// the 60s estimator tick fires (measured: min 65s, p50 67s). So every run
// had an ETA-less window, and for every user without the toggle that window
// was the whole run — they got a range ("most runs finish in 2–10 min")
// where issue #906 correctly says there should always be an estimate.
//
// THE FIX. A deterministic step-ladder computed purely from elapsed time.
// No server call, no LLM, no persistence: given the run's start timestamp
// the client can always produce a number, from second zero, for everyone.
//
// BASELINE_PRIORS mirrors the p50 columns of RUN_LENGTH_PRIORS in
// src/services/llm.js — "given a run has been going this long, half of them
// have this much left". tests/ai-progress-estimate.test.js pins the two
// tables together so a priors refresh cannot silently desync the client.
var BASELINE_PRIORS = {
  // p50 REMAINING seconds, keyed by how long the run has already gone.
  buckets: [
    { key: '<2m', minS: 0, maxS: 120, p50RemainingS: 124 },
    { key: '2-5m', minS: 120, maxS: 300, p50RemainingS: 207 },
    { key: '5-10m', minS: 300, maxS: 600, p50RemainingS: 400 },
    { key: '10-20m', minS: 600, maxS: 1200, p50RemainingS: 369 },
    { key: '20m+', minS: 1200, maxS: null, p50RemainingS: 450 },
  ],
  // The population median total run length — the ladder's first rung, i.e.
  // what we predict before the run has told us anything at all.
  p50TotalS: 190,
};

// Hard stop on the ladder walk. 190s + repeated 450s rungs reaches ten
// hours in well under this many steps; the cap exists so a corrupted
// priors table (a zero or negative p50) can never spin the UI thread.
var BASELINE_MAX_RUNGS = 512;

function baselineP50RemainingS(elapsedS) {
  var b = BASELINE_PRIORS.buckets;
  for (var i = 0; i < b.length; i++) {
    if (elapsedS >= b[i].minS && (b[i].maxS == null || elapsedS < b[i].maxS)) {
      return b[i].p50RemainingS;
    }
  }
  return b[b.length - 1].p50RemainingS;
}

// The projected finish, in seconds from the start of the run.
//
// MIRRORS THE SERVER GUARD'S SEMANTICS (src/services/estimate-guard.js):
// the projection is HELD steady while it still lies ahead, and extends only
// once the run has effectively caught up with it — the same "expired" cause
// the guard uses. That produces a countdown that genuinely runs DOWN between
// rungs instead of the one-minute-per-minute treadmill.
//
// The ladder is 190 → 397 → 797 → 1166 → 1535 → 1985 → +450s per rung. Each
// extension is looked up by the ANCHOR BEING EXTENDED (the projection that
// just ran out), not by raw elapsed: "we thought it would be done at 397s
// and it isn't" is the fact we are reacting to, so the conditional median at
// 397s is the right increment.
//
// Non-decreasing in elapsed by construction, so the displayed finish never
// jumps backwards. Returns 0 for non-numeric input (there is nothing to
// project from); negative elapsed is treated as a run that just started.
function baselineFinishSeconds(elapsedMs) {
  var ms = Number(elapsedMs);
  if (!isFinite(ms)) return 0;
  var elapsedS = Math.max(0, ms / 1000);
  var finish = BASELINE_PRIORS.p50TotalS;
  for (var i = 0; i < BASELINE_MAX_RUNGS; i++) {
    // COUNTDOWN_FLOOR_MS worth of slack: once the projection is inside the
    // floor the display has bottomed out at "under a minute left", so that
    // is the moment to extend rather than sitting at the floor.
    if (elapsedS < finish - COUNTDOWN_FLOOR_MS / 1000) break;
    var step = baselineP50RemainingS(finish);
    if (!(step > 0)) break;
    finish += step;
  }
  return finish;
}

// Terminal phases: the run is over, so there is nothing left to count down
// and a lingering "~2m left" beside "Finished" would be plainly wrong.
var BASELINE_TERMINAL_PHASES = ['done', 'push_failed', 'interrupted'];
// Wrap-up phases: committing and pushing take seconds, and the ladder — which
// knows only about elapsed time — has no way to see that. The phase marker
// does, so it wins.
var BASELINE_WRAPUP_PHASES = ['commit', 'push'];

// The rendered baseline readout for a live run. Same shape and same
// vocabulary as the AI countdown beside it (formatCountdown → 30s floor,
// 30s/1m rounding), so the two are indistinguishable in style and a user
// who turns the estimator on sees a better number, not a different widget.
//
// Returns '' ONLY for a terminal phase. For every other state of a live run
// this yields a time — that is the whole point of #906.
function baselineCountdownText(elapsedMs, phaseKey) {
  var key = String(phaseKey == null ? '' : phaseKey).trim().toLowerCase();
  if (BASELINE_TERMINAL_PHASES.indexOf(key) !== -1) return '';
  if (BASELINE_WRAPUP_PHASES.indexOf(key) !== -1) return ' · under a minute left';
  var ms = Number(elapsedMs);
  var now = isFinite(ms) ? Math.max(0, ms) : 0;
  return formatCountdown(baselineFinishSeconds(now) * 1000, now);
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
  // #906: the RAW head of that same marker ('claude', 'commit', 'push',
  // 'done'…), lower-cased. phaseLabel is display copy and gets translated;
  // the baseline countdown needs to branch on the machine-readable phase,
  // and matching translated prose would break the moment the copy changed.
  var phaseKey = null;

  for (var i = 0; i < log.length; i++) {
    var line = log[i] == null ? '' : String(log[i]);
    if (CC_ACTION_RE.test(line)) steps++;
  }

  for (var p = log.length - 1; p >= 0; p--) {
    var pm = (log[p] == null ? '' : String(log[p])).trim().match(/^\[([^\]]+)\]$/);
    if (pm) {
      phaseLabel = ccPhaseLabel(pm[1]);
      // '[claude (mode build)]' → 'claude'; '[push_failed]' → 'push_failed'.
      phaseKey = String(pm[1]).trim().toLowerCase().split(/[\s(]/)[0];
      break;
    }
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
    phaseKey: phaseKey,
  };
}

// Node (tests) — browsers just get the globals.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    formatElapsed, formatCountdown, summarizeCcProgress, ccPhaseLabel,
    truncateCcLabel, runCohortHint, roundCountdownMs, COUNTDOWN_FLOOR_MS,
    BASELINE_PRIORS, baselineFinishSeconds, baselineCountdownText,
  };
}
