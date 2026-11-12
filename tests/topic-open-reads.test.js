// #6604: opening a thread in the side panel reads only what that thread
// needs, together, and never reloads the Workshop board.
//
//   1. _renderTopicSubView starts the item read and the thread prefetch in
//      the same tick, and requests no board path at all.
//   2. prefetchDevData is a no-op in the side panel's document and on a
//      topic's own address, and still loads the board elsewhere.
//   3. A live burst on an open request re-reads its own row once, not the
//      board.
//   4. One burst asks liveReads.resync for a path once.
//
// Loads the real public/js/app-view.js into a vm context with its externals
// stubbed (the approach tests/dev-topic-fast-open.test.js uses).
//
// Run with: node --test tests/topic-open-reads.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
};

function makeEl(id) {
  return {
    id, innerHTML: '', scrollTop: 0, _handlers: {},
    firstElementChild: null,
    addEventListener() {},
    setAttribute() {}, removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return { forEach() {} }; },
    scrollTo() {},
  };
}

function makeHarness({ embeddedPanel = false, hash = '#app/demo/dev/issues/7', threadPresent = true } = {}) {
  const els = {};
  const el = (id) => {
    if (!(id in els)) els[id] = makeEl(id);
    return els[id];
  };
  const thread = el('dev-topic-thread');
  thread.firstElementChild = makeEl('mounted');
  const fetches = [];
  const prefetched = [];
  const resyncs = [];
  const state = { threadPresent, devLoads: 0 };
  const resync = (reason, url) => { resyncs.push(url); };
  const sandbox = {
    console,
    relTime: () => 'just now',
    URLSearchParams,
    location: { search: '', hash, pathname: '/' },
    App: {
      user: { id: 1 }, currentApp: 'demo', currentTab: 'dev', currentSubTab: 'topic',
      embeddedPanel,
      switchTab() {},
    },
    GroupChat: { unmountThread() {}, mountThread() {}, refreshVoteControls() {} },
    UITelemetry: {},
    document: {
      getElementById: (id) => (id === 'dev-topic-thread'
        ? (state.threadPresent ? thread : null)
        : el(id)),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: (url) => {
      fetches.push(String(url));
      if (/\/github-issues\/7$/.test(String(url))) {
        return Promise.resolve({ ok: true, json: async () => ({ issue: { number: 7, title: 'Issue 7', state: 'open' } }) });
      }
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    },
    requestAnimationFrame: (fn) => fn(),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    PlatformI18n: englishPlatformI18n(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.UsernodeReact = {
    devBoard: {
      prefetchThread(slug, n) { prefetched.push(`${slug}:${n}`); return Promise.resolve(null); },
      mountTopicSubView() {},
    },
    liveReads: { resync },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'demo' };
  AppView._renderTopicHead = () => {};
  AppView._mountTopicThread = () => {};
  AppView._releaseTopicSwap = () => {};
  AppView._loadDevData = async () => { state.devLoads += 1; return true; };
  return { AppView, sandbox, fetchLog: fetches, prefetched, resyncs, state, thread };
}

const BOARD_PATHS = [
  '/github-issues?', '/issues?kinds=governance', '/promoted', '/merged',
  '/board-order', '/active-sessions', '/shared-sessions', '/topic-categories',
];

test('opening a request starts its item read and its thread read together, with no board paths', async () => {
  const h = makeHarness();
  // A row the board already holds is not there: this is a cold open.
  await h.AppView._renderTopicSubView(makeEl('content'), { kind: 'issue', id: 7 });

  assert.deepEqual(h.prefetched, ['demo:7'], 'the thread read starts in the same tick');
  assert.deepEqual(h.fetchLog, ['/api/apps/demo/github-issues/7'], 'one read, and it is the item');
  for (const p of BOARD_PATHS) {
    assert.ok(!h.fetchLog.some((url) => url.includes(p)), `no board path ${p}`);
  }
  assert.equal(h.state.devLoads, 0, 'the board is not loaded behind the page');
});

test('prefetchDevData is a no-op in the side panel and on a thread address', () => {
  const panel = makeHarness({ embeddedPanel: true });
  panel.AppView.prefetchDevData('demo');
  assert.equal(panel.state.devLoads, 0, 'the panel does not load the board');

  const onThread = makeHarness({ hash: '#app/demo/dev/proposals/501' });
  onThread.AppView.prefetchDevData('demo');
  assert.equal(onThread.state.devLoads, 0, 'a topic address does not load the board');

  const elsewhere = makeHarness({ hash: '#app/demo/dev/topic' });
  elsewhere.AppView.prefetchDevData('demo');
  assert.equal(elsewhere.state.devLoads, 1, 'the Workshop still loads the board');
});

test('a live burst on an open request re-reads its own row and not the board', async () => {
  const h = makeHarness();
  h.AppView._devTopic = { kind: 'issue', id: 7 };
  h.AppView._devTopicInPanel = false;
  h.sandbox.App.currentSubTab = 'topic';
  h.AppView._ghIssues = [{ number: 7, title: 'Issue 7', state: 'open' }];
  h.AppView._devDataSlug = 'demo';

  await h.AppView._refreshTopicLive({ kinds: new Set(['issue']), ids: new Set([7]) });
  assert.deepEqual(h.fetchLog, ['/api/apps/demo/github-issues/7'], 'one read: the request itself');
  assert.equal(h.state.devLoads, 0, 'no board load');
});

test('one live burst asks the thread to resync a path once', () => {
  const h = makeHarness();
  h.AppView._devTopic = { kind: 'issue', id: 7 };
  h.AppView._devTopicInPanel = true;
  const live = {
    kinds: new Set(['issue']), ids: new Set([7]), numbers: new Set([7]),
    slugs: new Set(['demo']), unnamed: false, devRead: true, resynced: new Set(),
  };
  assert.equal(h.AppView.refreshShownTopic(live), true);
  assert.equal(h.AppView.refreshShownTopic(live), true, 'the second surface is still answered');
  assert.deepEqual(h.resyncs, ['/api/apps/demo/threads/7'], 'but the path is resynced once');
});
