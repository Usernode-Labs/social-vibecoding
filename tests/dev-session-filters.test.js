// The filter bar over SESSION cards (app-view.js _devCardMatches's 'session'
// kind, _kanbanView's In-progress pass, _sessionFilterNoteRow).
//
// Session cards used to be exempt from the filter bar entirely: type a search
// term and they just sat there in the In-progress column with no explanation.
// Now:
//
//   • text, #number, and a named person DO filter sessions, matching the label
//     the card shows, the issue numbers it links, and its author,
//   • priority / category genuinely cannot apply (a dev session carries no
//     such metadata), so they are an explicit no-op rather than a
//     rule the session can never satisfy — and the column SAYS SO out loud
//     instead of silently ignoring them.
//
// Run with: node --test tests/dev-session-filters.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { kanbanHtml } = require('./lib/dev-card-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
const MERGE_STATUS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'merge-status.js'), 'utf8');

function makeAppView() {
  const sandbox = {
    console,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s == null ? '' : s),
    escapeAttr: (s) => String(s == null ? '' : s),
    App: { user: { id: 42 }, currentApp: 'app' },
    Kudos: { renderButton: () => '', attach: () => {}, _ensureCache: () => ({ count: 0 }) },
    PlatformUI: { isTouch: () => false, actionSheet: () => {}, toast: () => {} },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${MERGE_STATUS_SRC}\n${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView._proposalsCtx = { majority: 1 };
  AppView._mergedCtx = { majority: 1 };
  AppView._visualsOpen = new Set();
  AppView._govProposals = [];
  AppView._ghIssuesMeta = {};
  AppView._sharedById = {};
  AppView._archivedSessions = [];
  return AppView;
}

const F = (over) => ({ q: '', priority: null, category: null, assignee: null, needsVote: false, ...over });
const SESS = (over) => ({
  id: 51, session_title: 'Dark mode work', status: 'active',
  created_at: '2026-06-01T00:00:00Z', last_activity_at: '2026-06-01T01:00:00Z', ...over,
});

// ── The predicate ───────────────────────────────────────────────────────

test('text matches the label the card actually shows, through its fallbacks', () => {
  const AppView = makeAppView();
  const m = (row, q) => AppView._devCardMatches('session', row, F({ q }));
  assert.ok(m(SESS(), 'dark'), 'session_title');
  assert.ok(m(SESS(), 'DARK'), 'case-insensitive');
  assert.ok(!m(SESS(), 'light'));
  // The card falls back session_title → pr_title → branch_name, so the
  // filter has to as well or a card would be unfindable by its own label.
  assert.ok(m({ pr_title: 'Tidy the header' }, 'tidy'));
  assert.ok(m({ branch_name: 'feat/dark-mode' }, 'feat/'));
});

test('#number matches the issue numbers the session links', () => {
  const AppView = makeAppView();
  const m = (row, q) => AppView._devCardMatches('session', row, F({ q }));
  assert.ok(m(SESS({ linked_issues: [900002, 900003] }), '#900002'));
  assert.ok(m(SESS({ linked_issues: [900002] }), '900002'), 'the leading # is optional');
  assert.ok(!m(SESS({ linked_issues: [900002] }), '#900999'));
  assert.ok(!m(SESS({ linked_issues: null }), '#900002'));
  // A session's own PR number is searchable too, once it has one.
  assert.ok(m(SESS({ pr_number: 700 }), '#700'));
});

test('a session matches on its owner, like every other card', () => {
  const AppView = makeAppView();
  assert.ok(AppView._devCardMatches('session', SESS({ username: 'maya' }), F({ q: 'maya' })));
});

test('priority / category are a no-op; a named person matches the session author', () => {
  const AppView = makeAppView();
  // Returning false here would hide every session the moment anyone picked a
  // priority — silently wrong, since a session cannot carry one.
  assert.equal(AppView._devCardMatches('session', SESS(), F({ priority: 'high' })), true);
  assert.equal(AppView._devCardMatches('session', SESS(), F({ category: 'bug' })), true);
  assert.equal(AppView._devCardMatches('session', SESS({ username: 'maya' }), F({ assignee: 'maya' })), true);
  assert.equal(AppView._devCardMatches('session', SESS({ username: 'maya' }), F({ assignee: 'sam' })), false);
  assert.equal(AppView._devCardMatches('session', SESS({ username: 'maya' }),
    F({ priority: 'high', category: 'bug', assignee: 'maya' })), true);
  // The Unassigned sentinel keeps its previous no-op behavior because a
  // session is not an assignable board item.
  assert.equal(AppView._devCardMatches('session', SESS(),
    F({ assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED })), true);
});

test('the no-op does NOT let a text filter through', () => {
  const AppView = makeAppView();
  // Text still has to match even when an inapplicable filter is also set.
  assert.equal(AppView._devCardMatches('session', SESS(), F({ q: 'nope', priority: 'high' })), false);
});

test('needs-my-vote excludes sessions (there is nothing to vote on yet)', () => {
  const AppView = makeAppView();
  assert.equal(AppView._devCardMatches('session', SESS(), F({ needsVote: true })), false);
});

// ── The visible note ────────────────────────────────────────────────────

test('the note names WHICH filters did not apply, and how many cards', () => {
  const AppView = makeAppView();
  AppView._kanbanFilters = F({ priority: 'high' });
  // The note is a `note` ListRow now (card/list-rows.tsx renders it); its
  // TEXT is what this file is about, so it reads the row's text.
  const note = (n) => (AppView._sessionFilterNoteRow(n) || { text: '' }).text;
  assert.match(note(1), /The 1 session card below is not filtered by priority/);

  AppView._kanbanFilters = F({ priority: 'high', assignee: 'maya' });
  // #1404: a NAMED person now applies to a session, through its author, so
  // the note must no longer claim it does not. Only the Unassigned sentinel
  // is still inapplicable — a session is not an assignable board item.
  assert.match(note(3), /The 3 session cards below are not filtered by priority/);
  // Scoped to the VARIABLE half: the note's fixed preamble ("Dev sessions
  // don't carry priority, category or assignee") names the word either way.
  assert.doesNotMatch(note(3).split('not filtered by')[1], /assignee/);

  AppView._kanbanFilters = F({
    priority: 'high', category: 'bug', assignee: AppView.KANBAN_ASSIGNEE_UNASSIGNED,
  });
  assert.match(note(2), /priority, category or assignee/);
});

test('the note is silent when there is nothing to explain', () => {
  const AppView = makeAppView();
  // No sessions in the column.
  AppView._kanbanFilters = F({ priority: 'high' });
  assert.equal(AppView._sessionFilterNoteRow(0), null);
  // No inapplicable filter active — a text filter DOES apply to sessions.
  AppView._kanbanFilters = F({ q: 'dark' });
  assert.equal(AppView._sessionFilterNoteRow(2), null);
  AppView._kanbanFilters = F();
  assert.equal(AppView._sessionFilterNoteRow(2), null);
});

// ── End to end through the column ───────────────────────────────────────

function board(AppView, filters, over) {
  const o = over || {};
  // A seeded board is a LOADED board. `_kanbanView()` reports `loading` until
  // this is set and the columns draw placeholders instead of cards — see
  // frontend/src/features/dev-board/card/skeleton.tsx.
  AppView._devDataReady = true;
  AppView._ghIssues = o.issues || [];
  AppView._envIssueNumbers = new Set();
  AppView._proposals = [];
  AppView._merged = [];
  AppView._mergedTotal = 0;
  AppView._mergedHasMore = false;
  AppView._mySessions = o.mine || [];
  AppView._sharedSessions = o.shared || [];
  AppView._kanbanFilters = filters;
  return kanbanHtml(AppView);
}

test('a text filter drops a non-matching session and keeps a matching one', () => {
  const AppView = makeAppView();
  const html = board(AppView, F({ q: 'dark' }), {
    mine: [SESS(), SESS({ id: 52, session_title: 'Unrelated refactor' })],
  });
  assert.match(html, /Dark mode work/);
  assert.doesNotMatch(html, /Unrelated refactor/);
});

test('an inapplicable filter keeps every session AND renders the note', () => {
  const AppView = makeAppView();
  const html = board(AppView, F({ priority: 'high' }), {
    mine: [SESS()],
    shared: [{ id: 71, session_title: 'Theirs', username: 'them', user_id: 9,
      shared_at: '2026-06-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z', chat_count: 0 }],
  });
  assert.match(html, /Dark mode work/);
  assert.match(html, /Theirs/);
  assert.match(html, /The 2 session cards below are not filtered by priority/);
});

test('a named person keeps sessions by that author and drops other sessions', () => {
  const AppView = makeAppView();
  const html = board(AppView, F({ assignee: 'maya' }), {
    mine: [SESS({ username: 'maya' })],
    shared: [{ id: 71, session_title: 'Theirs', username: 'them', user_id: 9,
      shared_at: '2026-06-01T00:00:00Z', created_at: '2026-06-01T00:00:00Z', chat_count: 0 }],
  });
  assert.match(html, /Dark mode work/);
  assert.doesNotMatch(html, /Theirs/);
  assert.doesNotMatch(html, /not filtered by assignee/);
});

test('the note counts only the sessions that SURVIVED the text filter', () => {
  const AppView = makeAppView();
  const html = board(AppView, F({ q: 'dark', priority: 'high' }), {
    mine: [SESS(), SESS({ id: 52, session_title: 'Unrelated refactor' })],
  });
  assert.match(html, /The 1 session card below is not filtered by priority/);
  assert.doesNotMatch(html, /Unrelated refactor/);
});

test('no note on an unfiltered board', () => {
  const AppView = makeAppView();
  const html = board(AppView, F(), { mine: [SESS()] });
  assert.doesNotMatch(html, /Dev sessions don't carry/);
});
