// Kanban filter bar (#482): AppView._devCardMatches() is the pure per-card
// predicate behind the board's filter controls (text search, priority,
// assignee, "needs my vote"). It takes (kind, item, filters) with kind ∈
// 'issue' | 'proposal' | 'gov' | 'merged' and reads no DOM or AppView
// state, so — like _bucketDevItems — we load app-view.js into a vm context
// (same harness as dev-kanban-buckets.test.js) and call it directly with
// synthetic rows.
//
// Run with: node --test tests/dev-kanban-filters.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeCtx(over) {
  const o = over || {};
  const sandbox = {
    matchMedia: o.matchMedia,
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 1 }, currentSubTab: 'forum' },
    Kudos: { renderButton: () => '', attach: () => {} },
    document: o.document || {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: o.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: o.localStorage || { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView() {
  return makeCtx().__AppView;
}

// Default (empty) filters — the fast-path that must match everything.
const none = { q: '', priority: null, assignee: null, needsVote: false };

const issue = (over) => ({
  number: 42, title: 'Dark mode toggle resets', created_by_username: 'evan',
  priority: null, assignee: null,
  ...over,
});
const prop = (over) => ({
  id: 9000001, pr_number: 900101, pr_title: 'Rework the proposal card header',
  username: 'sam', status: 'promoted', my_vote: null,
  priority: null, assignee: null,
  ...over,
});
const gov = (over) => ({
  id: 7, kind: 'rename', title: 'Rename app', payload: { newName: 'Shiny App' },
  created_by_username: 'evan', my_vote: null, github_issue_number: 55,
  ...over,
});
const merged = (over) => ({
  id: 8000001, pr_number: 800101, pr_title: 'Fix leaderboard scroll jump',
  username: 'kim', priority: null, assignee: null,
  ...over,
});

test('default filters match every kind', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('issue', issue({}), none), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), none), true);
  assert.equal(AppView._devCardMatches('gov', gov({}), none), true);
  assert.equal(AppView._devCardMatches('merged', merged({}), none), true);
  // No-filters object at all behaves the same.
  assert.equal(AppView._devCardMatches('issue', issue({}), undefined), true);
});

test('text search matches titles case-insensitively', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: 'DARK MODE' }), true);
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: 'leaderboard' }), false);
  assert.equal(AppView._devCardMatches('merged', merged({}), { ...none, q: 'leaderboard' }), true);
  // Proposal without a pr_title falls back to "Change by <username>",
  // mirroring the card renderer.
  assert.equal(
    AppView._devCardMatches('proposal', prop({ pr_title: null }), { ...none, q: 'change by sam' }),
    true
  );
  // Gov rename searches the new name, mirroring _renderGovCard's title.
  assert.equal(AppView._devCardMatches('gov', gov({}), { ...none, q: 'shiny' }), true);
  assert.equal(
    AppView._devCardMatches('gov', gov({ kind: 'secret_change', title: 'Set STRIPE_KEY', payload: null }),
      { ...none, q: 'stripe' }),
    true
  );
});

test('text search matches author names', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: 'Evan' }), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: 'sam' }), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: 'evan' }), false);
  // Issues without a resolved creator fall back to the GitHub login.
  assert.equal(
    AppView._devCardMatches('issue', issue({ created_by_username: null, user: 'octocat' }),
      { ...none, q: 'octo' }),
    true
  );
});

test('text search matches issue/PR numbers, with or without a leading #', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: '900101' }), true);
  assert.equal(AppView._devCardMatches('proposal', prop({}), { ...none, q: '#900101' }), true);
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: '#42' }), true);
  assert.equal(AppView._devCardMatches('issue', issue({}), { ...none, q: '#43' }), false);
  assert.equal(AppView._devCardMatches('merged', merged({}), { ...none, q: '800101' }), true);
});

test('priority filter matches the top-voted value; unset and gov cards fail', () => {
  const AppView = makeAppView();
  const f = { ...none, priority: 'high' };
  assert.equal(AppView._devCardMatches('issue', issue({ priority: { top: 'high', count: 2 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ priority: { top: 'low', count: 1 } }), f), false);
  assert.equal(AppView._devCardMatches('issue', issue({ priority: null }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ priority: { top: 'high', count: 1 } }), f), true);
  // Gov cards never carry priority — excluded by design under this filter.
  assert.equal(AppView._devCardMatches('gov', gov({}), f), false);
});

test('assignee filter matches the top-voted assignee; unassigned cards fail', () => {
  const AppView = makeAppView();
  const f = { ...none, assignee: 'sam' };
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'sam', count: 3 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'kim', count: 1 } }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ assignee: null }), f), false);
  assert.equal(AppView._devCardMatches('gov', gov({}), f), false);
});

test('needsVote keeps only unvoted promoted proposals and unvoted gov proposals', () => {
  const AppView = makeAppView();
  const f = { ...none, needsVote: true };
  assert.equal(AppView._devCardMatches('proposal', prop({ my_vote: null }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ my_vote: 'yes' }), f), false);
  // Non-promoted (e.g. merging) proposals are no longer votable.
  assert.equal(AppView._devCardMatches('proposal', prop({ status: 'merging', my_vote: null }), f), false);
  assert.equal(AppView._devCardMatches('gov', gov({ my_vote: null }), f), true);
  assert.equal(AppView._devCardMatches('gov', gov({ my_vote: 'up' }), f), false);
  // Issues and merged cards are never votable.
  assert.equal(AppView._devCardMatches('issue', issue({}), f), false);
  assert.equal(AppView._devCardMatches('merged', merged({}), f), false);
});

test('filters AND together', () => {
  const AppView = makeAppView();
  const card = prop({
    pr_title: 'Tighten card spacing',
    priority: { top: 'high', count: 2 },
    assignee: { top: 'sam', count: 1 },
    my_vote: null,
  });
  const f = { q: 'spacing', priority: 'high', assignee: 'sam', needsVote: true };
  assert.equal(AppView._devCardMatches('proposal', card, f), true);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, q: 'leaderboard' }), false);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, priority: 'low' }), false);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, assignee: 'kim' }), false);
  assert.equal(
    AppView._devCardMatches('proposal', { ...card, my_vote: 'yes' }, f),
    false
  );
});

test('_kanbanFiltersActive reflects any non-default filter', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), false);
  AppView._kanbanFilters = { q: '   ', priority: null, assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), false, 'whitespace-only search is not active');
  AppView._kanbanFilters = { q: 'x', priority: null, assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true);
  AppView._kanbanFilters = { q: '', priority: 'high', assignee: null, needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true);
  AppView._kanbanFilters = { q: '', priority: null, assignee: 'sam', needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true);
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: true };
  assert.equal(AppView._kanbanFiltersActive(), true);
});

test('_kanbanAssigneeOptions unions board data and keeps the current selection', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 1, assignee: { top: 'zoe', count: 1 } }),
    issue({ number: 2, assignee: null }),
  ];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [prop({ assignee: { top: 'sam', count: 2 } })];
  AppView._merged = [merged({ assignee: { top: 'kim', count: 1 } })];
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: false };
  // Options come back as the vm realm's Array — map into the host realm
  // before comparing (same trick as dev-kanban-buckets' numbersOf/idsOf).
  const names = () => Array.from(AppView._kanbanAssigneeOptions());
  assert.deepEqual(names(), ['kim', 'sam', 'zoe']);
  // A selected assignee that vanished from the data stays listed so the
  // active filter never silently self-clears.
  AppView._kanbanFilters.assignee = 'evan';
  assert.deepEqual(names(), ['evan', 'kim', 'sam', 'zoe']);
});
