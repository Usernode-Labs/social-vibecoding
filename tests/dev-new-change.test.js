// #2241 — "New change" creates nothing until you send.
//
// Clicking New change used to POST /api/apps/:slug/sessions before a single
// word had been typed. #1350 had already taken the BRANCH out of that POST
// (no ref is minted until something needs one); this takes the ROW out of
// the CLICK, for the same reason: most of the sessions created that way were
// never used, and each one still spent a slot from the viewer's active-session
// cap, sat in the session list, and showed up in Improve as a change in
// progress — with nothing to do about it but archive it by hand.
//
// What replaces it is a screen with a route of its own —
// /app/<slug>/dev/sessions/new — rendered against a client-only placeholder
// (`DevChat.startPendingSession`). The first send turns it into a real
// session (`_materializePendingSession`) and the turn proceeds normally.
//
// What these tests pin, in order:
//   1. the route: `new` is the one session ref that is a word, and the two
//      copies of that literal (the router, DevChat) agree;
//   2. the entry points: Improve's New change and the sync banner's
//      "Start a new change" navigate instead of creating; the out-of-credits
//      hand-off still creates up front, because it has a session to hand over;
//   3. the placeholder: no id, no owner, nothing said about a venue or a PR,
//      and NO request of any kind while it is on screen;
//   4. the send: one session created, the message posted to the new id, and
//      a refusal that leaves the text in the box and creates nothing;
//   5. the copy: the empty state says so.
//
// Run with: node --test tests/dev-new-change.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const APP_SRC = read('public', 'js', 'app.js');
const APP_VIEW_SRC = read('public', 'js', 'app-view.js');
const DEV_CHAT_SRC = read('frontend', 'src', 'features', 'dev-chat', 'dev-chat.js');

const { transcriptHtml } = require('./lib/dev-transcript-html');

/** Objects built inside a vm realm are not deep-equal to ours — compare as data. */
const plain = (v) => JSON.parse(JSON.stringify(v === undefined ? null : v));

// ── harnesses ─────────────────────────────────────────────────────────

/** app.js in a vm — the router half. Mirrors tests/clean-app-paths.test.js. */
function loadApp() {
  const origin = 'https://social-vibecoding.test';
  const location = { origin, pathname: '/', search: '', hash: '' };
  Object.defineProperty(location, 'href', {
    get() { return `${origin}${location.pathname}${location.search}${location.hash}`; },
    set(value) {
      const next = new URL(value, `${origin}${location.pathname}`);
      location.pathname = next.pathname;
      location.search = next.search;
      location.hash = next.hash;
    },
  });
  const urls = [];
  const history = {
    state: null,
    pushState(_s, _t, v) { urls.push(['push', v]); location.href = v; },
    replaceState(_s, _t, v) { urls.push(['replace', v]); location.href = v; },
  };
  const element = {
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, removeAttribute() {}, appendChild() {},
  };
  const document = {
    visibilityState: 'visible', title: '',
    addEventListener() {}, getElementById() { return element; },
    querySelector() { return null; }, createElement() { return { ...element }; },
    head: element,
  };
  const AppView = {
    appData: null, pendingInnerPath: null,
    launchRecordFor() { return null; }, beginLaunch() { return true; },
    open() { return Promise.resolve(); }, close() {},
    _getViewMode() { return 'workshop'; },
  };
  const window = { location, history, addEventListener() {}, AppView };
  const context = vm.createContext({
    window, document, location, history, AppView,
    PlatformUI: { transition(fn) { fn(); }, pullToRefresh() {} },
    URL, URLSearchParams, AbortController,
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    navigator: {}, console, setTimeout, clearTimeout,
    fetch: async () => ({ ok: false }),
    DevChat: { NEW_SESSION_REF: 'new', currentSession: null },
  });
  vm.runInContext(APP_SRC, context);
  const App = window.App;
  App._departingScreen = () => element;
  App._setScreenVisible = () => {};
  App._showOnlyScreen = () => {};
  return { App, context, location, urls };
}

/** app-view.js in a vm — just enough for createProposal / renderDevChatTab. */
function loadAppView() {
  const calls = { createSession: [], switchTab: [], pending: [] };
  const sandbox = {
    console,
    relTime: () => 'just now',
    Kudos: { renderButton: () => '' },
    ConfirmModal: { show: async () => true },
    document: {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ style: {}, classList: { add: () => {}, remove: () => {} } }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    App: {
      user: { id: 42 },
      switchTab: async (...args) => { calls.switchTab.push(args); },
    },
    DevChat: {
      NEW_SESSION_REF: 'new',
      _devFlow: { mode: null, agent: null },
      _devFlowEnsureStatus: () => {},
      renderMessages: () => {},
      createSession: async (...args) => {
        calls.createSession.push(args);
        return { id: 77 };
      },
      startPendingSession: (...args) => { calls.pending.push(args); },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${APP_VIEW_SRC}\n;globalThis.__AppView = AppView;`, sandbox);
  const AppView = sandbox.__AppView;
  AppView.appData = { slug: 'recipe-box' };
  return { AppView, calls, sandbox };
}

/** dev-chat.js in a vm. Adapted from tests/devchat-composer-restore.test.js. */
function makeElement(id) {
  const classes = new Set();
  return {
    id, style: {}, dataset: {}, disabled: false, title: '',
    innerHTML: '', textContent: '', value: '', scrollHeight: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { return c; }, removeChild() {}, remove() {},
    focus() {}, blur() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
  };
}

function makeDevChat() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const requests = [];
  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {}, removeEventListener() {},
    visibilityState: 'visible',
  };
  const storage = new Map();
  const hashes = [];
  const sandbox = {
    console,
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    AbortController,
    escapeHtml: (s) => String(s == null ? '' : s),
    PlatformUI: { toast: (m) => { sandbox.toasts.push(m); } },
    toasts: [],
    App: {
      currentTab: 'dev', currentSubTab: 'sessions', user: { id: 9 },
      updateHash: (opts) => hashes.push(opts || {}),
    },
    Notifications: {},
    addEventListener() {}, removeEventListener() {},
    location: { search: '', hash: '' },
    URLSearchParams,
  };
  // One recording fetch. Every test overrides `reply` rather than the stub,
  // so the request LOG is complete for every path — which is how "the
  // placeholder makes no requests" is asserted at all.
  sandbox.reply = async () => ({ ok: true, status: 200, json: async () => ({}) });
  sandbox.fetch = async (url, init) => {
    requests.push([String(url), (init && init.method) || 'GET']);
    return sandbox.reply(url, init);
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // The render plumbing is not what these tests are about; the methods under
  // test (startPendingSession, _materializePendingSession, sendMessage,
  // createSession) stay real.
  DevChat.renderMessages = () => {};
  DevChat.renderSessionList = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._removeSpinner = () => {};
  DevChat._flushStreamingFinal = () => {};
  DevChat._stopProgressPolling = () => {};
  DevChat._closeResumableStream = () => {};
  DevChat._openResumableStream = () => {};
  DevChat._startProgressPolling = () => {};
  DevChat._setStreamingUI = (streaming) => { getEl('dc-input').disabled = !!streaming; };
  // Requests the SESSION story cares about. dev-chat.js also warms the model
  // picker (`GET /api/models`) when it loads, which says nothing about
  // whether a change was created.
  const sessionRequests = () => requests.filter(
    ([u]) => /^\/api\/(apps\/[^/]+\/sessions|sessions\/)/.test(u)
  );
  return { DevChat, sandbox, document, getEl, requests, sessionRequests, hashes, storage };
}

// ── 1. the route ──────────────────────────────────────────────────────

test('the unsent change has a route of its own, and one spelling of it', () => {
  // The router and DevChat each hold a copy of the literal — app.js must
  // answer for URLs before any other module has loaded — so they are pinned
  // against each other here rather than left to drift.
  assert.match(DEV_CHAT_SRC, /NEW_SESSION_REF: 'new',/);
  assert.match(APP_SRC, /if \(ref === 'new'\) return \{ tab: 'dev', subTab: 'sessions', ref: 'new' \};/);

  const { App } = loadApp();
  assert.deepEqual(plain(App._normalizeTab('dev', 'new', 'sessions')),
    { tab: 'dev', subTab: 'sessions', ref: 'new' },
    'the word survives normalization; a parseInt would have made it NaN');
  assert.equal(App._appUrl('recipe-box', 'dev', 'new', 'sessions'),
    '/app/recipe-box/dev/sessions/new');
  // …and nothing else does. A session sub-tab with no ref still falls back
  // to the card list, which is exactly why the screen needed a word.
  assert.deepEqual(plain(App._normalizeTab('dev', null, 'sessions')),
    { tab: 'dev', subTab: 'forum', ref: null });
  assert.deepEqual(plain(App._normalizeTab('dev', 'newish', 'sessions')),
    { tab: 'dev', subTab: 'forum', ref: null });
});

test('the address survives a reload, and the placeholder serializes back to it', () => {
  const { App, context, location } = loadApp();
  // Reading the URL: /app/<slug>/dev/sessions/new is the session sub-tab.
  const routed = [];
  App.navigateToApp = async (slug, tab, ref, subTab) => { routed.push([slug, tab, ref, subTab]); };
  location.href = '/app/recipe-box/dev/sessions/new';
  App.restoreFromHash();
  assert.deepEqual(plain(routed.at(-1)), ['recipe-box', 'dev', 'new', 'sessions'],
    'a cold link lands on the unsent-change screen, not the board');

  // Writing it: updateHash asks DevChat for the open session's ref, and an
  // unsent change has no id to give — `null` there would normalize the whole
  // route back to the board and throw the reader off the screen they are on.
  App.currentApp = 'recipe-box';
  App.currentTab = 'dev';
  App.currentSubTab = 'sessions';
  context.DevChat.currentSession = { pending: true, id: null, app_slug: 'recipe-box' };
  App.updateHash();
  assert.equal(location.pathname, '/app/recipe-box/dev/sessions/new');
});

// ── 2. the entry points ───────────────────────────────────────────────

test('Improve\'s New change navigates and creates nothing', async () => {
  const { AppView, calls } = loadAppView();
  await AppView.createProposal();
  assert.deepEqual(plain(calls.createSession), [], 'no session is POSTed on the click');
  assert.deepEqual(plain(calls.switchTab), [['dev', 'new', 'sessions']],
    'it opens the unsent-change screen');
  assert.equal(AppView._proposalHint, true, 'the one-shot hint still rides along');
});

test('the out-of-credits hand-off still creates up front', async () => {
  // It is the one caller with a reason: the walkthrough it opens hands the
  // session to a web agent, and the hand-off is recorded ON the session
  // (POST /sessions/:id/build-venue), so there has to be a row to point at.
  const { AppView, calls, sandbox } = loadAppView();
  await AppView.createProposal({ flow: 'codex' });
  assert.deepEqual(plain(calls.createSession), [['recipe-box']]);
  assert.deepEqual(plain(calls.switchTab), [['dev', 77, 'sessions']]);
  assert.equal(sandbox.DevChat._devFlow.agent, 'codex');
});

test('the banner\'s "Start a new change" leads to the same screen', async () => {
  const { DevChat, sandbox, sessionRequests } = makeDevChat();
  const switched = [];
  sandbox.App.switchTab = async (...args) => { switched.push(args); };
  sandbox.AppView = { appData: { slug: 'recipe-box' } };
  DevChat._publishBanners = () => {};
  await DevChat.startNewChange();
  assert.deepEqual(plain(switched), [['dev', 'new', 'sessions']]);
  assert.deepEqual(plain(sessionRequests()), [], 'and creates nothing on the way');
  assert.equal(DevChat._newChangePending, false, 'the button is released either way');
});

// ── 3. the placeholder ────────────────────────────────────────────────

test('the placeholder has no id and no owner, so nothing owner-scoped is offered', () => {
  const { DevChat } = makeDevChat();
  const s = DevChat.startPendingSession('recipe-box');
  assert.equal(s.pending, true);
  assert.equal(s.id, null, 'no id: every per-session request in this module guards on one');
  assert.equal(s.user_id, undefined, 'no owner: _ownsSession is what empties the ⋯ menu');
  assert.equal(s.app_slug, 'recipe-box');
  assert.equal(s.created_from_issue_number, null,
    'nothing links an unsent change to an issue — the issue row\'s own button still creates up front (#609)');
  assert.equal(DevChat.isPendingSession(), true);
  assert.deepEqual(plain(DevChat.messages), []);
  assert.equal(DevChat._devFlow, null,
    'a stale hand-off wizard would swap the composer for a launchpad with no session');

  const head = DevChat._sessionHeaderView();
  assert.equal(head.title, 'New change');
  assert.equal(head.sessionId, null);
  assert.equal(head.pr, null);
  assert.equal(head.life, null);
  assert.equal(head.venue, null,
    'the venue is resolved by the server when the row is created (#1348) — before that, say nothing');
  assert.deepEqual(plain(head.actions), [], 'Pause / Archive / Free worker have nothing to act on');
});

test('an unsent change on screen makes no requests at all', async () => {
  const { DevChat, sessionRequests } = makeDevChat();
  DevChat.startPendingSession('recipe-box');
  // The three things that fire by themselves on an open session.
  DevChat._startHeartbeat();
  await DevChat._reconcileDrafts(DevChat.currentSession.id, null);
  assert.equal(await DevChat._resumeCurrentSessionIfPaused({ silent: true }), false);
  assert.deepEqual(plain(sessionRequests()), [],
    'arriving, reading and leaving again writes nothing — the whole point of #2241');
});

// ── 4. the send ───────────────────────────────────────────────────────

const MSG = 'add a dark mode toggle to the settings page';

function sendReplies(sandbox, { create = { id: 101, agent_backend: 'claude' } } = {}) {
  sandbox.reply = async (url, init) => {
    if (/\/api\/apps\/[^/]+\/sessions$/.test(url) && init && init.method === 'POST') {
      return { ok: true, status: 201, json: async () => ({ session: create }) };
    }
    // The chat POST: an immediate non-ok, so the turn unwinds without an SSE
    // reader. What this test is about happened before it.
    return { ok: false, status: 500, json: async () => ({ error: 'nope' }) };
  };
}

test('the first send creates the session, once, and posts the turn to it', async () => {
  const { DevChat, sandbox, requests, hashes } = makeDevChat();
  sendReplies(sandbox);
  DevChat.startPendingSession('recipe-box');

  await DevChat.sendMessage(MSG);

  const posts = requests.filter(([u, m]) => m === 'POST' && /\/sessions$/.test(u));
  assert.equal(posts.length, 1, 'exactly one session is created');
  assert.equal(posts[0][0], '/api/apps/recipe-box/sessions');
  assert.ok(requests.some(([u]) => u === '/api/sessions/101/chat'),
    'and the message goes to the session that was just created');
  assert.equal(DevChat.currentSession.id, 101);
  assert.equal(DevChat.currentSession.pending, undefined, 'the placeholder is gone');
  assert.deepEqual(plain(hashes.at(-1)), { replace: true, ref: 101 },
    'the screen earns its own address, replacing /sessions/new so Back skips it');
});

test('an empty submit still creates nothing', async () => {
  const { DevChat, sandbox, sessionRequests } = makeDevChat();
  sendReplies(sandbox);
  DevChat.startPendingSession('recipe-box');
  await DevChat.sendMessage('', []);
  assert.deepEqual(plain(sessionRequests()), [], 'the content check runs before the creation');
  assert.equal(DevChat.isPendingSession(), true);
});

test('a refused creation leaves the text in the box and the screen unsent', async () => {
  const { DevChat, sandbox, document, sessionRequests } = makeDevChat();
  sandbox.reply = async () => ({
    ok: false, status: 429,
    json: async () => ({ error: 'You already have 3 running sessions. Pause or archive one first.' }),
  });
  DevChat.startPendingSession('recipe-box');
  const input = document.getElementById('dc-input');
  input.value = ''; // _submitFromInput clears optimistically

  await DevChat.sendMessage(MSG);

  assert.equal(sessionRequests().length, 1, 'the cap is hit at creation — no turn is attempted');
  assert.match(sandbox.toasts.join(' '), /already have 3 running sessions/,
    'the server\'s own refusal is what the user reads');
  assert.equal(input.value, MSG, 'the message is never lost');
  assert.equal(DevChat.isPendingSession(), true, 'still unsent, so the next try is one click');
  assert.equal(DevChat.isStreaming, false, 'and no turn was armed');
});

test('a second click while the first is in flight creates one session, not two', async () => {
  const { DevChat, sandbox, requests } = makeDevChat();
  let release;
  const gate = new Promise((r) => { release = r; });
  sandbox.reply = async (url, init) => {
    if (/\/sessions$/.test(url) && init && init.method === 'POST') {
      await gate;
      return { ok: true, status: 201, json: async () => ({ session: { id: 101 } }) };
    }
    return { ok: false, status: 500, json: async () => ({ error: 'nope' }) };
  };
  DevChat.startPendingSession('recipe-box');
  const first = DevChat.sendMessage(MSG);
  const second = DevChat.sendMessage(MSG);
  release();
  await Promise.all([first, second]);
  assert.equal(requests.filter(([u, m]) => m === 'POST' && /\/sessions$/.test(u)).length, 1);
});

// ── 5. the copy ───────────────────────────────────────────────────────

test('the empty state says that nothing has been created yet', () => {
  const unsent = transcriptHtml({
    rows: [], devFlowHtml: '', activity: null, busy: false, empty: true, unsent: true,
  });
  assert.match(unsent, /id="dc-empty-unsent"/);
  assert.match(unsent, /Nothing is created until you send/);
  // …and an ordinary empty session does not, because for it the sentence
  // would simply be false.
  const created = transcriptHtml({
    rows: [], devFlowHtml: '', activity: null, busy: false, empty: true, unsent: false,
  });
  assert.match(created, /id="dc-empty-state"/);
  assert.doesNotMatch(created, /dc-empty-unsent/);
});
