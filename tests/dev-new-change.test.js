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
// What replaced it was a screen with a route of its own —
// /app/<slug>/dev/sessions/new — rendered against a client-only placeholder
// (`DevChat.startPendingSession`). The first send turned it into a real
// session (`_materializePendingSession`) and the turn proceeded normally.
//
// #2779 retired that screen as a destination: classic sessions are no
// longer created, and New change opens an unsent agent session instead. The
// address still resolves — a bookmark, Back, a link an older page wrote —
// and the router sends it to the unsent agent session on the same app.
// #4268 deleted the placeholder machinery, which nothing could reach any
// more, along with `DevChat.createSession`, which only it called.
//
// What these tests pin, in order:
//   1. the route: `new` is still the one session ref that is a word, and the
//      old address lands on an unsent agent session, replacing itself;
//   2. the entry points: New change (AppView.createProposal), the
//      out-of-credits hand-off and the banner's "Start a new change" open an
//      agent session and create nothing;
//   3. the placeholder is gone, and the dev chat creates no session at all;
//   4. the copy: the empty state invites the first message.
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
// The venue vocabulary and the launchpad question load beside the dev chat,
// as they do in the shell.
const BUILD_VENUES_SRC = read('public', 'js', 'build-venues.js');
const LAUNCHPAD_SRC = read('frontend', 'src', 'features', 'dev-chat', 'launchpad.js');

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
  const calls = { createSession: [], switchTab: [] };
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
      // Gone from DevChat (#4268); stubbed so a stray classic creation
      // from AppView would be recorded rather than throw.
      createSession: async (...args) => {
        calls.createSession.push(args);
        return { id: 77 };
      },
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
    PlatformUI: {
      toast: (m) => { sandbox.toasts.push(m); },
      hasKit: () => false,
      menu: () => Promise.resolve(null),
    },
    toasts: [],
    // Only has to EXIST for _devFlowTarget to consider a wizard at all.
    DevFlowSelect: { wizardHtml: () => '<div data-flow-wizard="1"></div>' },
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
  // so the request LOG is complete for every path — which is how "nothing
  // is created" is asserted at all.
  sandbox.reply = async () => ({ ok: true, status: 200, json: async () => ({}) });
  sandbox.fetch = async (url, init) => {
    requests.push([String(url), (init && init.method) || 'GET', init || {}]);
    return sandbox.reply(url, init);
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(BUILD_VENUES_SRC, sandbox);
  vm.runInContext(LAUNCHPAD_SRC, sandbox);
  vm.runInContext(`${DEV_CHAT_SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // The render plumbing is not what these tests are about; the methods under
  // test stay real.
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
  DevChat.renderChatView = () => {};
  DevChat._devFlowEnsureStatus = () => {};
  // Requests the SESSION story cares about. dev-chat.js also warms the model
  // picker (`GET /api/models`) when it loads, which says nothing about
  // whether a change was created.
  const sessionRequests = () => requests.filter(
    ([u]) => /^\/api\/(apps\/[^/]+\/sessions|sessions\/)/.test(u)
  );
  return {
    DevChat, sandbox, document, getEl, requests, sessionRequests, hashes, storage,
  };
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

test('the old address opens an unsent agent session on that app, in place of itself (#2779)', () => {
  const { App, context, location, urls } = loadApp();
  const prepared = [];
  const routed = [];
  context.window.UsernodeReact = { agentSession: { prepareDraft: (hint) => { prepared.push(plain(hint)); } } };
  // A desktop: the unsent conversation opens beside the inbox, not full-screen.
  context.window.matchMedia = () => ({ matches: true });
  App.navigateToApp = async (...args) => { routed.push(['app', ...args]); };
  App.navigateToMessages = (...args) => { routed.push(['messages', ...plain(args)]); };
  location.href = '/app/recipe-box/dev/sessions/new';
  App.restoreFromHash();
  assert.deepEqual(prepared, [{ slug: 'recipe-box', entry: 'app' }],
    'the unsent conversation is focused on the app the address named');
  assert.deepEqual(plain(urls[0]), ['replace', '/#messages/agent/new'],
    'replaced, from the root, so Back does not bounce through the old address');
  assert.equal(routed.some(([kind]) => kind === 'app'), false, 'the classic screen is never opened');
  assert.deepEqual(routed.at(-1), ['messages', null, null, { kind: 'agent', id: 'new' }]);
});

test('an unsent conversation already on screen takes the old address\'s hint in place (#2779)', () => {
  // The route alone would change nothing there, and the hint would wait for
  // the next unsent conversation; the controller's own start applies it.
  const { App, context, location, urls } = loadApp();
  const started = [];
  const prepared = [];
  context.window.UsernodeReact = {
    agentSession: {
      isOpen: () => true,
      currentId: () => 'new',
      start: (hint) => { started.push(plain(hint)); },
      prepareDraft: (hint) => { prepared.push(plain(hint)); },
    },
  };
  context.window.matchMedia = () => ({ matches: true });
  App.navigateToApp = async () => { throw new Error('the classic screen must not open'); };
  App.navigateToMessages = () => {};
  location.href = '/app/recipe-box/dev/sessions/new';
  App.restoreFromHash();
  assert.deepEqual(started, [{ slug: 'recipe-box', entry: 'app' }]);
  assert.deepEqual(prepared, [], 'start carries the hint; nothing is left pending');
  assert.deepEqual(plain(urls[0]), ['replace', '/#messages/agent/new']);
});

// ── 2. the entry points ───────────────────────────────────────────────

test('New change on an app opens an agent session and creates nothing', () => {
  const { AppView, calls, sandbox } = loadAppView();
  const started = [];
  sandbox.UsernodeReact = { agentSession: { start: (hint) => { started.push(plain(hint)); } } };
  AppView.createProposal();
  assert.deepEqual(started, [{ slug: 'recipe-box', entry: 'app' }]);
  assert.deepEqual(plain(calls.createSession), [], 'no session is POSTed');
  assert.deepEqual(plain(calls.switchTab), [], 'and the classic screen is not opened');
});

test('the out-of-credits hand-off opens the agent session on its "Build with" tab', () => {
  // It used to create a classic session up front to record the hand-off on;
  // an agent session hands off from its composer's "Build with" sheet.
  const { AppView, calls, sandbox } = loadAppView();
  const started = [];
  sandbox.UsernodeReact = { agentSession: { start: (hint) => { started.push(plain(hint)); } } };
  AppView.createProposal({ flow: 'codex' });
  AppView.createProposal({ flow: 'something-else' });
  assert.deepEqual(started, [
    { slug: 'recipe-box', entry: 'app', handoff: 'codex' },
    { slug: 'recipe-box', entry: 'app' },
  ]);
  assert.deepEqual(plain(calls.createSession), []);
});

test('the banner\'s "Start a new change" opens an agent session on the same app', () => {
  const { DevChat, sandbox, sessionRequests } = makeDevChat();
  const started = [];
  const switched = [];
  sandbox.App.switchTab = async (...args) => { switched.push(args); };
  sandbox.AppView = { appData: { slug: 'recipe-box' } };
  sandbox.UsernodeReact = { agentSession: { start: (hint) => { started.push(plain(hint)); } } };
  DevChat.startNewChange();
  assert.deepEqual(started, [{ slug: 'recipe-box', entry: 'banner' }]);
  assert.deepEqual(plain(switched), [], 'the classic screen is not opened');
  assert.deepEqual(plain(sessionRequests()), [], 'and nothing is created on the way');
});

// ── 3. the placeholder is gone (#4268) ───────────────────────────────

test('the unsent classic change and the creation behind it are deleted', () => {
  // Nothing reached them once the old address became an agent session's:
  // the router answers it before the dev chat renders, and no entry point
  // opened the placeholder. Each was a client-only stand-in for a row that
  // POST /api/apps/:slug/sessions now refuses to a browser
  // (`agent_sessions_only`), so the only thing left for them to do was fail.
  for (const name of [
    'startPendingSession', '_materializePendingSession',
    '_materializePendingSessionForVenue', 'isPendingSession',
    '_pendingCreateInFlight', 'pending_agent_choice', 'createSession',
  ]) {
    assert.doesNotMatch(DEV_CHAT_SRC, new RegExp(`\\b${name}\\b`), `${name} is gone`);
  }
  assert.doesNotMatch(DEV_CHAT_SRC,
    /fetch\(`\/api\/apps\/\$\{[^}]*\}\/sessions`,\s*\{\s*method: 'POST'/,
    'the dev chat never POSTs a classic session');
  // The router no longer serializes a placeholder as the word: every
  // session the dev chat has open is a row with an id.
  assert.doesNotMatch(APP_SRC, /currentSession\.pending/);

  const { DevChat } = makeDevChat();
  for (const name of ['startPendingSession', '_materializePendingSession', 'createSession', 'isPendingSession']) {
    assert.equal(typeof DevChat[name], 'undefined', `DevChat.${name}`);
  }
});

test('the venue sheet always answers for a real session', () => {
  // 'start' was the placeholder's case: "nothing in it yet". A session the
  // sheet opens on now always has a row, so it says what each venue keeps.
  const { DevChat, sandbox } = makeDevChat();
  sandbox.AppView = { readOnly: false, appData: { repo_url: 'https://example.test/r' } };
  DevChat.currentSession = { id: 101, app_slug: 'recipe-box', status: 'active', source: 'request_spec' };
  assert.equal(DevChat._venueSheetState().mode, 'switch');
  assert.match(DevChat._sessionHeaderView().venue.title, /^Building in Homeroom · Claude\./);
});

// ── 4. the copy ───────────────────────────────────────────────────────

// #2572: the screen no longer spells out that nothing is created until you
// send — neither in the transcript's empty state nor in the header strip's
// tooltip. The empty state itself stays: it is what invites the first
// message, and it is the same on an unsent change as on any empty session.
test('the empty state invites the first message and claims nothing about creation', () => {
  const empty = transcriptHtml({
    rows: [], devFlowHtml: '', activity: null, busy: false, empty: true,
  });
  assert.match(empty, /id="dc-empty-state"/);
  assert.match(empty, /What should this session change\?/);
  assert.doesNotMatch(empty, /dc-empty-unsent/);
  assert.doesNotMatch(empty, /Nothing is created until you send/);
});
