'use strict';

// The "Where it stands" ledger, for a proposal that cannot merge.
//
// It used to render one row per SUBSYSTEM — mergeability, checks, behind
// main, votes — each built by a builder that could not see the others. On
// #1496 that produced six sentences about one situation, two of which named
// different actors: "Syncing automatically, then it retries the merge" sat
// three lines under "It cannot merge until somebody reconciles them". Both
// were true. Neither knew the other was on the page.
//
// _topicLedgerPath rewrites those rows as one ordered path: sync, then
// checks, then the vote. These tests pin the four things that fixed, and
// the one thing that must not change: the row keys, which are the rows'
// data-note and what dapp.json's declared checks select on.
//
// Run with: node --test tests/topic-ledger-path.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function makeAppView() {
  const sandbox = {
    console, relTime: () => 'just now',
    App: { user: { id: 1 }, currentTab: 'dev', currentSubTab: 'topic' },
    Kudos: { renderButton: () => '' }, DOMPurify: { sanitize: (s) => s },
    document: {
      getElementById: () => null, querySelector: () => ({ innerHTML: '' }),
      querySelectorAll: () => ({ forEach: () => {} }), addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} }, hidden: false,
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }), alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval, addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { search: '', hash: '' }, URLSearchParams,
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${read('public/js/merge-status.js')}\n${read('public/js/session-transcript.js')}\n`
    + `${read('public/js/app-view.js')}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1, activeUsers: 5, locked: false };
  AppView.appData = { slug: 'app' };
  return AppView;
}
const plain = (o) => JSON.parse(JSON.stringify(o));
const rowsOf = (AppView, pr) => plain(AppView._proposalDetailsView(pr).ledger);
const find = (rows, key) => rows.find((r) => r.key === key);

// #1496, near enough: conflicting with main, 118 commits behind, one stale
// failing check, one no vote.
const CONFLICTED = {
  id: 1496, status: 'promoted', username: 'Sumarno', source: 'native',
  branch_name: 'dev/Sumarno-1788274912205',
  check_state: 'failing', yes_count: 0, no_count: 1, votes_required: 1,
  test_results: [{ name: 'Repo unit suite (npm test) passes', status: 'fail', path: 'package.json' }],
  freshness: {
    mergeability: 'conflict', behindBy: 118, checkedAt: '2026-09-07T09:00:00Z',
    mergeabilityFiles: ['dapp.json', 'src/services/visuals.js', 'capture/capture.js'],
    mergeabilityFilesComplete: true,
  },
};

test('a conflicted proposal reads as one ordered path, not four verdicts', () => {
  const AppView = makeAppView();
  const rows = rowsOf(AppView, CONFLICTED);

  // Sync, checks, vote — numbered, in that order, and nothing else numbered.
  const steps = rows.filter((r) => r.step).map((r) => [r.step, r.key, r.label]);
  assert.deepEqual(steps, [
    [1, 'mergeability', 'Sync with main'],
    [2, 'checks', 'Re-run checks'],
    [3, 'votes', 'Votes'],
  ], 'the path is sync, then checks, then the vote');

  // Behind-main is folded into the sync step rather than contradicting it.
  assert.equal(find(rows, 'behind'), undefined, 'no second row telling the reader to wait');
  const sync = find(rows, 'mergeability');
  assert.match(sync.text.join(''), /Main has moved 118 commits ahead/, 'the commit count survives the fold');
  assert.match(sync.text.join(''), /automatic sync cannot finish this one/);
  assert.equal(sync.sub, 'Sumarno, now', 'the step names who acts and when');

  // The remedy still names the person and the exact action.
  const footText = sync.foot.filter(Array.isArray)
    .map((f) => f.map((x) => (typeof x === 'string' ? x : x.b)).join('')).join(' ');
  assert.match(footText, /Sync with main/);
  assert.match(footText, /Sumarno/);
});

test('the sync step says how many files overlap and does not list them', () => {
  // Both-sides-changed is an UPPER BOUND on the conflict, not the conflict:
  // two edits at opposite ends of one file land in it and merge cleanly. The
  // list was the bulkiest thing on the panel and it changed nothing about
  // the one move available, which is to run the sync and let git name the
  // real overlaps. The count stays, in the sentence, where it says how big
  // the job is without claiming to say which files it is.
  const AppView = makeAppView();
  const sync = find(rowsOf(AppView, CONFLICTED), 'mergeability');
  assert.match(sync.text.join(''), /3 files changed on both sides/);
  assert.equal(sync.foot.filter((f) => !Array.isArray(f)).length, 0, 'no file list on the step');
  const flat = JSON.stringify(sync);
  assert.doesNotMatch(flat, /src\/services\/visuals\.js/, 'and no path smuggled into a line');
});

test('a box that leads with its list still renders the list first', () => {
  // The ordering fix this change carries, tested where it is still visible.
  // The platform-variables box puts its keys FIRST and its two explanatory
  // lines after — "the keys lead, they are what a reader has to act on".
  // Bucketing lines into `foot` and lists into `list` sent the keys to the
  // bottom of the row, under both explanations, silently.
  const AppView = makeAppView();
  const rows = rowsOf(AppView, {
    ...CONFLICTED,
    check_state: 'passing', test_results: [],
    freshness: { mergeability: 'clean', behindBy: 0, mergeabilityFiles: [] },
    platform_env_state: 'failing',
    platform_env_detail: { added: [], missing: [{ key: 'SMTP_URL', description: 'Outbound mail' }] },
  });
  const env = find(rows, 'env');
  assert.ok(env, 'the platform-variables row renders');
  const first = env.foot[0];
  assert.ok(first && !Array.isArray(first) && Array.isArray(first.list),
    'the keys are the first thing under the heading, not the last');
  assert.equal(first.list[0].code, 'SMTP_URL');
  assert.ok(Array.isArray(env.foot[1]), 'and the explanations follow them');
});

test('a verdict measured against a base main has left behind is not reported as live', () => {
  const AppView = makeAppView();
  const checks = find(rowsOf(AppView, CONFLICTED), 'checks');
  assert.equal(checks.sub, 'automatic, after 1');
  assert.equal(checks.tone, 'mute', 'it is not the blocker while step 1 stands');
  assert.doesNotMatch(checks.text.join(''), /Merge is blocked until they pass/,
    'the present tense described code that would no longer merge');
  assert.match(checks.text.join(''), /once the branch is up to date/);
  assert.ok(checks.fails && checks.fails.length, 'the failing check is still named');
  const foot = (checks.foot || []).filter(Array.isArray).map((f) => f.join('')).join(' ');
  assert.doesNotMatch(foot, /Pushing a fix/,
    'an instruction under "nothing to do here" is the contradiction this pass exists to remove');
});

test('a proposal that is only behind main says the platform is doing it', () => {
  const AppView = makeAppView();
  const rows = rowsOf(AppView, {
    ...CONFLICTED,
    freshness: { mergeability: 'clean', behindBy: 3, mergeabilityFiles: [] },
  });
  const sync = find(rows, 'behind');
  assert.ok(sync, 'the behind row is the sync step when nothing conflicts');
  assert.equal(sync.step, 1);
  assert.equal(sync.sub, 'automatic, now', 'nobody is being asked to do anything');
  assert.match(sync.text.join(''), /The platform is syncing this proposal onto it/);
});

test('with nothing to sync the ledger is left exactly as it was', () => {
  // The path only earns its numbering when a sync step orders the others.
  // "Checks, step 1 of 1" would say less than "Checks".
  const AppView = makeAppView();
  const rows = rowsOf(AppView, {
    ...CONFLICTED,
    freshness: { mergeability: 'clean', behindBy: 0, mergeabilityFiles: [] },
  });
  assert.deepEqual(rows.filter((r) => r.step), [], 'no steps');
  assert.equal(find(rows, 'checks').label, 'Checks');
});

test('the path is drawn as a checklist, and a cleared step is ticked', () => {
  // Numbering says the steps are ORDERED. A box per step says they are a
  // GATE, and it only earns the shape because the boxes have two states:
  // checks that passed and a vote that reached the threshold are cleared
  // while the sync is still outstanding.
  const AppView = makeAppView();
  const blocked = AppView._proposalDetailsView(CONFLICTED);
  assert.equal(blocked.pathSteps, 3);
  assert.equal(blocked.pathLeft, 3, 'nothing is cleared yet');
  assert.deepEqual(plain(blocked.ledger.filter((r) => r.step).map((r) => !!r.stepDone)),
    [false, false, false]);

  const nearlyThere = AppView._proposalDetailsView({
    ...CONFLICTED,
    check_state: 'passing',
    test_results: [{ name: 'Repo unit suite (npm test) passes', status: 'pass' }],
    yes_count: 2, no_count: 0, votes_required: 1,
  });
  assert.deepEqual(plain(nearlyThere.ledger.filter((r) => r.step).map((r) => !!r.stepDone)),
    [false, true, true], 'the sync is never ticked — it is on the path only while it is pending');
  assert.equal(nearlyThere.pathLeft, 1, 'and the caption says how many are left');

  // With no path there is no checklist at all.
  const clean = AppView._proposalDetailsView({
    ...CONFLICTED,
    freshness: { mergeability: 'clean', behindBy: 0, mergeabilityFiles: [] },
  });
  assert.equal(clean.pathSteps, null);
  assert.equal(clean.pathLeft, null);
});

test('a step box is a box, and a cleared one is not still coloured by the blocker', () => {
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ledger-row\[data-step\] \.dev-ledger-dot \{[^}]*border-radius: 5px;/,
    'squared off, so it reads as a checkbox rather than a status dot');
  assert.match(css, /\.dev-ledger-row\[data-step\]\[data-step-done\] \.dev-ledger-dot \{[^}]*--state-ok/,
    'a ticked box takes the ok tone, not the row it sits in');
  assert.doesNotMatch(css, /The path rail/, 'the rail it replaced is gone, geometry and all');
});

test('the row keys the declared checks select on are untouched', () => {
  const AppView = makeAppView();
  const keys = rowsOf(AppView, CONFLICTED).map((r) => r.key);
  for (const k of ['mergeability', 'checks', 'votes']) {
    assert.ok(keys.includes(k), `data-note="${k}" still addresses a row`);
  }
});

test('a count on a chip carries its unit', () => {
  // "Conflicts with main · 10" (files) sat beside "Behind main · 118"
  // (commits) in the same grammar, and read as commits.
  const AppView = makeAppView();
  const reason = AppView.blockReasons(CONFLICTED).find((r) => r.key === 'mergeability_conflict');
  assert.equal(reason.label, 'Conflicts with main · 3 files');
});

test('the ledger label column can hold the labels it is given', () => {
  // `nowrap` in a fixed 118px track sent "Conflicts with main" across the
  // gap and into its own sentence.
  const css = read('public/css/app.css');
  assert.match(css, /\.dev-ledger-k \{[^}]*white-space: normal;/);
  assert.doesNotMatch(css, /\.dev-ledger-k \{ font-weight: 600; white-space: nowrap; \}/);
});
