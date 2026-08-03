// Tests for the Claude Code progress indicator helpers (#50).
//
// Two layers:
//   1. Unit tests for formatElapsed / summarizeCcProgress —
//      public/js/cc-progress-summary.js is a plain script with a
//      module.exports guard, so we require the REAL helpers the dev-chat
//      UI ships instead of mirroring their logic.
//   2. Source guards — index.html must load cc-progress-summary.js before
//      dev-chat.js, dev-chat.js must actually call both helpers, and the
//      build path in src/routes/sessions.js must persist durationMs on
//      the 'Claude Code finished' status — so the unit-tested functions
//      can't silently become dead code.
//
// Run with: node --test tests/cc-progress-summary.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  formatElapsed,
  formatCountdown,
  summarizeCcProgress,
  ccPhaseLabel,
  runCohortHint,
  BASELINE_PRIORS,
  baselineFinishSeconds,
  baselineCountdownText,
} = require('../public/js/cc-progress-summary.js');

// ── 1a. formatElapsed unit tests ────────────────────────────────────────

test('formatElapsed: sub-minute values render as bare seconds', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(999), '0s');
  assert.equal(formatElapsed(42_000), '42s');
  assert.equal(formatElapsed(59_999), '59s');
});

test('formatElapsed: minute boundary and zero-padded seconds', () => {
  assert.equal(formatElapsed(60_000), '1m 00s');
  assert.equal(formatElapsed(185_000), '3m 05s');
  assert.equal(formatElapsed(252_000), '4m 12s');
  assert.equal(formatElapsed(3_599_000), '59m 59s');
});

test('formatElapsed: hour rollover drops seconds, zero-pads minutes', () => {
  assert.equal(formatElapsed(3_600_000), '1h 00m');
  assert.equal(formatElapsed(4_320_000), '1h 12m');
  assert.equal(formatElapsed(7_500_000), '2h 05m');
});

test('formatElapsed: garbage and negative inputs clamp to 0s', () => {
  assert.equal(formatElapsed(-5_000), '0s');
  assert.equal(formatElapsed(NaN), '0s');
  assert.equal(formatElapsed(undefined), '0s');
});

// ── 1a-bis. formatCountdown unit tests (#359, recalibrated #892) ────────
//
// #892 changed two things. Values round to a granularity the estimate can
// actually support (30s under five minutes, a whole minute above) instead of
// implying second-level precision the measured ~3-minute median error does
// not justify. And the function ALWAYS returns a numeric form — the old
// zero/overrun clamp to "· due now" froze there, sometimes for twenty more
// minutes, because a run that outlived its estimate had nothing else to show.

test('formatCountdown: positive remaining renders "· ~X left" via formatElapsed', () => {
  // 2m 30s out — already on a 30s boundary.
  assert.equal(formatCountdown(1_150_000, 1_000_000), ' · ~2m 30s left');
  // Sub-five-minutes rounds to the nearest 30s: 2m 42s -> 2m 30s.
  assert.equal(formatCountdown(1_162_000, 1_000_000), ' · ~2m 30s left');
  // Above five minutes rounds to the nearest whole minute: 6m 40s -> 7m.
  assert.equal(formatCountdown(1_400_000, 1_000_000), ' · ~7m 00s left');
});

test('formatCountdown (#892): only ever shows 30s-granular values', () => {
  // The rounding contract: under five minutes the seconds component is
  // always :00 or :30, above it always :00. An arbitrary seconds digit
  // would imply a precision the measured ~3-minute median error cannot
  // support.
  for (let remaining = 31_000; remaining <= 3_900_000; remaining += 7_000) {
    const out = formatCountdown(1_000_000 + remaining, 1_000_000);
    if (out === ' · under a minute left') continue;
    if (/^ · ~\d+h \d\dm left$/.test(out)) continue;  // hour form has no seconds
    const m = out.match(/^ · ~(\d+)m (\d\d)s left$/);
    assert.ok(m, `unexpected countdown form for ${remaining}ms: ${out}`);
    assert.ok(m[2] === '00' || m[2] === '30',
      `non-30s-granular seconds at ${remaining}ms: ${out}`);
    if (Number(m[1]) >= 5) {
      assert.equal(m[2], '00', `above five minutes must be whole minutes: ${out}`);
    }
  }
});

test('formatCountdown (#892): under the floor reads "under a minute left"', () => {
  assert.equal(formatCountdown(1_020_000, 1_000_000), ' · under a minute left');
  assert.equal(formatCountdown(1_030_000, 1_000_000), ' · under a minute left');
});

// The core #892 invariant: the countdown ALWAYS shows a number. A run that
// outlives its estimate holds at the floor for at most one estimator tick,
// then the server's next guess extends the projection — it never switches to
// an open-ended message and never freezes on "due now".
test('formatCountdown (#892): always numeric — no "due now", no "taking longer"', () => {
  const cases = [
    [1_000_000, 1_000_000],          // exactly due
    [1_000_000, 1_000_001],          // one ms past
    [1_000_000, 1_001_000],          // one second past
    [1_000_000, 1_600_000],          // ten minutes past
    [1_000_000, 5_000_000],          // over an hour past
    [NaN, 1_000],
    [undefined, undefined],
    [null, 1_000_000],
    ['nonsense', 1_000_000],
  ];
  for (const [target, now] of cases) {
    const out = formatCountdown(target, now);
    assert.equal(out, ' · under a minute left', `bad output for ${target}/${now}: ${out}`);
    assert.ok(!/due now/.test(out), 'the retired "due now" copy must never appear');
    assert.ok(!/taking longer/i.test(out), 'no open-ended overrun copy may appear');
  }
});

test('formatCountdown: re-anchoring to a new target yields the new value', () => {
  const now = 1_000_000;
  assert.equal(formatCountdown(now + 60_000, now), ' · ~1m 00s left');
  // a fresh, larger estimate counts down from the bigger number
  assert.equal(formatCountdown(now + 120_000, now), ' · ~2m 00s left');
});

// #891: the count-down is anchored on the server's `estimatedAt` (when the
// guess was MADE), so a target fixed once actually walks down as the ticker
// advances `nowMs`. Before the fix the same guess, re-delivered by the 3s
// /status poll, re-anchored the target to arrival time — the readout sat
// frozen at a constant "~X left".
test('formatCountdown (#891): a fixed anchor decrements as time passes', () => {
  const estimatedAt = 1_000_000;
  const target = estimatedAt + 180_000;  // Haiku said "180s left" at that moment
  assert.equal(formatCountdown(target, estimatedAt), ' · ~3m 00s left');
  assert.equal(formatCountdown(target, estimatedAt + 60_000), ' · ~2m 00s left');
  assert.equal(formatCountdown(target, estimatedAt + 150_000), ' · under a minute left');
  // ...and the run outlasting its own guess still shows a time (#892),
  // never a negative value, never a count-up, never an open-ended message.
  assert.equal(formatCountdown(target, estimatedAt + 300_000), ' · under a minute left');
});

// ── 1a-ter. runCohortHint (#892) ────────────────────────────────────────
//
// Population context derived from 880 measured runs (p50 190s, p90 1029s,
// p99 2233s). A statement about the distribution, never a prediction about
// this run, so it cannot be individually wrong.

// #906 RETIRED THE FIRST BUCKET. "most runs finish in 2–10 min" was a range
// standing where a time should have been, and it rendered from second zero
// of every run — so for anyone without the experimental estimator it was the
// ONLY time statement they ever got, which is exactly what issue #906
// reported. The baseline countdown now owns that slot; the cohort hint is
// reduced to genuine long-run context.
test('runCohortHint (#906): silent under ten minutes, long-run context above', () => {
  assert.equal(runCohortHint(0), '');
  assert.equal(runCohortHint(599_999), '');
  assert.equal(runCohortHint(600_000), 'running longer than most — about 1 in 5 runs do');
  assert.equal(runCohortHint(1_799_999), 'running longer than most — about 1 in 5 runs do');
  assert.equal(runCohortHint(1_800_000), 'this is a long one — some runs go 30 min+');
  assert.equal(runCohortHint(9_999_999), 'this is a long one — some runs go 30 min+');
});

test('runCohortHint (#906): the retired range string is gone from the helper', () => {
  for (let ms = 0; ms <= 7_200_000; ms += 5_000) {
    assert.doesNotMatch(runCohortHint(ms), /most runs finish/,
      `the retired range copy came back at ${ms}ms`);
  }
});

test('runCohortHint: non-decreasing in severity as elapsed grows', () => {
  const rank = (s) => (s === '' ? 0 : s.startsWith('running') ? 1 : 2);
  let prev = -1;
  for (let ms = 0; ms <= 3_600_000; ms += 15_000) {
    const r = rank(runCohortHint(ms));
    assert.ok(r >= prev, `cohort hint went backwards at ${ms}ms`);
    prev = r;
  }
});

test('runCohortHint: garbage input falls back to the silent first bucket', () => {
  assert.equal(runCohortHint(undefined), '');
  assert.equal(runCohortHint(NaN), '');
  assert.equal(runCohortHint(-5000), '');
});

// ── 1a-quater. The always-present baseline countdown (#906) ─────────────
//
// The concrete ETA used to exist only on the opt-in AI-estimator path, and
// even there not before the estimator's first 60s tick. These tests pin the
// contract that replaces it: for a live, non-terminal run there is ALWAYS a
// time, it never runs backwards, and it is worded exactly like the AI
// countdown it alternates with.

test('baselineFinishSeconds: the ladder walks the measured rungs', () => {
  // 190 (population median) → +207 (2-5m p50) → +400 (5-10m) → +369, +369
  // (10-20m) → +450 (20m+), each extension looked up by the ANCHOR being
  // extended rather than by raw elapsed.
  assert.equal(baselineFinishSeconds(0), 190);
  assert.equal(baselineFinishSeconds(159_000), 190);
  assert.equal(baselineFinishSeconds(160_000), 397);
  assert.equal(baselineFinishSeconds(366_000), 397);
  assert.equal(baselineFinishSeconds(367_000), 797);
  assert.equal(baselineFinishSeconds(767_000), 1166);
  assert.equal(baselineFinishSeconds(1_136_000), 1535);
  assert.equal(baselineFinishSeconds(1_505_000), 1985);
});

test('baselineFinishSeconds: strictly positive and never runs backwards', () => {
  let prev = 0;
  for (let ms = 0; ms <= 6 * 3_600_000; ms += 7_000) {
    const f = baselineFinishSeconds(ms);
    assert.ok(f > 0, `projection must be positive at ${ms}ms`);
    assert.ok(f >= prev, `projection moved backwards at ${ms}ms`);
    // The projection must always stay ahead of the run itself, or the
    // countdown would be describing a finish already in the past.
    assert.ok(f * 1000 > ms - 60_000, `projection fell behind elapsed at ${ms}ms`);
    prev = f;
  }
});

test('baselineFinishSeconds: terminates on an absurdly long run', () => {
  // A ten-hour run must still return promptly — the ladder walk is capped so
  // a corrupted priors table can never spin the UI thread.
  const f = baselineFinishSeconds(10 * 3_600_000);
  assert.ok(Number.isFinite(f) && f > 36_000, 'a 10h run must still project ahead of itself');
});

test('baselineFinishSeconds: non-numeric input projects nothing', () => {
  assert.equal(baselineFinishSeconds(undefined), 0);
  assert.equal(baselineFinishSeconds(NaN), 0);
  assert.equal(baselineFinishSeconds('nonsense'), 0);
  assert.equal(baselineFinishSeconds(Infinity), 0);
  // A negative elapsed is a clock skew, not garbage — treat it as a run that
  // has only just started rather than blanking the readout.
  assert.equal(baselineFinishSeconds(-5000), 190);
});

test('baselineCountdownText: a live run ALWAYS shows a time (#906)', () => {
  for (let ms = 0; ms <= 6 * 3_600_000; ms += 5_000) {
    const t = baselineCountdownText(ms, 'claude');
    assert.notEqual(t, '', `no estimate rendered at ${ms}ms elapsed`);
    assert.match(t, / · (~.* left|under a minute left)$/,
      `unexpected countdown form at ${ms}ms: ${t}`);
    assert.doesNotMatch(t, /-/, `negative countdown at ${ms}ms: ${t}`);
  }
});

test('baselineCountdownText: honours the 30s floor and the rounding granularity', () => {
  for (let ms = 0; ms <= 3_600_000; ms += 1_000) {
    const t = baselineCountdownText(ms, 'claude');
    const m = t.match(/~(\d+)m (\d\d)s left/);
    if (!m) continue;
    const totalS = Number(m[1]) * 60 + Number(m[2]);
    assert.ok(totalS >= 60, `below the display floor at ${ms}ms: ${t}`);
    // Above five minutes the readout snaps to whole minutes; below it, to
    // 30s. Never a raw seconds value implying accuracy we do not have.
    if (totalS > 300) assert.equal(m[2], '00', `seconds digit above 5 min at ${ms}ms: ${t}`);
    else assert.ok(m[2] === '00' || m[2] === '30', `off-granularity at ${ms}ms: ${t}`);
  }
});

test('baselineCountdownText: the phase marker overrides the ladder', () => {
  // Committing and pushing take seconds; the ladder knows only about elapsed
  // time and cannot see that, but the phase marker can.
  assert.equal(baselineCountdownText(240_000, 'commit'), ' · under a minute left');
  assert.equal(baselineCountdownText(240_000, 'push'), ' · under a minute left');
  // Terminal phases: the run is over, so there is nothing left to count down
  // and a lingering estimate beside "Finished" would be plainly wrong.
  assert.equal(baselineCountdownText(240_000, 'done'), '');
  assert.equal(baselineCountdownText(240_000, 'push_failed'), '');
  assert.equal(baselineCountdownText(240_000, 'interrupted'), '');
  // Everything else — including no marker at all — counts down normally.
  assert.notEqual(baselineCountdownText(240_000, null), '');
  assert.notEqual(baselineCountdownText(240_000, ''), '');
  assert.notEqual(baselineCountdownText(240_000, 'refresh'), '');
  assert.notEqual(baselineCountdownText(240_000, 'sync_merge'), '');
});

test('baselineCountdownText: never renders an open-ended or at-zero state', () => {
  for (const ms of [0, 1, 189_000, 190_000, 191_000, 1_000_000, 20_000_000]) {
    const t = baselineCountdownText(ms, 'claude');
    assert.doesNotMatch(t, /due now/i, `at-zero freeze at ${ms}ms`);
    assert.doesNotMatch(t, /taking longer/i, `open-ended overrun copy at ${ms}ms`);
    assert.doesNotMatch(t, /0m 00s/, `zero countdown at ${ms}ms`);
  }
});

test('BASELINE_PRIORS: the client mirror tiles the elapsed line', () => {
  assert.ok(BASELINE_PRIORS && Array.isArray(BASELINE_PRIORS.buckets));
  let prevMax = 0;
  for (const b of BASELINE_PRIORS.buckets) {
    assert.equal(b.minS, prevMax, `${b.key}: bucket bounds must be contiguous`);
    assert.ok(b.p50RemainingS > 0, `${b.key}: the rung must be a positive step`);
    prevMax = b.maxS == null ? Infinity : b.maxS;
  }
  assert.equal(prevMax, Infinity, 'the last bucket must be open-ended');
  assert.ok(BASELINE_PRIORS.p50TotalS > 0, 'the ladder needs a positive first rung');
});

// ── 1b. summarizeCcProgress unit tests ──────────────────────────────────

test('summarizeCcProgress: picks the last action line as the current label', () => {
  const { currentLabel, steps } = summarizeCcProgress([
    'Reading public/js/app.js',
    '  ⎿ Read: 120 lines',
    'Editing public/js/app.js',
  ]);
  assert.equal(currentLabel, 'Editing public/js/app.js');
  assert.equal(steps, 2);
});

test('summarizeCcProgress: skips tool-result lines when picking the label', () => {
  const { currentLabel } = summarizeCcProgress([
    'Editing src/server.js',
    '  ⎿ Edit: ok',
  ]);
  assert.equal(currentLabel, 'Editing src/server.js');
});

test('summarizeCcProgress: maps phase markers to friendly labels', () => {
  assert.equal(summarizeCcProgress(['[refresh]']).currentLabel, 'Syncing branch');
  assert.equal(summarizeCcProgress(['[claude (mode build)]']).currentLabel, 'Claude is working');
  assert.equal(summarizeCcProgress(['[claude (resume abc123, mode scout)]']).currentLabel, 'Claude is working');
  assert.equal(summarizeCcProgress(['[commit]']).currentLabel, 'Committing');
  assert.equal(summarizeCcProgress(['[push]']).currentLabel, 'Pushing');
  assert.equal(summarizeCcProgress(['[sync_merge]']).currentLabel, 'Syncing with main');
});

test('summarizeCcProgress (#906): reports the machine-readable phase key', () => {
  // phaseLabel is display copy; phaseKey is what the baseline countdown
  // branches on, so it must survive a copy change to the label.
  assert.equal(summarizeCcProgress(['[claude (mode build)]']).phaseKey, 'claude');
  assert.equal(summarizeCcProgress(['[claude (resume abc123, mode scout)]']).phaseKey, 'claude');
  assert.equal(summarizeCcProgress(['[commit]']).phaseKey, 'commit');
  assert.equal(summarizeCcProgress(['[push]']).phaseKey, 'push');
  assert.equal(summarizeCcProgress(['[push_failed]']).phaseKey, 'push_failed');
  assert.equal(summarizeCcProgress(['[done]']).phaseKey, 'done');
  // The LAST marker wins, matching phaseLabel.
  assert.equal(summarizeCcProgress(['[refresh]', 'Editing a.js', '[commit]']).phaseKey, 'commit');
  // Null until the run emits a marker at all.
  assert.equal(summarizeCcProgress(['Reading a.js']).phaseKey, null);
  assert.equal(summarizeCcProgress([]).phaseKey, null);
});

test('ccPhaseLabel: unknown phases fall back to the raw phase text', () => {
  assert.equal(ccPhaseLabel('warm-ready'), 'warm-ready');
});

test('ccPhaseLabel: terminal markers map to terminal labels', () => {
  assert.equal(ccPhaseLabel('done'), 'Finished');
  assert.equal(ccPhaseLabel('push_failed'), 'Push failed');
  assert.equal(ccPhaseLabel('interrupted'), 'Interrupted');
});

test('summarizeCcProgress: a log ending in [done] shows Finished, never a frozen verb', () => {
  const { currentLabel } = summarizeCcProgress([
    'Editing src/server.js',
    '[commit]',
    '[push]',
    '[done]',
  ]);
  assert.equal(currentLabel, 'Finished');
  assert.equal(summarizeCcProgress(['[push]', '[push_failed]']).currentLabel, 'Push failed');
  assert.equal(summarizeCcProgress(['[push]', '[interrupted]']).currentLabel, 'Interrupted');
});

test('summarizeCcProgress: thinking lines are label candidates but not steps', () => {
  const { currentLabel, steps } = summarizeCcProgress([
    'Reading public/index.html',
    '… Planning the change before touching files',
  ]);
  assert.equal(currentLabel, '… Planning the change before touching files');
  assert.equal(steps, 1);
});

test('summarizeCcProgress: falls back to the last non-empty line (bootstrap output)', () => {
  const { currentLabel, steps } = summarizeCcProgress([
    'Cloning into workspace...',
    'Checking out branch dev/foo',
    '',
  ]);
  assert.equal(currentLabel, 'Checking out branch dev/foo');
  assert.equal(steps, 0);
});

test('summarizeCcProgress: steps counts only tool_use-shaped action lines', () => {
  const { steps } = summarizeCcProgress([
    '[refresh]',
    'remote: Enumerating objects: 12, done.',
    'Reading a.js',
    '  ⎿ Read: 10 lines',
    'Writing b.js',
    '$ npm test',
    'Using WebFetch',
    '… thinking about it',
    '[commit]',
  ]);
  assert.equal(steps, 4);
});

test('summarizeCcProgress: truncates long labels on a whitespace boundary', () => {
  const long = '$ grep -rn "some very long pattern here" public/js src/routes src/services tests && echo done';
  const { currentLabel } = summarizeCcProgress([long]);
  assert.ok(currentLabel.length <= 61, `label too long: ${currentLabel.length}`);
  assert.ok(currentLabel.endsWith('…'));
  // Whitespace boundary: the kept prefix must end exactly where a word
  // ends in the original, not slice through the middle of one.
  const kept = currentLabel.slice(0, -1);
  assert.equal(long.charAt(kept.length), ' ', `cut mid-word: "${kept}"`);
});

test('summarizeCcProgress: empty / undefined / junk logs are safe', () => {
  const bare = { currentLabel: '', steps: 0, phaseLabel: null, phaseKey: null };
  assert.deepEqual(summarizeCcProgress([]), bare);
  assert.deepEqual(summarizeCcProgress(undefined), bare);
  assert.deepEqual(summarizeCcProgress(null), bare);
  const { currentLabel } = summarizeCcProgress([null, undefined, 42]);
  assert.equal(currentLabel, '42');
});

// #892: the DETERMINISTIC stage readout that sits beside the AI guess.
// Derived from markers the run genuinely emits, so unlike the guess it
// cannot be wrong — it is what the user has to look at when the estimate is
// uncertain.
test('summarizeCcProgress (#892): phaseLabel comes from the LAST phase marker', () => {
  const log = ['[sync]', 'Reading a.js', '[claude (mode build)]', 'Editing b.js', '[commit]'];
  assert.equal(summarizeCcProgress(log).phaseLabel, 'Committing');
});

test('summarizeCcProgress (#892): phaseLabel is null before any marker lands', () => {
  assert.equal(summarizeCcProgress(['Reading a.js', 'Editing b.js']).phaseLabel, null);
});

test('summarizeCcProgress (#892): phaseLabel survives later non-phase lines', () => {
  // The current-activity label moves on to the file edit, but the STAGE is
  // still "Claude is working" — they answer different questions.
  const summ = summarizeCcProgress(['[claude (mode build)]', 'Editing b.js']);
  assert.equal(summ.phaseLabel, 'Claude is working');
  assert.equal(summ.currentLabel, 'Editing b.js');
});

// ── 2. Source guards ────────────────────────────────────────────────────

const indexHtml = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'), 'utf8'
);
const devChatSrc = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'), 'utf8'
);
const sessionsSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'), 'utf8'
);

test('index.html loads cc-progress-summary.js before dev-chat.js', () => {
  const helperIdx = indexHtml.indexOf('/js/cc-progress-summary.js');
  const devChatIdx = indexHtml.indexOf('/js/dev-chat.js');
  assert.ok(helperIdx !== -1, 'cc-progress-summary.js script tag missing');
  assert.ok(devChatIdx !== -1, 'dev-chat.js script tag missing');
  assert.ok(helperIdx < devChatIdx, 'cc-progress-summary.js must load before dev-chat.js');
});

test('dev-chat.js actually calls the helpers (not dead code)', () => {
  assert.ok(/summarizeCcProgress\(/.test(devChatSrc), 'dev-chat.js must call summarizeCcProgress');
  assert.ok(/formatElapsed\(/.test(devChatSrc), 'dev-chat.js must call formatElapsed');
  assert.ok(/formatCountdown\(/.test(devChatSrc), 'dev-chat.js must call formatCountdown (#359)');
  assert.ok(/data-elapsed-since/.test(devChatSrc), 'dev-chat.js must render the elapsed-ticker span');
  assert.ok(/data-countdown-to/.test(devChatSrc), 'dev-chat.js must render the count-down span (#359)');
});

test("sessions.js persists durationMs on the completion status", () => {
  // #358: the completion status text is now outcome-derived (a `statusText`
  // variable that is 'Claude Code finished' only on success), but the
  // terminal ccOutput row must still carry durationMs.
  const finishedCall = sessionsSrc.match(
    /sendStatus\(statusText,\s*\{[^}]*\}/
  );
  assert.ok(finishedCall, 'missing sendStatus(statusText, {...}) completion row');
  assert.ok(
    /durationMs/.test(finishedCall[0]),
    'completion status metadata must include durationMs'
  );
  assert.ok(
    /ccOutcome/.test(finishedCall[0]),
    'completion status metadata must include ccOutcome'
  );
  // The literal 'Claude Code finished' header is still produced for the
  // success outcome.
  assert.ok(
    /statusText\s*=\s*ccOutcome === 'success'\s*\?\s*'Claude Code finished'/.test(sessionsSrc),
    "success outcome must still surface 'Claude Code finished'"
  );
});

// ── 3. #892 render guards ───────────────────────────────────────────────
//
// The coding-run summary must ALWAYS render a countdown with a numeric-form
// label — including when the delivered target is already in the past — and
// the cohort hint must only compete with it once past ten minutes.

const devChat = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'), 'utf8'
);

test('#892: the countdown span always renders a numeric form', () => {
  // The span's initial text comes straight from formatCountdown, which has
  // no non-numeric branch left — so a target already in the past still
  // paints a time rather than a frozen "due now".
  assert.match(devChat, /_countdownSpanHtml\(countdownTo\) \{/, 'the span builder must exist');
  assert.match(devChat, /const initial = formatCountdown\(countdownTo, Date\.now\(\)\);/,
    'the initial fill must go through formatCountdown');
  assert.equal(formatCountdown(Date.now() - 600_000, Date.now()), ' · under a minute left');
});

test('#892: the client mirrors the server guard and never renders a later target uncaused', () => {
  // A reordered SSE/poll delivery must not visibly push the finish out —
  // that is the exact treadmill the server-side guard exists to stop.
  assert.match(devChat, /nextTarget > target\._countdownTo && !o\.slipReason/,
    'a later target without a stated cause must be ignored');
  assert.match(devChat, /o\.displayedRemainingSeconds != null \? o\.displayedRemainingSeconds : remaining/,
    'the countdown must prefer the post-guard displayed value');
});

test('#906: the render-time cohort gate is gone', () => {
  // `data-cohort-gated` was computed once per render from msg._estimate —
  // always falsy on first render — and neither _applyEstimate nor
  // _patchProgressSummary ever refreshed it, so the range blurb kept
  // rendering beside a live AI countdown for the rest of the run. The
  // visibility rule now lives in the pure helper instead.
  assert.doesNotMatch(devChat, /data-cohort-gated="/,
    'the stale render-time gate attribute must not come back');
  assert.doesNotMatch(devChat, /dataset\.cohortGated/,
    'the ticker must not read a frozen gate');
  assert.match(devChat, /runCohortHint\(elapsed\)/, 'the hint text must come from the pure helper');
});

test('#906: the baseline countdown renders on every live coding run', () => {
  assert.match(devChat, /class="dc-cc-eta"/, 'the baseline countdown needs its own span');
  assert.match(devChat, /data-eta-since="\$\{etaSince\}"/,
    'the span must carry the run start the ticker counts from');
  assert.match(devChat, /data-eta-phase="\$\{escapeHtml\(summ\.phaseKey \|\| ''\)\}"/,
    'the span must carry the machine-readable phase the countdown branches on');
  assert.match(devChat, /const eta = details\.querySelector\('\.dc-cc-eta'\);/,
    'the phase must be refreshed as lines stream in, not frozen at render');
  assert.match(devChat, /el\.textContent = baselineCountdownText\(Math\.max\(0, now - since\), el\.dataset\.etaPhase\);/,
    'the ticker must recompute the countdown from the pure helper');
});

test('#906: precedence is resolved at tick time from the sibling estimate span', () => {
  // Deliberately NOT a flag stamped at render: the AI guess lands 60s+ into
  // a run and is patched straight into .dc-cc-estimate, so a render-time
  // flag is permanently wrong — the exact defect the cohort gate had.
  const tickAt = devChat.indexOf('etas.forEach');
  assert.ok(tickAt > 0, 'the baseline countdown must tick');
  const body = devChat.slice(tickAt, tickAt + 500);
  assert.match(body, /querySelector\('\.dc-cc-estimate'\)/,
    'precedence must be read from the sibling AI-estimate span');
  assert.match(body, /ai\.textContent\.trim\(\)/,
    'precedence must depend on what that span actually holds right now');
  assert.match(body, /el\.textContent = '';/,
    'the baseline must yield when a better number exists');
});

test('#906: the retired range copy appears nowhere in the shipped client', () => {
  const dir = path.join(__dirname, '..', 'public');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  ));
  // The comments explaining what was retired legitimately quote it, so
  // strip comments before scanning — what's left is what actually ships.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  for (const file of walk(dir)) {
    if (!/\.(js|css|html)$/.test(file)) continue;
    assert.doesNotMatch(stripComments(fs.readFileSync(file, 'utf8')), /most runs finish/i,
      `${path.relative(dir, file)} still renders the retired range message`);
  }
});

test('#892: the deterministic stage label renders and is patched in place', () => {
  assert.match(devChat, /class="dc-cc-phase"/, 'the stage label must have its own span');
  assert.match(devChat, /summ\.phaseLabel \? `· \$\{escapeHtml\(summ\.phaseLabel\)\}` : ''/,
    'the stage label must be escaped and empty-safe');
  assert.match(devChat, /const phase = details\.querySelector\('\.dc-cc-phase'\);/,
    'the label must be patched as lines stream in, not only on full re-render');
});

test('#892: the summary row renders countdown and cohort in the specified order', () => {
  const rowAt = devChat.indexOf('${currentSpan}${stepsSpan}');
  assert.ok(rowAt > 0, 'the coding-run summary row must exist');
  const row = devChat.slice(rowAt, rowAt + 200);
  // current action · steps · phase · elapsed · baseline ETA (#906) ·
  // AI countdown (inside estimate) · cohort
  const order = ['${currentSpan}', '${stepsSpan}', '${phaseSpan}', '${elapsedHtml}',
    '${etaSpan}', '${estimateSpan}', '${cohortSpan}'];
  let at = -1;
  for (const token of order) {
    const next = row.indexOf(token);
    assert.ok(next > at, `${token} must follow the previous element in the summary row`);
    at = next;
  }
});
