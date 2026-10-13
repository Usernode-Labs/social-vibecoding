// #788: UI-string tests for how an "explicit approval" proposal renders
// — the amber chip, the SUPPRESSED merge countdown, the retained
// rejection countdown, the help-text clause, and the hidden Admin-merge
// button for a non-platform app admin — plus the reason-aware copy and
// the member floor ("A Yes from another member"), with the browser's
// copy held to the server's (src/services/explicit-approval.js).
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
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
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
  assert.match(pill, /won(&#39;|'|’)t merge on a timer/);
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
  assert.match(plain, /Goes live in/, 'precondition: unflagged, this row counts down');

  const flagged = AppView.voteCountPill(lazyRow({ requires_explicit_approval: true }), 3);
  assert.doesNotMatch(flagged, /Goes live in/);
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
  assert.match(pill, /Set aside in/);
  assert.match(pill, /gc-reject-countdown/);
  assert.match(pill, /gc-vote-explicit/, 'the chip rides along');
});

// ── Help text ─────────────────────────────────────────────────────────

test('_votingHelpText: default regime, below threshold — no countdown, explains the rule', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText(lazyRow({ requires_explicit_approval: true }));
  assert.doesNotMatch(s, /goes live in/i);
  assert.doesNotMatch(s, /quiet is taken as a nod/i);
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
  assert.match(s, /Queued to merge shortly/);
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
  assert.match(s, /set aside in/);
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
  assert.match(s, /goes live in/i, 'the ordinary lazy-consensus copy still appears');
  assert.doesNotMatch(s, /won’t merge on a timer/);
});

// ── MergeStatus ───────────────────────────────────────────────────────

test('MergeStatus.lifecycle: a flagged in-vote row keeps its state + gains the flag', () => {
  const sandbox = { console };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
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
    check_state: 'passing', requires_explicit_approval: true, explicit_approval_reason: 'admins',
    needs_other_member_yes: true, other_member_yes_count: 0,
  });
  assert.match(html, /Changes to who runs this app need a Yes from another member\./);
  assert.match(html, /won&#x27;t merge on a timer/);
  assert.match(html, /needs 3 real Yes votes and has 1 so far/);
  assert.match(html, /can still be voted down/);
  assert.match(html, /text-amber-800/, 'amber styling, matching the locked note family');
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

test('_proposalDetailsHtml: the note names the reason, and says when only the member is missing', () => {
  const AppView = makeAppView();
  const html = detailsHtml(AppView, {
    id: 1, status: 'promoted', yes_count: 3, no_count: 0, votes_required: 3,
    check_state: 'passing', requires_explicit_approval: true, explicit_approval_reason: 'visibility',
    needs_other_member_yes: true, other_member_yes_count: 0,
  });
  assert.match(html, /Changes to who can see this app need a Yes from another member\./);
  assert.match(html, /has the Yes votes it needs \(3 of 3\), but none of them is from another member yet/);
  assert.doesNotMatch(html, /admins list/, 'no hard-coded admins copy');
});

test('_proposalDetailsHtml: a one-member community names the change without asking for a member', () => {
  const AppView = makeAppView();
  const html = detailsHtml(AppView, {
    id: 1, status: 'promoted', yes_count: 1, no_count: 0, votes_required: 1,
    check_state: 'passing', requires_explicit_approval: true, explicit_approval_reason: 'secrets',
    needs_other_member_yes: false, other_member_yes_count: 0,
  });
  assert.match(html, /It changes this app’s keys\./);
  assert.doesNotMatch(html, /another member/);
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

// ── Reason-aware copy (the member floor) ─────────────────────────────

const serverCopy = require('../src/services/explicit-approval');

test('the browser copy says exactly what the server says, for every reason', () => {
  const sandbox = { console };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC};globalThis.__MS = MergeStatus;`, sandbox);
  const MS = sandbox.__MS;
  for (const reason of [...serverCopy.REASONS, null, 'not-a-reason']) {
    const c = MS.explicitApprovalCopy(reason);
    assert.equal(c.sentence, serverCopy.reasonSentence(reason), `sentence for ${reason}`);
    assert.equal(c.line, serverCopy.reasonLine(reason), `line for ${reason}`);
    assert.equal(c.phrase, serverCopy.reasonPhrase(reason), `phrase for ${reason}`);
  }
});

test('the five reasons read in plain words', () => {
  assert.equal(serverCopy.reasonSentence('visibility'), 'Changes to who can see this app need a Yes from another member.');
  assert.equal(serverCopy.reasonSentence('governance'), 'Changes to how changes are approved need a Yes from another member.');
  assert.equal(serverCopy.reasonSentence('admins'), 'Changes to who runs this app need a Yes from another member.');
  assert.equal(serverCopy.reasonSentence('platform_env'), 'Changes to this app’s platform settings need a Yes from another member.');
  assert.equal(serverCopy.reasonSentence('secrets'), 'Changes to this app’s keys need a Yes from another member.');
  assert.equal(serverCopy.reasonSentence(null), 'This change needs a Yes from another member.');
  assert.equal(serverCopy.primaryReason(['secrets', 'visibility']), 'visibility');
  assert.equal(serverCopy.secretChangeReason(true), 'platform_env');
  assert.equal(serverCopy.secretChangeReason(false), 'secrets');
});

test('statusPillState: the lock carries the reason as its tooltip', () => {
  const AppView = makeAppView();
  const s = AppView.statusPillState({
    id: 1, status: 'promoted', yes_count: 1, no_count: 0, votes_required: 3, my_vote: 'yes',
    check_state: 'passing', requires_explicit_approval: true, explicit_approval_reason: 'visibility',
    needs_other_member_yes: true, other_member_yes_count: 0,
  });
  assert.equal(s.lock, true);
  assert.match(s.lockTitle, /^Changes to who can see this app need a Yes from another member\./);
  assert.match(s.lockTitle, /won’t merge on a timer/);
});

test('statusPillState: votes in but no other member yet is not a green pass', () => {
  const AppView = makeAppView();
  const row = {
    id: 1, status: 'promoted', yes_count: 1, no_count: 0, votes_required: 1, my_vote: 'yes',
    check_state: 'passing', requires_explicit_approval: true, explicit_approval_reason: 'governance',
    needs_other_member_yes: true, other_member_yes_count: 0,
  };
  // #3826: the wait gets words, not a bare count. The tally reads full, so
  // "1 / 1" in the pass tone read as a mistake; the pill now says what it
  // waits for, in the amber the conversation tier wears, with the reason
  // as its tooltip.
  const waiting = AppView.statusPillState(row);
  assert.equal(waiting.key, 'needs_member');
  assert.equal(waiting.label, 'Needs another member’s Yes · 1/1');
  assert.equal(waiting.tone, 'attention');
  assert.equal(waiting.title, 'Changes to how changes are approved need a Yes from another member.');
  const passed = AppView.statusPillState({ ...row, yes_count: 2, votes_required: 2, other_member_yes_count: 1 });
  assert.equal(passed.tone, 'ok');
  assert.equal(passed.key, 'tally');
});

test('voteCountPill: the chip tooltip names the reason', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill({
    status: 'promoted', yes_count: 1, no_count: 0, votes_required: 3,
    requires_explicit_approval: true, explicit_approval_reason: 'secrets', needs_other_member_yes: true,
  }, 3);
  assert.match(pill, /title="Changes to this app’s keys need a Yes from another member\./);
});

test('Admin merge tooltip names the change instead of saying admins', () => {
  const AppView = makeAppView({ user: { id: 1, isAdmin: true, canAdminWrite: true } });
  const html = AppView.voteButtonsHtml({
    id: 1, status: 'promoted', requires_explicit_approval: true, explicit_approval_reason: 'visibility',
  });
  assert.match(html, /title="Admin: merge this change to who can see this app right now, without the vote or another member’s Yes"/);
  assert.doesNotMatch(html, /admins-changing/);
  const plain = AppView.voteButtonsHtml({ id: 2, status: 'promoted' });
  assert.match(plain, /bypassing the vote majority/);
});

test('_votingHelpText: the reason leads the no-timer note, and the floor is a blocker', () => {
  const AppView = makeAppView();
  const s = AppView._votingHelpText({
    id: 1, status: 'promoted', yes_count: 3, no_count: 0, votes_required: 3,
    check_state: 'passing', requires_explicit_approval: true, explicit_approval_reason: 'visibility',
    needs_other_member_yes: true, other_member_yes_count: 0,
  });
  assert.match(s, /can’t merge yet: none of its Yes votes is from another member yet/);
  assert.doesNotMatch(s, /Queued to merge shortly/);
  assert.match(s, /Changes to who can see this app need a Yes from another member\. It won’t merge on a timer/);
});

test('the requirement row: "A Yes from another member", with the reason as its line', () => {
  const AppView = makeAppView();
  const line = AppView._stepLine(
    { key: 'explicit', label: 'A Yes from another member', state: 'waiting', detail: { reason: 'visibility' } },
    { requires_explicit_approval: true }, {}
  );
  assert.equal(line, 'It changes who can see this app');
  const done = AppView._stepLine(
    { key: 'explicit', label: 'A Yes from another member', state: 'done', detail: { reason: 'visibility' } },
    {}, {}
  );
  assert.equal(done, null, 'a met step says nothing');
  const legacy = AppView._stepLine(
    { key: 'explicit', state: 'waiting', detail: { source: 'live' } },
    { explicit_approval_reason: 'admins' }, {}
  );
  assert.equal(legacy, 'It changes who runs this app', 'a recording from before the reason falls back to the row');
});

test('MergeStatus.lifecycle: votes in, no other member yet, is its own state', () => {
  const sandbox = { console };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  sandbox.PlatformI18n = require('./lib/platform-i18n').englishPlatformI18n();
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC};globalThis.__MS = MergeStatus;`, sandbox);
  const MS = sandbox.__MS;
  const row = {
    status: 'promoted', yes_count: 1, votes_required: 1, check_state: 'passing',
    requires_explicit_approval: true, explicit_approval_reason: 'visibility',
    needs_other_member_yes: true, other_member_yes_count: 0,
  };
  const waiting = MS.lifecycle(row, {});
  assert.equal(waiting.key, 'awaiting_member');
  assert.equal(waiting.tone, 'amber');
  assert.equal(waiting.title, 'Changes to who can see this app need a Yes from another member.');
  assert.equal(MS.lifecycle({ ...row, other_member_yes_count: 1 }, {}).key, 'ready');
  assert.equal(MS.lifecycle({ ...row, needs_other_member_yes: false }, {}).key, 'ready',
    'a one-member community does not wait on anyone');
  const inVote = MS.lifecycle({ ...row, yes_count: 0 }, {});
  assert.equal(inVote.key, 'in_vote');
  assert.match(inVote.title, /^Changes to who can see this app need a Yes from another member\. It won’t merge on a timer/);
});
