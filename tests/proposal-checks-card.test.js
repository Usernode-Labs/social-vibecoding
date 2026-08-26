// #47 "CI for proposals": the checks badge + per-test detail + pin rank on
// the proposal card (app-view.js checksBadgeHtml / _checksDetailHtml /
// _proposalPinRank). The badge mirrors check_state (passing/failing/
// pending/error), the detail lists per-test pass/fail rows, and a
// failing/error proposal pins high in the feed. A legacy row with no
// check_state falls back to the advisory console badge.
//
// Same vm-context harness as console-warning-card.test.js.
//
// Run with: node --test tests/proposal-checks-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { actionHtml, checksHtml, proposalCardHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

function makeAppView(userId) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: userId } },
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

const ME = 42;
const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'someone',
  user_id: 999, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  ...over,
});

// The CARD folds checks into the composite status pill: green checks with a
// vote still running reads as the vote state, not as a redundant "✓ Checks
// passing" badge stacked beside the tally. The standalone badge helper is
// unchanged and still asserted below — it's what other surfaces render.
test('checksBadgeHtml: passing renders the OK-tone badge, not the merged violet', () => {
  const AppView = makeAppView(ME);
  const badge = AppView.checksBadgeHtml(baseProposal({ check_state: 'passing', test_results: [] }));
  assert.match(badge, /Checks passing/);
  // Its own class: sharing .gc-merged-badge is what made the PASSING badge
  // inherit the violet "Merged" colour.
  assert.match(badge, /gc-checks-passing-badge/);
  assert.doesNotMatch(badge, /gc-merged-badge/);
});

test('card: green checks + an open vote surface the vote state in the pill', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    check_state: 'passing', test_results: [], yes_count: 1, no_count: 0, my_vote: 'yes',
  }));
  assert.match(html, /dev-status-pill/, 'one composite pill');
  assert.doesNotMatch(html, /Checks passing/, 'nothing left to warn about, so nothing is said');
});

test('card: check_state="failing" is a BLOCKED pill, never a plain tally', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    check_state: 'failing',
    yes_count: 3, no_count: 0, votes_required: 3, my_vote: 'yes',
    test_results: [
      { name: 'Home', path: '/', status: 'pass' },
      { name: 'Feed', path: '/feed', status: 'fail', failureReason: 'boom' },
      { name: 'Board', path: '/board', status: 'fail', failureReason: 'missing' },
    ],
  }));
  // The whole point of the pill: even with the vote won, a proposal whose
  // tests fail must not read as a neutral "3 / 3".
  assert.match(html, /Checks failing · 2/);
  assert.match(html, /gc-vote-count-blocked/, 'blocked tone, not the advisory amber');
  assert.doesNotMatch(html, /gc-vote-count-label">3 \/ 3/);
});

test('checksBadgeHtml: failing carries the blocked tone (it gates the merge)', () => {
  const AppView = makeAppView(ME);
  const badge = AppView.checksBadgeHtml(baseProposal({
    check_state: 'failing',
    test_results: [{ name: 'Feed', path: '/feed', status: 'fail' }],
  }));
  assert.match(badge, /gc-blocked-badge/, 'failing blocks, so it is not the advisory amber');
  assert.match(badge, /Checks failing · 1/);
});

test('card: check_state="pending" renders the running pill', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ check_state: 'pending', test_results: [] }));
  assert.match(html, /Checks running/);
  assert.match(html, /dc-status-spinner-arc/, 'spinner inside the pill');
});

test('card: check_state="error" is a blocked pill naming the boot failure', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ check_state: 'error', test_results: [] }));
  assert.match(html, /Preview won/, 'the pill names WHY checks could not run');
  assert.match(html, /gc-vote-count-blocked/);
  // The standalone helper keeps its own wording for the other surfaces.
  assert.match(AppView.checksBadgeHtml(baseProposal({ check_state: 'error' })), /Checks couldn/);
});

test('a legacy row (no check_state) surfaces its console errors in the pill', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    console_check_state: 'errors',
    console_errors: [{ kind: 'console', message: 'oops' }],
  }));
  assert.match(html, /Console errors · 1/);
  // Advisory, so the ATTENTION tone — it never blocks the vote.
  assert.match(html, /gc-vote-count-attention/);
});

test('the checks detail lists per-test rows with failure reasons', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    check_state: 'failing',
    checks_checked_at: '2026-06-01T00:00:00Z',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
      { name: 'Feed renders', path: '/feed', status: 'fail', failureReason: '1 console error on load', consoleErrors: [{ kind: 'pageerror', message: 'TypeError: x', source: 'a.js:1' }] },
    ],
  }));
  assert.match(html, /Merge is blocked/);
  assert.match(html, /Home loads/);
  assert.match(html, /Feed renders/);
  assert.match(html, /1 console error on load/);
  assert.match(html, /TypeError: x/);
  assert.match(html, /Last checked/);
});

test('the checks detail shows a "couldn\'t run" block for error state', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({ check_state: 'error', test_results: [] }));
  // React escapes the apostrophe in text children.
  assert.match(html, /couldn&#x27;t run/);
});

test('passing with no result detail renders nothing (the green badge is enough)', () => {
  const AppView = makeAppView(ME);
  assert.equal(checksHtml(AppView, baseProposal({ check_state: 'passing', test_results: [] })), '');
});

// #461: an explicit terminal 'skipped' verdict renders a grey, non-blocking
// badge + detail carrying the recorded reason, with the manual re-run still
// offered so an owner/admin can force a real run.
test('checksBadgeHtml: "skipped" is grey, spinner-free and non-blocking', () => {
  const AppView = makeAppView(ME);
  const badge = AppView.checksBadgeHtml(baseProposal({
    check_state: 'skipped', test_results: [],
    check_error_detail: 'branch has no commits beyond main, so there is nothing to test',
  }));
  assert.match(badge, /Checks skipped/);
  assert.match(badge, /gc-checks-running-badge/);
  assert.match(badge, /does not block the merge/);
  assert.doesNotMatch(badge, /dc-status-spinner-arc/);
});

test('card: a skipped verdict blocks nothing, so the pill shows the vote state', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    check_state: 'skipped', test_results: [], my_vote: 'yes',
    yes_count: 1, no_count: 0, votes_required: 2,
    check_error_detail: 'branch has no commits beyond main, so there is nothing to test',
  }));
  assert.match(html, /dev-status-pill/);
  assert.match(html, /gc-vote-count-label">1 \/ 2/, 'skipped is terminal + non-blocking');
});

test('the checks detail shows a skipped block with the reason and the re-run button for the owner', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    check_state: 'skipped', test_results: [], user_id: ME,
    check_error_detail: 'branch has no commits beyond main, so there is nothing to test',
  }));
  assert.match(html, /Checks skipped/);
  assert.match(html, /nothing to test/);
  assert.match(html, /does not block the merge/);
  assert.match(html, /Re-run checks/);
});

// #607: a fresh proposal with NOTHING recorded yet (no check_state, no
// console snapshot — the first run hasn't stamped 'pending') shows an
// explicit in-progress state instead of silence / a bare re-run button.
test('card: a fresh row with no verdict renders the "Checks starting…" pill', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({}));
  assert.match(html, /Checks starting/);
  assert.match(html, /dc-status-spinner-arc/);
  assert.match(html, /dev-status-pill/, 'one pill, not a badge stacked beside a tally');
});

test('a fresh-NULL detail shows "Checks are starting…" with NO re-run button', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    user_id: ME,
    created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  }));
  assert.match(html, /Checks are starting/);
  assert.match(html, /dc-status-spinner-arc/);
  assert.doesNotMatch(html, /Re-run checks/);
});

test('a stale fresh-NULL row (old created_at) offers the re-run escape hatch to the owner', () => {
  const AppView = makeAppView(ME);
  // baseProposal's created_at is far in the past → past the 10-min window.
  const html = checksHtml(AppView, baseProposal({ user_id: ME }));
  assert.match(html, /Checks are starting/);
  assert.match(html, /Re-run checks/);
});

test('a FRESH pending run shows the spinner + started line and hides the re-run button', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    user_id: ME, check_state: 'pending', test_results: [],
    checks_checked_at: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  }));
  assert.match(html, /Checks are still running/);
  assert.match(html, /dc-status-spinner-arc/);
  assert.match(html, /Started .+\./); // relTime renders "2m ago" / "just now"
  assert.doesNotMatch(html, /Re-run checks/);
});

// The two stage captions. A checks run is two very differently-sized halves
// (build the branch + clone the app's data, then run the suite), and showing
// one opaque message for both made a mid-flight build look identical to a
// wedged one. The two tests above deliberately pass NO check_phase, so they
// are the NULL/legacy-wording guard.
test('a pending run in its BUILDING half names the preview-preparation stage', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    user_id: ME, check_state: 'pending', check_phase: 'building', test_results: [],
    checks_checked_at: new Date(Date.now() - 60 * 1000).toISOString(),
  }));
  assert.match(html, /Preparing the staging preview/);
  assert.doesNotMatch(html, /Checks are still running/);
  assert.match(html, /dc-status-spinner-arc/);
  // The surrounding affordances are untouched by the caption change.
  assert.match(html, /Merge is blocked until all tests pass/);
  assert.match(html, /Started .+\./);
});

test('a pending run in its TESTING half names the test stage', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    user_id: ME, check_state: 'pending', check_phase: 'testing', test_results: [],
    checks_checked_at: new Date(Date.now() - 60 * 1000).toISOString(),
  }));
  assert.match(html, /Running the automated tests/);
  assert.doesNotMatch(html, /Preparing the staging preview/);
  assert.match(html, /Merge is blocked until all tests pass/);
});

test('an unrecognised phase falls back to the previous wording verbatim', () => {
  // Legacy rows carry NULL; a typo or a value from a newer writer must not
  // render an unknown caption.
  const AppView = makeAppView(ME);
  for (const check_phase of [null, undefined, '', 'cloning', 'BUILDING', 42]) {
    const html = checksHtml(AppView, baseProposal({
      user_id: ME, check_state: 'pending', check_phase, test_results: [],
      checks_checked_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
    assert.match(html, /Checks are still running/, `phase ${JSON.stringify(check_phase)}`);
    assert.match(html, /The staging build is being tested/);
  }
});

test('the phase caption still renders the stale-run escape hatch', () => {
  // The phase is only the wording — the freshness gate that reveals "Re-run
  // checks" is unchanged, so a wedged BUILDING run is still recoverable.
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    user_id: ME, check_state: 'pending', check_phase: 'building', test_results: [],
    checks_checked_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  }));
  assert.match(html, /Preparing the staging preview/);
  assert.match(html, /Re-run checks/);
});

// #1144: WHY the run started. "Started 4 minutes ago" answers a different
// question from "who asked for this" — a run the platform kicked off for
// itself (boot reconcile, stuck sweep) reads as inexplicable churn without
// it, and someone who just pressed Re-run gets no confirmation that the run
// on screen is theirs.
test('a pending run names what triggered it, alongside the stage and the start time', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    user_id: ME, check_state: 'pending', check_phase: 'building',
    check_trigger: 'commit-push', test_results: [],
    checks_checked_at: new Date(Date.now() - 60 * 1000).toISOString(),
  }));
  assert.match(html, /Triggered by a new commit on this proposal\./);
  // The trigger is an ADDITION — it replaces neither the stage caption nor
  // the started-at line.
  assert.match(html, /Preparing the staging preview/);
  assert.match(html, /Started .+\./);
});

test('a platform-initiated run says so, rather than looking like unexplained churn', () => {
  const AppView = makeAppView(ME);
  for (const [trigger, copy] of [
    ['stuck-sweep', /Restarted automatically by the platform\./],
    ['boot-reconcile', /Restarted by the platform after it came back up\./],
    ['manual-recheck', /Triggered by someone asking for a re-run\./],
    ['promote-kick', /Triggered by this proposal being put to a vote\./],
  ]) {
    const html = checksHtml(AppView, baseProposal({
      user_id: ME, check_state: 'pending', check_trigger: trigger, test_results: [],
      checks_checked_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
    assert.match(html, copy, `trigger ${trigger}`);
  }
});

test('an unrecognised or absent trigger renders no caption at all', () => {
  // Every row written before #1144 carries NULL, and they far outnumber the
  // new ones — an "unknown" line on all of them would be worse than silence.
  const AppView = makeAppView(ME);
  for (const check_trigger of [null, undefined, '', 'capture', 'COMMIT-PUSH', 42]) {
    const html = checksHtml(AppView, baseProposal({
      user_id: ME, check_state: 'pending', check_trigger, test_results: [],
      checks_checked_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }));
    assert.doesNotMatch(html, /Triggered by|Restarted /, `trigger ${JSON.stringify(check_trigger)}`);
    assert.match(html, /Checks are still running/, 'the rest of the block is unchanged');
  }
});

test('a STALE pending run (past the 10-min window) still offers the re-run button', () => {
  const AppView = makeAppView(ME);
  const html = checksHtml(AppView, baseProposal({
    user_id: ME, check_state: 'pending', test_results: [],
    checks_checked_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  }));
  assert.match(html, /Checks are still running/);
  assert.match(html, /re-runs the checks automatically/);
  assert.match(html, /Re-run checks/);
});

// #607: a WS/poll-driven re-render mid-recheck must not resurrect an
// enabled button.
test('an in-flight recheck renders a disabled "Re-running…" button on re-render', () => {
  const AppView = makeAppView(ME);
  const pr = baseProposal({ user_id: ME, check_state: 'error', test_results: [] });
  AppView._recheckInFlight.add(pr.id);
  const a = AppView._recheckAction(pr);
  assert.match(actionHtml(a), /Re-running…/);
  assert.match(actionHtml(a), /disabled/);
  assert.equal(a.act, undefined, 'the disabled button dispatches nothing');
});

test('the board pins failing/error proposals above ordinary ones', () => {
  // #47 used to be asserted against AppView._proposalPinRank, which ordered
  // the retired List view's proposal group. THE UI OVERHAUL replaced that view
  // with the pure-recency Feed and removed the helper; the board is where
  // priority lives now, so the rule is asserted through _bucketDevItems's
  // In-review column instead — the surface a viewer actually reads it off.
  const AppView = makeAppView(ME);
  const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;
  // Authored newest-first so ONLY the pin can reorder them.
  const proposals = [
    baseProposal({ id: 1, check_state: 'passing', promoted_at: at(9), last_message_at: at(9) }),
    baseProposal({ id: 2, check_state: 'failing', promoted_at: at(2), last_message_at: at(2) }),
    baseProposal({ id: 3, merge_conflict_state: 'failed', promoted_at: at(3), last_message_at: at(3) }),
    baseProposal({ id: 4, status: 'merging', promoted_at: at(1), last_message_at: at(1) }),
  ];
  const buckets = AppView._bucketDevItems({
    issues: [], proposals, gov: [], merged: [], mySessions: [], sharedSessions: [],
  });
  assert.deepEqual(
    Array.from(buckets.inReview, (e) => e.item.id),
    [4, 3, 2, 1],
    'merging → conflict-failed → checks-failing → ordinary'
  );

  // A passing / pending / skipped proposal is not pinned by checks —
  // 'skipped' (#461) is not a problem state, so all three keep pure recency.
  const calm = AppView._bucketDevItems({
    issues: [],
    proposals: [
      baseProposal({ id: 10, check_state: 'skipped', promoted_at: at(1), last_message_at: at(1) }),
      baseProposal({ id: 11, check_state: 'pending', promoted_at: at(5), last_message_at: at(5) }),
      baseProposal({ id: 12, check_state: 'passing', promoted_at: at(3), last_message_at: at(3) }),
    ],
    gov: [], merged: [], mySessions: [], sharedSessions: [],
  });
  assert.deepEqual(Array.from(calm.inReview, (e) => e.item.id), [11, 12, 10]);
});
