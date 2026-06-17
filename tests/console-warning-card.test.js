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

test('console_check_state="errors" renders the amber warning badge with a count', () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    console_check_state: 'errors',
    console_errors: [{ kind: 'pageerror', message: 'boom' }, { kind: 'console', message: 'splat' }],
  }));
  assert.match(html, /gc-warning-badge/, 'warning badge class present');
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

test('warning badge renders ALONGSIDE a merge-state badge, not instead of it', () => {
  const AppView = makeAppView(ME);
  // behind_main drives the amber "Behind main" badge; the console warning
  // is independent and must also appear.
  const html = AppView._renderProposalCard(baseProposal({
    behind_main: 3,
    console_check_state: 'errors',
    console_errors: [{ kind: 'console', message: 'oops' }],
  }));
  assert.match(html, /Behind main · 3/, 'merge-state badge still present');
  assert.match(html, /gc-warning-badge/, 'console warning present too');
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
