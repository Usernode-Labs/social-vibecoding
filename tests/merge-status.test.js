// #405: unit tests for the shared merge-lifecycle helper
// (public/js/merge-status.js). The helper is the single source of truth for
// a proposal's canonical merge state across the feed card, the home strip,
// and the dev session header — so its 11-state derivation precedence and its
// missing-vote-data fallback are the contract every surface relies on.
//
// merge-status.js is UMD (module.exports under Node), so it's required
// directly with no vm/sandbox harness.
//
// Run with: node --test tests/merge-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const MergeStatus = require('../public/js/merge-status.js');

// Convenience: derive just the canonical key.
const key = (p, opts) => MergeStatus.lifecycle(p, opts).key;

test('state 1 — merged outranks everything', () => {
  const life = MergeStatus.lifecycle({
    status: 'merged', check_state: 'failing', merge_conflict_state: 'failed',
    behind_main: 5, yes_count: 0, majority: 9,
  });
  assert.equal(life.key, 'merged');
  assert.equal(life.label, 'Merged');
  assert.equal(life.tone, 'violet');
  assert.equal(life.spinner, false);
});

test('state 2 — merging outranks behind_main / checks', () => {
  const life = MergeStatus.lifecycle({
    status: 'merging', behind_main: 3, check_state: 'failing',
  });
  assert.equal(life.key, 'merging');
  assert.equal(life.label, 'Merging…');
  assert.equal(life.tone, 'amber');
  assert.equal(life.spinner, true);
});

test('state 3 — resolving from persisted snapshot AND from the process-local flag', () => {
  assert.equal(key({ status: 'promoted', merge_conflict_state: 'resolving' }), 'resolving');
  assert.equal(key({ status: 'promoted', resolving: true }), 'resolving');
  const life = MergeStatus.lifecycle({ status: 'promoted', resolving: true });
  assert.equal(life.tone, 'amber');
  assert.equal(life.spinner, true);
});

test('state 4 — conflict_failed beats checks pending (precedence)', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', merge_conflict_state: 'failed', check_state: 'pending',
  });
  assert.equal(life.key, 'conflict_failed');
  assert.equal(life.tone, 'red');
});

test('state 5b — checks failing is amber, with failing-test count in the label', () => {
  const failing = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'failing',
    test_results: [
      { status: 'pass' }, { status: 'fail' }, { status: 'fail' },
    ],
  });
  assert.equal(failing.key, 'checks_failing');
  assert.equal(failing.label, 'Checks failing · 2');
  assert.equal(failing.tone, 'amber');
});

// #237: an 'error' check_state means the staging preview itself never booted,
// so no test ran — distinct from a test failure. It gets its own red
// "Preview won't boot" badge, and the captured reason rides in the tooltip.
test("state 5a — checks error renders a distinct red \"Preview won't boot\" badge", () => {
  const errored = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'error',
    check_error_detail: '[exited (exit=1)] error: no unique or exclusion constraint matching the ON CONFLICT specification',
  });
  assert.equal(errored.key, 'preview_failed');
  assert.equal(errored.label, "Preview won't boot");
  assert.equal(errored.tone, 'red');
  assert.match(errored.title, /ON CONFLICT/);

  // Without a captured reason it still resolves to the same badge, with a
  // generic tooltip.
  const bare = MergeStatus.lifecycle({ status: 'promoted', check_state: 'error' });
  assert.equal(bare.key, 'preview_failed');
  assert.equal(bare.tone, 'red');
});

test('state 6 — checks pending is neutral + spinner (not amber)', () => {
  const life = MergeStatus.lifecycle({ status: 'promoted', check_state: 'pending' });
  assert.equal(life.key, 'checks_running');
  assert.equal(life.label, 'Checks running…');
  assert.equal(life.tone, 'neutral');
  assert.equal(life.spinner, true);
});

test('state 6b — checks skipped (#461) is neutral, terminal (no spinner) and carries the reason', () => {
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'skipped',
    check_error_detail: 'branch has no commits beyond main — nothing to test',
  });
  assert.equal(life.key, 'checks_skipped');
  assert.equal(life.label, 'Checks skipped');
  assert.equal(life.tone, 'neutral');
  assert.equal(life.spinner, false);
  assert.ok(/nothing to test/.test(life.title), 'tooltip carries the recorded reason');
  assert.ok(/does not block/.test(life.title), 'tooltip says the merge is not blocked');
  // No recorded reason → generic non-blocking tooltip, never "undefined".
  const bare = MergeStatus.lifecycle({ status: 'promoted', check_state: 'skipped' });
  assert.equal(bare.key, 'checks_skipped');
  assert.ok(!/undefined/.test(bare.title));
});

test('state 6b — checks skipped outranks behind_main (precedence)', () => {
  // Per the #461 precedence, the explicit skipped verdict sits between the
  // pending rung and the behind-main rung.
  const life = MergeStatus.lifecycle({
    status: 'promoted', check_state: 'skipped', behind_main: 2,
  });
  assert.equal(life.key, 'checks_skipped');
});

test('state 7 — behind main, with the commit count in the label', () => {
  const life = MergeStatus.lifecycle({ status: 'promoted', behind_main: 4, check_state: 'passing' });
  assert.equal(life.key, 'behind');
  assert.equal(life.label, 'Behind main · 4');
  assert.equal(life.tone, 'amber');
  // A 'behind'/'conflict' snapshot with no count still resolves. (A
  // verdict is set — with none recorded the #607 checks-starting rung
  // would outrank behind, same as 'pending' does.)
  assert.equal(key({ status: 'promoted', merge_conflict_state: 'conflict', check_state: 'passing' }), 'behind');
});

test('state 8 — awaiting admin: locked + majority reached', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', yes_count: 5 },
    { majority: 3, locked: true }
  );
  assert.equal(life.key, 'awaiting_admin');
  assert.equal(life.tone, 'amber');
  // Not locked → falls through to ready.
  assert.equal(
    key({ status: 'promoted', check_state: 'passing', yes_count: 5 }, { majority: 3 }),
    'ready'
  );
});

test('state 9 — ready: passed the vote with green checks and not behind', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', behind_main: 0, yes_count: 3 },
    { majority: 3 }
  );
  assert.equal(life.key, 'ready');
  assert.equal(life.label, 'Passed — merging shortly');
  assert.equal(life.tone, 'green');
  // Past threshold but checks NOT passing → not ready (the gate blocks it).
  // #607: with no verdict recorded at all the row reads as checks-starting
  // (in progress), never falsely "ready".
  assert.equal(
    key({ status: 'promoted', check_state: null, yes_count: 9 }, { majority: 3 }),
    'checks_running'
  );
});

// #607: a promoted row with NO verdict recorded yet (fresh proposal whose
// first run hasn't stamped 'pending' — e.g. the promote-time staging build
// is still going) reads as checks-in-progress, not as a plain vote state.
// Rows carrying a console snapshot are genuine pre-#47 legacy and keep
// falling through.
test('state 6a (#607) — promoted with no verdict and no console snapshot reads as checks starting', () => {
  const life = MergeStatus.lifecycle({ status: 'promoted' });
  assert.equal(life.key, 'checks_running');
  assert.equal(life.label, 'Checks starting…');
  assert.equal(life.tone, 'neutral');
  assert.equal(life.spinner, true);
  // Legacy pre-#47 row (console snapshot recorded, no check_state) falls
  // through to the vote states as before.
  assert.equal(
    key({ status: 'promoted', console_check_state: 'clean', yes_count: 1 }, { majority: 3 }),
    'in_vote'
  );
});

test('state 10 — in vote (below majority)', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', yes_count: 1 },
    { majority: 3 }
  );
  assert.equal(life.key, 'in_vote');
  assert.equal(life.label, 'In vote');
  assert.equal(life.tone, 'violet');
  // votes ride along for the pill renderer.
  assert.deepEqual(life.votes, { yes: 1, majority: 3, reached: false });
});

test('state 11 — draft (active, not yet proposed)', () => {
  const life = MergeStatus.lifecycle({ status: 'active' });
  assert.equal(life.key, 'draft');
  assert.equal(life.label, 'Draft');
  assert.equal(life.tone, 'neutral');
});

test('missing vote data → in_vote stays tally-free (never falsely "ready")', () => {
  // No yes_count: a promoted+passing row with unknown votes must not be
  // treated as past-threshold. It reads as plain "In vote".
  const life = MergeStatus.lifecycle({ status: 'promoted', check_state: 'passing' });
  assert.equal(life.key, 'in_vote');
  assert.equal(life.votes, undefined);
});

test('unknown / non-merge status → none (no badge)', () => {
  assert.equal(key({ status: 'paused' }), 'none');
  assert.equal(key({ status: 'archived' }), 'none');
  assert.equal(key({}), 'none');
  assert.equal(MergeStatus.lifecycle({ status: 'paused' }).label, '');
});

test('badgeHtml: renders the label with the tone class + spinner; escapes the label', () => {
  const merging = MergeStatus.badgeHtml(MergeStatus.lifecycle({ status: 'merging' }));
  assert.match(merging, /ms-badge-amber/);
  assert.match(merging, /dc-status-spinner-arc/);
  assert.match(merging, /Merging…/);

  // 'none' renders nothing.
  assert.equal(MergeStatus.badgeHtml(MergeStatus.lifecycle({ status: 'paused' })), '');
});

test('pillHtml: in-vote pill appends the tally; badgeHtml does not', () => {
  const life = MergeStatus.lifecycle(
    { status: 'promoted', check_state: 'passing', yes_count: 2 },
    { majority: 5 }
  );
  const pill = MergeStatus.pillHtml(life);
  assert.match(pill, /ms-pill-violet/);
  assert.match(pill, /In vote · 2\/5/);
  // The text-style badge stays compact (the surfaces that use it show a
  // separate vote pill), so it must NOT carry the tally.
  assert.match(MergeStatus.badgeHtml(life), /In vote/);
  assert.doesNotMatch(MergeStatus.badgeHtml(life), /2\/5/);
});

test('STATE_BADGE_KEYS covers the merge-pipeline / conflict / ready states only', () => {
  assert.deepEqual(
    MergeStatus.STATE_BADGE_KEYS.slice().sort(),
    ['behind', 'conflict_failed', 'merged', 'merging', 'ready', 'resolving'].sort()
  );
  // in_vote / draft / checks states are deliberately excluded (pill + the
  // dedicated checks badge cover them on the feed card).
  for (const k of ['in_vote', 'draft', 'checks_failing', 'checks_running', 'none']) {
    assert.ok(MergeStatus.STATE_BADGE_KEYS.indexOf(k) === -1, `${k} excluded`);
  }
});
