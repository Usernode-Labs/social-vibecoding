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
  // The Unassigned sentinel is a fixed dropdown option, never a name —
  // an active Unassigned filter must not leak into the alphabetized list.
  AppView._kanbanFilters.assignee = AppView.KANBAN_ASSIGNEE_UNASSIGNED;
  assert.deepEqual(names(), ['kim', 'sam', 'zoe']);
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
  AppView._kanbanFilters = { q: 'dark', priority: 'high', assignee: 'sam', needsVote: true };
  AppView._saveKanbanFilters('my-app');
  assert.deepEqual(plain(AppView._loadKanbanFilters('my-app')),
    { q: 'dark', priority: 'high', assignee: 'sam', needsVote: true });
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
    { q: 'hi', priority: null, assignee: null, needsVote: false });
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

// ── Session cards are exempt from the filter bar ────────────────────────────
// The In progress column now holds the viewer's pinned sessions (top) and
// other users' shared sessions (bottom). The filter bar's vocabulary
// (text/priority/assignee/needs-vote) doesn't apply to sessions, so an
// active filter must keep every session card while filtering issue cards.

test('active filters keep session cards and drop non-matching issue cards', () => {
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
  const html = AppView._renderKanbanInner();
  assert.match(html, /My pinned session/, 'pinned own session survives the filter');
  assert.match(html, /Shared by them/, 'shared session survives the filter');
  assert.match(html, /Only you can see your active sessions/, 'visibility caption renders');
  assert.doesNotMatch(html, /beta bug/, 'non-matching issue card is filtered out');
});
