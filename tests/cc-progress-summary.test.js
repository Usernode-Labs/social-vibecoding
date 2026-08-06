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

// ── 1a-ter. runCohortHint (#892, narrowed in #906) ──────────────────────
//
// Long-run context derived from 880 measured runs (p50 190s, p90 1029s,
// p99 2233s). A statement about the distribution, never a prediction about
// this run, so it cannot be individually wrong.
//
// #906 removed the first bucket. "most runs finish in 2–10 min" was a range
// standing where a time should have been: it said nothing about your run,
// never changed, and rendered from second zero — so for anyone without the
// experimental estimator it was the only thing that ever appeared in this
// slot. It is removed, not replaced: with no real estimate the slot is
// empty. Only the genuinely-long-run notes survive.

test('runCohortHint (#906): silent below ten minutes, long-run context above', () => {
  assert.equal(runCohortHint(0), '');
  assert.equal(runCohortHint(599_999), '');
  assert.equal(runCohortHint(600_000), 'running longer than most — about 1 in 5 runs do');
  assert.equal(runCohortHint(1_799_999), 'running longer than most — about 1 in 5 runs do');
  assert.equal(runCohortHint(1_800_000), 'this is a long one — some runs go 30 min+');
  assert.equal(runCohortHint(9_999_999), 'this is a long one — some runs go 30 min+');
});

test('runCohortHint (#906): the retired range copy is gone at every elapsed', () => {
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
  assert.equal(summarizeCcProgress(['[codex (mode build)]']).currentLabel, 'Codex is working');
  assert.equal(summarizeCcProgress(['[codex (resume thr-0199, mode scout)]']).currentLabel, 'Codex is working');
  assert.equal(summarizeCcProgress(['[agent (mode build)]']).currentLabel, 'Coding agent is working');
  assert.equal(summarizeCcProgress(['[commit]']).currentLabel, 'Committing');
  assert.equal(summarizeCcProgress(['[push]']).currentLabel, 'Pushing');
  assert.equal(summarizeCcProgress(['[sync_merge]']).currentLabel, 'Syncing with main');
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
  const bare = { currentLabel: '', steps: 0, phaseLabel: null };
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
  // `data-cohort-gated` was stamped once per render from msg._estimate —
  // necessarily falsy at first render, since the first AI guess is a full
  // 60s estimator tick away — and neither _applyEstimate nor
  // _patchProgressSummary ever refreshed it. So every run rendered
  // gated="0" and the range blurb kept painting beside the live countdown
  // for the rest of the run. Matched as literal code forms, not bare
  // words: the comments explaining what was retired legitimately name it.
  assert.doesNotMatch(devChat, /data-cohort-gated="/,
    'the frozen gate attribute must not come back');
  assert.doesNotMatch(devChat, /dataset\.cohortGated/,
    'the ticker must not read a frozen gate');
});

test('#906: the side slot is resolved at tick time from live state only', () => {
  const tickAt = devChat.indexOf('cohorts.forEach');
  assert.ok(tickAt > 0, 'the cohort hint must tick');
  const body = devChat.slice(tickAt, tickAt + 1600);
  // Elapsed is the only input, recomputed every second from the DOM anchor.
  assert.match(body, /parseInt\(el\.dataset\.cohortSince, 10\)/,
    'the hint must be derived from the live elapsed anchor');
  assert.match(body, /const hint = runCohortHint\(elapsed\);/,
    'the whole visibility rule must live in the pure helper');
  // An empty hint must blank the span rather than leave a dangling "· ".
  assert.match(body, /el\.textContent = hint \? ' (·|\\u00b7) ' \+ hint : '';/,
    'an empty hint must write an empty span, not a bare separator');
});

test('#906: the retired range copy ships nowhere in the client', () => {
  // The comments explaining what was retired legitimately quote the phrase,
  // so strip comments first — what is left is what actually ships.
  const stripComments = (s) => s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
  const dir = path.join(__dirname, '..', 'public');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]
  ));
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
  // current action · steps · phase · elapsed · countdown (inside estimate) · cohort
  const order = ['${currentSpan}', '${stepsSpan}', '${phaseSpan}', '${elapsedHtml}',
    '${estimateSpan}', '${cohortSpan}'];
  let at = -1;
  for (const token of order) {
    const next = row.indexOf(token);
    assert.ok(next > at, `${token} must follow the previous element in the summary row`);
    at = next;
  }
});
