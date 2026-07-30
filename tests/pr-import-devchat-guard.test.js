// #846 — an IMPORTED proposal has no dev chat, so nothing may ever render
// the dev-chat session view for one. The import flow no longer navigates
// there (see pr-import-menu.test.js), but old bookmarks, the browser Back
// button and pasted links still can, so renderDevChatTab guards the surface
// itself: after the session GET reveals source === 'imported' it drops the
// session and routes to the proposal's discussion page instead.
//
// Loads the real public/js/app-view.js into a vm context (so this can't
// drift from shipped code) and exercises:
//   - an imported session redirects to switchTab('dev', {kind:'proposal'}, 'topic'),
//     clears DevChat.currentSession, and never calls renderChatView;
//   - a NATIVE session on the same path still renders the chat view.
//
// Run with: node --test tests/pr-import-devchat-guard.test.js

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
  const el = {
    dataset: {},
    style: {},
    textContent: '',
    className: '',
    disabled: false,
    _html: '',
    _classes: new Set(),
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    addEventListener: () => {},
    setAttribute: () => {},
    insertAdjacentHTML: () => {},
    scrollTop: 0,
  };
  el.classList = {
    add: (...cs) => cs.forEach((c) => el._classes.add(c)),
    remove: (...cs) => cs.forEach((c) => el._classes.delete(c)),
    contains: (c) => el._classes.has(c),
    toggle: () => false,
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => el._html,
    set: (v) => { el._html = v; },
  });
  return el;
}

// `session` is what GET /api/sessions/:id resolves to; the fake DevChat's
// openSession installs it exactly as the real one does.
function makeHarness(session) {
  const switchCalls = [];
  const renderChatViewCalls = [];
  const container = makeEl();

  const DevChat = {
    currentSession: null,
    sessions: [],
    stagingPanel: { open: false },
    specViewer: { open: false, sessionId: null },
    reset() { DevChat.currentSession = null; },
    async loadSessions() {},
    async openSession(id) {
      // The real openSession assigns the fetched row and arms a heartbeat;
      // what matters here is that currentSession carries `source`.
      DevChat.currentSession = { ...session, id: Number(id) };
    },
    renderChatView() { renderChatViewCalls.push(true); },
    startActiveSessionsPoll() {},
    stopActiveSessionsPoll() {},
    renderSessionList() {},
  };

  const sandbox = {
    console: { ...console, warn: () => {}, debug: () => {} },
    Date,
    relTime: () => 'just now',
    escapeHtml: (s) => String(s),
    escapeAttr: (s) => String(s),
    resolveDevHost: (u) => u,
    App: {
      user: { id: 1 },
      currentApp: 'x',
      currentTab: 'dev',
      currentSubTab: 'sessions',
      switchTab: (...a) => { switchCalls.push(a); },
      updateHash: () => {},
    },
    DevChat,
    Kudos: { renderButton: () => '' },
    document: {
      getElementById: (id) => ((id === 'app-content' || id === 'dc-view') ? container : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => makeEl(),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    addEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(VIEW_SRC, sandbox);
  const AppView = sandbox.window.AppView;
  AppView.appData = { slug: 'x', name: 'X', can_collaborate: true };
  return { AppView, DevChat, switchCalls, renderChatViewCalls };
}

test('renderDevChatTab redirects an imported session to its proposal page', async () => {
  const { AppView, DevChat, switchCalls, renderChatViewCalls } = makeHarness({
    source: 'imported', status: 'promoted', pr_number: 9401, app_slug: 'x',
  });

  await AppView.renderDevChatTab(555);

  assert.equal(renderChatViewCalls.length, 0,
    'the dev chat view is never rendered for an imported proposal');
  assert.equal(DevChat.currentSession, null,
    'currentSession dropped so the heartbeat no-ops');
  assert.equal(switchCalls.length, 1, 'redirected exactly once');
  const [tab, ref, subTab] = switchCalls[0];
  assert.equal(tab, 'dev');
  assert.equal(subTab, 'topic', 'landed on the topic (discussion) view');
  assert.equal(ref.kind, 'proposal');
  assert.equal(ref.id, 555, 'the proposal id is the session id');
});

test('renderDevChatTab still renders the chat view for a native session', async () => {
  const { AppView, DevChat, switchCalls, renderChatViewCalls } = makeHarness({
    source: 'native', status: 'active', app_slug: 'x',
  });

  await AppView.renderDevChatTab(556);

  assert.equal(renderChatViewCalls.length, 1, 'native session renders its chat');
  assert.ok(DevChat.currentSession, 'native session stays open');
  assert.equal(switchCalls.length, 0, 'no redirect for a native session');
});

test('renderDevChatTab renders the chat view when source is absent (legacy row)', async () => {
  // Pre-#687 rows can carry a NULL source; they are native by definition and
  // must not be swept into the redirect.
  const { AppView, switchCalls, renderChatViewCalls } = makeHarness({
    status: 'active', app_slug: 'x',
  });

  await AppView.renderDevChatTab(557);

  assert.equal(renderChatViewCalls.length, 1, 'legacy row renders its chat');
  assert.equal(switchCalls.length, 0, 'no redirect for a legacy row');
});
