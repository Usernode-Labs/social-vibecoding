'use strict';

// A conflicting proposal whose checks fail or could not run is one the
// conflict lane never resolves (src/workflow/merge-queue/machine.ts
// admission), and every surface said "the platform will resolve it" anyway.
// On 19 Oct 2026, 33 of the 35 conflicting proposals in review were such
// heads, some up since September, none ever asked to resolve. The lane now
// writes its verdict on the row like its other reasons, and each surface
// names who acts.
//
// Run with: node --test tests/conflict-lane-checks-reason.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { admission } = require('../src/workflow/merge-queue/machine.ts');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// app-view's merge verdict and step line, in a browser-shaped sandbox with the
// real English catalogs (the way tests/unified-change-detail.test.js loads it).
function appView() {
  const c = {
    console,
    document: { getElementById: () => null, querySelector: () => null, addEventListener() {} },
    localStorage: { getItem: () => null }, addEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '' }, URLSearchParams,
  };
  c.window = c;
  c.PlatformI18n = englishPlatformI18n();
  vm.createContext(c);
  for (const rel of ['public/js/merge-status.js', 'public/js/app-view.js']) {
    vm.runInContext(read(rel), c);
  }
  // app-view.js declares AppView with `const`, so the script's binding is not
  // a property of the sandbox's global: publish it the way the other suites do.
  vm.runInContext('globalThis.av = AppView', c);
  return c.av;
}

const candidate = (over = {}) => ({
  forkHead: false, gaveUp: null, head: 'a'.repeat(40), integrationMain: 'b'.repeat(40), backoffUntil: 0,
  unmergeable: null, approved: true, forced: false, resolutionSpent: false, conflictFiles: [], githubConflict: false, ...over,
});

test('a stale failing verdict is resolved first, and named on the row only once the free resolution is spent', () => {
  // #6531: its verdict was measured against an older main, and a conflicting
  // head gets no fresh automatic run, so the lane resolves it and the new
  // head gets its own checks run.
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_failing', resolutionSpent: false, approved: false }), Date.now()),
    { admit: true, reason: 'first_conflict' });
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_error', resolutionSpent: false, approved: false }), Date.now()),
    { admit: true, reason: 'first_conflict' });
  // Approved: the yes lets the lane resolve it too.
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_failing', resolutionSpent: true }), Date.now()),
    { admit: true, reason: 'approved' });
  // Spent and still failing: nobody but its author (or the bot) moves it.
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_failing', resolutionSpent: true, approved: false }), Date.now()),
    { admit: false, reason: 'checks_failing' });
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_error', resolutionSpent: true, approved: false }), Date.now()),
    { admit: false, reason: 'checks_error' });
  assert.deepEqual(admission(candidate(), Date.now()), { admit: true, reason: 'approved' });
  const src = read('src/workflow/merge-queue/machine.ts');
  assert.match(src, /const LANE_REASONS: ReadonlySet<string> = new Set\(\['awaiting_approval', 'unresolvable', 'fork_head', 'checks_failing', 'checks_error'\]\);/,
    'a declined head\'s reason reaches the card only through LANE_REASONS');
});

test('a conflict only in a mechanical file is settled without spending the free resolution', () => {
  const mechanical = candidate({ conflictFiles: ['tests/baselines/test-durations.json'], resolutionSpent: true, approved: false });
  assert.deepEqual(admission(mechanical, Date.now()), { admit: true, reason: 'mechanical' });
  assert.deepEqual(admission(candidate({ conflictFiles: ['src/db/migrations/manifest.json'] }), Date.now()),
    { admit: true, reason: 'mechanical' });
  // One real file alongside it is a real conflict.
  assert.deepEqual(admission(candidate({ conflictFiles: ['tests/baselines/test-durations.json', 'src/a.ts'], approved: false }), Date.now()),
    { admit: true, reason: 'first_conflict' });
  // GitHub's own refusal is measured afresh; it is not the mechanical lane's.
  assert.deepEqual(admission(candidate({ conflictFiles: ['tests/baselines/test-durations.json'], githubConflict: true,
    resolutionSpent: true, approved: false }), Date.now()), { admit: false, reason: 'awaiting_approval' });
});

test('the gate\'s thread line and the dev-chat pill say the checks come first', () => {
  const votes = read('src/routes/votes.js');
  assert.match(votes, /Its checks are failing too, so the platform waits for \$\{owner\} to fix them before it resolves the conflict\./);
  assert.match(votes, /Its checks could not run either; once they are re-run and pass, the platform resolves the conflict\./);
  const pill = read('public/js/merge-status.js');
  assert.match(pill, /served\.indexOf\('checks_failing'\) !== -1\s*\? t\('session:merge\.title\.conflictChecksFailing'\)/);
  assert.match(pill, /served\.indexOf\('checks_error'\) !== -1\s*\? t\('session:merge\.title\.conflictChecksError'\)/);
  const session = JSON.parse(read('frontend/locales/en/session.json'));
  assert.match(session['merge.title.conflictChecksFailing'].text, /creator fixes the checks first/);
  assert.match(session['merge.title.conflictChecksError'].text, /once they are re-run and pass/);
});

test('the change card and the bot tab word a yes-only conflict the same way', () => {
  const core = JSON.parse(read('frontend/locales/en/core.json'));
  assert.equal(core['work.line.conflictOnYes'].text,
    'Conflicts with main: Homeroom resolves it once you approve');
  assert.equal(core['work.stage.syncing'].text, 'Syncing with main');
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.equal(changes['page.votes.note.conflictOnYes'].text,
    'Conflicts with main: Homeroom resolves it once you approve.');
  assert.match(changes['page.votes.note.syncing'].text, /^Syncing with main: Homeroom asks for votes when it is caught up/);
  const view = read('public/js/app-view.js');
  assert.match(view, /blocked\.indexOf\('awaiting_approval'\) !== -1\) note\.push\(PlatformI18n\.t\('changes:page\.votes\.note\.conflictOnYes'\)\)/);
  assert.match(view, /blocked\.indexOf\('integrating'\) !== -1 \|\| !blocked\.some/);
  // The bot tab's row: the feed item carries the flag, and the row words it.
  assert.match(read('src/routes/workshop-overview.js'), /AS conflict_on_yes/);
  assert.match(read('frontend/src/features/ai/model.ts'), /row\.voteConflict/);
});

test('the card\'s integration line says it too, before the automatic fallbacks', () => {
  const view = read('public/js/app-view.js');
  const line = view.slice(view.indexOf('  _integrationLine(g, p, viewer) {'), view.indexOf('  INTEGRATION_LINE_IDS: {'));
  const checks = line.indexOf("served.includes('checks_failing')");
  const queued = line.indexOf('conflict(IDS.queued)');
  assert.ok(checks > 0 && queued > checks, 'checked before the "queued to fix" fallback');
  assert.match(line, /if \(served\.includes\('checks_error'\)\) return conflict\(IDS\.checksRerun\);/);
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.equal(changes['step.integration.checksFirstMain'].text, 'Conflict with main · fix the checks first');
  assert.equal(changes['step.integration.checksRerunMain'].text, 'Conflict with main · re-run the checks first');
  assert.ok(changes['step.integration.checksFirstFiles_one'] && changes['step.integration.checksFirstFiles_other']);
});

// #6550: a later GitHub snapshot that says nothing (mergeability null or
// 'unknown') hid Homeroom's own clean merge measurement, so the step read
// "Not measured yet" and the count stayed one short. The integration record
// is a real merge made for this version of the change; it wins over an
// answer-less snapshot, and a real newer verdict still wins over it.
test('a clean merge check is not hidden by a later GitHub snapshot with no answer (#6550)', () => {
  const av = appView();
  const head = 'a'.repeat(40);
  const measuredAt = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const later = new Date(Date.now() - 60 * 1000).toISOString();
  const clean = {
    integration_merges_clean: true, integration_measured_at: measuredAt,
    integration_head_sha: head, reviewed_head_sha: head,
    freshness_checked_at: later, mergeability: 'unknown',
  };
  const fresh = av._freshnessOf(clean);
  assert.equal(fresh.mergeability, 'clean', 'the platform\'s own measured merge wins');
  assert.equal(fresh.checkedAt, measuredAt, 'and the line reports that measurement\'s age');

  // The gate is promoted, so the count moves on (3/5 becomes 4/5).
  const gates = av._withLiveState([
    { key: 'integration', state: 'pending' }, { key: 'checks', state: 'pending' },
  ], clean);
  assert.equal(gates[0].state, 'done', 'a clean measured merge completes the step');

  // The line names the verdict and when it was checked, on fresh and done gates.
  assert.equal(av._integrationLine({ state: 'pending' }, clean, null), 'No conflicts · measured 2 minutes ago');
  assert.equal(av._integrationLine({ state: 'done' }, clean, null), 'No conflicts · measured 2 minutes ago');

  // A check made before the change last moved does not count.
  const stale = av._freshnessOf({ ...clean, integration: { stale: true } });
  assert.equal(stale.mergeability, 'unknown');
  assert.equal(av._integrationLine({ state: 'pending' }, { ...clean, integration: { stale: true } }, null), 'Measuring…');
  const moved = av._freshnessOf({ ...clean, integration_head_sha: head, reviewed_head_sha: 'b'.repeat(40) });
  assert.equal(moved.mergeability, 'unknown', 'a measurement for an older head is not this change\'s');
  assert.equal(av._integrationLine({ state: 'pending' }, { ...clean, integration_head_sha: head, reviewed_head_sha: 'b'.repeat(40) }, null), 'Measuring…');

  // A newer GitHub snapshot WITH a verdict still wins.
  const githubConflict = av._freshnessOf({ ...clean, mergeability: 'conflict' });
  assert.equal(githubConflict.mergeability, 'conflict');
  const conflictLine = av._integrationLine({ state: 'pending' }, { ...clean, mergeability: 'conflict' }, null);
  assert.equal(conflictLine, 'Conflict with main · queued to fix · measured a minute ago');

  // A newer measurement by Homeroom itself wins, and the conflict carries its age.
  const ownConflict = {
    integration_merges_clean: false, integration_measured_at: later,
    integration_conflict_paths: ['src/a.js'],
    freshness_checked_at: measuredAt, mergeability: 'clean',
  };
  assert.equal(av._freshnessOf(ownConflict).mergeability, 'conflict');
  assert.equal(av._integrationLine({ state: 'pending' }, ownConflict, null),
    'Conflict in 1 file · queued to fix · measured a minute ago');

  // Nothing measured either way still reads "Measuring…", never "Not measured yet".
  assert.equal(av._freshnessOf({}).mergeability, null);
  assert.equal(av._integrationLine({ state: 'pending' }, {}, null), 'Measuring…');

  // The catalog and the line agree, and the retired wording is gone.
  const changes = JSON.parse(read('frontend/locales/en/changes.json'));
  assert.equal(changes['step.integration.clean'].text, 'No conflicts');
  assert.equal(changes['step.integration.measuring'].text, 'Measuring…');
  assert.equal(changes['step.integration.withAge'].text, '{{line}} · {{measured}}');
  assert.equal(changes['step.integration.notMeasured'], undefined, 'the stale wording is retired');
  const line = read('public/js/app-view.js').slice(
    read('public/js/app-view.js').indexOf('  _integrationLine(g, p, viewer) {'),
    read('public/js/app-view.js').indexOf('  INTEGRATION_LINE_IDS: {'));
  assert.doesNotMatch(line, /notMeasured/);
  assert.match(line, /step\.integration\.measuring/);
  assert.match(line, /step\.integration\.clean/);
  assert.match(line, /const conflict = \(ids\) => aged\(/);
});
