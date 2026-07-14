// #386: the red "resolve conflict" affordance must surface ONLY after an
// auto-resolve attempt actually ran and failed (merge_conflict_state ===
// 'failed'). A fresh 'conflict' snapshot — written the instant a merge
// 405s, before the auto-fix has reported back — is NOT a warning: that
// path always bumps behind_main >= 1, so the card/strip fall through to
// the neutral amber "Behind main" badge while the resolver runs.
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
const HOME_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'home.js'),
  'utf8'
);
// #405: the proposal card / home strip now derive their merge-state badge
// from window.MergeStatus, so load it into the sandbox first (mirrors the
// real page load order in index.html).
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

test("card: a fresh 'conflict' snapshot shows the amber Behind badge, not the red affordance", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js', 'public/index.html'],
    behind_main: 2,
  }));
  assert.match(html, /Behind main · 2/, "renders the neutral amber 'Behind main' badge");
  assert.doesNotMatch(html, /⚠ Conflicts/, "no pre-emptive red 'Conflicts' badge");
  assert.doesNotMatch(html, /Conflict resolution failed/, "no failed-state affordance pre-attempt");
});

test("card: a 'failed' snapshot shows the red 'Conflict resolution failed' affordance", () => {
  const AppView = makeAppView(ME);
  const html = AppView._renderProposalCard(baseProposal({
    merge_conflict_state: 'failed',
    conflict_files: ['src/server.js'],
    behind_main: 1,
  }));
  assert.match(html, /⚠ Conflict resolution failed/, 'red failed badge present after a failed attempt');
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

test("detail: a 'conflict' snapshot renders no merge-conflict detail box", () => {
  const AppView = makeAppView(ME);
  const html = AppView._mergeConflictDetailHtml(baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    conflict_checked_at: '2026-06-01T00:00:00Z',
  }));
  assert.equal(html, '', "pre-attempt 'conflict' shows nothing on the detail screen");
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

// ── Home-strip compact badge (Home.renderMyProposalsSection) ───────────

function makeHome() {
  const sandbox = {
    console,
    App: { user: { id: ME } },
    document: { getElementById: () => null },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${HOME_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return sandbox.__Home;
}

const homeProposal = (over) => ({
  id: 7, app_slug: 'demo', app_name: 'Demo', pr_number: 700,
  pr_title: 'Tidy the header', yes_count: 1, majority: 2, status: 'promoted',
  check_state: 'passing', test_results: [],
  ...over,
});

test("home strip: a 'conflict' proposal shows the amber Behind chip, not a red Conflicts chip", () => {
  const Home = makeHome();
  Home._myProposals = { proposals: [homeProposal({ merge_conflict_state: 'conflict', behind_main: 2 })], governance: [] };
  const html = Home.renderMyProposalsSection();
  // #405: the home strip now uses the canonical "Behind main · N" label.
  assert.match(html, /Behind main · 2/, "renders the neutral 'Behind main' chip");
  assert.doesNotMatch(html, /⚠ Conflicts/, "no pre-emptive red 'Conflicts' chip");
  assert.doesNotMatch(html, /Conflict resolution failed/, 'no failed affordance pre-attempt');
});

test("home strip: a 'failed' proposal shows the red Failed chip", () => {
  const Home = makeHome();
  Home._myProposals = { proposals: [homeProposal({ merge_conflict_state: 'failed', behind_main: 1 })], governance: [] };
  const html = Home.renderMyProposalsSection();
  // #405: canonical red "Conflict resolution failed" label (was "⚠ Failed").
  assert.match(html, /Conflict resolution failed/, 'red failed chip present after a failed attempt');
});
