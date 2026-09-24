// The #2879 case on a Workshop TOPIC page (an issue or a change opened at
// /app/<slug>/dev/issues/<n> or /dev/proposals/<id>): with no app record for
// the app on screen, the page did not say so.
//
// navigateToApp goes on to the Dev screens whether or not AppView.open got
// GET /api/apps/<slug>. #2879 covered the session screen and #2971 the board;
// _renderTopicSubView had neither guard. With AppView.appData empty,
// _loadDevData returned null and the page silently bounced to the board (or,
// when the tab was resuming it, dropped the remembered Workshop view), so a
// transient failure lost the page the link asked for. With a record for
// ANOTHER app it was worse: that app's lists were loaded and searched, and
// issue numbers repeat across every app's repo, so issue #7 of the other app
// was painted under this one's name.
//
// Loads the real public/js/app-view.js into a vm context and pins:
//   - a missing record is asked for once more with the skeleton up, and a
//     record that then arrives renders the topic against it;
//   - a record that still will not come is said in #dev-topic-thread (the
//     host the legacy module already fills) with a Try again control, rather
//     than a bounce to the board, and no data is loaded against no record;
//   - Try again renders the topic once the record is back;
//   - a record for another app counts as missing, and its lists are never
//     read for this page;
//   - leaving for another app while the retry is in flight paints nothing;
//   - a record already here costs no extra request.
//
// Run with: node --test tests/dev-topic-missing-app-record.test.js

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
    querySelector: (sel) => (sel === '#dev-topic-app-unavailable-retry'
      && el._html.includes('dev-topic-app-unavailable-retry')
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
  const thread = makeEl();
  let threadMounted = false;
  const topicMounts = [];
  const dataLoads = [];
  const heads = [];
  const switches = [];
  const titles = [];
  const appRequests = [];
  const answers = [...recordAnswers];

  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    App: {
      user: { id: 1 },
      currentApp: 'topic-app',
      currentTab: 'dev',
      currentSubTab: 'topic',
      _appLoad: null,
      switchTab: (tab) => { switches.push(tab); },
      _abandonWorkshopResume: () => false,
      updateHash: () => {},
      setBackIcon: () => {},
      setHeaderTitle: (...args) => { titles.push(args[0]); },
    },
    document: {
      getElementById: (id) => {
        if (id === 'app-content') return content;
        if (id === 'dev-topic-thread') return threadMounted ? thread : null;
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
      if (u === '/api/apps/topic-app') {
        appRequests.push(u);
        const answer = answers.length ? answers.shift() : false;
        if (answer === 'throw') throw new TypeError('Failed to fetch');
        return answer
          ? { ok: true, status: 200, json: async () => ({ app: { slug: 'topic-app', name: 'Topic app', can_collaborate: true } }) }
          : { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    },
    requestAnimationFrame: () => {},
    PlatformUI: { pullToRefresh: () => {}, toast: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController,
    addEventListener: () => {},
    location: { search: '', hash: '', pathname: '/' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // The topic frame's bridge: mounting it puts #dev-topic-thread (with its
  // skeleton) in the document, as features/dev-board/topic-frame.tsx does.
  sandbox.UsernodeReact = {
    devBoard: {
      mountTopicSubView: () => {
        threadMounted = true;
        thread.innerHTML = '<div class="skeleton"></div>';
        topicMounts.push(true);
      },
      publishTopicHead: () => {},
      mountChangePage: () => {},
      unmountAll: () => {},
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  const AppView = sandbox.window.AppView;
  AppView.refreshToken = async () => {};
  AppView.prefetchDevData = () => {};
  AppView.startActivityTracking = () => {};
  AppView.startTokenRefresh = () => {};
  AppView._setSurface = () => {};
  AppView._attrInit = () => {};
  AppView._cardMenuInit = () => {};
  AppView._parkAppFrame = () => {};
  AppView._invalidateVoteRoster = () => {};
  AppView._mountTopicThread = () => {};
  // The board data: whichever app the record names, its open issues —
  // numbered from 1 in every repo, which is why a record for another app
  // could resolve this page's issue number to that app's issue.
  AppView._loadDevData = async () => {
    const slug = AppView.appData ? AppView.appData.slug : null;
    dataLoads.push(slug);
    if (!slug) return null;
    AppView._ghIssues = [{ number: 7, title: `Issue 7 of ${slug}`, app: slug }];
    return true;
  };
  AppView._renderTopicHead = () => {
    const item = AppView._findTopicItem();
    heads.push(item ? item.app : null);
  };
  AppView.appData = null;
  return { AppView, sandbox, thread, topicMounts, dataLoads, heads, switches, titles, appRequests };
}

const ISSUE = { kind: 'issue', id: 7 };

async function settle(until) {
  for (let i = 0; i < 50 && !until(); i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

test('a topic with no app record asks once more, and renders against it when it arrives', async () => {
  const h = makeHarness([true]);

  await h.AppView.renderDevView('topic', ISSUE);

  assert.equal(h.appRequests.length, 1, 'the record is asked for again');
  assert.deepEqual(h.dataLoads, ['topic-app'], 'the data loads against the record');
  assert.deepEqual(h.heads, ['topic-app'], 'the topic is painted for this app');
  assert.deepEqual(h.switches, [], 'no bounce to the board');
  assert.doesNotMatch(h.thread.innerHTML, /dev-topic-app-unavailable/);
});

test('a record that will not come is said in the topic host, with Try again, not a bounce to the board', async () => {
  const h = makeHarness([false]);

  await h.AppView.renderDevView('topic', ISSUE);

  assert.equal(h.appRequests.length, 1);
  assert.deepEqual(h.dataLoads, [], 'nothing is loaded against no record');
  assert.deepEqual(h.switches, [], 'the page the link asked for is not silently swapped for the board');
  assert.match(h.thread.innerHTML, /id="dev-topic-app-unavailable"/, 'the error state is rendered in #dev-topic-thread');
  assert.match(h.thread.innerHTML, /This app could not be loaded\. Check your connection and try again\./);
  assert.match(h.thread.innerHTML, /id="dev-topic-app-unavailable-retry"[^>]*>Try again</, 'with a way to try again');
});

test('a network error on the retry is the same stated error, not a thrown render', async () => {
  const h = makeHarness(['throw']);

  await h.AppView.renderDevView('topic', ISSUE);

  assert.match(h.thread.innerHTML, /id="dev-topic-app-unavailable"/);
  assert.deepEqual(h.dataLoads, []);
});

test('Try again renders the topic once the record is back', async () => {
  const h = makeHarness([false, true]);

  await h.AppView.renderDevView('topic', ISSUE);
  assert.equal(typeof h.thread._listeners.click, 'function', 'Try again is wired');
  h.thread._listeners.click();
  assert.equal(h.thread._retryBtn.disabled, true, 'the button is disabled while it retries');
  await settle(() => h.heads.length > 0);

  assert.equal(h.appRequests.length, 2);
  assert.deepEqual(h.dataLoads, ['topic-app']);
  assert.deepEqual(h.heads, ['topic-app'], 'the topic is painted after the retry');
});

test('a record for ANOTHER app counts as missing, and its issue is never painted here', async () => {
  const h = makeHarness([true]);
  h.AppView.appData = { slug: 'some-other-app', name: 'Other' };

  await h.AppView.renderDevView('topic', ISSUE);

  assert.equal(h.appRequests.length, 1, 'the open app\'s record is asked for');
  assert.deepEqual(h.dataLoads, ['topic-app'], 'only the open app\'s data is loaded');
  assert.deepEqual(h.heads, ['topic-app'], 'the issue painted is this app\'s');
  assert.deepEqual(h.titles, ['Topic app'], 'and the header never names the other app');
});

test('leaving for another app while the retry is in flight paints nothing', async () => {
  const h = makeHarness([false]);
  const realFetch = h.sandbox.fetch;
  h.sandbox.fetch = async (url) => {
    h.sandbox.App.currentApp = 'elsewhere';
    return realFetch(url);
  };

  await h.AppView.renderDevView('topic', ISSUE);

  assert.deepEqual(h.dataLoads, []);
  assert.deepEqual(h.heads, []);
  assert.deepEqual(h.switches, []);
  assert.doesNotMatch(h.thread.innerHTML, /dev-topic-app-unavailable/);
});

test('a record already here costs no extra request', async () => {
  const h = makeHarness([]);
  h.AppView.appData = { slug: 'topic-app', name: 'Topic app' };

  await h.AppView.renderDevView('topic', ISSUE);

  assert.equal(h.appRequests.length, 0);
  assert.deepEqual(h.dataLoads, ['topic-app']);
  assert.deepEqual(h.heads, ['topic-app']);
  assert.equal(h.topicMounts.length, 1);
});
