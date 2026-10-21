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

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { admission } = require('../src/workflow/merge-queue/machine.ts');

const candidate = (over = {}) => ({
  forkHead: false, gaveUp: null, head: 'a'.repeat(40), integrationMain: 'b'.repeat(40), backoffUntil: 0,
  unmergeable: null, approved: true, forced: false, resolutionSpent: false, ...over,
});

test('the lane declines a head whose checks fail or could not run, and writes that on the row', () => {
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_failing' }), Date.now()), { admit: false, reason: 'checks_failing' });
  assert.deepEqual(admission(candidate({ unmergeable: 'checks_error' }), Date.now()), { admit: false, reason: 'checks_error' });
  assert.deepEqual(admission(candidate(), Date.now()), { admit: true, reason: 'approved' });
  const src = read('src/workflow/merge-queue/machine.ts');
  assert.match(src, /const LANE_REASONS: ReadonlySet<string> = new Set\(\['awaiting_approval', 'unresolvable', 'fork_head', 'checks_failing', 'checks_error'\]\);/,
    'a declined head\'s reason reaches the card only through LANE_REASONS');
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
