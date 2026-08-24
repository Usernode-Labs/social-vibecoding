// #788: UI-string tests for how an "explicit approval" proposal renders
// — the amber chip, the SUPPRESSED merge countdown, the retained
// rejection countdown, the help-text clause, and the hidden Admin-merge
// button for a non-platform app admin.
//
// Same vm-context harness as tests/approver-advisory-ui.test.js: load
// merge-status.js + app-view.js into a sandbox, stub the globals they
// reach, assert on the returned HTML.
//
// Run with: node --test tests/explicit-approval-vote-panel.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { detailsHtml } = require('./lib/dev-card-html');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const MERGE_STATUS_SRC = read('merge-status.js');
const APP_VIEW_SRC = read('app-view.js');

function makeAppView(opts = {}) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: opts.user || { id: 1 } },
    Kudos: { renderButton: () => '' },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    location: { search: '' },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = Object.assign(
    { majority: 3, activeUsers: 5, locked: false }, opts.ctx || {}
  );
  return AppView;
}

const hoursAhead = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

// A row that WOULD show a countdown if it weren't flagged: below
// threshold, Yes leading, no opposition — the lazy-consensus shape.
const lazyRow = (extra) => Object.assign({
  id: 1, status: 'promoted', yes_count: 1, no_count: 0, votes_required: 3,
  merge_window_ends_at: hoursAhead(72), check_state: 'passing',
}, extra);

// ── The chip ──────────────────────────────────────────────────────────

test('voteCountPill: a flagged row renders the amber "Explicit approval" chip', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill(
    { status: 'promoted', yes_count: 1, no_count: 0, votes_required: 3, requires_explicit_approval: true }, 3
  );
  assert.match(pill, /gc-vote-explicit/);
  assert.match(pill, /Explicit approval/);
  assert.match(pill, /won&#39;t merge on a timer|won't merge on a timer/);
});

test('voteCountPill: an ordinary row renders no chip', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill(
    { status: 'promoted', yes_count: 1, no_count: 0, votes_required: 3 }, 3
  );
  assert.doesNotMatch(pill, /gc-vote-explicit/);
});

test('voteCountPill: the chip is suppressed on settled rows', () => {
  const AppView = makeAppView();
  for (const status of ['merged', 'merging']) {
    const pill = AppView.voteCountPill(
      { status, yes_count: 3, no_count: 0, votes_required: 3, requires_explicit_approval: true }, 3
    );
    assert.doesNotMatch(pill, /gc-vote-explicit/, `${status} rows are history`);
  }
});

// ── The suppressed merge countdown ────────────────────────────────────

test('voteCountPill: a flagged row never renders a merge countdown', () => {
  const AppView = makeAppView();
  // Same row twice — the only difference is the flag.
  const plain = AppView.voteCountPill(lazyRow(), 3);
  assert.match(plain, /Merging in/, 'precondition: unflagged, this row counts down');

  const flagged = AppView.voteCountPill(lazyRow({ requires_explicit_approval: true }), 3);
  assert.doesNotMatch(flagged, /Merging in/);
  assert.doesNotMatch(flagged, /gc-merge-countdown/);
  assert.match(flagged, /1 \/ 3/, 'it falls back to the ordinary tally');
});

test('voteCountPill: the tally denominator is the app’s NORMAL threshold', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill(
    { status: 'promoted', yes_count: 2, no_count: 0, votes_required: 4, requires_explicit_approval: true }, 4
  );
  assert.match(pill, /2 \/ 4/, 'the rule changes the clocks, not the threshold');
});

// ── The retained rejection countdown ──────────────────────────────────

test('voteCountPill: a flagged row STILL renders the rejection countdown', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill({
    status: 'promoted', yes_count: 0, no_count: 3, votes_required: 3,
    rejection_armed: true, reject_window_ends_at: hoursAhead(9),
    requires_explicit_approval: true,
  }, 3);
  assert.match(pill, /Rejecting in/);
  assert.match(pill, /gc-reject-countdown/);
  assert.match(pill, /gc-vote-explicit/, 'the chip rides along');
});

// ── Help text ─────────────────────────────────────────────────────────

test('_votingHelpText: default regime, below threshold — no countdown, explains the rule', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText(lazyRow({ requires_explicit_approval: true }));
  assert.doesNotMatch(s, /merges in/i);
  assert.doesNotMatch(s, /silence counts as agreement/);
  assert.match(s, /needs 3 actual Yes votes/);
  assert.match(s, /won’t merge on a timer/);
});

test('_votingHelpText: default regime, at threshold — queued, no window to wait out', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText({
    id: 1, status: 'promoted', yes_count: 3, no_count: 0, votes_required: 3,
    merge_window_ends_at: null, check_state: 'passing', requires_explicit_approval: true,
  });
  assert.match(s, /votes it needs \(3 of 3\)/);
  assert.match(s, /queued to merge shortly/);
});

test('_votingHelpText: a blocker still folds into the threshold-met sentence', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText({
    id: 1, status: 'promoted', yes_count: 3, no_count: 0, votes_required: 3,
    check_state: 'failing', requires_explicit_approval: true,
  });
  assert.match(s, /can’t merge yet/);
  assert.match(s, /automated checks are failing/);
});

test('_votingHelpText: the rejection countdown sentence still renders when flagged', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText({
    id: 1, status: 'promoted', yes_count: 0, no_count: 3, votes_required: 3,
    rejection_armed: true, reject_window_ends_at: hoursAhead(9),
    check_state: 'passing', requires_explicit_approval: true,
  });
  assert.match(s, /closes in/);
});

test('_votingHelpText: at-least-N regime keeps its own wording plus the note', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText({
    id: 1, status: 'promoted', yes_count: 1, no_count: 0, votes_required: 2,
    approvals_required: 2, approval_policy: 'anyone',
    check_state: 'passing', requires_explicit_approval: true,
  });
  assert.match(s, /requires at least 2 approvals/, 'the configured rule still leads');
  assert.match(s, /won’t merge on a timer/);
});

test('_votingHelpText: invited-approver regime keeps its footnote plus the note', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText({
    id: 1, status: 'promoted', yes_count: 3, no_count: 0,
    qualified_yes_count: 1, qualified_no_count: 0, votes_required: 2,
    approval_policy: 'invited', check_state: 'passing', requires_explicit_approval: true,
  });
  assert.match(s, /only approvers’ votes count/);
  assert.match(s, /won’t merge on a timer/);
});

test('_votingHelpText: an unflagged row is completely unchanged', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText(lazyRow());
  assert.match(s, /merges in/i, 'the ordinary lazy-consensus copy still appears');
  assert.doesNotMatch(s, /won’t merge on a timer/);
});

// ── MergeStatus ───────────────────────────────────────────────────────

test('MergeStatus.lifecycle: a flagged in-vote row keeps its state + gains the flag', () => {
  const sandbox = { console };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC};globalThis.__MS = MergeStatus;`, sandbox);
  const MS = sandbox.__MS;

  const flagged = MS.lifecycle(
    { status: 'promoted', yes_count: 1, check_state: 'passing', requires_explicit_approval: true },
    { majority: 3 }
  );
  assert.equal(flagged.key, 'in_vote', 'the threshold is unchanged, so the state is too');
  assert.equal(flagged.explicitApproval, true);
  assert.match(flagged.title, /won’t merge on a timer/);

  const plain = MS.lifecycle(
    { status: 'promoted', yes_count: 1, check_state: 'passing' }, { majority: 3 }
  );
  assert.equal(plain.key, 'in_vote');
  assert.equal(plain.explicitApproval, undefined);
  assert.equal(plain.title, undefined);
});

// ── Admin-merge affordance ────────────────────────────────────────────

test('voteButtonsHtml: a platform admin keeps Admin merge even on a flagged row', () => {
  const AppView = makeAppView({ user: { id: 1, isAdmin: true, canAdminWrite: true } });
  const html = AppView.voteButtonsHtml({ id: 1, status: 'promoted', requires_explicit_approval: true });
  assert.match(html, /Admin merge/);
});

test('voteButtonsHtml: an app admin gets Admin merge on an ordinary row', () => {
  const AppView = makeAppView({ user: { id: 2 }, ctx: { isAppAdmin: true } });
  const html = AppView.voteButtonsHtml({ id: 1, status: 'promoted' });
  assert.match(html, /Admin merge/);
});

test('voteButtonsHtml: an app admin LOSES Admin merge on a flagged row', () => {
  const AppView = makeAppView({ user: { id: 2 }, ctx: { isAppAdmin: true } });
  const html = AppView.voteButtonsHtml({ id: 1, status: 'promoted', requires_explicit_approval: true });
  assert.doesNotMatch(html, /Admin merge/,
    'an app admin must not be able to unilaterally add another admin');
});

test('voteButtonsHtml: an ordinary user never gets Admin merge', () => {
  const AppView = makeAppView({ user: { id: 3 } });
  assert.doesNotMatch(AppView.voteButtonsHtml({ id: 1, status: 'promoted' }), /Admin merge/);
});

// ── The inline details-block note ─────────────────────────────────────

test('_proposalDetailsHtml: a flagged row below threshold renders the amber note with M of N', () => {
  const AppView = makeAppView();
  const html = detailsHtml(AppView, {
    id: 1, status: 'promoted', yes_count: 1, no_count: 0, votes_required: 3,
    check_state: 'passing', requires_explicit_approval: true,
  });
  assert.match(html, /edits the app&#x27;s admins list/);
  assert.match(html, /won&#x27;t merge on a timer/);
  assert.match(html, /needs 3 real Yes votes and has 1 so far/);
  assert.match(html, /can still be voted down/);
  assert.match(html, /text-amber-600/, 'amber styling, matching the locked note family');
});

test('_proposalDetailsHtml: a flagged row at threshold says it will merge once gates clear', () => {
  const AppView = makeAppView();
  const html = detailsHtml(AppView, {
    id: 1, status: 'promoted', yes_count: 3, no_count: 0, votes_required: 3,
    check_state: 'passing', requires_explicit_approval: true,
  });
  assert.match(html, /has the Yes votes it needs \(3 of 3\)/);
  assert.match(html, /checks and conflict gates clear/);
});

test('_proposalDetailsHtml: qualified tallies and the ctx majority fallback drive the numbers', () => {
  const AppView = makeAppView({ ctx: { majority: 4 } });
  const html = detailsHtml(AppView, {
    id: 1, status: 'promoted', yes_count: 5, qualified_yes_count: 2, no_count: 0,
    votes_required: null, check_state: 'passing', requires_explicit_approval: true,
  });
  assert.match(html, /needs 4 real Yes votes and has 2 so far/,
    'qualified count beats the raw tally; ctx.majority backs a missing snapshot');
});

test('_proposalDetailsHtml: the note is absent on settled rows', () => {
  const AppView = makeAppView();
  for (const status of ['merged', 'merging']) {
    const html = detailsHtml(AppView, {
      id: 1, status, yes_count: 3, no_count: 0, votes_required: 3,
      requires_explicit_approval: true,
    });
    assert.doesNotMatch(html, /won't merge on a timer/, `${status} rows are history`);
  }
});

test('_proposalDetailsHtml: the note is absent on unflagged rows', () => {
  const AppView = makeAppView();
  const html = detailsHtml(AppView, {
    id: 1, status: 'promoted', yes_count: 1, no_count: 0, votes_required: 3,
    check_state: 'passing',
  });
  assert.doesNotMatch(html, /won't merge on a timer/);
  assert.doesNotMatch(html, /admins list/);
});
