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

test('check_state="passing" renders a green checks-passing badge', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ check_state: 'passing', test_results: [] }));
  assert.match(html, /Checks passing/);
});

test('check_state="failing" renders an amber badge with the failing count', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    check_state: 'failing',
    test_results: [
      { name: 'Home', path: '/', status: 'pass' },
      { name: 'Feed', path: '/feed', status: 'fail', failureReason: 'boom' },
      { name: 'Board', path: '/board', status: 'fail', failureReason: 'missing' },
    ],
  }));
  assert.match(html, /gc-warning-badge/);
  assert.match(html, /Checks failing · 2/);
});

test('check_state="pending" renders a running badge', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ check_state: 'pending', test_results: [] }));
  assert.match(html, /Checks running/);
});

test('check_state="error" renders a red "couldn\'t run" badge', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ check_state: 'error', test_results: [] }));
  assert.match(html, /Checks couldn/);
  assert.match(html, /gc-conflict-badge/);
});

test('a legacy row (no check_state) falls back to the advisory console badge', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    console_check_state: 'errors',
    console_errors: [{ kind: 'console', message: 'oops' }],
  }));
  assert.match(html, /gc-warning-badge/);
  assert.match(html, /Console errors/);
});

test('the checks detail lists per-test rows with failure reasons', () => {
  const AppView = makeAppView(ME);
  const html = AppView._checksDetailHtml(baseProposal({
    check_state: 'failing',
    checks_checked_at: '2026-06-01T00:00:00Z',
    test_results: [
      { name: 'Home loads', path: '/', status: 'pass', consoleErrors: [], failureReason: '' },
      { name: 'Feed renders', path: '/feed', status: 'fail', failureReason: '1 console error on load', consoleErrors: [{ kind: 'pageerror', message: 'TypeError: x', source: 'a.js:1' }] },
    ],
  }));
  assert.match(html, /merge is blocked/);
  assert.match(html, /Home loads/);
  assert.match(html, /Feed renders/);
  assert.match(html, /1 console error on load/);
  assert.match(html, /TypeError: x/);
  assert.match(html, /Last checked/);
});

test('the checks detail shows a "couldn\'t run" block for error state', () => {
  const AppView = makeAppView(ME);
  const html = AppView._checksDetailHtml(baseProposal({ check_state: 'error', test_results: [] }));
  assert.match(html, /couldn't run/);
});

test('passing with no result detail renders nothing (the green badge is enough)', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._checksDetailHtml(baseProposal({ check_state: 'passing', test_results: [] })), '');
});

// #461: an explicit terminal 'skipped' verdict renders a grey, non-blocking
// badge + detail carrying the recorded reason, with the manual re-run still
// offered so an owner/admin can force a real run.
test('check_state="skipped" renders a grey non-blocking badge with the reason', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    check_state: 'skipped', test_results: [],
    check_error_detail: 'branch has no commits beyond main — nothing to test',
  }));
  assert.match(html, /Checks skipped/);
  assert.match(html, /gc-checks-running-badge/);
  assert.match(html, /does not block the merge/);
  assert.doesNotMatch(html, /dc-status-spinner-arc.*Checks skipped/);
});

test('the checks detail shows a skipped block with the reason and the re-run button for the owner', () => {
  const AppView = makeAppView(ME);
  const html = AppView._checksDetailHtml(baseProposal({
    check_state: 'skipped', test_results: [], user_id: ME,
    check_error_detail: 'branch has no commits beyond main — nothing to test',
  }));
  assert.match(html, /Checks skipped/);
  assert.match(html, /nothing to test/);
  assert.match(html, /does not block the merge/);
  assert.match(html, /Re-run checks/);
});

// #607: a fresh proposal with NOTHING recorded yet (no check_state, no
// console snapshot — the first run hasn't stamped 'pending') shows an
// explicit in-progress state instead of silence / a bare re-run button.
test('a fresh row with no verdict renders the "Checks starting…" spinner badge', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({}));
  assert.match(html, /Checks starting/);
  assert.match(html, /dc-status-spinner-arc/);
});

test('a fresh-NULL detail shows "Checks are starting…" with NO re-run button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._checksDetailHtml(baseProposal({
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
  const html = AppView._checksDetailHtml(baseProposal({ user_id: ME }));
  assert.match(html, /Checks are starting/);
  assert.match(html, /Re-run checks/);
});

test('a FRESH pending run shows the spinner + started line and hides the re-run button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._checksDetailHtml(baseProposal({
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
  const html = AppView._checksDetailHtml(baseProposal({
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
  const html = AppView._checksDetailHtml(baseProposal({
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
    const html = AppView._checksDetailHtml(baseProposal({
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
  const html = AppView._checksDetailHtml(baseProposal({
    user_id: ME, check_state: 'pending', check_phase: 'building', test_results: [],
    checks_checked_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
  }));
  assert.match(html, /Preparing the staging preview/);
  assert.match(html, /Re-run checks/);
});

test('a STALE pending run (past the 10-min window) still offers the re-run button', () => {
  const AppView = makeAppView(ME);
  const html = AppView._checksDetailHtml(baseProposal({
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
  const html = AppView._recheckBtnHtml(pr);
  assert.match(html, /Re-running…/);
  assert.match(html, /disabled/);
  assert.doesNotMatch(html, /castRecheck/);
});

test('_proposalPinRank pins failing/error proposals above ordinary ones', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._proposalPinRank(baseProposal({ status: 'merging' })), 0);
  assert.equal(AppView._proposalPinRank(baseProposal({ merge_conflict_state: 'failed' })), 2);
  assert.equal(AppView._proposalPinRank(baseProposal({ check_state: 'failing' })), 3);
  assert.equal(AppView._proposalPinRank(baseProposal({ check_state: 'error' })), 3);
  // A passing / pending / skipped proposal is not pinned by checks —
  // 'skipped' (#461) is not a problem state.
  assert.equal(AppView._proposalPinRank(baseProposal({ check_state: 'passing' })), 4);
  assert.equal(AppView._proposalPinRank(baseProposal({ check_state: 'pending' })), 4);
  assert.equal(AppView._proposalPinRank(baseProposal({ check_state: 'skipped' })), 4);
});
