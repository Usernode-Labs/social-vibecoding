// #386 gave the red affordance to 'failed' (an auto-resolve ran and gave
// up). The silent-merge-failure fix extends it to 'conflict': that state is
// written ONLY when a real merge attempt 405s at GitHub, and the
// auto-resolver drain only picks up vote-eligible proposals — so below the
// gate (or on an admin force-merge) nothing would ever retry and the old
// neutral "Behind main" badge was a false promise. 'conflict' now renders
// red ("Merge failed — conflict") with creator-must-finish guidance; while
// the resolver IS actively working, the 'resolving' state outranks it so
// the card shows progress instead of a stale failure.
//
// app-view.js and home.js are plain browser scripts (`const X = {…}`).
// We load each source into a vm context, stub the globals they reach,
// expose the object, and assert on the returned HTML string.
//
// Run with: node --test tests/proposal-conflict-affordance.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
const WORK_DRAWER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'work-drawer.js'),
  'utf8'
);
// #405: the proposal card / cog-drawer section now derive their merge-state
// badge from window.MergeStatus, so load it into the sandbox first (mirrors
// the real page load order in index.html).
const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'),
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
  vm.runInContext(`${MERGE_STATUS_SRC}\n${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  return AppView;
}

const ME = 42;
// check_state 'passing' keeps these rows on the conflict/behind rungs under
// test — with NO verdict recorded the #607 "Checks starting…" rung would
// outrank behind, same as 'pending' does.
const baseProposal = (over) => ({
  id: 7, pr_number: 700, pr_title: 'Tidy the header', username: 'me',
  user_id: ME, status: 'promoted', created_at: '2026-06-01T00:00:00Z',
  check_state: 'passing', test_results: [],
  ...over,
});

// ── Proposal card badge ────────────────────────────────────────────────

test("card: a 'conflict' snapshot (merge attempt failed) shows the red 'Merge failed' badge", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js', 'public/index.html'],
    behind_main: 2,
  }));
  assert.match(html, /Merge conflict/, 'the pill names the conflict after a real attempt');
  assert.match(html, /gc-vote-count-blocked/, 'blocked tone');
  assert.match(html, /creator needs to finish the merge/, 'tooltip names the way out');
  assert.doesNotMatch(html, /Behind main/, 'merge-failed outranks the neutral behind badge');
  assert.doesNotMatch(html, /Conflict resolution failed/, "the 'failed' affordance stays distinct");
});

test("card: a 'conflict' snapshot with the resolver in flight shows 'Resolving conflicts…' instead", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    merge_conflict_state: 'conflict',
    behind_main: 2,
    resolving: true,
  }));
  assert.match(html, /Resolving conflicts…/, 'in-flight resolve outranks the failure badge');
  assert.doesNotMatch(html, /Merge failed — conflict/, 'no stale failure while progress is being made');
});

test("card: a 'failed' snapshot shows the red 'Conflict resolution failed' affordance", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    merge_conflict_state: 'failed',
    conflict_files: ['src/server.js'],
    behind_main: 1,
  }));
  assert.match(html, /Conflict resolution failed/, 'the pill names the failed auto-resolve');
  assert.match(html, /gc-vote-count-blocked/, 'blocked tone');
  assert.doesNotMatch(html, /Behind main/, 'failed outranks the behind badge');
});

test("card: a plain 'behind' snapshot still shows the amber Behind badge", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    merge_conflict_state: 'behind',
    behind_main: 3,
  }));
  assert.match(html, /Behind main · 3/, 'behind badge unaffected by the change');
  assert.doesNotMatch(html, /⚠ Conflict/, 'no conflict affordance for a behind-only proposal');
});

// ── Proposal detail block ──────────────────────────────────────────────

test("detail: a 'conflict' snapshot renders the merge-failed detail box naming the creator", () => {
  const AppView = makeAppView(ME);
  const html = AppView._mergeConflictDetailHtml(baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    conflict_checked_at: '2026-06-01T00:00:00Z',
  }));
  assert.match(html, /A merge was attempted, but this proposal conflicts with main\./, 'merge-failed heading present');
  assert.match(html, /src\/app\.js/, 'lists the conflicting files');
  assert.match(html, /me<\/span> needs to finish the merge/, 'names the creator as the one who must act');
  assert.match(html, /Sync with main/, 'points at the dev-chat sync action');
});

test("detail: a 'conflict' snapshot with the resolver in flight renders nothing (progress badge covers it)", () => {
  const AppView = makeAppView(ME);
  const html = AppView._mergeConflictDetailHtml(baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    resolving: true,
  }));
  assert.equal(html, '', 'no stale failure box while a resolve is actively running');
});

test("detail: a 'failed' snapshot renders the red 'resolution failed' detail box", () => {
  const AppView = makeAppView(ME);
  const html = AppView._mergeConflictDetailHtml(baseProposal({
    merge_conflict_state: 'failed',
    conflict_files: ['src/server.js'],
    conflict_checked_at: '2026-06-01T00:00:00Z',
  }));
  assert.match(html, /Automatic conflict resolution failed\./, 'failed heading present');
  assert.match(html, /src\/server\.js/, 'lists the conflicting files');
  assert.match(html, /Sync with main/, 'keeps the manual-resolve guidance');
});

// ── Cog-drawer compact badge (WorkDrawer.renderProposalsSection) ────────
// (The section lived on the home screen as "Your proposals" until it
// moved into the header cog's drawer — public/js/work-drawer.js.)

function makeWorkDrawer() {
  const sandbox = {
    console,
    App: { user: { id: ME } },
    document: { getElementById: () => null, addEventListener: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${WORK_DRAWER_SRC}\n;globalThis.__WorkDrawer = WorkDrawer;`, sandbox);
  return sandbox.__WorkDrawer;
}

const drawerProposal = (over) => ({
  id: 7, app_slug: 'demo', app_name: 'Demo', pr_number: 700,
  pr_title: 'Tidy the header', yes_count: 1, majority: 2, status: 'promoted',
  check_state: 'passing', test_results: [],
  ...over,
});

test("cog drawer: a 'conflict' proposal shows the red 'Merge failed' chip", () => {
  const WorkDrawer = makeWorkDrawer();
  WorkDrawer.proposals = [drawerProposal({ merge_conflict_state: 'conflict', behind_main: 2 })];
  WorkDrawer.governance = [];
  const html = WorkDrawer.renderProposalsSection();
  assert.match(html, /Merge failed — conflict/, 'red merge-failed chip after a real attempt');
  assert.doesNotMatch(html, /Behind main/, 'merge-failed outranks the neutral behind chip');
  assert.doesNotMatch(html, /Conflict resolution failed/, "the 'failed' affordance stays distinct");
});

test("cog drawer: a 'failed' proposal shows the red Failed chip", () => {
  const WorkDrawer = makeWorkDrawer();
  WorkDrawer.proposals = [drawerProposal({ merge_conflict_state: 'failed', behind_main: 1 })];
  WorkDrawer.governance = [];
  const html = WorkDrawer.renderProposalsSection();
  // #405: canonical red "Conflict resolution failed" label (was "⚠ Failed").
  assert.match(html, /Conflict resolution failed/, 'red failed chip present after a failed attempt');
});
