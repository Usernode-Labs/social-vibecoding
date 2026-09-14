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
const { consoleCheckHtml, detailActionsHtml, proposalCardHtml } = require('./lib/dev-card-html');

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

test('console_check_state="errors" draws NO tag on the card (#2038)', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    console_check_state: 'errors',
    console_errors: [{ kind: 'pageerror', message: 'boom' }, { kind: 'console', message: 'splat' }],
  }));
  // Console errors already BLOCK. services/visuals.js classifyTests puts "a
  // blocking check had console errors" straight into check_state 'failing',
  // which draws its own red tag and which the merge gate refuses.
  //
  // console_check_state measures the same class of problem on a DIFFERENT
  // target set — the screenshot capture routes rather than the declared
  // dapp.json checks — so drawing it too meant one card carrying two tags
  // about console errors, one red and blocking, one amber and not. The
  // column and its messages are kept; the detail view is where an advisory
  // reading belongs, and it still enumerates them.
  assert.doesNotMatch(html, /Console errors/, 'no second tag about console errors');
  assert.equal(AppView.blockReasons(baseProposal({
    console_check_state: 'errors', console_errors: [{ message: 'x' }],
  })).length, 0, 'and no reason either');
});

test('console_check_state="clean" renders NO warning badge', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ console_check_state: 'clean', console_errors: [] }));
  assert.doesNotMatch(html, /gc-warning-badge/, 'clean proposal has no warning');
});

test('console_check_state="unknown" / missing renders NO warning badge', () => {
  const AppView = makeAppView(ME);
  assert.doesNotMatch(
    proposalCardHtml(AppView, baseProposal({ console_check_state: 'unknown' })),
    /gc-warning-badge/, 'unknown state shows nothing'
  );
  assert.doesNotMatch(
    proposalCardHtml(AppView, baseProposal()),
    /gc-warning-badge/, 'absent state shows nothing'
  );
});

test('two reasons at once: both are tags, and neither is the bar', () => {
  const AppView = makeAppView(ME);
  // A LOOP worth recording, because this test has now argued both sides.
  // Originally the card rendered "Behind main · 3" AND "Console errors · 1"
  // side by side, and this test was written to retire that: the reader was
  // left to work out that both applied, so the pill took the worst one and
  // counted the rest in its tooltip.
  //
  // That fixed the ambiguity by removing information, and it cost the bar:
  // whatever was most wrong took the slot the VOTE needed. So the two facts
  // are side by side again — but they are tags now, off the bar and tinted
  // by severity, which is the part the first arrangement was missing. The
  // reader is not asked to work out that both apply; the colours say which
  // one stops it landing.
  const pr = baseProposal({
    behind_main: 3,
    console_check_state: 'errors',
    console_errors: [{ kind: 'console', message: 'oops' }],
  });
  const html = proposalCardHtml(AppView, pr);
  assert.match(html, /<span class="dev-badge [^"]*amber[^"]*"[^>]*>Behind main · 3<\/span>/);
  assert.doesNotMatch(html, /and 1 more reason, open for details/,
    'nothing is hidden behind a tooltip count any more');
  // #2038: the console errors are no longer one of the reasons.
  assert.equal(AppView.blockReasons(pr).length, 1);
});

test('a HARD reason beside soft ones: red first, then amber, and the bar counts votes', () => {
  const AppView = makeAppView(ME);
  const pr = baseProposal({
    behind_main: 2,
    check_state: 'failing',
    test_results: [{ name: 'Feed', path: '/feed', status: 'fail' }],
    console_check_state: 'errors',
    console_errors: [{ kind: 'console', message: 'oops' }],
  });
  const html = proposalCardHtml(AppView, pr);
  // Severity-ordered: the blocking one is red and leads.
  assert.match(html, /<span class="dev-badge [^"]*red[^"]*"[^>]*>Checks failing · 1<\/span>/);
  assert.ok(html.indexOf('Checks failing · 1') < html.indexOf('Behind main · 2'),
    'the block leads the line');
  // The bar is no longer blocked-toned — it is the vote.
  assert.doesNotMatch(html, /gc-vote-count-blocked/);
  // The detail view is untouched: same heading, same severity-first order.
  const reasonsView = AppView._detailActionsView('proposal', pr).reasons;
  assert.equal(reasonsView.heading, 'Why this can’t merge yet');
  assert.equal(reasonsView.items.map((r) => r.label).join('|'), 'Checks failing · 1|Behind main · 2',
    'enumerated severity-first');
});

test('the console-error detail block lists the captured messages', () => {
  const AppView = makeAppView(ME);
  const html = consoleCheckHtml(AppView, baseProposal({
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
  assert.equal(consoleCheckHtml(AppView, baseProposal({ console_check_state: 'clean' })), '');
});
