// Kanban filter bar (#482): AppView._devCardMatches() is the pure per-card
// predicate behind the board's filter controls (text search, priority,
// person, "needs my vote"). It takes (kind, item, filters) with kind ∈
// 'issue' | 'proposal' | 'gov' | 'merged' | 'session' and reads no DOM or AppView
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
const { renderComponent } = require('./lib/render-tsx');
const { kanbanHtml } = require('./lib/dev-card-html');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Minimal in-memory Web Storage stand-in (getItem/setItem/removeItem) so the
// persistence helpers can round-trip without a browser.
function makeMemoryStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

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
    sessionStorage: o.sessionStorage || makeMemoryStore(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  return sandbox;
}

function makeAppView() {
  const sandbox = makeCtx();
  // Every test here drives a board that has ALREADY loaded — filtering,
  // bucketing, counts. `_devDataReady` is what tells the view models that,
  // and without it `_kanbanView()` reports `loading` and the columns render
  // placeholders instead of cards (see card/skeleton.tsx). Set once here
  // rather than per test: an unloaded board has its own coverage in
  // tests/dev-board-loading.test.js.
  sandbox.__AppView._devDataReady = true;
  // The bar's markup is features/dev-board/kanban-filters.tsx's since #1191,
  // so a test that drives the module needs the sandbox back to see what was
  // published — and `document.activeElement`, which decides whether a select
  // the reader has open keeps its options.
  sandbox.__AppView.__sandbox = sandbox;
  return sandbox.__AppView;
}

// Default (empty) filters — the fast-path that must match everything.
const none = { q: '', priority: null, assignee: null, category: null, needsVote: false };

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

// Applied close-issue rows in the Done column (row_type='close_issue'):
// text search reads the target issue's title/number and the proposer,
// mirroring _renderCompletedCloseIssueCard; attribute filters exclude them
// (they carry no priority/assignee/category), and needs-vote never matches
// a settled row.
const closedIssue = (over) => ({
  id: 77, row_type: 'close_issue', kind: 'close_issue', status: 'closed',
  title: 'Close issue #12: "Dark mode toggle resets"',
  payload: { issueNumber: 12, issueTitle: 'Dark mode toggle resets', appliedAt: '2026-01-15T00:00:00.000Z', appliedBy: 'group-vote' },
  created_by_username: 'casey',
  ...over,
});

test('merged close-issue rows match by target issue title, proposer, and number', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), none), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: 'dark mode' }), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: 'casey' }), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: '#12' }), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, q: 'leaderboard' }), false);
  // Attribute filters exclude them (no chips), like any card lacking the value.
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, priority: 'high' }), false);
  assert.equal(AppView._devCardMatches('merged', closedIssue({}), { ...none, needsVote: true }), false);
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

test('category filter matches the top-voted value; unset and gov cards fail', () => {
  const AppView = makeAppView();
  const f = { ...none, category: 'bug' };
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'bug', count: 2 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'feature', count: 1 } }), f), false);
  assert.equal(AppView._devCardMatches('issue', issue({ category: null }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ category: { top: 'bug', count: 1 } }), f), true);
  // Gov cards never carry a category — excluded by design under this filter.
  assert.equal(AppView._devCardMatches('gov', gov({}), f), false);
});

test('category filter composes with priority, assignee and search', () => {
  const AppView = makeAppView();
  const card = prop({
    pr_title: 'Tighten card spacing',
    priority: { top: 'high', count: 2 },
    assignee: { top: 'sam', count: 1 },
    category: { top: 'improvement', count: 3 },
    my_vote: null,
  });
  const f = { q: 'spacing', priority: 'high', assignee: 'sam', category: 'improvement', needsVote: true };
  assert.equal(AppView._devCardMatches('proposal', card, f), true);
  assert.equal(AppView._devCardMatches('proposal', card, { ...f, category: 'bug' }), false);
});

// #780: custom categories are per-app options stored as ordinary slugs, so
// the predicate needs no special case — filtering by one just works.
test('category filter matches a CUSTOM category slug like a built-in', () => {
  const AppView = makeAppView();
  const f = { ...none, category: 'dev experience' };
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'dev experience', count: 2 } }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ category: { top: 'dev experience', count: 1 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ category: { top: 'bug', count: 5 } }), f), false);
});

// #780: the category vocabulary is built from the app's registry — built-ins
// first, then customs — instead of the hardcoded six. The Streamlined
// Concept moved the select into the Filters dialog, so the vocabulary is
// DATA now (_kanbanCategoryChoices feeds the dialog's payload); the "Any
// category" default is the dialog's own leading option, not an entry here.
test('category choices list built-ins then the app custom categories', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { ...none };
  AppView._appCategories = [
    ...AppView.ATTR_CATEGORY_VALUES.map((v) => ({ value: v, label: v, custom: false })),
    { value: 'dev experience', label: 'Dev Experience', custom: true },
    { value: 'performance', label: 'Performance', custom: true },
  ];
  const choices = Array.from(AppView._kanbanCategoryChoices());
  assert.deepEqual(
    Array.from(choices, (c) => c.value),
    [...Array.from(AppView.ATTR_CATEGORY_VALUES), 'dev experience', 'performance'],
    'built-ins precede the customs, in registry order'
  );
  assert.equal(
    choices.find((c) => c.value === 'dev experience').label,
    'Dev Experience',
    'a custom choice shows its registered label'
  );

  // With no vocabulary loaded it degrades to built-ins only (pre-#780 view).
  AppView._appCategories = null;
  assert.deepEqual(
    Array.from(AppView._kanbanCategoryChoices(), (c) => c.value),
    Array.from(AppView.ATTR_CATEGORY_VALUES)
  );
});

// Mirrors the assignee list's rule: an active selection is never dropped
// from the vocabulary, so a filter can't silently self-clear on a refresh.
test('category choices keep an active selection that left the vocabulary', () => {
  const AppView = makeAppView();
  AppView._appCategories = null;
  AppView._kanbanFilters = { ...none, category: 'retired category' };
  const values = Array.from(AppView._kanbanCategoryChoices(), (c) => c.value);
  assert.ok(values.includes('retired category'), 'the active filter survives');
});

// The Filters dialog's write-back merges the dialog-owned keys over the
// current set — search stays the bar's own — and repaints through the
// normal surface path.
test('applyKanbanFilters merges dialog keys and preserves the search text', () => {
  const AppView = makeAppView();
  let repainted = 0;
  AppView._repaintBoardSurface = () => { repainted += 1; };
  AppView._kanbanFilters = { ...none, q: 'ripple', priority: 'low' };
  AppView.applyKanbanFilters({ priority: 'high', category: 'bug', assignee: null, needsVote: true });
  // Field-by-field (the object comes from the vm realm, so deepEqual would
  // trip on its foreign Object prototype rather than its contents).
  const f = AppView._kanbanFilters;
  assert.equal(f.q, 'ripple', 'search text is preserved');
  assert.equal(f.priority, 'high');
  assert.equal(f.category, 'bug');
  assert.equal(f.assignee, null);
  assert.equal(f.needsVote, true);
  assert.equal(repainted, 1, 'one repaint per apply');
});

// The bar itself is features/dev-board/kanban-filters.tsx's — search, the
// `Filters (n)` chip that opens the dialog, and one dismissable chip per
// active filter. The selects it used to render live in the dialog now.
test('the bar renders search, the Filters chip, and dismissable active chips', () => {
  const html = renderComponent(
    'frontend/src/features/dev-board/kanban-filters.tsx', 'KanbanFiltersView',
    {
      mounted: true,
      q: '',
      seq: 0,
      count: 2,
      chips: [
        { key: 'priority', label: 'High priority' },
        { key: 'needsVote', label: 'Needs my vote' },
      ],
    },
  );
  assert.match(html, /id="dev-kanban-search"[^>]*placeholder="Search title, author, or #"/);
  assert.match(html, /id="dev-kanban-filters-btn"[^>]*aria-haspopup="dialog"/);
  assert.match(html, />Filters \(2\)</, 'the chip counts the dialog-owned filters');
  // The chip reads as SET while any dialog filter is on — the filled tonal state.
  assert.match(html, /id="dev-kanban-filters-btn"[^>]*bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900/);
  assert.match(html, /data-filter-chip="priority"/);
  assert.match(html, /aria-label="Remove filter: High priority"/);
  assert.match(html, /data-filter-chip="needsVote"/);
  // No select survives in the strip.
  assert.ok(!/<select/.test(html), 'the selects moved into the Filters dialog');
});

test('person filter matches either the top-voted assignee or the author', () => {
  const AppView = makeAppView();
  const f = { ...none, assignee: 'sam' };
  // Explicit assignment still matches even when someone else authored it.
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'sam', count: 3 } }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'kim', count: 1 } }), f), false);
  // Authored-but-unassigned is the behavior this change adds.
  assert.equal(AppView._devCardMatches('proposal', prop({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'kim', assignee: null }), f), false);
});

test('person filter uses every card kind\'s existing author field', () => {
  const AppView = makeAppView();
  const by = (name) => ({ ...none, assignee: name });
  assert.equal(AppView._devCardMatches('issue', issue({ created_by_username: 'evan' }), by('evan')), true);
  assert.equal(AppView._devCardMatches('issue',
    issue({ created_by_username: null, user: 'octocat' }), by('octocat')), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ username: 'sam' }), by('sam')), true);
  assert.equal(AppView._devCardMatches('gov', gov({ created_by_username: 'evan' }), by('evan')), true);
  assert.equal(AppView._devCardMatches('merged', merged({ username: 'kim' }), by('kim')), true);
  assert.equal(AppView._devCardMatches('merged', closedIssue({ created_by_username: 'casey' }), by('casey')), true);
  assert.equal(AppView._devCardMatches('session', { username: 'maya' }, by('maya')), true);
  assert.equal(AppView._devCardMatches('session', { username: 'maya' }, by('someone-else')), false);
});

test('Unassigned sentinel matches only cards with no top assignee; gov excluded', () => {
  const AppView = makeAppView();
  const f = { ...none, assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED };
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: null, count: 0 } }), f), true);
  assert.equal(AppView._devCardMatches('proposal', prop({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('merged', merged({ assignee: null }), f), true);
  assert.equal(AppView._devCardMatches('issue', issue({ assignee: { top: 'sam', count: 1 } }), f), false);
  assert.equal(AppView._devCardMatches('proposal', prop({ assignee: { top: 'kim', count: 2 } }), f), false);
  assert.equal(AppView._devCardMatches('merged', merged({ assignee: { top: 'zoe', count: 1 } }), f), false);
  // Gov cards never carry an assignee — excluded under Unassigned too,
  // mirroring the named-assignee rule.
  assert.equal(AppView._devCardMatches('gov', gov({}), f), false);
});

test('Unassigned sentinel composes with priority and search', () => {
  const AppView = makeAppView();
  const un = AppView.KANBAN_ASSIGNEE_UNASSIGNED;
  const card = issue({ priority: { top: 'high', count: 1 }, assignee: null });
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, priority: 'high' }), true);
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, priority: 'low' }), false);
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, q: 'dark mode' }), true);
  assert.equal(AppView._devCardMatches('issue', card, { ...none, assignee: un, q: 'leaderboard' }), false);
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
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, category: 'bug', needsVote: false };
  assert.equal(AppView._kanbanFiltersActive(), true, 'an active category filter counts');
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: true };
  assert.equal(AppView._kanbanFiltersActive(), true);
});

test('_kanbanAssigneeOptions unions assignees and authors and keeps the current selection', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 1, assignee: { top: 'zoe', count: 1 } }),
    issue({ number: 2, assignee: null }),
  ];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [prop({ assignee: { top: 'sam', count: 2 } })];
  AppView._govProposals = [gov({ created_by_username: 'casey' })];
  AppView._merged = [merged({ assignee: { top: 'kim', count: 1 } })];
  AppView._mySessions = [{ username: 'maya' }];
  AppView._sharedSessions = [{ username: 'evan' }];
  AppView._kanbanFilters = { q: '', priority: null, assignee: null, needsVote: false };
  // Options come back as the vm realm's Array — map into the host realm
  // before comparing (same trick as dev-kanban-buckets' numbersOf/idsOf).
  const names = () => Array.from(AppView._kanbanAssigneeOptions());
  assert.deepEqual(names(), ['casey', 'evan', 'kim', 'maya', 'sam', 'zoe']);
  // A selected assignee that vanished from the data stays listed so the
  // active filter never silently self-clears.
  AppView._kanbanFilters.assignee = 'alex';
  assert.deepEqual(names(), ['alex', 'casey', 'evan', 'kim', 'maya', 'sam', 'zoe']);
  // The Unassigned sentinel is a fixed dropdown option, never a name —
  // an active Unassigned filter must not leak into the alphabetized list.
  // (The "Anyone" / "Unassigned" leading options are the Filters dialog's
  // own now — this list is just the names its payload carries.)
  AppView._kanbanFilters.assignee = AppView.KANBAN_ASSIGNEE_UNASSIGNED;
  assert.deepEqual(names(), ['casey', 'evan', 'kim', 'maya', 'sam', 'zoe']);
});

// ── Persistence helpers (sessionStorage-backed, per app slug) ──────────

// Objects come back from the vm realm with a foreign Object.prototype, which
// trips deepStrictEqual — copy into the host realm before comparing (same
// realm-crossing trick the assignee-options test uses for arrays).
const plain = (o) => ({ ...o });

test('_loadKanbanFilters returns defaults for unknown slug / empty store', () => {
  const AppView = makeAppView();
  assert.deepEqual(plain(AppView._loadKanbanFilters('nope')), none);
  // A falsy slug never touches storage.
  assert.deepEqual(plain(AppView._loadKanbanFilters('')), none);
  assert.deepEqual(plain(AppView._loadKanbanFilters(null)), none);
});

test('_saveKanbanFilters round-trips through _loadKanbanFilters under the slug', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { q: 'dark', priority: 'high', assignee: 'sam', category: 'bug', needsVote: true };
  AppView._saveKanbanFilters('my-app');
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')),
    { q: 'dark', priority: 'high', assignee: 'sam', category: 'bug', needsVote: true });
});

test('_saveKanbanFilters clears the key when filters are at defaults', () => {
  const store = makeMemoryStore();
  const AppView = makeCtx({ sessionStorage: store }).__AppView;
  const key = `${AppView.KANBAN_FILTERS_KEY}:my-app`;
  // First persist an active filter, then clear it — the key must be removed
  // rather than left holding an empty object (no residue for a cleared board).
  AppView._kanbanFilters = { q: 'dark', priority: null, assignee: null, needsVote: false };
  AppView._saveKanbanFilters('my-app');
  assert.notEqual(store.getItem(key), null);
  AppView._kanbanFilters = AppView._defaultKanbanFilters();
  AppView._saveKanbanFilters('my-app');
  assert.equal(store.getItem(key), null);
});

test('persisted filters are isolated per app slug', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = { q: 'alpha', priority: null, assignee: null, needsVote: false };
  AppView._saveKanbanFilters('app-a');
  AppView._kanbanFilters = { q: 'beta', priority: null, assignee: null, needsVote: false };
  AppView._saveKanbanFilters('app-b');
  assert.equal(AppView._loadKanbanFilters('app-a').q, 'alpha');
  assert.equal(AppView._loadKanbanFilters('app-b').q, 'beta');
});

test('_loadKanbanFilters merges over defaults for a partial stored object', () => {
  const store = makeMemoryStore();
  const AppView = makeCtx({ sessionStorage: store }).__AppView;
  store.setItem(`${AppView.KANBAN_FILTERS_KEY}:my-app`, JSON.stringify({ q: 'hi' }));
  // Missing fields fall back to their defaults rather than becoming undefined.
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')),
    { q: 'hi', priority: null, assignee: null, category: null, needsVote: false });
});

test('_loadKanbanFilters yields defaults on corrupt stored JSON', () => {
  const store = makeMemoryStore();
  const AppView = makeCtx({ sessionStorage: store }).__AppView;
  store.setItem(`${AppView.KANBAN_FILTERS_KEY}:my-app`, '{not valid json');
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')), none);
});

test('persistence helpers survive a storage-less environment', () => {
  // Simulate sessionStorage throwing (private-window / disabled storage):
  // load falls back to defaults and save is a silent no-op, never throwing.
  const throwing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => { throw new Error('denied'); },
  };
  const AppView = makeCtx({ sessionStorage: throwing }).__AppView;
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')), none);
  AppView._kanbanFilters = { q: 'dark', priority: null, assignee: null, needsVote: false };
  assert.doesNotThrow(() => AppView._saveKanbanFilters('my-app'));
});

// ── Session cards have only the filters their data supports ─────────────────
// The In progress column now holds the viewer's pinned sessions (top) and
// other users' shared sessions (bottom). The filter bar's vocabulary
// Priority/category do not apply to sessions; text and the person filter do.

test('a text filter now applies to session cards too (they used to be exempt)', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 5, title: 'beta bug', headless: { status: 'generating' } }),
  ];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = [
    { id: 51, session_title: 'My pinned session', status: 'active',
      created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T01:00:00Z' },
  ];
  AppView._sharedSessions = [
    { id: 71, session_title: 'Shared by them', status: 'paused', username: 'them',
      user_id: 9, shared_at: '2026-06-01T01:00:00Z', created_at: '2026-06-01T01:00:00Z',
      chat_count: 2 },
  ];
  AppView._archivedSessions = [];
  AppView._kanbanFilters = { q: 'zzz-no-match', priority: null, assignee: null, needsVote: false };
  const html = kanbanHtml(AppView);
  // Session cards used to be EXEMPT from the filter bar entirely — type a
  // search term and they just sat there unexplained. Now they filter on
  // their displayed label like every other card.
  assert.doesNotMatch(html, /My pinned session/, 'a non-matching own session is filtered out');
  assert.doesNotMatch(html, /Shared by them/, 'a non-matching shared session is filtered out');
  assert.doesNotMatch(html, /beta bug/, 'non-matching issue card is filtered out');
  // Every card gone, so the column reads as filtered rather than empty.
  assert.match(html, /No matching cards/);
});

test('a session matches on its LABEL and on the issue numbers it links', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._archivedSessions = [];
  AppView._sharedSessions = [];
  AppView._mySessions = [
    { id: 51, session_title: 'Dark mode work', status: 'active', linked_issues: [900002],
      created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T01:00:00Z' },
  ];

  const byTitle = { q: 'dark', priority: null, category: null, assignee: null, needsVote: false };
  AppView._kanbanFilters = byTitle;
  assert.match(kanbanHtml(AppView), /Dark mode work/, 'matches its displayed label');

  AppView._kanbanFilters = { ...byTitle, q: '#900002' };
  assert.match(kanbanHtml(AppView), /Dark mode work/, 'matches a linked issue number');

  AppView._kanbanFilters = { ...byTitle, q: '#900999' };
  assert.doesNotMatch(kanbanHtml(AppView), /Dark mode work/, 'an unrelated number does not');
});

test('priority / category are a VISIBLE no-op on session cards', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._archivedSessions = [];
  AppView._sharedSessions = [];
  AppView._mySessions = [
    { id: 51, session_title: 'Dark mode work', status: 'active',
      created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T01:00:00Z' },
  ];
  AppView._kanbanFilters = { q: '', priority: 'high', category: null, assignee: null, needsVote: false };
  const html = kanbanHtml(AppView);
  // A dev session carries no such metadata, so hiding it would be silently
  // wrong — it stays, and the column SAYS why the filter didn't apply.
  assert.match(html, /Dark mode work/, 'the session survives an inapplicable filter');
  assert.match(html, /Dev sessions don&#x27;t carry priority, category or assignee/);
  assert.match(html, /not filtered by priority/);

  // The predicate itself keeps the attribute filters as an explicit no-op.
  assert.equal(
    AppView._devCardMatches('session', { session_title: 'x' },
      { priority: 'high', category: 'bug' }),
    true
  );
});

test('a named person filters sessions by author while Unassigned stays a no-op', () => {
  const AppView = makeAppView();
  const session = { session_title: 'Dark mode work', username: 'maya' };
  assert.equal(AppView._devCardMatches('session', session, { ...none, assignee: 'maya' }), true);
  assert.equal(AppView._devCardMatches('session', session, { ...none, assignee: 'sam' }), false);
  assert.equal(AppView._devCardMatches('session', session,
    { ...none, assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED }), true);
});

// ── #1112: the column is titled "Underway", keyed `inprogress` ─────────────
// "In progress" was the column title, the chip on every card in it, and the
// label on the button that put a card there — three different meanings of one
// phrase. The title changed; the KEY did not, because it is the stored kanban
// column_key, the element id and the `?col=` deep-link value.

test('the second column reads "Underway" but keeps its inprogress key and id', () => {
  const AppView = makeAppView();
  AppView._ghIssues = [
    issue({ number: 5, title: 'beta bug', headless: { status: 'generating' } }),
  ];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = [];
  AppView._sharedSessions = [];
  AppView._archivedSessions = [];
  AppView._kanbanFilters = { q: '', priority: null, category: null, assignee: null, needsVote: false };
  const html = kanbanHtml(AppView);

  assert.match(html, /Underway <span[^>]*>· 1<\/span>/, 'column head retitled');
  assert.ok(!/In progress <span/.test(html), 'the old title is gone');
  // Load-bearing and unchanged: the key, the id and the tab wiring.
  assert.match(html, /id="dev-kanban-col-inprogress"/);
  assert.match(html, /data-kanban-col="inprogress"/);
  assert.match(html, /aria-controls="dev-kanban-col-inprogress"/);
  // The tab strip reads the same title, so the two surfaces cannot drift.
  const tab = html.match(/id="dev-kanban-tab-inprogress"[\s\S]*?<\/button>/);
  assert.ok(tab && /Underway/.test(tab[0]), 'the mobile tab is retitled too');
  // One-line hover explanation on the column head — the column name alone
  // still cannot say what the five underway states have in common.
  const head = html.match(/id="dev-kanban-col-inprogress"[\s\S]*?dev-kanban-col-head[^>]*title="([^"]+)"/);
  assert.ok(head, 'the column head carries a title attribute');
  assert.match(head[1], /auto-solving/i);
  assert.match(head[1], /paused/i);
  // …and only that column has one, so the other three heads are unchanged.
  assert.equal((html.match(/dev-kanban-col-head[^>]*title="/g) || []).length, 1);
});

// ── The bar itself (#1191, then Streamlined Concept) ────────────────────
//
// The strip was an `innerHTML` template plus six re-bound listeners; #1191
// made it React's, and the Streamlined Concept slimmed it to search + the
// `Filters (n)` chip + the active-filter chips. One property carried through
// every shape and still needs pinning:
//
//   An ordinary board repaint must NOT disturb the search box. That is why
//   `#dev-kanban-filterbar` was left untouched while `#dev-kanban-board` was
//   rewritten around it — a rebuild would have taken the caret with it. The
//   box is uncontrolled for the same reason, and dismissing the Search chip
//   is the one path allowed to replace it (through a `seq` that is its React
//   key).

test('the search box survives a repaint; only its chip dismissal replaces it', () => {
  // Uncontrolled: the typed text is the DOM's, seeded once. A `value` prop
  // here would re-render the box on every repaint and move the caret.
  const html = renderComponent(
    'frontend/src/features/dev-board/kanban-filters.tsx', 'KanbanFiltersView',
    { mounted: true, q: 'photo', seq: 0, count: 0, chips: [] },
  );
  assert.match(html, /id="dev-kanban-search"[^>]*value="photo"/);
  const tsx = read('frontend/src/features/dev-board/kanban-filters.tsx');
  assert.match(tsx, /defaultValue=\{q\}/, 'the search field is uncontrolled');
  assert.doesNotMatch(tsx, /\bvalue=\{q\}/, 'a controlled one would move the caret on every repaint');
  assert.match(tsx, /key=\{`q\$\{seq\}`\}/, 'and its identity is the seq the dismissal bumps');

  // Dismissing the Search chip bumps that seq — the one write that empties
  // the box. The dialog-owned keys just null out, seq untouched.
  const AppView = makeAppView();
  AppView._repaintBoardSurface = () => {};
  AppView._kanbanFilters = { ...none, q: 'photo', priority: 'high' };
  const seq0 = AppView._kanbanFilterSeq;
  AppView._dismissKanbanFilter('priority');
  assert.equal(AppView._kanbanFilters.priority, null);
  assert.equal(AppView._kanbanFilterSeq, seq0, 'a non-search dismissal leaves the box alone');
  AppView._dismissKanbanFilter('q');
  assert.equal(AppView._kanbanFilters.q, '');
  assert.equal(AppView._kanbanFilterSeq, seq0 + 1, 'the Search dismissal re-keys the field');
});

test('a repaint republishes the whole strip: count and chips track the filters', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = {
    ...none, q: ' ripple ', priority: 'high', assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED, needsVote: true,
  };
  const seen = [];
  AppView._reactDevBoard = () => ({ publishKanbanFilters: (p) => seen.push(p) });
  // `_updateKanbanFilterBarUI` bails when the host is absent, so give it one.
  AppView.__sandbox.document.getElementById =
    (id) => (id === 'dev-kanban-filterbar' ? { id } : null);
  AppView._updateKanbanFilterBarUI();
  const view = seen[0];
  assert.equal(view.count, 3, 'search stays out of the Filters (n) count');
  // One chip per active filter, in the module's fixed order, labels resolved.
  assert.deepEqual(
    Array.from(view.chips, (c) => ({ ...c })),
    [
      { key: 'q', label: 'Search: ripple' },
      { key: 'priority', label: 'High priority' },
      { key: 'assignee', label: 'Unassigned' },
      { key: 'needsVote', label: 'Needs my vote' },
    ],
  );
});
