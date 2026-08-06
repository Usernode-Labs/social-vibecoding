// Tests for the #381 console-error warning on the proposal card
// (app-view.js consoleWarningBadgeHtml + _renderProposalCard render slot +
// _consoleCheckDetailHtml). The amber "⚠ Console errors" badge must render
// when console_check_state === 'errors', stay absent for 'clean'/'unknown'/
// missing, and render ALONGSIDE a merge-state badge rather than replacing
// it. The detail block lists the captured messages.
//
// Same vm-context harness as archive-proposal-card.test.js: load app-view.js
// into a sandbox, stub the globals it reaches, assert on the returned HTML.
//
// Run with: node --test tests/console-warning-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// #405: the proposal card's merge-state badge is driven by window.MergeStatus;
// load it into the sandbox first (mirrors index.html's load order).
const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'),
  'utf8'
);
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

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
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
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

test('console_check_state="errors" renders the amber warning badge with a count', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    console_check_state: 'errors',
    console_errors: [{ kind: 'pageerror', message: 'boom' }, { kind: 'console', message: 'splat' }],
  }));
  assert.match(html, /gc-vote-count-attention/, 'advisory ATTENTION tone in the pill');
  assert.match(html, /Console errors · 2/, 'shows the error count');
  assert.match(html, /may break the app/, 'tooltip explains the risk');
});

test('console_check_state="clean" renders NO warning badge', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({ console_check_state: 'clean', console_errors: [] }));
  assert.doesNotMatch(html, /gc-warning-badge/, 'clean proposal has no warning');
});

test('console_check_state="unknown" / missing renders NO warning badge', () => {
  const AppView = makeAppView(ME);
  assert.doesNotMatch(
    AppView._renderProposalCard(baseProposal({ console_check_state: 'unknown' })),
    /gc-warning-badge/, 'unknown state shows nothing'
  );
  assert.doesNotMatch(
    AppView._renderProposalCard(baseProposal()),
    /gc-warning-badge/, 'absent state shows nothing'
  );
});

test('two reasons at once: the pill names the worst and counts the rest', () => {
  const AppView = makeAppView(ME);
  // This card used to render "Behind main · 3" AND "⚠ Console errors · 1"
  // side by side, leaving the reader to work out that both applied. Now the
  // pill names the most severe one and its tooltip says how many more there
  // are; the detail view enumerates every one of them.
  const pr = baseProposal({
    behind_main: 3,
    console_check_state: 'errors',
    console_errors: [{ kind: 'console', message: 'oops' }],
  });
  const html = AppView._renderProposalCard(pr);
  assert.match(html, /Behind main · 3/, 'the worst reason is the pill label');
  assert.match(html, /and 1 more reason — open for details/, 'the rest are counted, not hidden');
  assert.doesNotMatch(html, /gc-warning-badge/, 'no second badge stacked beside it');

  // blockReasons is the shared source of truth for both.
  const reasons = AppView.blockReasons(pr);
  assert.equal(reasons.length, 2);
  assert.equal(reasons.map((r) => r.key).join(','), 'behind,console_errors');

  const detail = AppView._detailActionsHtml('proposal', pr);
  assert.match(detail, /Worth knowing before you vote/, 'neither reason blocks, so the heading says so');
  assert.match(detail, /Behind main · 3/);
  assert.match(detail, /Console errors · 1/);
});

test('a HARD reason beside a soft one: the heading names the block', () => {
  const AppView = makeAppView(ME);
  const pr = baseProposal({
    behind_main: 2,
    check_state: 'failing',
    test_results: [{ name: 'Feed', path: '/feed', status: 'fail' }],
    console_check_state: 'errors',
    console_errors: [{ kind: 'console', message: 'oops' }],
  });
  const html = AppView._renderProposalCard(pr);
  assert.match(html, /Checks failing · 1/, 'the hard reason wins the label');
  assert.match(html, /gc-vote-count-blocked/);
  assert.match(html, /and 2 more reasons/);
  const detail = AppView._detailActionsHtml('proposal', pr);
  assert.match(detail, /Why this can’t merge yet/);
  assert.match(detail, /Checks failing · 1[\s\S]*Behind main · 2[\s\S]*Console errors · 1/,
    'enumerated severity-first');
});

test('the console-error detail block lists the captured messages', () => {
  const AppView = makeAppView(ME);
  const html = AppView._consoleCheckDetailHtml(baseProposal({
    console_check_state: 'errors',
    console_checked_at: '2026-06-01T00:00:00Z',
    console_errors: [{ kind: 'pageerror', message: "TypeError: x is undefined", source: 'app.js:1' }],
  }));
  assert.match(html, /may break the app/, 'heading present');
  assert.match(html, /TypeError: x is undefined/, 'error message listed');
  assert.match(html, /app\.js:1/, 'source listed');
  assert.match(html, /Last checked/, 'checked-at shown');
});

test('the detail block is empty for a clean proposal', () => {
  const AppView = makeAppView(ME);
  assert.equal(AppView._consoleCheckDetailHtml(baseProposal({ console_check_state: 'clean' })), '');
});
