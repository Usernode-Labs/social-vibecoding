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

// ── 1a-bis. formatCountdown unit tests (#359) ───────────────────────────

test('formatCountdown: positive remaining renders "· ~X left" via formatElapsed', () => {
  // 2m 30s out
  assert.equal(formatCountdown(1_150_000, 1_000_000), ' · ~2m 30s left');
  // sub-minute
  assert.equal(formatCountdown(1_042_000, 1_000_000), ' · ~42s left');
});

test('formatCountdown: zero / overrun clamps to "· due now"', () => {
  assert.equal(formatCountdown(1_000_000, 1_000_000), ' · due now');
  assert.equal(formatCountdown(1_000_000, 1_005_000), ' · due now');
});

test('formatCountdown: re-anchoring to a new target yields the new value', () => {
  const now = 1_000_000;
  assert.equal(formatCountdown(now + 30_000, now), ' · ~30s left');
  // a fresh, larger estimate counts down from the bigger number
  assert.equal(formatCountdown(now + 120_000, now), ' · ~2m 00s left');
});

test('formatCountdown: garbage inputs clamp to "· due now"', () => {
  assert.equal(formatCountdown(NaN, 1_000), ' · due now');
  assert.equal(formatCountdown(undefined, undefined), ' · due now');
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
  assert.deepEqual(summarizeCcProgress([]), { currentLabel: '', steps: 0 });
  assert.deepEqual(summarizeCcProgress(undefined), { currentLabel: '', steps: 0 });
  assert.deepEqual(summarizeCcProgress(null), { currentLabel: '', steps: 0 });
  const { currentLabel } = summarizeCcProgress([null, undefined, 42]);
  assert.equal(currentLabel, '42');
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
