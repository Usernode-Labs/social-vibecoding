// Wiring tests for the merge gate and the proposal-card display of the
// platform-variables check (src/routes/votes.js, public/js/app-view.js,
// the preview machine's checks.publish work in src/workflow/preview/services.ts).
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
const { message } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const votesJs = fs.readFileSync(path.join(root, 'src/routes/votes.js'), 'utf8');
const appViewJs = fs.readFileSync(path.join(root, 'public/js/app-view.js'), 'utf8');
const servicesTs = fs.readFileSync(path.join(root, 'src/workflow/preview/services.ts'), 'utf8');
const envCheckJs = fs.readFileSync(path.join(root, 'src/services/platform-env-check.js'), 'utf8');

// The machine's checks.publish work: what runs once a checks run settles.
const publishWork = (() => {
  const start = servicesTs.indexOf('[WORK.publish]: {');
  assert.notStrictEqual(start, -1, 'the checks.publish work anchor moved');
  const end = servicesTs.indexOf('[WORK.', start + 1);
  return servicesTs.slice(start, end === -1 ? undefined : end);
})();

// ── The gate ──────────────────────────────────────────────────────────

const gate = (() => {
  const start = votesJs.indexOf("phase: 'gate:checks'");
  assert.notStrictEqual(start, -1, 'the checks gate anchor moved');
  const end = votesJs.indexOf('// Main-health gate', start);
  assert.notStrictEqual(end, -1, 'the gate-region end anchor moved');
  // Use semantic anchors rather than a character budget. New independent
  // gates may legitimately sit between checks and platform variables, while
  // the main-health anchor still keeps the later merge body out of scope.
  return votesJs.slice(start, end);
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
  const start = appViewJs.indexOf('_platformEnvNote(pr) {');
  assert.notStrictEqual(start, -1, '_platformEnvNote is missing');
  return appViewJs.slice(start, start + 3000);
})();

test('the block is rendered next to the checks block', () => {
  // The head builds an ORDERED list of detail blocks now (see
  // `_proposalDetailsView`) instead of concatenating three strings; the
  // ordering contract it encodes is the same one this pinned.
  // #1442 added a fourth block to the run — the PREDICTED conflict, which
  // sits between the attempted one and the checks because it answers the
  // same question earlier. The contract this pins is the grouping, not the
  // exact count, so the merge-blocking notes are allowed to grow between
  // the two anchors as long as they stay contiguous.
  assert.match(
    appViewJs,
    /_mergeConflictNote\(pr\),\s*\n(?:\s*AppView\._\w+\(pr\),\s*\n)*[^\n]*checks[^\n]*\n\s*AppView\._platformEnvNote\(pr\),/,
    'one place to look for "why can this not merge yet"'
  );
});

test('skipped renders nothing at all', () => {
  assert.match(detailFn, /'skipped'/);
  assert.match(detailFn.slice(0, 600), /return null/,
    'the overwhelmingly common case must add no chrome to the card');
});

test('a failing verdict names the missing keys and offers the fix in place', () => {
  assert.match(detailFn, /missing/);
  // The card only ever renders on a self-app proposal, so the viewer is
  // already on the app whose panel fixes this — open it rather than sending
  // them to a deep link (and a non-admin to a screen they can't act on).
  assert.match(detailFn, /fn: 'openPlatformVariables'/,
    'one click from the block to the panel is the difference between a '
    + '20-second fix and a hunt');
  assert.match(detailFn, /PlatformI18n\.t\('changes:envNote\.setNow'\) : PlatformI18n\.t\('changes:envNote\.proposeValue'\)/,
    'both audiences get an action: admins set it, everyone else proposes it');
  assert.equal(message('changes:envNote.setNow'), 'Set them now');
  assert.equal(message('changes:envNote.proposeValue'), 'Propose a value');
});

test('an error verdict is shown as non-blocking, not as a failure', () => {
  assert.match(detailFn, /'error'/);
});

// ── Re-capture ────────────────────────────────────────────────────────

test('a staging capture refreshes the verdict and reuses the checks broadcast', () => {
  // A settled run's checks.publish work refreshes the platform's own app's
  // verdict. The checks_ready the settlement pushed went out before this
  // ran, so the refreshed verdict needs its own broadcast to reach the card.
  assert.match(publishWork, /refreshPlatformEnvCheck/);
  assert.match(publishWork, /checks_ready|notifyChecks/,
    'reusing checks_ready avoids a second event type the client would have to learn');
});

test('a refresh failure never breaks the capture pipeline', () => {
  // The publish work awaits the refresh, so the refresh itself must never
  // throw: a throw would retry the whole publish (the PR body patch too).
  const fn = envCheckJs.slice(envCheckJs.indexOf('async function refreshPlatformEnvCheck('));
  assert.match(fn, /^async function refreshPlatformEnvCheck\(\{ pool, app, session \}\) \{\s+try \{/,
    'the verdict is a nice-to-have; the screenshots are not');
  assert.match(fn.slice(0, fn.indexOf('\n}\n')), /\} catch \(err\) \{[\s\S]*return null;\s+\}/);
});
