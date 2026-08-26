// Tests for the "How voting works" explainer's live status line
// (app-view.js AppView._votingHelpText). The line must describe the SAME
// situation the tally pill / countdown shows (voteCountPill), derived from
// the serialized gate fields the /promoted endpoint attaches
// (votes_required, merge_window_ends_at, reject_window_ends_at,
// rejection_armed, contested) plus status/check_state/behind_main. The
// regimes mirror stagingMockProposals() in src/routes/votes.js.
//
// Same vm-context harness as console-warning-card.test.js: load app-view.js
// into a sandbox, stub the globals it reaches, assert on the returned text.
//
// Run with: node --test tests/voting-help-text.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'),
  'utf8'
);
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeAppView(ctx) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
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
  AppView._proposalsCtx = ctx || { majority: 3, activeUsers: 5, locked: false };
  return AppView;
}

const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

const base = (over) => ({
  id: 7, status: 'promoted', yes_count: 0, no_count: 0,
  votes_required: 3, contested: false, rejection_armed: false,
  merge_window_ends_at: null, reject_window_ends_at: null,
  check_state: 'passing', behind_main: 0, merge_conflict_state: null,
  ...over,
});

test('below threshold, no window → "needs N of M active testers" with tally', () => {
  const AppView = makeAppView({ majority: 3, activeUsers: 5 });
  const txt = AppView._votingHelpText(base({ yes_count: 0, no_count: 0, votes_required: 3 }));
  assert.match(txt, /needs 3 of 5 active testers to vote Yes/);
  assert.match(txt, /Currently 0 Yes, 0 No\./);
});

test('threshold met + visibility window running → "merges in ~X unless someone objects"', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 2, no_count: 0, votes_required: 2, merge_window_ends_at: hoursAhead(5),
  }));
  assert.match(txt, /enough Yes votes \(2 of 2\)/);
  assert.match(txt, /merges in ~/);
  assert.match(txt, /unless someone objects/);
});

test('lazy consensus (below threshold, unopposed) → "silence counts as agreement"', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 1, no_count: 0, votes_required: 2, merge_window_ends_at: hoursAhead(67),
  }));
  assert.match(txt, /has support \(1 of 2 needed\)/);
  assert.match(txt, /silence counts as agreement/);
});

test('rejection armed → "More No than Yes ... closes in ~X"', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 2, no_count: 3, votes_required: 6,
    rejection_armed: true, reject_window_ends_at: hoursAhead(140),
  }));
  assert.match(txt, /More No than Yes/);
  assert.match(txt, /closes in ~/);
});

test('contested → needs a clear majority, timed path off', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 4, no_count: 3, votes_required: 6, contested: true,
  }));
  assert.match(txt, /contested/i);
  assert.match(txt, /clear majority/);
});

test('reached + green checks, no window → "queued to merge shortly"', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 9, no_count: 0, votes_required: 9, check_state: 'passing',
  }));
  assert.match(txt, /votes it needs \(9 of 9\)/);
  assert.match(txt, /Queued to merge shortly/);
});

test('reached but checks still running → folds the checks blocker in', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 9, no_count: 0, votes_required: 9, check_state: 'pending',
  }));
  assert.match(txt, /enough Yes votes \(9 of 9\)/);
  assert.match(txt, /can’t merge yet/);
  assert.match(txt, /still running/);
  assert.doesNotMatch(txt, /Queued to merge shortly/);
});

test('reached but behind main → folds the behind-main blocker in', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 5, no_count: 0, votes_required: 3, behind_main: 2,
  }));
  assert.match(txt, /behind the main app/);
});

test('countdown running with a failing check → appends a blocker note', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText(base({
    yes_count: 2, no_count: 0, votes_required: 2,
    merge_window_ends_at: hoursAhead(5), check_state: 'failing',
  }));
  assert.match(txt, /merges in ~/);
  assert.match(txt, /Note: its automated checks are failing/);
});

test('locked app + reached → notes the admin-yes requirement', () => {
  const AppView = makeAppView({ majority: 3, activeUsers: 5, locked: true });
  const txt = AppView._votingHelpText(base({
    yes_count: 9, no_count: 0, votes_required: 9, check_state: 'passing',
  }));
  assert.match(txt, /admin’s Yes/);
});

test('merged / merging short-circuit to their terminal lines', () => {
  const AppView = makeAppView();
  assert.match(AppView._votingHelpText(base({ status: 'merged' })), /already merged/);
  assert.match(AppView._votingHelpText(base({ status: 'merging' })), /being merged into the app right now/);
});

test('missing row returns empty string', () => {
  const AppView = makeAppView();
  assert.equal(AppView._votingHelpText(null), '');
});
