// #889: clicking Stop in dev chat used to acknowledge itself with nothing
// at all — the red Stop button stayed red (there is no `:disabled` rule for
// `.dc-send-btn`, so `disabled = true` was invisible), the "Claude Code is
// running…" line kept spinning, and the chat looked untouched for the ~19s
// the server took to unwind the turn.
//
// These tests drive the REAL DevChat._stopCurrentTurn / _enterStoppingState /
// _clearStoppingState / _setStreamingUI / _finishStreaming against a minimal
// fake DOM, asserting on the observable button + message-list state rather
// than the network. Same vm-in-a-sandbox approach as
// tests/devchat-composer-restore.test.js — dev-chat.js is a plain browser
// script (`const DevChat = {…}`), so we load its source into a vm context,
// expose DevChat, and drive it.
//
// Cases (per the spec's Tests section):
//   1. click            → _stopping, dc-btn-stopping, exactly one row, the
//                         previously-live status row deactivated
//   2. `stopped` event  → row spliced, button back to Send, flag cleared
//   3. fetch rejects    → failure row, red Stop restored, turn still live
//   4. wrap-up refusal  → mayor2 spinner state, no stopping row
//   5. duplicate events → still exactly one row
//
// Run with: node --test tests/devchat-stop-feedback.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// One persistent fake element per id (registry-backed) so the send button we
// assert on survives re-resolution by id, mirroring the real DOM.
function makeElement(id) {
  const classes = new Set();
  const attrs = new Map();
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute(k, v) { attrs.set(k, v); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    removeChild() {},
    remove() {},
    focus() {},
    blur() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

function makeHarness() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };

  const document = {
    _title: 'MyApp',
    get title() { return this._title; },
    set title(v) { this._title = v; },
    getElementById: (id) => getEl(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag) => makeElement(`__created_${tag}`),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  // Timers are inert: the 30s "taking longer than usual" escalation is
  // exercised by calling the row mutation directly, not by waiting.
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    document,
    localStorage,
    AbortController,
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions', user: { username: 'evan' } },
    Notifications: {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize rendering + streaming plumbing. Crucially _setStreamingUI is
  // left REAL — the button state is exactly what these tests are about.
  DevChat.renderMessages = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._removeSpinner = () => {};
  DevChat._flushStreamingFinal = () => {};
  DevChat._stopProgressPolling = () => {};
  DevChat._closeResumableStream = () => {};
  DevChat._openResumableStream = () => {};
  DevChat._startProgressPolling = () => {};
  DevChat._syncSaveDraftBtn = () => {};
  DevChat._renderSavedDrafts = () => {};
  DevChat._renderQuickReplies = () => {};
  DevChat._applySyncBanner = () => {};
  DevChat._restoreComposer = () => {};
  DevChat._reconcileAfterFallbackDone = () => {};

  return { DevChat, sandbox, document, getEl };
}

const SESSION_ID = 42;

// Put the harness in the state a user sees mid-CC-turn: streaming, a live
// "Claude Code is running…" status row, red Stop button mounted.
function arriveMidTurn(DevChat) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [
    { role: 'user', content: 'add dark mode', created_at: new Date().toISOString() },
    {
      role: 'system',
      content: 'Claude Code is running...',
      created_at: new Date().toISOString(),
      _slug: 'aaa111',
      _active: true,
    },
  ];
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'cc');
}

const stoppingRows = (DevChat) => DevChat.messages.filter((m) => m._stopping);

test('clicking Stop paints the stopping button + one transient row', async () => {
  const { DevChat, sandbox, document } = makeHarness();
  arriveMidTurn(DevChat);

  const btn = document.getElementById('dc-send-btn');
  assert.equal(btn.classList.contains('dc-btn-stop'), true, 'precondition: red Stop is mounted');

  let posted = null;
  sandbox.fetch = async (url, opts) => {
    posted = { url, method: opts?.method };
    return { ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }) };
  };

  await DevChat._stopCurrentTurn();

  assert.equal(posted.url, `/api/sessions/${SESSION_ID}/stop`);
  assert.equal(posted.method, 'POST');

  // Button: muted stopping state, not the red square, and unclickable.
  assert.equal(DevChat._stopping, true);
  assert.equal(btn.classList.contains('dc-btn-stopping'), true);
  assert.equal(btn.classList.contains('dc-btn-stop'), false);
  assert.equal(btn.disabled, true);
  assert.match(btn.innerHTML, /Stopping…/);
  assert.equal(btn.getAttribute('aria-label'), 'Stopping');

  // Transcript: exactly one live stopping row…
  const rows = stoppingRows(DevChat);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, 'Stopping the agent…');
  assert.equal(rows[0]._active, true, 'row is _active so it gets the arc spinner + elapsed ticker');
  assert.equal(rows[0].role, 'system');

  // …and the previously-spinning line froze, so only one thing spins.
  const ccRow = DevChat.messages.find((m) => m._slug === 'aaa111');
  assert.equal(ccRow._active, false);

  // The turn itself is still live until the server says otherwise.
  assert.equal(DevChat.isStreaming, true);
});

test('the `stopped` event splices the transient row and restores Send', async () => {
  const { DevChat, sandbox, document } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }),
  });
  await DevChat._stopCurrentTurn();
  assert.equal(stoppingRows(DevChat).length, 1);

  // What every 'stopped' handler (POST-SSE / resumable / WS) ends up calling.
  DevChat._finishStreaming();

  assert.equal(DevChat._stopping, false);
  assert.equal(stoppingRows(DevChat).length, 0, 'transient row is gone');
  // The real, persisted "…stopped by @user." row is the server's job; the
  // user message and the frozen CC line are untouched.
  assert.equal(DevChat.messages.length, 2);

  const btn = document.getElementById('dc-send-btn');
  assert.equal(btn.classList.contains('dc-btn-stopping'), false);
  assert.equal(btn.classList.contains('dc-btn-stop'), false);
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Send');
});

test('a failed stop request explains itself and hands back the Stop button', async () => {
  const { DevChat, sandbox, document } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => { throw new Error('network down'); };

  await DevChat._stopCurrentTurn();

  assert.equal(DevChat._stopping, false);
  assert.equal(stoppingRows(DevChat).length, 0, 'stopping row replaced, not left spinning');
  const last = DevChat.messages[DevChat.messages.length - 1];
  assert.equal(last.role, 'system');
  assert.match(last.content, /Couldn’t stop the agent/);

  // The turn is still running, so the red Stop must come back for a retry.
  const btn = document.getElementById('dc-send-btn');
  assert.equal(DevChat.isStreaming, true);
  assert.equal(btn.classList.contains('dc-btn-stop'), true);
  assert.equal(btn.classList.contains('dc-btn-stopping'), false);
  assert.equal(btn.disabled, false);
});

test('a non-ok HTTP response takes the same failure path', async () => {
  const { DevChat, sandbox, document } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

  await DevChat._stopCurrentTurn();

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.match(DevChat.messages[DevChat.messages.length - 1].content, /Couldn’t stop the agent/);
  assert.equal(document.getElementById('dc-send-btn').classList.contains('dc-btn-stop'), true);
});

test('"wrap-up cannot be stopped" switches to the finishing-up spinner', async () => {
  const { DevChat, sandbox, document } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, stopped: false, reason: 'wrap-up cannot be stopped' }),
  });

  await DevChat._stopCurrentTurn();

  assert.equal(DevChat._stopping, false);
  assert.equal(stoppingRows(DevChat).length, 0, 'no stop is coming, so nothing may keep spinning');
  assert.match(
    DevChat.messages[DevChat.messages.length - 1].content,
    /wrap-up can’t be interrupted/
  );

  const btn = document.getElementById('dc-send-btn');
  assert.equal(btn.classList.contains('dc-btn-streaming'), true, 'mayor2 spinner state');
  assert.equal(btn.classList.contains('dc-btn-stopping'), false);
  assert.equal(btn.classList.contains('dc-btn-stop'), false);
  assert.equal(btn.disabled, true);
  assert.equal(DevChat.isStreaming, true);
});

test('"no active turn" tears down streaming and reconciles from the DB', async () => {
  const { DevChat, sandbox, document } = makeHarness();
  arriveMidTurn(DevChat);
  let reconciled = null;
  let streamingAtReconcile = null;
  DevChat._reconcileAfterFallbackDone = (id) => {
    reconciled = id;
    // The real _reconcileAfterFallbackDone bails while isStreaming is true
    // ("a newer turn owns the timeline"), so capture the flag as it sees
    // it — asserting only that we CALLED it would pass even when the
    // reload can never actually happen.
    streamingAtReconcile = DevChat.isStreaming;
  };
  sandbox.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, stopped: false, reason: 'no active turn' }),
  });

  await DevChat._stopCurrentTurn();

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.equal(DevChat._stopping, false);
  assert.equal(reconciled, SESSION_ID, 'reloads so the timeline repaints as finished');
  assert.equal(streamingAtReconcile, false, 'streaming torn down first, or the reload no-ops');
  assert.equal(DevChat.isStreaming, false);
  // No `stopped` event is coming for a turn that already ended, so the
  // composer has to be usable again on our own.
  assert.equal(document.getElementById('dc-send-btn').textContent, 'Send');
});

test('duplicate `stopping` events collapse into a single row', async () => {
  const { DevChat, sandbox } = makeHarness();
  arriveMidTurn(DevChat);
  sandbox.fetch = async () => ({
    ok: true, status: 200, json: async () => ({ ok: true, stopped: true, phase: 'cc' }),
  });

  // Own click, then the server's echo arriving on both the WS and the
  // primary SSE (seq dedup covers the common case, but a bus replay after a
  // reconnect can genuinely deliver it again).
  await DevChat._stopCurrentTurn();
  DevChat._enterStoppingState({ by: 'evan' });
  DevChat._enterStoppingState({ by: 'evan' });

  assert.equal(stoppingRows(DevChat).length, 1);
  assert.equal(DevChat._stopping, true);
});

test('a stop by someone else names them in the row', () => {
  const { DevChat } = makeHarness();
  arriveMidTurn(DevChat);

  DevChat._enterStoppingState({ by: 'dana' });

  const rows = stoppingRows(DevChat);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '@dana is stopping the agent…');
});

test('_enterStoppingState is a no-op when nothing is streaming', () => {
  const { DevChat } = makeHarness();
  DevChat.currentSession = { id: SESSION_ID };
  DevChat.messages = [];
  DevChat.isStreaming = false;

  DevChat._enterStoppingState({ by: 'evan' });

  assert.equal(stoppingRows(DevChat).length, 0);
  assert.equal(DevChat._stopping, false);
});

test('a fresh send never inherits the previous turn stopping state', () => {
  const { DevChat, document } = makeHarness();
  arriveMidTurn(DevChat);
  // Reload-recovery sets the flag with no row to hang it on.
  DevChat._stopping = true;

  DevChat._clearStoppingState();
  DevChat._setStreamingUI(true, 'mayor1');

  const btn = document.getElementById('dc-send-btn');
  assert.equal(btn.classList.contains('dc-btn-stopping'), false);
  assert.equal(btn.classList.contains('dc-btn-stop'), true, 'a new turn is interruptible again');
});
