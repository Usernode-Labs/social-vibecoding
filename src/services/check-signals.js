'use strict';
// What a checks run says about ITSELF, read from the capture frames
// (capture/capture.js emitTest) beside the verdict. Two signals, both
// advisory: neither changes a check's pass or fail, the merge gate or the
// check history.
//
// 1. RETRY CLASS. A check that failed is asked again up to three times on
//    its own cold document. Before this, every recovered check read as
//    "flaky", which on 16 Oct 2026 was untrue in six of seven retry-heavy
//    runs: a preview still warming up failed the first groups a pod loaded
//    (the client's 2 s session timeout, #5305), and every one of their
//    retries passed. So each retried check is one of three:
//
//      run_fault  part of a burst of failures in a pod's first seconds whose
//                 retries all passed: the run was not ready, the check was
//                 fine. See RUN_FAULT_* below for the rule and its data.
//      flaky      at least one retry passed (and it was not such a burst).
//      failed     every retry failed too: a real failure.
//
// 2. COHORT FALLBACK. Checks on one document share a load and reach their
//    own address by writing `location.hash`. When a check's assertions did
//    not hold after that switch but did on a fresh load of the same address,
//    the runner marks the check's frame `cohortFallback: { waitMs, ms }`.
//    The run still passes it, at a cost of up to ~15 s of lane time each,
//    and an address change that does not draw what a fresh load draws is a
//    navigation bug people can hit. The note is shown only on checks the
//    proposal adds or changes (`authoredChecks`): those it can fix.
const appManifest = require('./app-manifest');

// ── The run-fault rule ───────────────────────────────────────────────────
//
// From the capture logs of 16 Oct 2026 (runs 6706, 8678, 8695, 8703, 8710,
// 8717 ×2, 8732, 8744, 8747, 8748, 8751, 8753; 42 pods):
//
//   * Eight runs had a burst in one pod each: 8 to 19 failed checks, every
//     one of them in the groups the pod started first, at once, one per
//     lane (their verdicts came 8.6 to 11.3 s in: one cold load plus the
//     assertion window), and all 3 retries of every one of them passed.
//   * No pod's later failures looked like that. The recurring flaky pair
//     (/?shot=feedback-capture-failed) failed 28–35 s in, as two checks;
//     the real failures (all retries failing) came 27–68 s in.
//
// So: a check is a run fault when its group STARTED within the pod's first
// RUN_FAULT_WINDOW_MS, all of its retries passed, and at least
// RUN_FAULT_MIN_CHECKS checks in the same pod meet both. One check on its
// own is never a run fault, however early: that is what flakiness looks
// like. A check with a failing retry is never one: the run recovered and
// it did not.
const RUN_FAULT_WINDOW_MS = 5000;
const RUN_FAULT_MIN_CHECKS = 3;

const RETRY_CLASSES = Object.freeze(['run_fault', 'flaky', 'failed']);

function finiteMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// frames: parseTests' records. Returns
//   { byIndex: Map<primaryIndex, retryClass>, bursts: [{ pod, checks, lastStartedMs }] }
// A primary that was not retried has no entry.
function classifyRetries(frames) {
  const list = Array.isArray(frames) ? frames : [];
  const primaries = new Map();
  const retriesOf = new Map();
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const index = Number(f.index);
    if (!Number.isInteger(index)) continue;
    if (Number.isInteger(f.retryOf)) {
      if (!retriesOf.has(f.retryOf)) retriesOf.set(f.retryOf, []);
      retriesOf.get(f.retryOf).push(f);
    } else {
      primaries.set(index, f);
    }
  }
  const byIndex = new Map();
  const candidates = new Map();
  for (const [index, retries] of retriesOf) {
    const passes = retries.filter((r) => r.status === 'pass').length;
    byIndex.set(index, passes === 0 ? 'failed' : 'flaky');
    const primary = primaries.get(index);
    if (!primary || primary.status === 'pass' || passes !== retries.length) continue;
    const started = finiteMs(primary.startedMs);
    if (started == null || started > RUN_FAULT_WINDOW_MS) continue;
    const pod = typeof primary.pod === 'string' ? primary.pod : '';
    if (!candidates.has(pod)) candidates.set(pod, []);
    candidates.get(pod).push({ index, started });
  }
  const bursts = [];
  for (const [pod, checks] of candidates) {
    if (checks.length < RUN_FAULT_MIN_CHECKS) continue;
    for (const c of checks) byIndex.set(c.index, 'run_fault');
    bursts.push({
      pod: pod || null,
      checks: checks.length,
      lastStartedMs: Math.max(...checks.map((c) => c.started)),
    });
  }
  return { byIndex, bursts };
}

// How the run's retried checks split, for the log line (no names, no URLs).
function retryCounts(byIndex) {
  const out = { run_fault: 0, flaky: 0, failed: 0 };
  for (const cls of (byIndex instanceof Map ? byIndex.values() : [])) {
    if (Object.prototype.hasOwnProperty.call(out, cls)) out[cls] += 1;
  }
  return out;
}

// A frame's cohortFallback, bounded to two whole numbers, or null.
function cohortFallbackOf(frame) {
  const fb = frame && frame.cohortFallback;
  if (!fb || typeof fb !== 'object') return null;
  const waitMs = finiteMs(fb.waitMs);
  const ms = finiteMs(fb.ms);
  if (waitMs == null && ms == null) return null;
  return { waitMs: waitMs == null ? 0 : waitMs, ms: ms == null ? 0 : ms };
}

// What a check asserts, for "did this proposal change it". Its key is its
// name and path (appManifest.checkKey); the rest is what it looks for.
// Readiness knobs (coldLoad, boot parameters) are left out on purpose: they
// say how the runner reaches the screen, not what the check is about.
function definitionOf(t) {
  return JSON.stringify([
    t && t.path ? String(t.path) : '',
    t && t.expectSelector ? String(t.expectSelector) : '',
    t && t.expectText ? String(t.expectText) : '',
  ]);
}

// The keys of the head's checks that are new or different from the base's.
// null when either side could not be read: no claim, so no note.
function authoredChecks(head, base) {
  if (!head || !head.ok || !base || !base.ok) return null;
  const before = new Map();
  for (const t of (Array.isArray(base.tests) ? base.tests : [])) {
    before.set(appManifest.checkKey(t.name, t.path), definitionOf(t));
  }
  const out = new Set();
  for (const t of (Array.isArray(head.tests) ? head.tests : [])) {
    const key = appManifest.checkKey(t.name, t.path);
    if (before.get(key) !== definitionOf(t)) out.add(key);
  }
  return out;
}

// Marks `authored: true` on each result row that carries a cohortFallback
// and is one of `authored` (a Set of check keys). Returns how many it marked.
function markAuthored(rows, authored) {
  if (!(authored instanceof Set) || !Array.isArray(rows)) return 0;
  let n = 0;
  for (const r of rows) {
    if (!r || !r.cohortFallback) continue;
    if (authored.has(appManifest.checkKey(r.name, r.path))) {
      r.authored = true;
      n += 1;
    }
  }
  return n;
}

// The agent-facing sentences (connector get_proposal / get_check_output and
// the CLI's proposal_status). English, as the platform's own words are; the
// web card reads its text from the catalogs.
const COHORT_FALLBACK_NOTE = 'This check needed a fresh load after an address change: fix the navigation '
  + '(an address change must draw what a fresh load of that address draws).';
const RETRY_CLASS_NOTES = Object.freeze({
  run_fault: 'Failed at the start of the run together with other checks, then passed every retry: the run '
    + 'was at fault, not this check or this change.',
  flaky: 'Failed, then passed at least one retry: this check is flaky on this build.',
  failed: 'Failed every retry as well: a real failure.',
});

// One advisory per result row that has something to say, in the order the
// rows are: a retry class, and a cohort fallback on a check this proposal
// adds or changes. Names and paths are the caller's to wrap as untrusted.
function advisoriesOf(results, { limit = 20 } = {}) {
  const out = [];
  for (const r of (Array.isArray(results) ? results : [])) {
    if (!r || typeof r !== 'object') continue;
    if (RETRY_CLASSES.includes(r.retryClass)) {
      out.push({ row: r, kind: r.retryClass, note: RETRY_CLASS_NOTES[r.retryClass] });
    }
    if (r.cohortFallback && r.authored === true) {
      out.push({ row: r, kind: 'cohort_fallback', note: COHORT_FALLBACK_NOTE, waitMs: finiteMs(r.cohortFallback.waitMs) });
    }
  }
  return out.slice(0, Math.max(0, limit));
}

module.exports = {
  RUN_FAULT_WINDOW_MS,
  RUN_FAULT_MIN_CHECKS,
  RETRY_CLASSES,
  COHORT_FALLBACK_NOTE,
  RETRY_CLASS_NOTES,
  classifyRetries,
  retryCounts,
  cohortFallbackOf,
  authoredChecks,
  markAuthored,
  advisoriesOf,
};
