// Fast open for topic pages (#4524): a request, proposal or governance page
// opened from a notification, a message card or any other link draws as soon
// as ITS OWN item has loaded, instead of waiting for the project's whole
// board. Covers the app-view.js changes:
//   1. _renderTopicSubView starts the board load UNAWAITED and mounts an
//      issue's / governance thread for the ref alone, before any item is
//      known.
//   2. The page paints from whichever resolves the item first — the
//      same-app lists (already loaded), an on-demand cache, or the item's
//      own single fetch — and the board's arrival repaints the head from
//      its list row.
//   3. The lists answer only for the app _devDataSlug names, so another
//      app's row #30 is never painted under this app's name.
//   4. The board failing no longer sinks a page the item can paint; both
//      missing still falls back to the board, only after both settle.
//   5. `topic_load` records success, failure (not_found) and cancel.
//
// app-view.js is a plain browser script; we load its source into a vm
// context with the external globals stubbed (same approach as
// proposal-fetch-on-demand.test.js).
//
// Run with: node --test tests/dev-topic-fast-open.test.js

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

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

// A telemetry stub with the three calls app-view.js makes. `terminal` keeps
// the one outcome per attempt the real module allows (outcome() deletes the
// attempt, so a second call is a no-op there).
function makeTelemetry() {
  const attempts = [];
  const outcomes = [];
  let n = 0;
  return {
    attempts,
    outcomes,
    attempt(action, ctx) {
      const id = `attempt-${++n}`;
      attempts.push({ id, action, ...ctx });
      return id;
    },
    outcome(id, code, detail) {
      outcomes.push({ id, code, ...(detail || {}) });
    },
    cancel(id) {
      outcomes.push({ id, code: 'cancelled' });
    },
  };
}

// `board` is what the stubbed _loadDevData returns (a deferred keeps the
// board pending); `fetchItem` scripts the single-item fetch. `threadPresent`
// is mutable so a test can walk away mid-load.
function makeAppView({ board = null, fetchImpl } = {}) {
  const els = {};
  const getEl = (id) => {
    if (id in els) return els[id];
    els[id] = makeEl(id);
    return els[id];
  };
  const state = { threadPresent: true };
  const thread = makeEl('dev-topic-thread');
  const switchTabCalls = [];
  const mountThreads = [];
  const heads = [];
  const fetchLog = [];
  const telemetry = makeTelemetry();
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
      mountThread(opts) { mountThreads.push(opts); },
      refreshVoteControls() {},
    },
    UITelemetry: telemetry,
    document: {
      getElementById: (id) => (
        id === 'dev-topic-thread' ? (state.threadPresent ? thread : null) : getEl(id)
      ),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    fetch: (url) => { fetchLog.push(String(url)); return fetchImpl(url); },
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
  if (board) AppView._loadDevData = () => board.promise;
  AppView._renderTopicHead = () => { heads.push(AppView._findTopicItem()); };
  return {
    AppView, sandbox, thread, state, switchTabCalls, mountThreads, heads,
    fetchLog, telemetry,
  };
}

const ISSUE = { kind: 'issue', id: 30 };

async function tick(n = 4) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

test('an issue head paints once its single fetch answers, board still pending', async () => {
  const board = deferred();
  const item = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => (
      /\/github-issues\/30$/.test(url)
        ? item.promise.then(() => ({ ok: true, json: async () => ({ issue: { number: 30, title: 'Issue 30', state: 'open' } }) }))
        : Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    ),
  });

  const running = h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  // The thread mounts for the ref alone, before any item fetch resolves.
  assert.equal(h.mountThreads.length, 1, 'thread mounted for an issue before the item resolves');
  assert.equal(h.heads.length, 0, 'nothing painted yet — the board is pending and no item is in hand');
  assert.deepEqual(h.switchTabCalls, [], 'no fallback while a source is still in flight');

  item.resolve();
  await running;
  assert.equal(h.heads.length, 1, 'the head paints from the single fetch alone');
  assert.equal(h.heads[0].number, 30);
  assert.deepEqual(h.switchTabCalls, [], 'painted — no fallback');
  assert.deepEqual(
    h.telemetry.outcomes.map((o) => o.code), ['success'],
    'topic_load records success at the first paint',
  );

  // The board's arrival repaints the head from its list row.
  h.AppView._ghIssues = [{ number: 30, title: 'Issue 30 of demo', state: 'open' }];
  h.AppView._devDataSlug = 'demo';
  board.resolve(true);
  await tick();
  assert.equal(h.heads.length, 2, 'the board landing repaints the head');
  assert.equal(h.heads[1].title, 'Issue 30 of demo', 'from the list row, not the single-item row');
});

test('another app\'s row #30 is never painted under this app\'s name', async () => {
  const board = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => (
      /\/github-issues\/30$/.test(url)
        ? Promise.resolve({ ok: true, json: async () => ({ issue: { number: 30, title: 'Issue 30 of demo' } }) })
        : Promise.resolve({ ok: true, json: async () => ({}) })
    ),
  });
  // The lists still hold the PREVIOUS app's board: issue numbers repeat
  // across every app's repo, so its #30 must not answer this page.
  h.AppView._ghIssues = [{ number: 30, title: 'Issue 30 of other', state: 'open' }];
  h.AppView._devDataSlug = 'other';

  const running = h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  assert.equal(h.heads.length, 0, 'the other app\'s row does not paint');
  await running;
  assert.equal(h.heads.length, 1, 'the page waits for this app\'s own fetch');
  assert.equal(h.heads[0].title, 'Issue 30 of demo');
  assert.deepEqual(h.switchTabCalls, []);
});

test('a board that already holds the item paints at once and buys no second fetch', async () => {
  const board = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => {
      assert.fail(`no request should be needed, got ${url}`);
    },
  });
  h.AppView._ghIssues = [{ number: 30, title: 'Issue 30 of demo', state: 'open' }];
  h.AppView._devDataSlug = 'demo';

  await h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  assert.equal(h.heads.length, 1, 'painted straight from the loaded lists');
  assert.deepEqual(h.switchTabCalls, []);

  board.resolve(true);
  await tick();
  assert.equal(h.heads.length, 2, 'the board refresh still repaints in place');
});

test('both sources missing: the board fallback waits for BOTH to settle', async () => {
  const board = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => (
      /\/github-issues\/30$/.test(url)
        ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
        : Promise.resolve({ ok: true, json: async () => ({}) })
    ),
  });

  const running = h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  await tick();
  assert.deepEqual(h.switchTabCalls, [], 'the item has settled but the board has not — no fallback yet');

  board.resolve(true);
  await running;
  assert.deepEqual(h.switchTabCalls, [['dev']], 'fell back only once both had settled');
  assert.deepEqual(
    h.telemetry.outcomes.map((o) => o.code), ['failure'],
    'topic_load records the failure',
  );
  assert.equal(h.telemetry.outcomes[0].errorCode, 'not_found');
});

test('the board failing does not sink a page the item can paint', async () => {
  const h = makeAppView({
    board: deferred(),
    fetchImpl: (url) => (
      /\/github-issues\/30$/.test(url)
        ? Promise.resolve({ ok: true, json: async () => ({ issue: { number: 30, title: 'Issue 30 of demo' } }) })
        : Promise.resolve({ ok: true, json: async () => ({}) })
    ),
  });
  h.AppView._loadDevData = () => Promise.reject(new Error('board down'));

  await h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  assert.equal(h.heads.length, 1, 'painted from the item fetch');
  assert.deepEqual(h.switchTabCalls, [], 'no fallback — the page the link asked for opened');
});

test('leaving mid-load cancels the attempt and paints nothing', async () => {
  const board = deferred();
  const item = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => (
      /\/github-issues\/30$/.test(url)
        ? item.promise.then(() => ({ ok: true, json: async () => ({ issue: { number: 30 } }) }))
        : Promise.resolve({ ok: true, json: async () => ({}) })
    ),
  });

  const running = h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  // The viewer navigates away while both sources are in flight.
  h.state.threadPresent = false;
  h.AppView._devTopic = null;
  item.resolve();
  await running;
  assert.equal(h.heads.length, 0, 'nothing painted after leaving');
  assert.deepEqual(h.switchTabCalls, [], 'and no fallback fires either');
  assert.deepEqual(
    h.telemetry.outcomes.map((o) => o.code), ['cancelled'],
    'topic_load is cancelled, not left to time out',
  );
});

test('a proposal page paints from its single fetch and mounts after it', async () => {
  const board = deferred();
  const item = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => (
      /\/proposals\/501$/.test(url)
        ? item.promise.then(() => ({ ok: true, json: async () => ({ proposal: { id: 501, status: 'promoted', pr_title: 'P' } }) }))
        : Promise.resolve({ ok: true, json: async () => ({}) })
    ),
  });

  const running = h.AppView._renderTopicSubView(makeEl('content'), { kind: 'proposal', id: 501 });
  assert.equal(h.mountThreads.length, 0, 'a change\'s thread waits for the item (its notice reads the status)');
  item.resolve();
  await running;
  assert.equal(h.mountThreads.length, 1, 'mounted once the item is in hand');
  assert.equal(h.heads.length, 1, 'and painted');
  assert.deepEqual(h.switchTabCalls, []);
});
