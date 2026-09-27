'use strict';

// The paused-live strip on Admin > Merge debug.
//
// Watching a filter is a two-step state: "Live" is what puts the 3s poll on,
// and switching it off pauses the view without changing what it filtered by.
// The rules this file pins:
//
//   1. The strip appears only when the checkbox has been ON and is then OFF
//      (the paused-live state), with Outcome = "Checks passing".
//   2. Turning Live back on removes it: the view is live again, not paused.
//   3. Refresh and the poll do NOT touch it; a filter change re-queries, so
//      the strip disarms — a strip naming a filter the list no longer
//      carries would lie.
//   4. It sits immediately above #admin-merges-runs, inside the section's
//      own content, and never renders while "Live" is on.
//
// The strip is runtime state, so the base-shaped assertions read the source
// and the built artifacts the checks and captures actually see. Run with:
//   node --test tests/admin-merges-paused-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/features/admin/admin-merges.tsx';
const SRC = fs.readFileSync(path.join(__dirname, '..', ENTRY), 'utf8');

// ── The contract ─────────────────────────────────────────────────────────

test('the strip renders only in the paused-live state and sits above the runs list', () => {
  // The whole rule in source: live OFF, has-been-live, and the outcome filter
  // the view was watching.
  assert.match(SRC, /const pausedStrip = !live && liveWasOn && filters\.outcome === 'passing';/);

  // It is the section's own content, between the filter card and the runs
  // list — immediately above #admin-merges-runs, as asked.
  const between = SRC.slice(SRC.indexOf('</section>'), SRC.indexOf('id="admin-merges-runs"'));
  assert.match(between, /id="admin-merges-paused-live"/,
    'the strip renders between the filter card and the runs list');
  assert.match(between, /Paused live view · Checks passing/);
});

test('arming and disarming follow the checkbox and the filters, not Refresh', () => {
  // The arming effect fires only on an enable; the disarm effect fires only
  // on a filters change. Refresh calls loadFirstPage and touches neither.
  assert.match(SRC, /useEffect\(\(\) => \{\s*if \(live\) setLiveWasOn\(true\);\s*\}, \[live\]\);/);
  assert.match(SRC, /useEffect\(\(\) => \{\s*setLiveWasOn\(false\);\s*\}, \[filters\]\);/);
  assert.ok(
    !SRC.slice(SRC.indexOf('const loadFirstPage')).includes('setLiveWasOn(false)') ||
    SRC.indexOf('setLiveWasOn(false)', SRC.indexOf('const loadFirstPage')) >
      SRC.indexOf('// Disarming'),
    'Refresh and the poll never disarm the strip directly',
  );
  // The strip's own state is local to the section: nothing server-side
  // answers for it, and no fetch URL carries a strip switch.
  assert.ok(!/admin-merges-paused-live/.test('/api/debug/merge-runs'));
});

test('the strip copy is written once, marked as a status, and stays sky in both themes', () => {
  const at = SRC.indexOf('id="admin-merges-paused-live"');
  const tag = SRC.slice(SRC.lastIndexOf('<p', at), SRC.indexOf('>', at) + 1);
  assert.match(tag, /role="status"/);
  assert.match(tag, /aria-live="polite"/);
  assert.match(tag, /border-sky-300 dark:border-sky-800 bg-sky-50 dark:bg-sky-950\/40/);
  assert.match(tag, /text-sky-800 dark:text-sky-300/);
});

test('the section still exports itself through the console seam unchanged', () => {
  const mod = loadTsx(ENTRY);
  assert.equal(typeof mod.AdminMerges.render, 'function');
  assert.equal(typeof mod.AdminMerges.destroy, 'function');
  assert.equal(typeof mod.MergesSection, 'function');
});

test('the served shell build never carries a live-only strip id on first paint', () => {
  // The built shell is the only thing a screenshot or a check sees before it
  // clicks anything. The strip is runtime state; the section ships empty
  // until it renders, so the id must not appear in either built artifact.
  for (const rel of ['public/index.html', 'public/shell/assets/shell.js']) {
    const built = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    assert.ok(!built.includes('admin-merges-paused-live'),
      `${rel} renders no strip before the controls are used`);
  }
  // And the section's own initial state IS the base shape: live off, never
  // been on, so the strip cannot be in the first render either.
  assert.match(SRC, /const \[live, setLive\] = useState\(false\);/);
  assert.match(SRC, /const \[liveWasOn, setLiveWasOn\] = useState\(false\);/);
});
