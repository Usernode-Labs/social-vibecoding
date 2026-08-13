// #695: UI-string tests for the approver-vs-advisory vote rendering on
// invited-approver apps. The headline tally everywhere must be the
// QUALIFYING (approver-only) count, with the non-approver surplus rendered
// separately as a muted "+N advisory" chip / "Q✓ +A" button label — and
// none of it may appear on default-policy ('anyone') rows.
//
// Same vm-context harness as tests/voting-help-text.test.js: load
// merge-status.js + app-view.js (and home.js for the strip pill) into a
// sandbox, stub the globals they reach, assert on the returned HTML.
//
// Run with: node --test tests/approver-advisory-ui.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { runModules } = require('./helpers/bundle-module');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8');
const MERGE_STATUS_SRC = read('merge-status.js');
const APP_VIEW_SRC = read('app-view.js');
// #1079 chunk B moved this module into the React bundle (it is the same
// file — see the note at the top of it); only the path changed here.
const WORK_DRAWER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'work-drawer', 'work-drawer.js'), 'utf8');

// `opts.el` backs document.getElementById (the roster paints into it);
// `opts.fetchData` backs fetch().json() (the roster endpoint's payload).
function makeSandbox(opts = {}) {
  const sandbox = {
    console,
    relTime: () => 'just now',
    App: { user: { id: 1 } },
    Kudos: { renderButton: () => '' },
    document: {
      getElementById: () => opts.el || null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => (opts.fetchData || {}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function makeAppView(opts) {
  const sandbox = makeSandbox(opts);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 3, activeUsers: 5, locked: false };
  return AppView;
}

// work-drawer.js is a bundle module and imports the kit-surface seam, which a
// classic-script `runInContext` cannot compile — runModules rewrites the
// import into a read of the stub table and leaves the rest of the source
// alone. See tests/helpers/bundle-module.js.
function makeWorkDrawer(opts) {
  const sandbox = makeSandbox(opts);
  return runModules(
    sandbox,
    [['merge-status.js', MERGE_STATUS_SRC], ['work-drawer.js', WORK_DRAWER_SRC]],
    { tail: 'return WorkDrawer;' },
  );
}

// ── voteCountPill ────────────────────────────────────────────────────

test('voteCountPill: invited at-least row — approver-only pill + advisory chip', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill({
    status: 'promoted', yes_count: 2, no_count: 0,
    qualified_yes_count: 0, qualified_no_count: 0,
    approval_policy: 'invited', approvals_required: 1, votes_required: 1,
  }, 3);
  assert.match(pill, /0 of 1 approval/);
  assert.match(pill, /gc-vote-advisory/);
  assert.match(pill, /\+2 advisory/);
  assert.match(pill, /don't count toward merging/);
});

test('voteCountPill: invited default-clock row — qualified headline + advisory chip', () => {
  const AppView = makeAppView();
  const pill = AppView.voteCountPill({
    status: 'promoted', yes_count: 3, no_count: 0,
    qualified_yes_count: 1, qualified_no_count: 0,
    approval_policy: 'invited', votes_required: 2,
  }, 3);
  assert.match(pill, /1 \/ 2/);
  assert.match(pill, /\+2 advisory/);
});

test('voteCountPill: no advisory chip under the anyone policy or on settled rows', () => {
  const AppView = makeAppView();
  // Default policy: qualified == raw, nothing new renders.
  const anyone = AppView.voteCountPill({
    status: 'promoted', yes_count: 2, no_count: 0, votes_required: 3,
  }, 3);
  assert.doesNotMatch(anyone, /advisory/);
  // Merged rows keep the snapshot pill alone — history isn't re-litigated.
  const merged = AppView.voteCountPill({
    status: 'merged', yes_count: 3, no_count: 0,
    qualified_yes_count: 1, approval_policy: 'invited', votes_required: 2,
  }, 3);
  assert.doesNotMatch(merged, /advisory/);
});

// ── voteButtonsHtml / _voteBtnTally ──────────────────────────────────

test('voteButtonsHtml: invited rows split the button tallies into Q✓ +A', () => {
  const AppView = makeAppView();
  const btns = AppView.voteButtonsHtml({
    id: 5, status: 'promoted', my_vote: null, yes_count: 2, no_count: 1,
    qualified_yes_count: 0, qualified_no_count: 1,
    approval_policy: 'invited',
  });
  assert.match(btns, /Yes \(0✓ \+2\)/);
  // Advisory suffix omitted when the surplus is zero.
  assert.match(btns, /No \(1✓\)/);
  assert.match(btns, /advisory votes don't count toward merging/);
});

test('voteButtonsHtml: default-policy rows keep the raw totals unchanged', () => {
  const AppView = makeAppView();
  const btns = AppView.voteButtonsHtml({
    id: 5, status: 'promoted', my_vote: null, yes_count: 2, no_count: 0,
  });
  assert.match(btns, /Yes \(2\)/);
  assert.match(btns, /No \(0\)/);
  assert.doesNotMatch(btns, /✓/);
});

// ── _renderGovCard ───────────────────────────────────────────────────

test('_renderGovCard: threads the qualified fields into the pill and buttons', () => {
  const AppView = makeAppView();
  AppView.readOnly = false;
  const html = AppView._renderGovCard({
    id: 9, kind: 'secret_change', title: 'Set FOO_KEY',
    payload: { key: 'FOO_KEY', action: 'set', hasValue: true },
    created_by: 2, created_by_username: 'alice',
    created_at: new Date().toISOString(),
    up_count: 2, down_count: 0, my_vote: null, chat_count: 0,
    qualified_yes_count: 0, qualified_no_count: 0,
    approval_policy: 'invited', approvals_required: 1, votes_required: 1,
    contested: false,
  }, {});
  assert.match(html, /0 of 1 approval/);
  // The advisory surplus rides INSIDE the composite pill as a muted "+N"
  // suffix now, rather than as a separate chip beside it.
  assert.match(html, /gc-vote-count-suffix[^>]*>\+2</);
  assert.match(html, /Yes \(0✓ \+2\)/);
  assert.match(html, /No \(0✓\)/);
});

// ── _loadVoteRoster ──────────────────────────────────────────────────

test('_loadVoteRoster: invited roster splits the headline into Q✓ + A advisory', async () => {
  const el = { innerHTML: '', textContent: '' };
  const AppView = makeAppView({
    el,
    fetchData: { yes: ['alice', 'bob'], no: [], approvers: ['alice'] },
  });
  AppView._proposals = [];
  await AppView._loadVoteRoster(1);
  assert.match(el.innerHTML, /Yes \(1✓ \+ 1 advisory\):/);
  assert.match(el.innerHTML, /No \(0✓\):/);
  assert.match(el.innerHTML, /@alice&nbsp;✓/);
  assert.match(el.innerHTML, /only invited approvers/);
});

test('_loadVoteRoster: default policy keeps the plain totals', async () => {
  const el = { innerHTML: '', textContent: '' };
  const AppView = makeAppView({
    el,
    fetchData: { yes: ['alice', 'bob'], no: [] },
  });
  AppView._proposals = [];
  await AppView._loadVoteRoster(1);
  assert.match(el.innerHTML, /Yes \(2\):/);
  assert.doesNotMatch(el.innerHTML, /advisory/);
});

// ── _votingHelpText ──────────────────────────────────────────────────

test('_votingHelpText: invited default-clock branch names the rule + advisory tally', () => {
  const AppView = makeAppView();
  const txt = AppView._votingHelpText({
    id: 7, status: 'promoted', yes_count: 2, no_count: 0,
    qualified_yes_count: 0, qualified_no_count: 0,
    approval_policy: 'invited', votes_required: 1,
    contested: false, rejection_armed: false,
    merge_window_ends_at: null, reject_window_ends_at: null,
    check_state: 'passing', behind_main: 0, merge_conflict_state: null,
  });
  assert.match(txt, /only approvers’ votes count/);
  assert.match(txt, /2 advisory votes from non-approvers are recorded but don’t count/);
});

// ── header-cog drawer "Your proposals" section (ex-home strip) ────────

test('cog drawer: pill uses the qualified tally vs votes_required, with the advisory chip', () => {
  const WorkDrawer = makeWorkDrawer();
  WorkDrawer.proposals = [{
    id: 42, app_slug: 'demo', app_name: 'Demo App', pr_title: 'Add a thing',
    status: 'promoted', yes_count: 2, no_count: 0,
    qualified_yes_count: 0, qualified_no_count: 0,
    approval_policy: 'invited', votes_required: 1, majority: 3,
    check_state: 'passing',
  }];
  WorkDrawer.governance = [{
    id: 300, app_slug: 'demo', app_name: 'Demo App', title: 'Set FOO_KEY',
    up_count: 2, down_count: 0,
    qualified_yes_count: 0, qualified_no_count: 0,
    approval_policy: 'invited', votes_required: 1, majority: 3,
  }];
  const html = WorkDrawer.renderProposalsSection();
  // PR row: 0 (approver yes) / 1 (governed requirement), +2 advisory —
  // NOT the raw-tally "2 / 3" (nor a false-green "2 / 1").
  assert.match(html, /0 \/ 1/);
  assert.match(html, /\+2 advisory/);
  assert.doesNotMatch(html, /2 \/ 3/);
  // Governance row gets the same treatment (two matches total).
  assert.equal((html.match(/\+2 advisory/g) || []).length, 2);
});

test('cog drawer: default-policy rows keep the raw tally, no advisory chip', () => {
  const WorkDrawer = makeWorkDrawer();
  WorkDrawer.proposals = [{
    id: 42, app_slug: 'demo', app_name: 'Demo App', pr_title: 'Add a thing',
    status: 'promoted', yes_count: 2, no_count: 0, majority: 3,
    check_state: 'passing',
  }];
  WorkDrawer.governance = [];
  const html = WorkDrawer.renderProposalsSection();
  assert.match(html, /2 \/ 3/);
  assert.doesNotMatch(html, /advisory/);
});
