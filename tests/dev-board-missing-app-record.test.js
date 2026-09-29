// The #2879 case on the Workshop board: with no app record, a Workshop that
// said Loading forever.
//
// navigateToApp goes on to the Dev screens whether or not AppView.open got
// GET /api/apps/<slug>. A failed or superseded read leaves AppView.appData
// empty (or describing another app); renderDevView mounted the board frame
// with its skeleton in #dev-body, and _loadDevData returned null ("not ready
// yet"), so _loadDevFeed left that skeleton up for good. A record for ANOTHER
// app was worse: its cards would load under this app's name.
//
// Loads the real public/js/app-view.js into a vm context and pins:
//   - a missing record is asked for once more, and a record that then
//     arrives renders the board against it;
//   - a record that still will not come (a failed read or a network error)
//     is said in #dev-body with a Try again control, instead of a skeleton
//     that never resolves, and the feed is never loaded against no record;
//   - Try again renders the board once the record is back;
//   - a record for another app counts as missing;
//   - leaving for another app while the retry is in flight paints nothing;
//   - a record already here costs no extra request.
//
// Run with: node --test tests/dev-board-missing-app-record.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const VIEW_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app-view.js'),
  'utf8'
);

function makeEl() {
  const listeners = {};
  const retryBtn = { disabled: false, addEventListener: (type, fn) => { listeners[type] = fn; } };
  const el = {
    dataset: {},
    style: {},
    _html: '',
    querySelector: (sel) => (sel === '#dev-app-unavailable-retry' && el._html.includes('dev-app-unavailable-retry')
      ? retryBtn
      : null),
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
    _listeners: listeners,
    _retryBtn: retryBtn,
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = v; },
  });
  return el;
}

// `recordAnswers` is the sequence of GET /api/apps/<slug> outcomes: true for
// a served record, false for a failed read, 'throw' for a network error.
function makeHarness(recordAnswers) {
  const content = makeEl();
  const devBody = makeEl();
  const mounts = [];
  const feedLoads = [];
  const appRequests = [];
  const answers = [...recordAnswers];

  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    App: {
      user: { id: 1 },
      currentApp: 'board-app',
      currentTab: 'dev',
      currentSubTab: 'forum',
      _appLoad: null,
      switchTab: () => {},
      updateHash: () => {},
      setBackIcon: () => {},
      setHeaderTitle: () => {},
    },
    document: {
      getElementById: (id) => {
        if (id === 'app-content') return content;
        if (id === 'dev-body') return devBody;
        return null;
      },
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async (url) => {
      const u = String(url);
      if (u === '/api/apps/board-app') {
        appRequests.push(u);
        const answer = answers.length ? answers.shift() : false;
        if (answer === 'throw') throw new TypeError('Failed to fetch');
        return answer
          ? { ok: true, status: 200, json: async () => ({ app: { slug: 'board-app', name: 'Board app', can_collaborate: true } }) }
          : { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    requestAnimationFrame: () => {},
    PlatformUI: { pullToRefresh: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    addEventListener: () => {},
    location: { search: '', hash: '', pathname: '/' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The board frame's bridge: record what it was mounted with.
  sandbox.UsernodeReact = {
    devBoard: {
      mountBoard: (host, props) => { mounts.push({ ...props, appSlug: props.illustrationApp?.slug || null }); },
      publishDiscussion: () => {},
      unmountAll: () => {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  const AppView = sandbox.window.AppView;
  // Everything outside the record question is beside the point here; keep it
  // inert so the harness needs no more of the shell.
  AppView.refreshToken = async () => {};
  AppView.prefetchDevData = () => {};
  AppView.startActivityTracking = () => {};
  AppView.startTokenRefresh = () => {};
  AppView._setSurface = () => {};
  AppView._attrInit = () => {};
  AppView._cardMenuInit = () => {};
  AppView._parkAppFrame = () => {};
  AppView._wirePlusMenu = () => {};
  AppView._loadDiscussionSummary = () => {};
  AppView._discussionView = () => ({});
  AppView._plusMenuShowsMembers = () => false;
  AppView._getFeedScroll = () => 0;
  // The feed loader is where the skeleton was left up; record each call and
  // the record it ran against.
  AppView._loadDevFeed = async () => { feedLoads.push(AppView.appData ? AppView.appData.slug : null); };
  AppView.appData = null;
  return { AppView, sandbox, devBody, mounts, feedLoads, appRequests };
}

async function settle(until) {
  for (let i = 0; i < 50 && !until(); i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

test('the board with no app record asks once more, and renders against it when it arrives', async () => {
  const h = makeHarness([true]);

  await h.AppView.renderDevView('forum', null);

  assert.equal(h.appRequests.length, 1, 'the record is asked for again');
  assert.deepEqual(h.feedLoads, ['board-app'], 'the feed loads against the record');
  assert.equal(h.mounts.at(-1).appSlug, 'board-app', 'the frame is re-rendered with the record');
  assert.equal(h.mounts.at(-1).canCollaborate, true);
  assert.doesNotMatch(h.devBody.innerHTML, /dev-app-unavailable/);
});

test('a record that will not come is said, with Try again, instead of an endless skeleton', async () => {
  const h = makeHarness([false]);

  await h.AppView.renderDevView('forum', null);

  assert.equal(h.appRequests.length, 1);
  assert.deepEqual(h.feedLoads, [], 'the feed is never loaded against no record');
  assert.match(h.devBody.innerHTML, /id="dev-app-unavailable"/, 'the error state is rendered in #dev-body');
  assert.match(h.devBody.innerHTML, /This app could not be loaded\. Check your connection and try again\./);
  assert.match(h.devBody.innerHTML, /id="dev-app-unavailable-retry"[^>]*>Try again</, 'with a way to try again');
});

test('a network error on the retry is the same stated error, not a thrown render', async () => {
  const h = makeHarness(['throw']);

  await h.AppView.renderDevView('forum', null);

  assert.match(h.devBody.innerHTML, /id="dev-app-unavailable"/);
  assert.deepEqual(h.feedLoads, []);
});

test('Try again renders the board once the record is back', async () => {
  const h = makeHarness([false, true]);

  await h.AppView.renderDevView('forum', null);
  assert.equal(typeof h.devBody._listeners.click, 'function', 'Try again is wired');
  h.devBody._listeners.click();
  assert.equal(h.devBody._retryBtn.disabled, true, 'the button is disabled while it retries');
  await settle(() => h.feedLoads.length > 0);

  assert.equal(h.appRequests.length, 2);
  assert.deepEqual(h.feedLoads, ['board-app'], 'the board loads after the retry');
  assert.equal(h.mounts.at(-1).appSlug, 'board-app');
});

test('a record for ANOTHER app counts as missing, and its cards are never loaded here', async () => {
  const h = makeHarness([true]);
  h.AppView.appData = { slug: 'some-other-app', name: 'Other' };

  await h.AppView.renderDevView('forum', null);

  assert.equal(h.appRequests.length, 1, 'the open app\'s record is asked for');
  assert.deepEqual(h.feedLoads, ['board-app'], 'and the feed loads for the open app only');
});

test('leaving for another app while the retry is in flight paints nothing', async () => {
  const h = makeHarness([false]);
  const realFetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url) => {
    h.sandbox.App.currentApp = 'elsewhere';
    return realFetch(url);
  };

  await h.AppView.renderDevView('forum', null);

  assert.deepEqual(h.feedLoads, []);
  assert.doesNotMatch(h.devBody.innerHTML, /dev-app-unavailable/);
});

test('a record already here costs no extra request', async () => {
  const h = makeHarness([]);
  h.AppView.appData = { slug: 'board-app', name: 'Board app' };

  await h.AppView.renderDevView('forum', null);

  assert.equal(h.appRequests.length, 0);
  assert.deepEqual(h.feedLoads, ['board-app']);
  assert.equal(h.mounts.length, 1);
});
