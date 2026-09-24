// #2879 — "Blank page": Home → the Homeroom menu → New change landed on
// /app/<self>/dev/sessions/new with the header naming Homeroom, Messages lit,
// and nothing at all beneath them.
//
// That screen is renderDevChatTab, and it returned early over an empty
// #dc-view whenever AppView.appData was missing. navigateToApp reaches it
// whether or not AppView.open got the app's record (a failed or superseded
// GET /api/apps/<slug> leaves appData empty), so a record that did not come
// back was a blank page with no way forward.
//
// Loads the real public/js/app-view.js into a vm context and pins:
//   - a missing record is asked for once more, and a record that then
//     arrives renders the unsent change as usual;
//   - a record that still will not come renders a stated error with a
//     Try again control — never an empty host;
//   - Try again re-renders the screen once the record is back;
//   - the Messages pane (embedded) keeps its own contract untouched.
//
// Run with: node --test tests/dev-session-missing-app-record.test.js

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
  const el = {
    dataset: {},
    style: {},
    _html: '',
    querySelector: (sel) => (sel === '#dc-app-unavailable-retry' && el._html.includes('dc-app-unavailable-retry')
      ? { addEventListener: (type, fn) => { listeners[type] = fn; } }
      : null),
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
    _listeners: listeners,
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = v; },
  });
  return el;
}

// `recordAnswers` is the sequence of GET /api/apps/<slug> outcomes: true for
// a served record, false for a failed read.
function makeHarness(recordAnswers) {
  const container = makeEl();
  const renderChatViewCalls = [];
  const pendingStarts = [];
  const appRequests = [];
  const answers = [...recordAnswers];

  const DevChat = {
    NEW_SESSION_REF: 'new',
    currentSession: null,
    sessions: [],
    stagingPanel: { open: false },
    specViewer: { open: false, sessionId: null },
    reset() { DevChat.currentSession = null; },
    async loadSessions() {},
    startPendingSession(slug) { pendingStarts.push(slug); DevChat.currentSession = { pending: true, app_slug: slug }; },
    renderChatView() { renderChatViewCalls.push(true); },
    renderSessionList() {},
  };

  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    App: {
      user: { id: 1 },
      currentApp: 'homeroom-self',
      currentTab: 'dev',
      currentSubTab: 'sessions',
      switchTab: () => {},
      updateHash: () => {},
    },
    DevChat,
    document: {
      getElementById: (id) => ((id === 'app-content' || id === 'dev-section') ? container : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async (url) => {
      const u = String(url);
      if (u === '/api/apps/homeroom-self') {
        appRequests.push(u);
        const ok = answers.length ? answers.shift() : false;
        return ok
          ? { ok: true, status: 200, json: async () => ({ app: { slug: 'homeroom-self', name: 'Homeroom', self_hosted: true, can_collaborate: true } }) }
          : { ok: false, status: 503, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    location: { search: '', hash: '', pathname: '/' },
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  const AppView = sandbox.window.AppView;
  // Everything AppView.open does after the record lands is beside the point
  // here; keep it inert so the harness needs no more of the shell.
  AppView.refreshToken = async () => {};
  AppView.prefetchDevData = () => {};
  AppView.startActivityTracking = () => {};
  AppView.startTokenRefresh = () => {};
  AppView._loadDevData = async () => {};
  AppView.appData = null;
  return { AppView, sandbox, container, renderChatViewCalls, pendingStarts, appRequests };
}

test('#2879: the unsent change with no app record asks once more, and renders when it arrives', async () => {
  const h = makeHarness([true]);

  await h.AppView.renderDevChatTab('new');

  assert.equal(h.appRequests.length, 1, 'the record is asked for again');
  assert.deepEqual(h.pendingStarts, ['homeroom-self'], 'the placeholder starts against the record');
  assert.equal(h.renderChatViewCalls.length, 1, 'the unsent change is drawn');
});

test('#2879: a record that will not come is said, with Try again — never an empty page', async () => {
  const h = makeHarness([false]);

  await h.AppView.renderDevChatTab('new');

  assert.equal(h.renderChatViewCalls.length, 0);
  assert.match(h.container.innerHTML, /id="dc-app-unavailable"/, 'the error state is rendered');
  assert.match(h.container.innerHTML, /could not be loaded/);
  assert.match(h.container.innerHTML, /id="dc-app-unavailable-retry"/, 'with a way to try again');
  assert.doesNotMatch(h.container.innerHTML, /id="dc-view"/, 'not the empty session host');
});

test('#2879: Try again re-renders the screen once the record is back', async () => {
  const h = makeHarness([false, true]);

  await h.AppView.renderDevChatTab('new');
  assert.equal(typeof h.container._listeners.click, 'function', 'Try again is wired');
  h.container._listeners.click();
  // The retry is an async render; let it settle.
  for (let i = 0; i < 20 && !h.renderChatViewCalls.length; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }

  assert.equal(h.renderChatViewCalls.length, 1, 'the unsent change is drawn after the retry');
  assert.deepEqual(h.pendingStarts, ['homeroom-self']);
});

test('#2879: a record for ANOTHER app counts as missing', async () => {
  const h = makeHarness([true]);
  h.AppView.appData = { slug: 'some-other-app', name: 'Other' };

  await h.AppView.renderDevChatTab('new');

  assert.equal(h.appRequests.length, 1, 'the open app\'s record is asked for');
  assert.deepEqual(h.pendingStarts, ['homeroom-self'], 'and the change is started for the open app');
});

test('#2879: the Messages pane keeps its own contract (no refetch, no error card)', async () => {
  const h = makeHarness([true]);
  h.sandbox.App.currentApp = null;

  const result = await h.AppView.renderDevChatTab('new', { embedded: true });

  assert.equal(result, undefined);
  assert.equal(h.appRequests.length, 0, 'the pane loads its own app; this does not');
  assert.doesNotMatch(h.container.innerHTML, /dc-app-unavailable/);
});
