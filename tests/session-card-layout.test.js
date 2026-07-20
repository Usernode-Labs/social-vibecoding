// In-progress session cards: the two-row card layout (title row + wrapping
// actions row) that fixes the crushed-title / crazy-tall card in the busy
// "working" state, the explicit "Open chat" action on visible own sessions,
// and the private/visible split around the "Show archived" toggle in both
// the kanban In progress column (_inProgressCardsHtml) and the list view's
// pinned block (_mySessionsBlockHtml).
//
// app-view.js is a plain browser script (`const AppView = {…}`); we load it
// into a vm context, stub the globals it reaches, and assert on the returned
// HTML strings — same harness as dev-kanban-buckets.test.js.
//
// Run with: node --test tests/session-card-layout.test.js

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

const mySess = (over) => ({
  id: 51, session_title: 'My session', status: 'active',
  created_at: '2026-06-01T01:00:00Z', last_activity_at: '2026-06-01T02:00:00Z',
  ...over,
});
const sharedSess = (over) => ({
  id: 71, session_title: 'Their session', status: 'active', username: 'them',
  user_id: 9, shared_at: '2026-06-01T01:00:00Z', created_at: '2026-06-01T00:00:00Z',
  chat_count: 2,
  ...over,
});

// Assert every marker is present and they appear in the given order.
function assertOrder(html, markers) {
  let prev = -1;
  for (const m of markers) {
    const i = html.indexOf(m);
    assert.ok(i >= 0, `expected marker in html: ${m}`);
    assert.ok(i > prev, `expected marker in order: ${m}`);
    prev = i;
  }
}

// Structural markers for the two-row card: the chevron path closes the
// title row, so anything indexed AFTER it lives in the actions row.
const CHEVRON = 'M9 5l7 7-7 7';
const ACTIONS_ROW = 'flex flex-wrap items-center gap-2';
const SPINNER = 'dc-status-spinner-arc';

// ── Two-row layout ──────────────────────────────────────────────────────────

test('busy own card: controls sit in a wrapping actions row below the title', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({ busy: true }));
  assert.match(html, /break-words/, 'title still word-wraps');
  assert.ok(html.includes(ACTIONS_ROW), 'actions row container flex-wraps');
  // Title row ends at the chevron; the busy tag, visibility button and
  // Archive all come after it (i.e. in the actions row, not beside the
  // title where they could crush it to zero width).
  assertOrder(html, ['break-words', CHEVRON, ACTIONS_ROW, SPINNER, 'Make visible', 'data-archive-chip="51"']);
});

test('shared card: badge + Preview sit in the actions row; noNav drops nav and chevron', () => {
  const AppView = makeAppView();
  const s = sharedSess({ busy: true, staging_url: 'https://example.invalid' });
  const nav = AppView._renderSharedSessionCard(s);
  assert.match(nav, /data-shared-session-row="71"/);
  assertOrder(nav, ['break-words', CHEVRON, ACTIONS_ROW, SPINNER, 'dev-chat-badge', 'Preview']);

  const noNav = AppView._renderSharedSessionCard(s, { noNav: true });
  assert.doesNotMatch(noNav, /data-shared-session-row/, 'noNav variant has no row hook');
  assert.ok(!noNav.includes(CHEVRON), 'noNav variant has no chevron');
  assert.ok(noNav.includes(ACTIONS_ROW), 'noNav variant keeps the actions row');
});

// ── Preview pill gating (#689) ──────────────────────────────────────────────

test('shared card: can_preview without a live staging_url still gets Preview (empty fallback)', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: null }));
  assert.match(html, /Preview<\/button>/);
  // Routed through ensure-staging with no last-known URL — the server
  // decides live-vs-rebuild.
  assert.match(html, /swapToStagingForSession\(71, ''\)/);
});

test('shared card: no pushed changes (can_preview false) → no Preview pill', () => {
  const AppView = makeAppView();
  const html = AppView._renderSharedSessionCard(sharedSess({ can_preview: false, staging_url: null }));
  assert.doesNotMatch(html, /Preview<\/button>/);
});

test('shared card, read-only viewer: pill requires a live staging_url', () => {
  const AppView = makeAppView();
  // readOnly is a getter over appData.can_collaborate (#621).
  AppView.appData = { can_collaborate: false };
  const rebuildOnly = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: null }));
  assert.doesNotMatch(rebuildOnly, /Preview<\/button>/, 'read-only viewers cannot trigger a rebuild');
  const live = AppView._renderSharedSessionCard(sharedSess({ can_preview: true, staging_url: 'https://example.invalid' }));
  assert.match(live, /Preview<\/button>/, 'a live URL still opens directly');
  assert.match(live, /swapToStagingForSession\(71, 'https:\/\/example\.invalid'\)/);
});

test('own card: Preview pill gated on pr_number (a PR exists once changes are pushed)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const withPr = AppView._renderMySessionCard(mySess({ pr_number: 123 }));
  assert.match(withPr, /Preview<\/button>/);
  assert.match(withPr, /swapToStagingForSession\(51, ''\)/);
  const noPr = AppView._renderMySessionCard(mySess({ pr_number: null }));
  assert.doesNotMatch(noPr, /Preview<\/button>/);
});

// ── "Open chat" on visible own sessions ─────────────────────────────────────

test('visible own card renders the labeled Open chat button (count from _sharedById)', () => {
  const AppView = makeAppView();
  AppView._sharedById = { 51: { id: 51, chat_count: 4 } };
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.match(html, /Open chat/, 'labeled button text');
  assert.match(html, /data-session-discuss="51"/, 'delegated discuss hook');
  assert.match(html, /data-count="4"/, 'badge carries the shared row count');
  assert.match(html, /data-unshare-chip="51"/, 'Hide stays available');
});

test('freshly-visible card (no _sharedById row yet) still gets Open chat at count 0', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({ shared_at: '2026-06-01T03:00:00Z' }));
  assert.match(html, /Open chat/);
  assert.match(html, /data-session-discuss="51"/);
  assert.match(html, /data-count="0"/);
});

test('private own card has no Open chat and keeps Make visible', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  const html = AppView._renderMySessionCard(mySess({}));
  assert.doesNotMatch(html, /Open chat/);
  assert.doesNotMatch(html, /data-session-discuss/);
  assert.match(html, /data-share-chip="51"/, 'Make visible renders');
});

// ── Private/visible split around the archived toggle ────────────────────────

const issueEntry = () => ({
  kind: 'issue',
  item: {
    number: 5, title: 'Issue five', headless: { status: 'generating' },
    priority: null, assignee: null,
  },
});

test('kanban In progress: private → archived toggle → visible → issues → shared', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [mySess({ id: 90, session_title: 'Old one', status: 'archived' })];
  const entries = [
    { kind: 'my-session', item: mySess({ id: 1, session_title: 'Private one' }) },
    { kind: 'my-session', item: mySess({ id: 2, session_title: 'Visible one', shared_at: '2026-06-01T03:00:00Z' }) },
    issueEntry(),
    { kind: 'shared-session', item: sharedSess({ id: 71 }) },
  ];
  const html = AppView._inProgressCardsHtml(entries, false);
  assertOrder(html, [
    'Only you can see your active sessions.',
    'data-session-chip="1"',
    'Show archived (1)',
    'Visible to everyone —',
    'data-session-chip="2"',
    'Issue five',
    'data-shared-session-row="71"',
  ]);
});

test('kanban In progress: no private sessions → no private caption; block still renders', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [];
  const entries = [
    { kind: 'my-session', item: mySess({ id: 2, shared_at: '2026-06-01T03:00:00Z' }) },
  ];
  const html = AppView._inProgressCardsHtml(entries, false);
  assert.doesNotMatch(html, /Only you can see your active sessions/);
  assertOrder(html, ['Visible to everyone —', 'data-session-chip="2"']);
});

test('kanban In progress: no visible sessions → nothing below the archived toggle', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._archivedSessions = [mySess({ id: 90, status: 'archived' })];
  const entries = [{ kind: 'my-session', item: mySess({ id: 1 }) }];
  const html = AppView._inProgressCardsHtml(entries, false);
  assert.doesNotMatch(html, /Visible to everyone —/);
  assertOrder(html, ['Only you can see your active sessions.', 'data-session-chip="1"', 'Show archived (1)']);
});

test('list view pinned block mirrors the split', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._mySessions = [
    mySess({ id: 1, session_title: 'Private one' }),
    mySess({ id: 2, session_title: 'Visible one', shared_at: '2026-06-01T03:00:00Z' }),
  ];
  AppView._archivedSessions = [mySess({ id: 90, session_title: 'Old one', status: 'archived' })];
  const html = AppView._mySessionsBlockHtml();
  assertOrder(html, [
    'Only you can see your active sessions.',
    'data-session-chip="1"',
    'Show archived (1)',
    'Visible to everyone —',
    'data-session-chip="2"',
  ]);
});

test('list view pinned block: only a visible session still renders (no private caption)', () => {
  const AppView = makeAppView();
  AppView._sharedById = {};
  AppView._mySessions = [mySess({ id: 2, shared_at: '2026-06-01T03:00:00Z' })];
  AppView._archivedSessions = [];
  const html = AppView._mySessionsBlockHtml();
  assert.notEqual(html, '');
  assert.doesNotMatch(html, /Only you can see your active sessions/);
  assertOrder(html, ['Visible to everyone —', 'data-session-chip="2"']);
});

test('list view pinned block: nothing to show → empty string', () => {
  const AppView = makeAppView();
  AppView._mySessions = [];
  AppView._archivedSessions = [];
  assert.equal(AppView._mySessionsBlockHtml(), '');
});
