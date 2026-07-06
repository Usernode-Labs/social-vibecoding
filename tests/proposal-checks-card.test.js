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
