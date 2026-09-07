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

test('the conflicting files sit under the line that introduces them', () => {
  // The defect: fromBox bucketed lines into `foot` and lists into `list`,
  // and the renderer drew every list last — so "Changed on both sides:" was
  // three sentences away from its own list.
  const AppView = makeAppView();
  const sync = find(rowsOf(AppView, CONFLICTED), 'mergeability');
  const lead = sync.foot.findIndex((f) => Array.isArray(f)
    && f.join('').startsWith('Changed on both sides'));
  assert.ok(lead >= 0, 'the list still has a lead-in');
  const next = sync.foot[lead + 1];
  assert.ok(next && !Array.isArray(next) && Array.isArray(next.list),
    'and the list is the very next thing under it');
  assert.deepEqual(next.list.map((i) => i.text),
    ['dapp.json', 'src/services/visuals.js', 'capture/capture.js']);
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
