// Fast open for topic pages (#4524, #6604): a request, proposal or
// governance page opened from a notification, a message card or any other
// link draws as soon as ITS OWN item has loaded, instead of waiting for the
// project's whole board — and it does not load the board at all.
// Covers the app-view.js changes:
//   1. _renderTopicSubView mounts an issue's / governance thread for the ref
//      alone, before any item is known, and starts the thread's own read in
//      the same tick as the item read. No _loadDevData runs.
//   2. The page paints from the same-app lists (already loaded), an on-demand
//      cache, or the item's own single fetch; the item read then refreshes the
//      head, rather than a board load.
//   3. The lists answer only for the app _devDataSlug names, so another
//      app's row #30 is never painted under this app's name.
//   4. A missing item still falls back to the board, after its read settles.
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
const { englishPlatformI18n } = require('./lib/platform-i18n');

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
  const unmountThreads = [];
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
      unmountThread() { unmountThreads.push(true); },
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
    // The language runtime's global, as the shell publishes it.
    PlatformI18n: englishPlatformI18n(),
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
    AppView, sandbox, thread, state, switchTabCalls, mountThreads, unmountThreads, heads,
    fetchLog, telemetry,
  };
}

const ISSUE = { kind: 'issue', id: 30 };

async function tick(n = 6) {
  for (let i = 0; i < n; i += 1) await new Promise((resolve) => setImmediate(resolve));
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

  // The board's arrival no longer repaints the head: a thread page does not
  // load the board at all (#6604). The item read is what paints it.
  h.AppView._ghIssues = [{ number: 30, title: 'Issue 30 of demo', state: 'open' }];
  h.AppView._devDataSlug = 'demo';
  board.resolve(true);
  await tick();
  assert.equal(h.heads.length, 1, 'the board landing repaints nothing');
  assert.equal(h.heads[0].title, 'Issue 30', 'the page keeps the row its own read painted');
});

test('#6604: a repaint while a page is still loading keeps the thread it mounted', () => {
  const h = makeAppView({
    fetchImpl: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
  });
  h.AppView._devTopic = { kind: 'issue', id: 30 };
  h.AppView._paintedTopic = null;
  // The row is still in flight, but the thread was mounted on the ref alone
  // and is reading: it is THIS page's stream, not a previous page to drop.
  h.sandbox.GroupChat.activeThread = { type: 'issue', ref: 30, language: 'request' };
  h.AppView._clearTopicHeadBody();
  assert.deepEqual(h.unmountThreads, [], 'the page keeps the stream it is loading');

  // A different topic's thread is still a previous page, and goes.
  h.sandbox.GroupChat.activeThread = { type: 'issue', ref: 29, language: 'request' };
  h.AppView._clearTopicHeadBody();
  assert.equal(h.unmountThreads.length, 1, 'another topic\'s stream is unmounted');
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

test('a board that already holds the item paints at once, then refreshes from its own read', async () => {
  const board = deferred();
  const item = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => (
      /\/github-issues\/30$/.test(url)
        ? item.promise.then(() => ({ ok: true, json: async () => ({ issue: { number: 30, title: 'Issue 30 (read now)', state: 'open' } }) }))
        : Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
    ),
  });
  h.AppView._ghIssues = [{ number: 30, title: 'Issue 30 of demo', state: 'open' }];
  h.AppView._devDataSlug = 'demo';

  const running = h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  assert.equal(h.heads.length, 1, 'painted straight from the loaded lists');
  assert.equal(h.heads[0].title, 'Issue 30 of demo');
  assert.deepEqual(h.switchTabCalls, []);

  item.resolve();
  await running;
  await tick();
  assert.equal(h.heads.length, 2, 'the item read refreshes the head in place');
  assert.equal(h.heads[1].title, 'Issue 30 (read now)', 'from the page\'s own read, not the list copy');

  board.resolve(true);
  await tick();
  assert.equal(h.heads.length, 2, 'the board landing repaints nothing');
});

test('a missing item falls back without waiting for a board load', async () => {
  const board = deferred();
  const h = makeAppView({
    board,
    fetchImpl: (url) => (
      /\/github-issues\/30$/.test(url)
        ? Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
        : Promise.resolve({ ok: true, json: async () => ({}) })
    ),
  });

  await h.AppView._renderTopicSubView(makeEl('content'), ISSUE);
  assert.deepEqual(h.switchTabCalls, [['dev']], 'fell back once the item read settled');
  assert.deepEqual(
    h.telemetry.outcomes.map((o) => o.code), ['failure'],
    'topic_load records the failure',
  );
  assert.equal(h.telemetry.outcomes[0].errorCode, 'not_found');
  // Board deliberately unresolved: the fallback never waited on it.
  assert.equal(board.promise instanceof Promise, true);
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

// ── #6608: a switch to another project's change never shows the old page ──
//
// The head is published from `_renderTopicHead`. Its state now names the
// project it was painted for (`slug`) and the route it was published on
// (`route`), and a repaint for a DIFFERENT topic whose row is not in hand yet
// publishes a loading state instead of leaving the previous change's body
// under the new heading. The same topic that merely left the lists (closed or
// merged mid-view) keeps its last render.

function makeHeadAppView() {
  const els = {};
  const getEl = (id) => {
    if (!(id in els)) els[id] = makeEl(id);
    return els[id];
  };
  const thread = makeEl('dev-topic-thread');
  const publishes = [];
  const heads = [];
  const unmounted = { threads: 0, transcripts: [] };
  const sandbox = {
    console,
    relTime: () => 'just now',
    URLSearchParams,
    location: { search: '', hash: '', pathname: '/' },
    App: { user: { id: 1 }, currentApp: 'a', _currentRoute: '' },
    Kudos: { renderButton: () => '', attach() {} },
    GroupChat: {
      unmountThread() { unmounted.threads += 1; },
      mountThread() {},
      _react: () => ({
        unmountTranscript(el) { unmounted.transcripts.push(el); },
      }),
    },
    document: {
      getElementById: (id) => (id === 'dev-topic-thread' ? thread : getEl(id)),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach() {} }),
      addEventListener() {},
      createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
      body: { appendChild() {} },
    },
    UsernodeReact: {
      devBoard: {
        mountTopicHead: (host) => { heads.push(host); },
        publishTopicHead: (state) => { publishes.push(state); },
      },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    requestAnimationFrame: (fn) => fn(),
    alert() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    PlatformI18n: englishPlatformI18n(),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'a' };
  AppView._topicViewFor = () => ({ card: {}, body: {} });
  AppView._refreshAiAvailability = () => {};
  AppView._fillKudosHosts = () => {};
  AppView._loadVoteRoster = () => {};
  AppView._loadGovVoteRoster = () => {};
  AppView._govRequestNumber = () => null;
  AppView._loadGovRequest = () => {};
  return { AppView, sandbox, publishes, heads, unmounted };
}

function paintChange(h, { slug, id, route, status = 'promoted' }) {
  h.AppView.appData = { slug };
  h.sandbox.App._currentRoute = `#${route}`;
  h.AppView._devTopic = { kind: 'proposal', id };
  h.AppView._topicProposal = { id, status, pr_title: `Change ${id}` };
  h.AppView._renderTopicHead();
  return h.publishes.at(-1);
}

test('a repaint for another project\'s unloaded change clears the old body first (#6608)', () => {
  const h = makeHeadAppView();
  const first = paintChange(h, { slug: 'a', id: 12, route: 'app/a/dev/changes/12' });
  assert.equal(first.item.id, 12, 'the change\'s own row is published');
  assert.equal(first.loading, false, 'a drawn page is not a loading one');
  assert.equal(first.slug, 'a', 'with the project it was painted for');
  assert.equal(first.route, 'app/a/dev/changes/12', 'and the route it was published on');

  const before = h.publishes.length;
  const threadsBefore = h.unmounted.threads;
  const transcriptsBefore = h.unmounted.transcripts.length;

  // The viewer picks Community Tier Lists' #44 while The Best Color's #12 was
  // open. The new project's board read and by-id fetch are still in flight.
  h.AppView.appData = { slug: 'b' };
  h.sandbox.App._currentRoute = '#app/b/dev/changes/44';
  h.AppView._devTopic = { kind: 'proposal', id: 44 };
  h.AppView._topicProposal = null;
  h.AppView._renderTopicHead();

  const cleared = h.publishes.at(-1);
  assert.deepEqual(
    { card: cleared.card, body: cleared.body, item: cleared.item, loading: cleared.loading },
    { card: null, body: null, item: null, loading: true },
    'the previous change\'s votes and events are gone, not left under the new heading',
  );
  assert.equal(h.unmounted.threads, threadsBefore + 1, 'and its stream is dropped');
  assert.equal(h.unmounted.transcripts.length, transcriptsBefore + 1, 'with the transcript');
  for (const state of h.publishes.slice(before)) {
    assert.ok(!(state.item && state.item.id === 12), 'no publish after the switch carries #12\'s item');
  }

  // The new project's read lands: #44 paints under its own project.
  h.AppView._topicProposal = { id: 44, status: 'promoted', pr_title: 'Community Tier Lists change' };
  h.AppView._renderTopicHead();
  const painted = h.publishes.at(-1);
  assert.equal(painted.item.id, 44);
  assert.equal(painted.slug, 'b', 'the head names the project it was painted for');
  assert.equal(painted.route, 'app/b/dev/changes/44');
  assert.equal(painted.loading, false);
});

test('a change that leaves the lists mid-view keeps its last render (#6608)', () => {
  const h = makeHeadAppView();
  paintChange(h, { slug: 'a', id: 12, route: 'app/a/dev/changes/12' });
  const before = h.publishes.length;
  const threadsBefore = h.unmounted.threads;

  // Same topic, same project, its row gone (it closed or merged while open):
  // the page the reader is on stays readable.
  h.AppView._topicProposal = null;
  h.AppView._renderTopicHead();

  assert.equal(h.publishes.length, before, 'nothing is republished');
  assert.equal(h.unmounted.threads, threadsBefore, 'and its stream is left mounted');
});

// ── A request's own stream survives a repaint before its row lands ──
//
// A request's (and a decision's) thread is mounted on its ref alone, before
// its row is in hand (_renderTopicSubView). A repaint in that gap
// (_repaintCards → _renderTopicHead, the row still missing) dropped that
// thread as if it were the previous page's, and the paint that follows the
// row does not mount it again: the page drew its head and no replies. The
// declared check "Request page screenshots link to the full-size file…"
// failed on it whenever the repaint won the race.

function openRequestThread(h, { slug, number }) {
  h.AppView.appData = { slug };
  h.sandbox.App._currentRoute = `#app/${slug}/dev/issues/${number}`;
  h.AppView._devTopic = { kind: 'issue', id: number };
  h.sandbox.GroupChat.appSlug = slug;
  h.sandbox.GroupChat.activeThread = { type: 'issue', ref: number, language: 'request' };
}

test('a request\'s own thread stays mounted through a repaint before its row lands', () => {
  const h = makeHeadAppView();
  openRequestThread(h, { slug: 'a', number: 900010 });

  h.AppView._renderTopicHead();

  assert.equal(h.publishes.at(-1).loading, true, 'the head waits for its row');
  assert.equal(h.unmounted.threads, 0, 'but the request\'s own stream is not dropped');
  assert.equal(h.unmounted.transcripts.length, 0, 'nor its transcript');
});

test('a thread that is not the new topic\'s own is still dropped', () => {
  // Another project's request with the same number.
  const other = makeHeadAppView();
  openRequestThread(other, { slug: 'a', number: 7 });
  other.AppView.appData = { slug: 'b' };
  other.sandbox.App._currentRoute = '#app/b/dev/issues/7';
  other.AppView._renderTopicHead();
  assert.equal(other.unmounted.threads, 1, 'project a\'s stream is not left under b\'s heading');

  // A change with the request's number, in the same project.
  const change = makeHeadAppView();
  openRequestThread(change, { slug: 'a', number: 12 });
  change.sandbox.GroupChat.activeThread = { type: 'session', ref: 12, language: 'change' };
  change.AppView._renderTopicHead();
  assert.equal(change.unmounted.threads, 1, 'change #12\'s stream is not request #12\'s');
});
