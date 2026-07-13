// Kanban view-mode: AppView._bucketDevItems() sorts the cached dev data
// into the four lifecycle columns shown on the board:
//
//   issues     — open GitHub issues with NO proposal yet (headless none/
//                failed/absent) and not linked to an open promoted proposal
//   inProgress — open issues whose headless proposal is generating/ready
//   inReview   — promoted PR proposals + governance proposals
//   done       — merged proposals
//
// The helper is pure (data in → buckets out, no DOM, no AppView state), so
// we load app-view.js into a vm context the same way feed-merge-pin-order
// does and call it directly with synthetic rows.
//
// Run with: node --test tests/dev-kanban-buckets.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

// Build a vm sandbox with app-view.js loaded. `over` can supply a custom
// `document`, `fetch`, `localStorage`, or `matchMedia` so tests that exercise
// the DOM-touching render paths (e.g. loadMoreMerged) can capture writes /
// steer the view mode / fake the viewport width. matchMedia is absent unless
// supplied — mirroring old browsers, and pinning the _getViewMode guard.
// Returns the sandbox; AppView is at sandbox.__AppView.
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

// Distinct, non-equal activity timestamps so recency ordering is unambiguous.
const at = (h) => `2026-06-01T${String(h).padStart(2, '0')}:00:00Z`;

const issue = (over) => ({
  number: over.number, title: `Issue ${over.number}`,
  updatedAt: at(1), lastMessageAt: at(1), headless: null,
  ...over,
});
const prop = (over) => ({
  id: over.id, pr_number: over.id * 10, pr_title: `PR ${over.id}`,
  username: 'me', user_id: 1, status: 'promoted', linked_issues: [],
  created_at: at(1), promoted_at: at(1), last_message_at: at(1),
  ...over,
});

// Buckets returned from the vm realm hold that realm's objects — compare by
// stable scalar keys mapped into the host realm.
const numbersOf = (items) => Array.from(items, (i) => i.number);
const idsOf = (items) => Array.from(items, (i) => i.id);
const reviewOf = (items) => Array.from(items, (x) => `${x.kind}:${x.item.id}`);

test('headless none/failed/absent → Issues; generating/ready → In progress', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 1, headless: null }),
      issue({ number: 2, headless: { status: 'failed' } }),
      issue({ number: 3, headless: { status: 'generating' } }),
      issue({ number: 4, headless: { status: 'ready' } }),
    ],
    proposals: [],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues).sort(), [1, 2]);
  assert.deepEqual(numbersOf(b.inProgress).sort(), [3, 4]);
});

test('issues linked to an open promoted proposal are excluded from both issue columns', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 10, headless: null }),
      issue({ number: 11, headless: { status: 'ready' } }),
      issue({ number: 12, headless: null }),
    ],
    // Proposal addresses issues 10 (plain) and 11 (ready) — both must drop
    // out of the issue columns since they render as the proposal card.
    proposals: [prop({ id: 100, linked_issues: [10, 11] })],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues), [12], 'only the unlinked plain issue remains');
  assert.deepEqual(numbersOf(b.inProgress), [], 'linked ready issue is removed');
  assert.deepEqual(reviewOf(b.inReview), ['proposal:100']);
});

test('In review holds promoted proposals + governance proposals', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [prop({ id: 1 }), prop({ id: 2 })],
    gov: [{ id: 9, kind: 'rename', created_at: at(1), last_message_at: at(1) }],
    merged: [],
  });
  const tags = reviewOf(b.inReview).sort();
  assert.deepEqual(tags, ['gov:9', 'proposal:1', 'proposal:2']);
});

test('In review: pinned pipeline states sort above normal, gov in the normal tier', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [
      prop({ id: 'normal', created_at: at(9), promoted_at: at(9), last_message_at: at(9) }),
      prop({ id: 'merging', status: 'merging', created_at: at(1), promoted_at: at(1), last_message_at: at(1) }),
    ],
    gov: [{ id: 'gov', kind: 'rename', created_at: at(8), last_message_at: at(8) }],
    merged: [],
  });
  // merging pins first; then the normal tier (rank 3) by recency: the
  // newest normal proposal (at 9) then the gov proposal (at 8).
  assert.deepEqual(reviewOf(b.inReview), ['proposal:merging', 'proposal:normal', 'gov:gov']);
});

test('Done holds merged rows, most-recent-activity first', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [],
    gov: [],
    merged: [
      { id: 1, created_at: at(2), last_message_at: at(2) },
      { id: 2, created_at: at(7), last_message_at: at(7) },
      { id: 3, created_at: at(5), last_message_at: at(5) },
    ],
  });
  assert.deepEqual(idsOf(b.done), [2, 3, 1]);
});

// ── #529: manually-completed tasks fold into the Done column ────────────────

test('Done interleaves manual completions with merged PRs by completion time', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [],
    proposals: [],
    gov: [],
    merged: [
      { id: 1, created_at: at(2), last_message_at: at(2) },
      { id: 2, created_at: at(6), last_message_at: at(6) },
    ],
    completed: [
      { number: 900, title: 'Manual A', completedAt: at(4) },
      { number: 901, title: 'Manual B', completedAt: at(8) },
    ],
  });
  // Newest-first across both kinds: 901 (8) > 2 (6) > 900 (4) > 1 (2).
  const key = (x) => (x._completed ? `c:${x.number}` : `m:${x.id}`);
  assert.deepEqual(Array.from(b.done, key), ['c:901', 'm:2', 'c:900', 'm:1']);
});

test('manual completions carry the _completed discriminator; merged rows do not', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [], proposals: [], gov: [],
    merged: [{ id: 1, created_at: at(1) }],
    completed: [{ number: 900, title: 'Manual', completedAt: at(2) }],
  });
  const flags = Array.from(b.done, (x) => !!x._completed);
  assert.deepEqual(flags, [true, false], 'the completion sorts first and is flagged');
});

test('_renderCompletedIssueCard shows the manual badge, #NN link, note; omits PR/undo/vote/kudos', () => {
  const AppView = makeAppView();
  AppView._ghIssuesMeta = { repoUrl: 'https://github.com/acme/widgets' };
  const html = AppView._renderCompletedIssueCard({
    number: 42,
    title: 'Migrated balances by hand',
    completedAt: at(3),
    completedByUsername: 'snait',
    note: 'Handled offchain',
  });
  assert.match(html, /Completed manually/, 'has the distinct badge');
  assert.match(html, /github\.com\/acme\/widgets\/issues\/42/, 'links the GitHub issue');
  assert.match(html, />#42</, 'shows the issue number, not a PR number');
  assert.match(html, /Migrated balances by hand/, 'shows the task title');
  assert.match(html, /Handled offchain/, 'shows the note');
  assert.match(html, /snait/, 'names who completed it');
  assert.doesNotMatch(html, /PR#/, 'no PR link');
  assert.doesNotMatch(html, /Undo/, 'no Undo button');
  assert.doesNotMatch(html, /loadMoreMerged|undoPr/, 'no merged-card actions');
});

test('_renderCompletedIssueCard escapes the title and note', () => {
  const AppView = makeAppView();
  // The sandbox's escapeHtml is a passthrough, so assert the values flow into
  // the escapeHtml call sites (title/note) rather than raw string identity —
  // here we just confirm both fields render and no crash on odd input.
  const html = AppView._renderCompletedIssueCard({
    number: 7, title: '<b>x</b>', completedAt: at(1), note: '<i>y</i>',
  });
  assert.match(html, /x/);
  assert.match(html, /y/);
});

test('issue columns sort newest-activity first', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({
    issues: [
      issue({ number: 1, updatedAt: at(2), lastMessageAt: at(2) }),
      issue({ number: 2, updatedAt: at(6), lastMessageAt: at(6) }),
      issue({ number: 3, updatedAt: at(4), lastMessageAt: at(4) }),
    ],
    proposals: [],
    gov: [],
    merged: [],
  });
  assert.deepEqual(numbersOf(b.issues), [2, 3, 1]);
});

test('empty / missing inputs yield four empty columns', () => {
  const AppView = makeAppView();
  const b = AppView._bucketDevItems({});
  // The result is a vm-realm object, so compare each column's length in the
  // host realm rather than deep-equalling the whole object across realms.
  assert.equal(b.issues.length, 0);
  assert.equal(b.inProgress.length, 0);
  assert.equal(b.inReview.length, 0);
  assert.equal(b.done.length, 0);
});

// ── Kanban "Done" column footer: expandable Load more (spec: make the Done
// column reach its remaining completed items in place) ─────────────────────

const mergedRow = (id, h) => ({
  id, pr_number: id * 10, pr_title: `PR ${id}`, username: 'me',
  created_at: at(h), status: 'merged',
});

// Seed the cached dev data the kanban renderer reads, with a Done column that
// has loaded fewer rows than the server total.
const seedDone = (AppView, { loaded, total, hasMore, loading }) => {
  AppView._ghIssues = [];
  AppView._proposals = [];
  AppView._govProposals = [];
  AppView._merged = Array.from({ length: loaded }, (_, i) => mergedRow(i + 1, (i % 23) + 1));
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedTotal = total;
  AppView._mergedHasMore = hasMore;
  AppView._mergedLoadingMore = loading;
};

test('Kanban Done footer is a clickable Load more button when more pages exist', () => {
  const AppView = makeAppView();
  seedDone(AppView, { loaded: 2, total: 25, hasMore: true, loading: false });
  const html = AppView._renderKanbanInner();
  assert.match(html, /onclick="AppView\.loadMoreMerged\(\)"/, 'wired to the pager');
  assert.match(html, /Load more \(23\)/, 'shows remaining count');
  assert.match(html, /class="gc-vote-btn"/, 'uses the shared button class');
  assert.doesNotMatch(html, /more completed/, 'no dead static hint when expandable');
});

test('Kanban Done Load more button is disabled with a Loading state while fetching', () => {
  const AppView = makeAppView();
  seedDone(AppView, { loaded: 2, total: 25, hasMore: true, loading: true });
  const html = AppView._renderKanbanInner();
  assert.match(html, /onclick="AppView\.loadMoreMerged\(\)"[^>]*>Loading…|disabled[^>]*onclick="AppView\.loadMoreMerged/);
  assert.match(html, /Loading…/);
  assert.match(html, /disabled/);
});

test('Kanban Done footer falls back to the static hint when the server has no more pages', () => {
  const AppView = makeAppView();
  // total exceeds loaded but hasMore=false — degenerate; keep a hint, no dead button.
  seedDone(AppView, { loaded: 1, total: 5, hasMore: false, loading: false });
  const html = AppView._renderKanbanInner();
  assert.match(html, /\+4 more completed/);
  assert.doesNotMatch(html, /loadMoreMerged/);
});

test('Kanban Done footer is absent once every completed item is loaded', () => {
  const AppView = makeAppView();
  seedDone(AppView, { loaded: 3, total: 3, hasMore: false, loading: false });
  const html = AppView._renderKanbanInner();
  assert.doesNotMatch(html, /loadMoreMerged/);
  assert.doesNotMatch(html, /more completed/);
});

// ── loadMoreMerged re-render is view-mode aware ────────────────────────────

// A capturing #gc-merged element; records innerHTML writes and no-ops the
// querySelector calls _applyAskAiCardAvailability makes.
const captureEl = (sink) => ({
  set innerHTML(v) { sink.push(v); },
  querySelector: () => null,
  querySelectorAll: () => ({ forEach: () => {} }),
});

const docWithGcMerged = (gcEl) => ({
  getElementById: (id) => (id === 'gc-merged' ? gcEl : null),
  querySelector: () => null,
  querySelectorAll: () => ({ forEach: () => {} }),
  addEventListener: () => {},
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
  body: { appendChild: () => {} },
});

const primePager = (AppView) => {
  AppView.appData = { slug: 'demo' };
  AppView._merged = [mergedRow(1, 1)];
  AppView._mergedCtx = { majority: 1, activeUsers: 1 };
  AppView._mergedHasMore = true;
  AppView._mergedLoadingMore = false;
  AppView._mergedCursor = { created_at: at(1), id: 1 };
};

test('loadMoreMerged repaints the board (not #gc-merged) in kanban mode', async () => {
  const writes = [];
  const ctx = makeCtx({
    localStorage: { getItem: () => 'kanban', setItem: () => {} },
    document: docWithGcMerged(captureEl(writes)),
    fetch: async () => ({ ok: true, json: async () => ({ merged: [], hasMore: false, total: 1 }) }),
  });
  const AppView = ctx.__AppView;
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  primePager(AppView);
  await AppView.loadMoreMerged();
  assert.ok(repaints >= 1, 'kanban mode repaints the whole board');
  assert.equal(writes.length, 0, '#gc-merged is never touched in kanban mode');
});

test('loadMoreMerged updates #gc-merged (not the board) in list mode', async () => {
  const writes = [];
  const ctx = makeCtx({
    localStorage: { getItem: () => 'list', setItem: () => {} },
    document: docWithGcMerged(captureEl(writes)),
    fetch: async () => ({ ok: true, json: async () => ({ merged: [], hasMore: false, total: 1 }) }),
  });
  const AppView = ctx.__AppView;
  let repaints = 0;
  AppView._repaintDevBody = () => { repaints += 1; };
  primePager(AppView);
  await AppView.loadMoreMerged();
  assert.equal(repaints, 0, 'list mode does not repaint the whole board');
  assert.ok(writes.length >= 1, '#gc-merged is updated in list mode');
});

// ── _getViewMode default: explicit preference, else width-based (#462) ─────

// A matchMedia stub that answers `wide` for the 1024px query and counts how
// many times it is evaluated (for the once-per-page-load memoization test).
const mediaStub = (wide, counter) => (query) => {
  if (counter) counter.n += 1;
  return { media: query, matches: wide };
};

test('no stored value + wide viewport → kanban by default', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: mediaStub(true),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'kanban');
});

test('no stored value + narrow viewport → list by default', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: mediaStub(false),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'list');
});

test('stored list beats the wide-viewport kanban default', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => 'list', setItem: () => {} },
    matchMedia: mediaStub(true),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'list');
});

test('stored kanban beats the narrow-viewport list default', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => 'kanban', setItem: () => {} },
    matchMedia: mediaStub(false),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'kanban');
});

test('no matchMedia in the environment → list (guarded fallback)', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  assert.equal(ctx.__AppView._getViewMode(), 'list');
});

test('unrecognized stored garbage falls through to the width-based default', () => {
  const ctx = makeCtx({
    localStorage: { getItem: () => 'banana', setItem: () => {} },
    matchMedia: mediaStub(true),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'kanban');
});

test('width-based default is memoized: media query evaluated once per context', () => {
  const counter = { n: 0 };
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: () => {} },
    matchMedia: mediaStub(true, counter),
  });
  const AppView = ctx.__AppView;
  assert.equal(AppView._getViewMode(), 'kanban');
  assert.equal(AppView._getViewMode(), 'kanban');
  assert.equal(AppView._getViewMode(), 'kanban');
  assert.equal(counter.n, 1, 'matchMedia consulted exactly once');
});

test('auto-default is never written back to localStorage', () => {
  const writes = [];
  const ctx = makeCtx({
    localStorage: { getItem: () => null, setItem: (k, v) => writes.push([k, v]) },
    matchMedia: mediaStub(true),
  });
  assert.equal(ctx.__AppView._getViewMode(), 'kanban');
  assert.equal(writes.length, 0, 'reading the mode must not persist the default');
});
