// Wiring tests for the merge gate and the proposal-card display of the
// platform-variables check (src/routes/votes.js, public/js/app-view.js,
// src/services/visuals.js).
//
// The load-bearing detail is that the GATE and the DISPLAY read
// different things. The card renders the stored verdict from
// chat_sessions.platform_env_state — a snapshot from whenever staging
// was last captured. checkAndMerge does NOT trust that snapshot; it
// re-resolves at the moment of the deciding vote. That asymmetry is the
// whole reason the fix loop is "set the value, vote again" instead of
// "set the value, rebuild staging, wait, vote again".
//
// Run with: node --test tests/platform-env-gate.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const votesJs = fs.readFileSync(path.join(root, 'src/routes/votes.js'), 'utf8');
const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
const visualsJs = fs.readFileSync(path.join(root, 'src/services/visuals.js'), 'utf8');

// ── The gate ──────────────────────────────────────────────────────────

const gate = (() => {
  const start = votesJs.indexOf("phase: 'gate:checks'");
  assert.notStrictEqual(start, -1, 'the checks gate anchor moved');
  return votesJs.slice(start, start + 4000);
})();

test('the gate re-resolves rather than reading the stored verdict', () => {
  assert.match(gate, /resolvePlatformEnvCheck/,
    'reading platform_env_state would mean a stale snapshot decides the merge');
  assert.ok(!/SELECT platform_env_state/.test(gate));
  assert.match(gate, /storePlatformEnvCheck/,
    'the fresh verdict is written back so the card agrees with the decision');
});

test('the gate only applies to the self-hosted app', () => {
  assert.match(gate, /self_hosted/);
});

test('only a determinate failure blocks', () => {
  assert.match(gate, /=== 'failing'/,
    "'skipped' and 'error' must fall through — the check fails open on purpose");
});

test('a blocked merge tells the voter what to do, in both places they might look', () => {
  assert.match(gate, /describeBlock/);
  assert.match(gate, /platformEnvBlocked: true/,
    'the caller needs to distinguish this from a vote-threshold miss');
  assert.match(gate, /platformEnvMissing/);
  assert.match(gate, /merged: false/);
});

test('the gate sits inside the force-merge bypass', () => {
  const forceIdx = votesJs.lastIndexOf('if (!force)', votesJs.indexOf("phase: 'gate:checks'"));
  assert.notStrictEqual(forceIdx, -1,
    'an admin force-merge must skip this gate like it skips the test-suite gate');
});

test('both proposal SELECTs expose the stored verdict to the UI', () => {
  const matches = [...votesJs.matchAll(/cs\.platform_env_state, cs\.platform_env_detail/g)];
  assert.equal(matches.length, 2,
    'the list and the detail query must agree, or the card renders differently in two places');
});

// ── The card ──────────────────────────────────────────────────────────

const detailFn = (() => {
  const start = appViewJs.indexOf('_platformEnvDetailHtml(pr) {');
  assert.notStrictEqual(start, -1, '_platformEnvDetailHtml is missing');
  return appViewJs.slice(start, start + 3000);
})();

test('the block is rendered next to the checks block', () => {
  assert.match(appViewJs, /\$\{AppView\._checksDetailHtml\(pr\)\}\s*\n\s*\$\{AppView\._platformEnvDetailHtml\(pr\)\}/,
    'one place to look for "why can this not merge yet"');
});

test('skipped renders nothing at all', () => {
  assert.match(detailFn, /'skipped'/);
  assert.match(detailFn.slice(0, 600), /return ''/,
    'the overwhelmingly common case must add no chrome to the card');
});

test('a failing verdict names the missing keys and offers the fix in place', () => {
  assert.match(detailFn, /missing/);
  // The card only ever renders on a self-app proposal, so the viewer is
  // already on the app whose panel fixes this — open it rather than sending
  // them to a deep link (and a non-admin to a screen they can't act on).
  assert.match(detailFn, /AppView\.openPlatformVariables\(\)/,
    'one click from the block to the panel is the difference between a '
    + '20-second fix and a hunt');
  assert.match(detailFn, /'Set them now' : 'Propose a value'/,
    'both audiences get an action: admins set it, everyone else proposes it');
});

test('an error verdict is shown as non-blocking, not as a failure', () => {
  assert.match(detailFn, /'error'/);
});

// ── Re-capture ────────────────────────────────────────────────────────

test('a staging capture refreshes the verdict and reuses the checks broadcast', () => {
  const capture = visualsJs.slice(visualsJs.indexOf('refreshPlatformEnvCheck') - 1500,
    visualsJs.indexOf('refreshPlatformEnvCheck') + 1500);
  assert.match(capture, /refreshPlatformEnvCheck/);
  assert.match(capture, /notifyChecks/,
    'reusing checks_ready avoids a second event type the client would have to learn');
});

test('a refresh failure never breaks the capture pipeline', () => {
  const idx = visualsJs.indexOf('refreshPlatformEnvCheck');
  const before = visualsJs.slice(Math.max(0, idx - 900), idx);
  assert.match(before, /try \{/,
    'the verdict is a nice-to-have; the screenshots are not');
});
