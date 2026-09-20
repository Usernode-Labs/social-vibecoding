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
// #2607 put the venue dropdown on this screen, so the venue vocabulary and
// the launchpad question are part of what the placeholder has to answer.
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
    // #2607: the venue sheet is presented by the kit. `hasKit` is false by
    // default, so the sheet is a no-op unless a test stands in for it (see
    // `pickVenue` below) — which keeps every other test here unchanged.
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
  // so the request LOG is complete for every path — which is how "the
  // placeholder makes no requests" is asserted at all.
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
  DevChat.renderChatView = () => {};
  DevChat._devFlowEnsureStatus = () => {};
  // Requests the SESSION story cares about. dev-chat.js also warms the model
  // picker (`GET /api/models`) when it loads, which says nothing about
  // whether a change was created.
  const sessionRequests = () => requests.filter(
    ([u]) => /^\/api\/(apps\/[^/]+\/sessions|sessions\/)/.test(u)
  );
  // #2607: stand in for the kit and click one of the sheet's rows, exactly
  // as tests/venue-return-to-chat.test.js does — the pick handler lives
  // inside a menu callback, so this is the only way to run the real one.
  // Returns the labels the sheet offered, which is also what pins the
  // wording a new change sees.
  const pickVenue = async (match) => {
    let offered = null;
    sandbox.PlatformUI.hasKit = () => true;
    sandbox.PlatformUI.menu = async (opts) => {
      offered = opts.items.map((i) => i.label);
      // `match` null lists the rows without clicking one, which is how the
      // wording an unsent change is offered gets pinned.
      const row = match ? opts.items.find((i) => match.test(i.label)) : null;
      if (match) assert.ok(row, `the sheet offers ${match}`);
      if (row) row.handler();
      return null;
    };
    DevChat.openVenueSheet();
    // The kit discards what a row's handler returns, so the pick cannot be
    // awaited directly. A macrotask turn drains every microtask the handler
    // queued — the creation POST and its json() — which is what the
    // assertions after it are about.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return offered;
  };
  return {
    DevChat, sandbox, document, getEl, requests, sessionRequests, hashes, storage, pickVenue,
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
  // #2572: and it says only that — the caption carries no tooltip spelling
  // out that nothing is created until you send.
  assert.equal(head.newChangeTitle, '');
  assert.equal(head.sessionId, null);
  assert.equal(head.pr, null);
  assert.equal(head.life, null);
  assert.deepEqual(plain(head.actions), [], 'Pause / Archive / Free worker have nothing to act on');
});

// ── 3b. #2607: the one control an unsent change DOES get ────────────

test('the unsent change states the venue it would be built in, and offers the choice', () => {
  // This assertion was `head.venue === null`, on the reasoning that a venue
  // is the server's answer at creation time and guessing before that would
  // be dishonest. The cost was that the one screen where "where should this
  // be built?" is still an open question was the one screen that never
  // asked it: the only way to reach the choice was to send a message into
  // the venue you did not want and switch afterwards.
  const { DevChat } = makeDevChat();
  DevChat.startPendingSession('recipe-box');

  const head = DevChat._sessionHeaderView();
  assert.ok(head.venue, 'the dropdown paints before the first send');
  assert.equal(head.venue.id, 'usernode-claude',
    'derived from the placeholder, exactly as a real row derives its own');
  assert.equal(head.venue.label, 'Homeroom · Claude');
  assert.equal(head.venue.disabled, false, 'nothing is running, so nothing is locked');
  assert.match(head.venue.title, /^This change will be built in Homeroom · Claude\./,
    'and the tense is the true one — nothing is being built yet');
  assert.doesNotMatch(head.venue.title, /^Building in/);

  // #2607 changes THIS control and nothing else about the strip.
  assert.equal(head.pr, null);
  assert.equal(head.life, null);
  assert.deepEqual(plain(head.actions), []);
});

test('the composer picker and the venue dropdown state the same in-chat venue', () => {
  // `pending_agent_choice` is the only thing that can move an unsent change
  // between the two in-chat venues, and both controls read it through the
  // same derivation, so they cannot disagree about a change nobody has sent.
  const { DevChat } = makeDevChat();
  DevChat.startPendingSession('recipe-box');
  DevChat.currentSession.agent_backend = 'codex_openrouter';
  assert.equal(DevChat._sessionHeaderView().venue.id, 'usernode-openrouter');
});

test('the sheet asks the unsent change the START question, with every answer open', async () => {
  const { DevChat, sandbox, pickVenue } = makeDevChat();
  sandbox.App.user = { ...sandbox.App.user, externalFlowsAvailable: true };
  sandbox.AppView = { readOnly: false, appData: { repo_url: 'https://example.test/r' } };
  DevChat.startPendingSession('recipe-box');

  const state = DevChat._venueSheetState();
  assert.equal(state.mode, 'start',
    'an unsent change is build-venues.js\'s own "nothing in it yet" case');
  assert.equal(state.sessionId, null);
  assert.equal(state.hasBranch, false);
  assert.equal(DevChat._webHandoffTargetId(), null,
    'so a hand-off starts new work rather than pushing onto a branch that does not exist');

  const offered = await pickVenue(null);
  assert.deepEqual(plain(offered), [
    'On-Platform ✓', 'Claude or Codex WebUI', 'Your Own Developer Tooling',
  ], 'the same rows an existing session is offered, with the in-chat one ticked');
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

test('an OpenRouter pick stays local until the placeholder is created', async () => {
  const { DevChat, sandbox, requests, sessionRequests } = makeDevChat();
  DevChat.startPendingSession('recipe-box');

  await DevChat._switchCurrentCodingAgent({
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });

  assert.deepEqual(plain(sessionRequests()), [],
    'an id-less placeholder must never call /sessions/null/reset-agent-context');
  assert.deepEqual(plain(DevChat.currentSession.pending_agent_choice), {
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  });
  assert.equal(DevChat.currentSession.agent_backend, 'codex_openrouter',
    'the grouped picker immediately reflects the staged provider');

  sendReplies(sandbox, {
    create: {
      id: 101,
      agent_backend: 'codex_openrouter',
      agent_model: 'openai/gpt-5.3-codex',
      agent_reasoning_effort: 'high',
    },
  });
  await DevChat.sendMessage(MSG);

  const create = requests.find(([u, m]) => m === 'POST' && /\/sessions$/.test(u));
  assert.deepEqual(JSON.parse(create[2].body), {
    backend: 'codex_openrouter',
    model: 'openai/gpt-5.3-codex',
    reasoningEffort: 'high',
  }, 'the first real session is created with the model selected while it was pending');
});

test('an Anthropic pick explicitly overrides the saved provider on first send', async () => {
  const { DevChat, sandbox, requests, sessionRequests } = makeDevChat();
  DevChat.startPendingSession('recipe-box');

  await DevChat._onModelPicked('anthropic:claude-fable-5-1');

  assert.deepEqual(plain(sessionRequests()), [], 'the pending choice is still client-only');
  assert.equal(DevChat.selectedModel, 'claude-fable-5-1');
  assert.deepEqual(plain(DevChat.currentSession.pending_agent_choice), {
    backend: 'claude_code', model: null, reasoningEffort: null,
  });

  sendReplies(sandbox, { create: { id: 101, agent_backend: 'claude_code' } });
  await DevChat.sendMessage(MSG);

  const create = requests.find(([u, m]) => m === 'POST' && /\/sessions$/.test(u));
  assert.deepEqual(JSON.parse(create[2].body), {
    backend: 'claude_code', model: null, reasoningEffort: null,
  }, 'the server must not silently reapply an OpenRouter default after this explicit pick');
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

// ── 4b. #2607: picking a venue before the first send ───────────────

/** An unsent change with the sheet's gates open and the creation stubbed. */
function pendingWithSheet({ create = { id: 101, agent_backend: 'claude_code' } } = {}) {
  const h = makeDevChat();
  h.sandbox.App.user = { ...h.sandbox.App.user, externalFlowsAvailable: true };
  h.sandbox.AppView = { readOnly: false, appData: { repo_url: 'https://example.test/r' } };
  h.sandbox.SessionOptions = {
    openInstructions: (opts) => { h.sandbox.instructions = opts; return { dismiss() {} }; },
  };
  h.sandbox.reply = async (url, init) => {
    if (/\/api\/apps\/[^/]+\/sessions$/.test(url) && init && init.method === 'POST') {
      return { ok: true, status: 201, json: async () => ({ session: create }) };
    }
    return { ok: true, status: 200, json: async () => ({ session: create }) };
  };
  h.DevChat.startPendingSession('recipe-box');
  return h;
}

test('an in-chat pick before the first send creates nothing', async () => {
  // On-Platform is the row the unsent change is already on, so picking it
  // is only reachable after a hand-off has been chosen and abandoned. What
  // matters either way is that it writes nothing: which in-chat agent the
  // change is created with is staged on the placeholder as
  // `pending_agent_choice` by the composer's picker, and left null the
  // server resolves the saved default at creation — which is exactly the
  // resolution the no-backend reset-agent-context asks for on a real row.
  const { DevChat, sessionRequests, pickVenue } = pendingWithSheet();
  // Stand the change on a hand-off first, in memory only, so On-Platform is
  // an offered row rather than the ticked one.
  DevChat.currentSession.build_venue = 'web-claude-code';
  DevChat._resetDevFlow(null);
  DevChat._devFlowFromCredits('claude-code', null);
  assert.equal(DevChat._launchpadVenue(), 'web-claude-code');

  await pickVenue(/On-Platform/);

  assert.deepEqual(plain(sessionRequests()), [],
    'no session is created, and nothing is POSTed against a null id');
  assert.equal(DevChat.isPendingSession(), true, 'still unsent');
  assert.equal(DevChat.currentSession.build_venue, null, 'the hand-off is cleared');
  assert.equal(DevChat.currentSession.pending_agent_choice, null,
    'and the in-chat choice stays the server\'s to resolve at creation');
  assert.equal(DevChat._launchpadVenue(), null, 'the composer is back');
});

test('a hand-off pick creates the session first, then hands off exactly as it would on a real one', async () => {
  const { DevChat, requests, getEl, hashes, storage, pickVenue } = pendingWithSheet();
  const TYPED = 'add a dark mode toggle to the settings page';
  getEl('dc-input').value = TYPED;

  await pickVenue(/Claude or Codex WebUI/);

  // 1. The row is created through the FIRST SEND'S own path: same endpoint,
  //    and no backend key, so the server resolves the saved default.
  const creates = requests.filter(([u, m]) => m === 'POST' && /\/sessions$/.test(u));
  assert.equal(creates.length, 1, 'exactly one session is created');
  assert.equal(creates[0][0], '/api/apps/recipe-box/sessions');
  assert.deepEqual(JSON.parse(creates[0][2].body), {},
    'same defaults as the first send — the server resolves the venue');
  assert.equal(DevChat.currentSession.id, 101);
  assert.equal(DevChat.isPendingSession(), false, 'the placeholder is gone');
  assert.deepEqual(plain(hashes.at(-1)), { replace: true, ref: 101 },
    'and the screen earns its own address, exactly as the first send gives it one');

  // 2. The chosen venue is recorded on it through the existing persistence.
  const venuePost = requests.find(([u, m]) => m === 'POST' && /\/build-venue$/.test(u));
  assert.ok(venuePost, 'the pick is recorded on the new row');
  assert.equal(venuePost[0], '/api/sessions/101/build-venue');
  assert.deepEqual(JSON.parse(venuePost[2].body), { venue: 'web-claude-code' });
  assert.ok(requests.some(([u, m]) => m === 'POST' && u === '/api/me/dev-flow'),
    'and answering the venue question answers it for next time, as it does on a real session');

  // 3. Then it continues precisely as the pick does on an existing session:
  //    the guided walkthrough, on the session that was just created.
  assert.equal(DevChat._launchpadVenue(), 'web-claude-code');
  assert.equal(DevChat._devFlow.mode, 'wizard');
  assert.equal(DevChat._devFlow.agent, 'claude-code');
  assert.equal(DevChat._devFlow.targetId, null,
    'a change with no branch starts new work — "Start new work with", not "Continue"');

  // 4. And what was typed is still there, under the id it now belongs to.
  assert.equal(getEl('dc-input').value, TYPED, 'the composer survives the creation');
  assert.equal(storage.get('usernode:dc-draft:101'), TYPED,
    're-keyed onto the new session, so the next paint cannot clear it');
  DevChat._restoreDraft();
  assert.equal(getEl('dc-input').value, TYPED, 'including the paint that follows');
});

test('the lease and the import both create the row first too', async () => {
  const lease = pendingWithSheet();
  lease.sandbox.App.user = {
    ...lease.sandbox.App.user, cliAuthEnabled: true, sessionBridgeEnabled: true,
  };
  await lease.pickVenue(/Local CLI Bridge/);
  assert.equal(lease.DevChat.currentSession.id, 101, 'a lease is granted against a session id');
  assert.equal(lease.sandbox.instructions.state.sessionId, 101,
    'and the card names the session that now exists, not null');

  const own = pendingWithSheet();
  await own.pickVenue(/Your Own Developer Tooling/);
  assert.equal(own.DevChat.currentSession.id, 101);
  const venuePost = own.requests.find(([u, m]) => m === 'POST' && /\/build-venue$/.test(u));
  assert.deepEqual(JSON.parse(venuePost[2].body), { venue: 'own-tools-pr' });
  assert.equal(own.DevChat._launchpadVenue(), 'own-tools-pr');
});

test('a refused creation says so and leaves the dropdown where it was', async () => {
  const { DevChat, sandbox, requests, pickVenue } = pendingWithSheet();
  sandbox.reply = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: 'You already have 3 running sessions. Pause or archive one first.' }),
  });

  await pickVenue(/Claude or Codex WebUI/);

  assert.match(sandbox.toasts.join(' '), /already have 3 running sessions/,
    'the server\'s own refusal is what the user reads, in the line that already says it');
  assert.equal(DevChat.isPendingSession(), true, 'still unsent, so the next try is one click');
  assert.equal(requests.filter(([u, m]) => m === 'POST' && /\/build-venue$/.test(u)).length, 0,
    'nothing is recorded against a row that was never created');
  assert.equal(DevChat._sessionHeaderView().venue.id, 'usernode-claude',
    'and the dropdown still states the venue it was showing');
  assert.equal(DevChat._launchpadVenue(), null, 'no launchpad for a session that does not exist');
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
