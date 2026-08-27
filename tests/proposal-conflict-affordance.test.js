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
const { mergeConflictHtml, mergeabilityHtml, proposalCardHtml } = require('./lib/dev-card-html');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);
// #405: the proposal card derives its merge-state badge from
// window.MergeStatus, so load it into the sandbox first (mirrors the real page
// load order in index.html).
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
  const html = proposalCardHtml(AppView, baseProposal({
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
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict',
    behind_main: 2,
    resolving: true,
  }));
  assert.match(html, /Resolving conflicts…/, 'in-flight resolve outranks the failure badge');
  assert.doesNotMatch(html, /Merge failed — conflict/, 'no stale failure while progress is being made');
});

test("card: a 'failed' snapshot shows the red 'Conflict resolution failed' affordance", () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
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
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'behind',
    behind_main: 3,
  }));
  assert.match(html, /Behind main · 3/, 'behind badge unaffected by the change');
  assert.doesNotMatch(html, /⚠ Conflict/, 'no conflict affordance for a behind-only proposal');
});

// ── Proposal detail block ──────────────────────────────────────────────

test("detail: a 'conflict' snapshot renders the merge-failed detail box naming the creator", () => {
  const AppView = makeAppView(ME);
  const html = mergeConflictHtml(AppView, baseProposal({
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
  const html = mergeConflictHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    resolving: true,
  }));
  assert.equal(html, '', 'no stale failure box while a resolve is actively running');
});

test("detail: a 'failed' snapshot renders the red 'resolution failed' detail box", () => {
  const AppView = makeAppView(ME);
  const html = mergeConflictHtml(AppView, baseProposal({
    merge_conflict_state: 'failed',
    conflict_files: ['src/server.js'],
    conflict_checked_at: '2026-06-01T00:00:00Z',
  }));
  assert.match(html, /Automatic conflict resolution failed\./, 'failed heading present');
  assert.match(html, /src\/server\.js/, 'lists the conflicting files');
  assert.match(html, /Sync with main/, 'keeps the manual-resolve guidance');
});

// A "Cog-drawer compact badge" block used to sit here, asserting that the SAME
// MergeStatus.badgeHtml string reached the header cog drawer's proposal rows —
// the section that had itself moved there from the home screen's "Your
// proposals" strip.
//
// THE UI OVERHAUL retired that drawer: its session list is the Improve panel's,
// scoped to the app on screen, and its pinned "Needs attention" rows are
// ordinary notifications in the merged hamburger. The card and detail
// assertions above are the whole surface now, and MergeStatus is still the one
// owner of the badge across every one of them.

// ── #1442: the conflict nobody has attempted yet ───────────────────────
//
// Everything above is about merge_conflict_state, which is written only when
// a real merge attempt failed. Proposal 3590 never got that far: the gate
// only attempts a merge once a proposal already looks mergeable, so for the
// entire time it was unmergeable it showed green checks and no conflict at
// all. `mergeability` is GitHub's PREDICTION, measured while the votes are
// still coming in, and these lock the two apart.

const FRESH = (over) => ({
  checkedAt: '2026-06-02T00:00:00Z',
  mainSha: 'a'.repeat(40),
  mergeBaseSha: 'b'.repeat(40),
  behindBy: 8, aheadBy: 3,
  mergeability: 'conflict',
  mergeabilityFiles: ['dapp.json', 'src/routes/votes.js'],
  mergeabilityFilesComplete: true,
  checksRanOnBase: null, checksBaseVerdict: 'current', checksBaseBehindBy: 0,
  error: null,
  ...over,
});

test('detail: a predicted conflict renders its own box, distinct from the attempted one', () => {
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({ freshness: FRESH() }));
  assert.match(html, /no longer merges into main on its own/, 'names the prediction, not an attempt');
  assert.match(html, /Changed on both sides:/);
  assert.match(html, /dapp\.json/);
  assert.match(html, /src\/routes\/votes\.js/);
  assert.match(html, /Some of those may still merge cleanly/,
    'the file list is an upper bound and says so');
  assert.match(html, /me<\/span> needs to bring it up to date/, 'names the creator');
  assert.match(html, /Sync with main/, 'points at the way out');
  assert.doesNotMatch(html, /A merge was attempted/, 'no attempt has been made');
});

test('detail: a capped file list is described as a sample', () => {
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({
    freshness: FRESH({ mergeabilityFilesComplete: false }),
  }));
  assert.match(html, /That is a sample of the files/);
});

test('detail: a predicted conflict with no located files still explains itself', () => {
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({
    freshness: FRESH({ mergeabilityFiles: [], mergeabilityFilesComplete: null }),
  }));
  assert.match(html, /no longer merges into main on its own/);
  assert.doesNotMatch(html, /Changed on both sides/, 'no empty list header');
});

test('detail: an ATTEMPTED merge failure outranks the prediction', () => {
  const AppView = makeAppView(ME);
  const pr = baseProposal({
    merge_conflict_state: 'conflict',
    conflict_files: ['src/app.js'],
    freshness: FRESH(),
  });
  assert.equal(mergeabilityHtml(AppView, pr), '', 'the prediction stands down');
  assert.match(mergeConflictHtml(AppView, pr), /A merge was attempted/,
    'and the record of the real attempt is what renders');
});

test('detail: a resolve in flight silences the prediction too', () => {
  const AppView = makeAppView(ME);
  assert.equal(
    mergeabilityHtml(AppView, baseProposal({ resolving: true, freshness: FRESH() })),
    '',
    'no stale conflict box while a resolve is actively running'
  );
});

test("detail: 'clean' and 'unknown' render nothing", () => {
  const AppView = makeAppView(ME);
  for (const m of ['clean', 'unknown', null]) {
    assert.equal(
      mergeabilityHtml(AppView, baseProposal({ freshness: FRESH({ mergeability: m }) })),
      '',
      `${m} is not a conflict`
    );
  }
});

test('detail: flat columns are read when the nested block is absent', () => {
  // The votes routes serialize both — the nested `freshness` block and the
  // raw columns — and older cached rows in the client only have the columns.
  const AppView = makeAppView(ME);
  const html = mergeabilityHtml(AppView, baseProposal({
    mergeability: 'conflict',
    mergeability_files: ['src/db/schema.sql'],
    mergeability_files_complete: true,
  }));
  assert.match(html, /no longer merges into main on its own/);
  assert.match(html, /src\/db\/schema\.sql/);
});

test('card: a predicted conflict is a blocked pill, not a green tally', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({ freshness: FRESH() }));
  assert.match(html, /Conflicts with main · 2/, 'the pill names it and counts the files');
  assert.match(html, /gc-vote-count-blocked/, 'blocked tone, because it cannot merge');
  assert.doesNotMatch(html, /Behind main/, 'the conflict outranks the behind badge');
});

test('card: the attempted-merge pill still wins over the predicted one', () => {
  const AppView = makeAppView(ME);
  const html = proposalCardHtml(AppView, baseProposal({
    merge_conflict_state: 'conflict', freshness: FRESH(),
  }));
  assert.match(html, /Merge conflict/);
  assert.doesNotMatch(html, /Conflicts with main/, 'one conflict pill, and it is the real one');
});
