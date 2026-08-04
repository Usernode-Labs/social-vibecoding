// Tests for the "phantom Stop button" fix: session-open is authoritative
// for the streaming UI. A freshly-opened idle session (e.g. a proposal
// clone) must never inherit a previously-streaming session's red Stop
// button or "⏳ Thinking…" title.
//
// Unlike the source-guard style of spec-viewer-session-reset.test.js,
// this test actually EXECUTES the real DevChat.openSession /
// _setStreamingUI / renderChatView against a minimal fake DOM + globals,
// so it asserts on observable button/flag/title state rather than tokens.
// dev-chat.js is a plain browser script (`const DevChat = {…}`), so we
// load its source into a vm context, expose DevChat, and drive it.
//
// Two cases (per the spec's "guard against over-resetting"):
//   1. busy:false → opening a different idle session resets to "Send",
//      isStreaming=false, no live "thinking" marker.
//   2. busy:true  → the busy branch re-arms the Stop/streaming UI, so a
//      genuinely mid-turn session still shows Stop.
//
// Run with: node --test tests/openSession-streaming-reset.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// ── Minimal fake DOM element ──────────────────────────────────────────
// One persistent fake element per id (registry-backed), so renderChatView
// re-writing innerHTML doesn't "destroy" the send button we assert on —
// getElementById keeps returning the same handle, mirroring how the real
// button is re-resolved by id after each re-render.
function makeElement(id) {
  const classes = new Set();
  return {
    id,
    style: {},
    dataset: {},
    _attrs: {},
    _children: [],
    disabled: false,
    title: '',
    innerHTML: '',
    textContent: '',
    value: '',
    scrollHeight: 0,
    scrollTop: 0,
    className: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {},
    insertBefore(c) { this._children.push(c); return c; },
    replaceChildren() { this._children = []; },
    append() {},
    prepend() {},
    remove() {},
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
    setSelectionRange() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
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
    body: makeElement('body'),
    documentElement: makeElement('html'),
    hidden: false,
    visibilityState: 'visible',
  };

  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };

  // No-op EventSource: openSession's busy path constructs one; we just
  // need it not to throw and to be closable.
  class FakeEventSource {
    constructor() { this.readyState = 1; }
    close() { this.readyState = 2; }
  }

  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    document,
    localStorage,
    navigator: { sendBeacon: () => true },
    EventSource: FakeEventSource,
    URL,
    Blob: class { constructor() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    // dev-chat.js mounts the chat shell title via escapeHtml (a global
    // defined in app.js at runtime); stub it for the template build.
    escapeHtml: (s) => String(s == null ? '' : s),
    // App gates whether the "thinking" title marker is allowed to stick;
    // pretend we're on the dev/sessions tab so setTitleStatus('thinking')
    // actually applies, matching the real phantom-state scenario.
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    // Native-kit adoption: renderChatView wires scroll/keyboard polish
    // through PlatformUI — no-op it for the streaming-state contract.
    PlatformUI: {
      isTouch: () => false,
      hasKit: () => false,
      toast: () => {},
      alert: async () => ({}),
      confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {},
      detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  // Expose the file-scoped `const DevChat` to the test.
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  // Neutralize heavy DOM-plumbing helpers that are irrelevant to the
  // streaming-state contract under test (they touch layout, scroll,
  // budget fetches, etc.). openSession / _setStreamingUI / renderChatView
  // and the streaming teardown helpers remain the REAL implementations.
  DevChat.renderMessages = () => {};
  DevChat.refreshBudget = () => {};
  DevChat.initScrollTracking = () => {};
  DevChat.restoreSessionScroll = () => {};
  DevChat._setupTextareaResize = () => {};
  DevChat._setupKeyboardShortcuts = () => {};
  DevChat._restoreDraft = () => {};
  DevChat.renderSessionList = () => {};
  DevChat._renderSyncBannerHtml = () => '';
  DevChat._renderNewChangeBannerHtml = () => '';
  DevChat._loadSpecViewer = () => {};
  DevChat._startHeartbeat = () => {};
  DevChat._setNotifyOnDone = () => {};

  return { DevChat, sandbox, document, getEl };
}

// Drive the send button into the "Stop" state to simulate a previously
// streaming session whose state has leaked into this tab.
function armStopButton(DevChat) {
  DevChat.isStreaming = true;
  DevChat._streamingPhase = null;
  DevChat._setStreamingUI(true, null);
}

function statusFetch(busy) {
  return async (url) => {
    if (/\/status$/.test(String(url))) {
      return { ok: true, json: async () => ({ busy, progress: [], phase: null }) };
    }
    // GET /api/sessions/:id — return a fully-formed active session.
    return {
      ok: true,
      json: async () => ({
        session: {
          id: 999,
          status: 'active',
          branch_name: 'dev/clone-999',
          session_title: 'Proposal clone',
          pr_number: null,
        },
        messages: [],
      }),
    };
  };
}

test('opening an existing CLI handoff hydrates its missing staging card from the session row', async () => {
  const { DevChat, sandbox } = makeHarness();
  sandbox.fetch = async (url) => {
    if (/\/status$/.test(String(url))) {
      return { ok: true, json: async () => ({ busy: false, progress: [], phase: null }) };
    }
    return {
      ok: true,
      json: async () => ({
        session: {
          id: 2969,
          status: 'promoted',
          source: 'cli_handoff',
          handoff_head_sha: 'a'.repeat(40),
          checks_commit_sha: 'a'.repeat(40),
          check_state: 'passing',
          staging_url: 'https://crypto-predictions--s2969.example.test',
          pr_number: 4,
        },
        // This is the historical failure mode: the CLI build updated the
        // session row but no staging-card system message was persisted.
        messages: [{ role: 'assistant', content: 'Local checks passed.' }],
      }),
    };
  };

  await DevChat.openSession(2969);

  const cards = DevChat.messages.filter((m) => m.stagingUrl || m.changesReady);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]._derivedFromSession, true);
  assert.equal(cards[0].stagingUrl, 'https://crypto-predictions--s2969.example.test');
});

test('opening a different idle session resets Stop → Send (busy:false)', async () => {
  const { DevChat, sandbox, document, getEl } = makeHarness();
  const btn = getEl('dc-send-btn');

  // A previously-streaming session is tracked, and the button shows Stop.
  DevChat.currentSession = { id: 111 };
  armStopButton(DevChat);
  assert.equal(btn.classList.contains('dc-btn-stop'), true, 'precondition: Stop is showing');
  assert.equal(DevChat.isStreaming, true, 'precondition: isStreaming true');
  assert.equal(DevChat._titleStatus, 'thinking', 'precondition: thinking marker set');
  assert.ok(document.title.startsWith('⏳'), 'precondition: title has thinking marker');

  sandbox.fetch = statusFetch(false);

  await DevChat.openSession(999);
  DevChat.renderChatView();

  assert.equal(DevChat.isStreaming, false, 'isStreaming reset to false on idle open');
  assert.equal(DevChat._streamingPhase, null, '_streamingPhase cleared');
  assert.equal(btn.classList.contains('dc-btn-stop'), false, 'Stop class removed');
  assert.equal(btn.classList.contains('dc-btn-streaming'), false, 'streaming class removed');
  assert.equal(btn.textContent, 'Send', 'button label back to Send');
  assert.equal(btn.getAttribute('aria-label'), 'Send', 'aria-label back to Send');
  assert.notEqual(DevChat._titleStatus, 'thinking', 'live thinking marker cleared');
  assert.ok(!document.title.includes('Thinking'), 'no Thinking marker left in title');
});

test('opening a genuinely busy session re-applies Stop/streaming UI (busy:true)', async () => {
  const { DevChat, sandbox, getEl } = makeHarness();
  const btn = getEl('dc-send-btn');

  // Start fully idle (Send), like a fresh tab.
  DevChat.currentSession = null;
  DevChat._setStreamingUI(false);
  assert.equal(btn.textContent, 'Send', 'precondition: Send showing');

  sandbox.fetch = statusFetch(true);

  await DevChat.openSession(999);
  DevChat.renderChatView();

  assert.equal(DevChat.isStreaming, true, 'busy session re-arms isStreaming');
  assert.equal(btn.classList.contains('dc-btn-stop'), true, 'Stop class re-applied');
  assert.equal(btn.getAttribute('aria-label'), 'Stop', 'aria-label is Stop');
  assert.equal(DevChat._titleStatus, 'thinking', 'thinking marker re-applied');
});

test('switching sessions aborts the previous session\'s in-flight POST SSE', async () => {
  // #329: the POST SSE chat reader for session A must be aborted when the
  // user navigates to session B, or A's tokens / cc_progress leak into B.
  const { DevChat, sandbox } = makeHarness();

  // Simulate a streaming session A with a live abort controller.
  let aborted = false;
  DevChat.currentSession = { id: 111 };
  DevChat.isStreaming = true;
  DevChat._abortController = { abort: () => { aborted = true; }, signal: {} };

  sandbox.fetch = statusFetch(false);

  await DevChat.openSession(999);

  assert.equal(aborted, true, 'previous session POST SSE was aborted');
  assert.equal(DevChat._abortController, null, '_abortController cleared after abort');
});

test('resumed-event guard drops a stale-session event', async () => {
  // #329: a late resumable-SSE event tagged with the session it was opened
  // for must not paint into a different, now-current session.
  const { DevChat } = makeHarness();

  DevChat.currentSession = { id: 999 };
  DevChat.messages = [];
  DevChat.scrollToBottom = () => {};
  let rendered = 0;
  DevChat.renderMessages = () => { rendered += 1; };

  // A cc_progress-shaped event that belongs to session 111 (the one we left)
  // arriving while 999 is current must be a no-op.
  DevChat._handleResumedEvent({ type: 'cc_progress', text: 'Reading foo.js', _seq: 5 }, 111);

  const leaked = DevChat.messages.some((m) => m._progress);
  assert.equal(leaked, false, 'no Claude Code progress message leaked from stale session');
  assert.equal(DevChat.messages.length, 0, 'no message appended for a stale-session event');

  // Sanity: the SAME event for the current session is NOT dropped by the guard.
  DevChat._handleResumedEvent({ type: 'cc_progress', text: 'Reading foo.js', _seq: 6 }, 999);
  assert.ok(DevChat.messages.some((m) => m._progress), 'current-session event still applies');
});

test('reopening the SAME busy session does not tear down its stream', async () => {
  // Guard the "gated on a session-id change" edge case: returning to the
  // already-tracked busy session must NOT drop+reopen its resumable
  // stream or flicker the Stop button off.
  const { DevChat, sandbox, getEl } = makeHarness();
  const btn = getEl('dc-send-btn');

  let closes = 0;
  DevChat.currentSession = { id: 999 };
  armStopButton(DevChat);
  DevChat._closeResumableStream = () => { closes += 1; };

  sandbox.fetch = statusFetch(true);

  await DevChat.openSession(999);
  DevChat.renderChatView();

  assert.equal(closes, 0, 'same-session reopen must not tear down the resumable stream');
  assert.equal(DevChat.isStreaming, true, 'still streaming');
  assert.equal(btn.classList.contains('dc-btn-stop'), true, 'Stop stays applied');
});
