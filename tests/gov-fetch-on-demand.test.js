// (#1115) Fetch-on-demand recovery for opening a GOVERNANCE proposal that
// isn't in any cached client list. Applied close-issue proposals live in the
// keyset-paginated Completed stream (_merged, which _loadDevData resets to
// page 1 on every call) and NOT in _govProposals (open rows only) — so every
// settled close card outside the newest page was a dead click: _findTopicItem
// came up empty and _renderTopicSubView bounced to the board with no message.
//
// This is the governance twin of proposal-fetch-on-demand.test.js and covers:
//   1. _fetchGovProposalById() loads one proposal and caches it in _topicGov.
//   2. _findTopicItem() consults _topicGov last, keyed by id (a stale one
//      from another topic never resolves).
//   3. _renderTopicSubView({kind:'gov'}) tries the on-demand fetch before
//      falling back to the board, and mounts the thread when it succeeds.
//   4. A genuinely missing proposal (fetch 404) falls back to the board AND
//      toasts, so the click never looks like it did nothing.
//   5. The gov fetch leaves voteState alone (governance ids collide
//      numerically with chat_sessions ids).
//
// app-view.js is a plain browser script; we load its source into a vm
// context with the external globals stubbed (same approach as
// proposal-fetch-on-demand.test.js).
//
// Run with: node --test tests/gov-fetch-on-demand.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    scrollTop: 0,
    _handlers: {},
    addEventListener(type, fn) { this._handlers[type] = fn; },
    querySelector() { return null; },
    querySelectorAll() { return { forEach() {} }; },
    scrollTo() {},
  };
}

// `fetchImpl` lets each test script the network. `thread` is the element
// returned for #dev-topic-thread (truthy keeps _renderTopicSubView alive).
function makeAppView({ fetchImpl, thread = null } = {}) {
  const els = {};
  const getEl = (id) => {
    if (id in els) return els[id];
    els[id] = makeEl(id);
    return els[id];
  };
  const switchTabCalls = [];
  const toasts = [];
  const sandbox = {
    console,
    relTime: () => 'just now',
    URLSearchParams,
    location: { search: '' },
    App: {
      user: { id: 1 }, currentApp: 'demo',
      switchTab(...a) { switchTabCalls.push(a); },
    },
    Kudos: { renderButton: () => '<button class="kudos">k</button>' },
    PlatformUI: { toast(msg) { toasts.push(msg); } },
    GroupChat: {
      unmountThread() {},
      mountThread(opts) { sandbox.__mountOpts = opts; },
      refreshVoteControls() { sandbox.__refreshed = (sandbox.__refreshed || 0) + 1; },
    },
    document: {
      getElementById: (id) => (id === 'dev-topic-thread' ? thread : getEl(id)),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    requestAnimationFrame: (fn) => fn(),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  return { AppView, sandbox, els, switchTabCalls, toasts };
}

// An APPLIED close-issue row, shaped like GET /api/apps/:slug/governance/:id
// returns it (the /merged close-row shape plus row_type).
const closeRow = (over) => ({
  id: 9100062,
  row_type: 'close_issue',
  kind: 'close_issue',
  status: 'closed',
  title: '[Mock] Close issue #900003: "Topic cards overflow on narrow phones"',
  description: '[Mock] Fixed by the responsive rework.',
  payload: {
    issueNumber: 900003,
    reason: '[Mock] Fixed by the responsive rework.',
    appliedAt: '2026-07-12T00:00:00Z',
    appliedBy: 'group-vote',
    upCount: 2,
    required: 2,
  },
  created_by_username: 'staging-tester',
  created_at: '2026-07-10T00:00:00Z',
  up_count: 2,
  down_count: 0,
  chat_count: 4,
  last_message_at: null,
  ...over,
});

test('_fetchGovProposalById caches the row and makes it resolvable', async () => {
  const row = closeRow();
  const { AppView } = makeAppView({
    fetchImpl: async (url) => {
      assert.match(url, /\/api\/apps\/demo\/governance\/9100062/, 'hits the by-id endpoint');
      return { ok: true, json: async () => ({ proposal: row }) };
    },
  });

  const out = await AppView._fetchGovProposalById(9100062);
  assert.equal(out.id, 9100062, 'returns the row');
  assert.equal(AppView._topicGov.id, 9100062, 'cached in _topicGov');

  // _findTopicItem now resolves it (nothing in _govProposals/_merged).
  AppView._devTopic = { kind: 'gov', id: 9100062 };
  AppView._govProposals = [];
  AppView._merged = [];
  assert.equal(AppView._findTopicItem(), row, 'resolved via _topicGov');
});

test('_fetchGovProposalById forwards ?demo=1 so mock rows resolve', async () => {
  let seen = null;
  const { AppView, sandbox } = makeAppView({
    fetchImpl: async (url) => {
      seen = url;
      return { ok: true, json: async () => ({ proposal: closeRow() }) };
    },
  });
  sandbox.location.search = '?demo=1';
  await AppView._fetchGovProposalById(9100062);
  assert.match(seen, /demo=1/, 'demo flag carried onto the by-id fetch');
});

test('the gov fetch does not touch voteState (id spaces collide)', async () => {
  const { AppView } = makeAppView({
    fetchImpl: async () => ({ ok: true, json: async () => ({ proposal: closeRow() }) }),
  });
  AppView.voteState = { bySession: {}, byPrNumber: {} };
  await AppView._fetchGovProposalById(9100062);
  assert.deepEqual(AppView.voteState.bySession, {}, 'no session-keyed entry');
  assert.deepEqual(AppView.voteState.byPrNumber, {}, 'no pr-keyed entry');
});

test('_findTopicItem ignores a stale _topicGov from another topic', () => {
  const { AppView } = makeAppView();
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._topicGov = closeRow({ id: 777 });
  AppView._devTopic = { kind: 'gov', id: 9100062 };
  assert.equal(AppView._findTopicItem(), null, 'mismatched id does not resolve');
});

test('_findTopicItem still prefers the cached lists over _topicGov', () => {
  const { AppView } = makeAppView();
  const cached = closeRow({ chat_count: 99 });
  AppView._govProposals = [];
  AppView._merged = [cached];
  AppView._topicGov = closeRow({ chat_count: 0 });
  AppView._devTopic = { kind: 'gov', id: 9100062 };
  assert.equal(AppView._findTopicItem(), cached, '_merged row wins');
});

test('openTopic clears a previously cached gov row', () => {
  const { AppView } = makeAppView();
  AppView._topicGov = closeRow();
  AppView.openTopic('gov', 9100060);
  assert.equal(AppView._topicGov, null, 'cache dropped on navigation');
});

test('_fetchGovProposalById returns null and leaves the cache untouched on a 404', async () => {
  const { AppView } = makeAppView({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Proposal not found' }) }),
  });
  const out = await AppView._fetchGovProposalById(123);
  assert.equal(out, null);
  assert.equal(AppView._topicGov, null, 'cache untouched');
});

test('_renderTopicSubView fetches a gov row on demand and mounts the thread', async () => {
  const thread = makeEl('dev-topic-thread');
  const row = closeRow();
  const { AppView, switchTabCalls, toasts } = makeAppView({
    thread,
    fetchImpl: async (url) => {
      if (/\/governance\/9100062/.test(url)) return { ok: true, json: async () => ({ proposal: row }) };
      return { ok: true, json: async () => ({}) };
    },
  });
  // Caches start empty — exactly what _loadDevData leaves behind for an
  // applied close proposal that isn't on the Completed stream's first page.
  AppView._loadDevData = async () => {
    AppView._govProposals = []; AppView._merged = []; return true;
  };
  let mounted = 0; let headed = 0;
  AppView._mountTopicThread = () => { mounted++; };
  AppView._renderTopicHead = () => { headed++; };

  const content = makeEl('content');
  await AppView._renderTopicSubView(content, { kind: 'gov', id: 9100062 });

  assert.equal(AppView._topicGov.id, 9100062, 'fetched on demand');
  assert.equal(mounted, 1, 'thread mounted');
  assert.equal(headed, 1, 'head painted');
  assert.deepEqual(switchTabCalls, [], 'did NOT bounce back to the board');
  assert.deepEqual(toasts, [], 'nothing to explain — it worked');
});

test('_renderTopicSubView still works when the gov row IS cached (no regression)', async () => {
  const thread = makeEl('dev-topic-thread');
  const row = closeRow({ id: 9100060 });
  let fetched = 0;
  const { AppView, switchTabCalls } = makeAppView({
    thread,
    fetchImpl: async (url) => {
      if (/\/governance\//.test(url)) fetched++;
      return { ok: true, json: async () => ({}) };
    },
  });
  AppView._loadDevData = async () => {
    AppView._govProposals = []; AppView._merged = [row]; return true;
  };
  let mounted = 0;
  AppView._mountTopicThread = () => { mounted++; };
  AppView._renderTopicHead = () => {};

  const content = makeEl('content');
  await AppView._renderTopicSubView(content, { kind: 'gov', id: 9100060 });

  assert.equal(mounted, 1, 'thread mounted from the cached row');
  assert.equal(fetched, 0, 'no needless by-id fetch');
  assert.deepEqual(switchTabCalls, [], 'no bounce');
});

test('_renderTopicSubView toasts and falls back when the gov row is truly missing', async () => {
  const thread = makeEl('dev-topic-thread');
  const { AppView, switchTabCalls, toasts } = makeAppView({
    thread,
    fetchImpl: async (url) => {
      if (/\/governance\//.test(url)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    },
  });
  AppView._loadDevData = async () => {
    AppView._govProposals = []; AppView._merged = []; return true;
  };
  let mounted = 0;
  AppView._mountTopicThread = () => { mounted++; };
  AppView._renderTopicHead = () => {};

  const content = makeEl('content');
  await AppView._renderTopicSubView(content, { kind: 'gov', id: 424242 });

  assert.equal(mounted, 0, 'thread never mounted');
  assert.deepEqual(switchTabCalls, [['dev']], 'fell back to the dev board');
  assert.equal(toasts.length, 1, 'the dead end is explained');
  assert.match(toasts[0], /discussion/i);
});

test('a missing ISSUE topic stays silent (unchanged behaviour)', async () => {
  const thread = makeEl('dev-topic-thread');
  const { AppView, switchTabCalls, toasts } = makeAppView({
    thread,
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  AppView._loadDevData = async () => { AppView._ghIssues = []; return true; };
  AppView._mountTopicThread = () => {};
  AppView._renderTopicHead = () => {};

  const content = makeEl('content');
  await AppView._renderTopicSubView(content, { kind: 'issue', id: 1069 });

  assert.deepEqual(switchTabCalls, [['dev']], 'fell back to the dev board');
  assert.deepEqual(toasts, [], 'a closed GitHub issue legitimately misses — no toast');
});

// ── The governance cache went stale for the same reason ───────────────
//
// _topicGov is _topicProposal's twin and had the identical defect: written
// once when the topic opens, cleared only by openTopic, refreshed by
// nothing. A settled close proposal opened from beyond the cached page
// repainted a snapshot frozen at page-open on every WS-driven refresh.

test('_refreshTopicOnDemandRow re-fetches a governance row the lists cannot supply', async () => {
  let fetches = 0;
  const { AppView } = makeAppView({
    fetchImpl: async (url) => {
      fetches += 1;
      assert.match(url, /\/api\/apps\/demo\/governance\/9100062/, 'hits the governance by-id endpoint');
      return { ok: true, json: async () => ({ proposal: closeRow({ status: 'applied' }) }) };
    },
  });
  AppView._govProposals = [];
  AppView._merged = [];
  AppView._topicGov = closeRow({ status: 'open' });
  AppView._devTopic = { kind: 'gov', id: 9100062 };

  await AppView._refreshTopicOnDemandRow();
  assert.equal(fetches, 1, 'the stale governance row is re-fetched');
  assert.equal(AppView._findTopicItem().status, 'applied',
    'and resolves to the LIVE state rather than the opening snapshot');
});

test('the governance refresh no-ops when a list holds the row', async () => {
  let fetches = 0;
  const { AppView } = makeAppView({ fetchImpl: async () => { fetches += 1; return { ok: false }; } });
  AppView._devTopic = { kind: 'gov', id: 9100062 };
  AppView._topicGov = closeRow();

  AppView._govProposals = [closeRow()];
  AppView._merged = [];
  await AppView._refreshTopicOnDemandRow();
  assert.equal(fetches, 0, 'the open governance list holds it');

  // …and the applied twin, which lives in _merged as a close_issue row —
  // matched on row_type too, exactly as _findTopicItem matches it.
  AppView._govProposals = [];
  AppView._merged = [closeRow({ row_type: 'close_issue' })];
  await AppView._refreshTopicOnDemandRow();
  assert.equal(fetches, 0, 'the completed page holds it');
});
