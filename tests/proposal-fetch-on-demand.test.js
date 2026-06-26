// Fetch-on-demand recovery for opening a proposal that isn't in any cached
// client list (the Completed list is keyset-paginated, so a merged proposal
// beyond the first page is unresolvable from state). Covers the app-view.js
// changes:
//   1. _fetchProposalById() loads one proposal, caches it in _topicProposal,
//      and seeds the inline vote snapshot — so _findTopicItem() resolves it.
//   2. _findTopicItem() consults _topicProposal last, keyed by id (a stale
//      one from another topic never resolves).
//   3. _renderTopicSubView() tries the on-demand fetch before falling back
//      to the forum, and mounts the thread when it succeeds.
//   4. A genuinely missing proposal (fetch 404) still falls back to the
//      forum via App.switchTab('dev').
//
// app-view.js is a plain browser script; we load its source into a vm
// context with the external globals stubbed (same approach as
// merged-discussion.test.js).
//
// Run with: node --test tests/proposal-fetch-on-demand.test.js

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
  return { AppView, sandbox, els, switchTabCalls };
}

const mergedRow = (over) => ({
  id: 9100024,
  pr_number: 910124,
  pr_title: '[Mock] Completed: an older merged proposal',
  username: 'evan',
  user_id: 9,
  status: 'merged',
  created_at: '2026-05-01T00:00:00Z',
  yes_count: 2,
  no_count: 0,
  chat_count: 3,
  ...over,
});

test('_fetchProposalById caches the row, seeds voteState, and is resolvable', async () => {
  const row = mergedRow();
  const { AppView, sandbox } = makeAppView({
    fetchImpl: async (url) => {
      assert.match(url, /\/api\/apps\/demo\/proposals\/9100024/, 'hits the by-id endpoint');
      return { ok: true, json: async () => ({ proposal: row }) };
    },
  });
  AppView.voteState = { bySession: {}, byPrNumber: {} };

  const out = await AppView._fetchProposalById(9100024);
  assert.equal(out.id, 9100024, 'returns the row');
  assert.equal(AppView._topicProposal.id, 9100024, 'cached in _topicProposal');
  assert.equal(AppView.voteState.bySession['9100024'], row, 'vote snapshot seeded by id');
  assert.equal(AppView.voteState.byPrNumber['910124'], row, 'vote snapshot seeded by pr_number');
  assert.ok(sandbox.__refreshed >= 1, 'vote controls refreshed');

  // _findTopicItem now resolves it (nothing in _proposals/_merged).
  AppView._devTopic = { kind: 'proposal', id: 9100024 };
  AppView._proposals = [];
  AppView._merged = [];
  assert.equal(AppView._findTopicItem(), row, 'resolved via _topicProposal');
});

test('_findTopicItem ignores a stale _topicProposal from another topic', () => {
  const { AppView } = makeAppView();
  AppView._proposals = [];
  AppView._merged = [];
  AppView._topicProposal = mergedRow({ id: 777 });
  AppView._devTopic = { kind: 'proposal', id: 9100024 };
  assert.equal(AppView._findTopicItem(), null, 'mismatched id does not resolve');
});

test('_fetchProposalById returns null and leaves cache untouched on a 404', async () => {
  const { AppView } = makeAppView({
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Proposal not found' }) }),
  });
  const out = await AppView._fetchProposalById(123);
  assert.equal(out, null);
  assert.equal(AppView._topicProposal, null, 'cache untouched');
});

test('_renderTopicSubView fetches on demand and mounts the thread (no forum fallback)', async () => {
  const thread = makeEl('dev-topic-thread');
  const row = mergedRow();
  const { AppView, sandbox, switchTabCalls } = makeAppView({
    thread,
    fetchImpl: async (url) => {
      if (/\/proposals\/9100024/.test(url)) return { ok: true, json: async () => ({ proposal: row }) };
      return { ok: true, json: async () => ({}) };
    },
  });
  // Caches start empty; _loadDevData succeeds but finds nothing.
  AppView._loadDevData = async () => { AppView._proposals = []; AppView._merged = []; return true; };
  let mounted = 0; let headed = 0;
  AppView._mountTopicThread = () => { mounted++; };
  AppView._renderTopicHead = () => { headed++; };

  const content = makeEl('content');
  await AppView._renderTopicSubView(content, { kind: 'proposal', id: 9100024 });

  assert.equal(AppView._topicProposal.id, 9100024, 'fetched on demand');
  assert.equal(mounted, 1, 'thread mounted');
  assert.equal(headed, 1, 'head painted');
  assert.deepEqual(switchTabCalls, [], 'did NOT fall back to the forum');
  assert.ok(sandbox); // touch to satisfy lints
});

test('_renderTopicSubView falls back to the forum when the proposal is truly missing', async () => {
  const thread = makeEl('dev-topic-thread');
  const { AppView, switchTabCalls } = makeAppView({
    thread,
    fetchImpl: async (url) => {
      if (/\/proposals\//.test(url)) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    },
  });
  AppView._loadDevData = async () => { AppView._proposals = []; AppView._merged = []; return true; };
  let mounted = 0;
  AppView._mountTopicThread = () => { mounted++; };
  AppView._renderTopicHead = () => {};

  const content = makeEl('content');
  await AppView._renderTopicSubView(content, { kind: 'proposal', id: 424242 });

  assert.equal(mounted, 0, 'thread never mounted');
  assert.deepEqual(switchTabCalls, [['dev']], 'fell back to the dev forum');
});
