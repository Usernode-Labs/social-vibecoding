// #2599: one source of truth for "a turn is live" in the dev chat.
//
// An OpenRouter run's state drifted from the UI in three ways the report
// lists: the run showed a ✓ while it was still running and a refresh said
// "running" again; a second spinning "OpenRouter is running…" row appeared
// beside an ENABLED Send button; and a run started with a ✓ that turned into
// a spinner by itself. All three come from the same root: three writers of
// `isStreaming` — the primary POST SSE, the shared channels (WS / resumable
// GET /events) and the 3s /status poll — with the poll and the shared `done`
// allowed to contradict a stream that was still delivering the turn, and a
// progress log that rendered with a hardcoded ✓ before its "… is running…"
// line existed.
//
// The contract pinned here:
//   1. the /status poll CONFIRMS but never contradicts a live stream;
//   2. a live event on an idle transcript re-arms the turn instead of
//      painting a spinner beside Send, and reuses the persisted progress row;
//   3. a `done` on a shared channel tears the turn down only once /status
//      agrees the session is idle;
//   4. the bootstrap progress log attaches to the live spin-up line and
//      spins, rather than rendering as an orphan "OpenRouter output ✓".
//
// Harness: the real dev-chat.js in a vm, as in
// tests/openSession-streaming-reset.test.js (composer state) and
// tests/dev-chat-cc-collapse.test.js (transcript html).
//
// Run with: node --test tests/dev-chat-live-turn-authority.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeComposerBridge } = require('./lib/dev-composer-html');
const { makeTranscriptBridge } = require('./lib/dev-transcript-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);
const SUMMARY_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'cc-progress-summary.js'),
  'utf8'
);

function makeElement(id) {
  const classes = new Set();
  return {
    id, style: {}, dataset: {}, _attrs: {}, _children: [],
    disabled: false, title: '', innerHTML: '', textContent: '', value: '',
    scrollHeight: 0, scrollTop: 0, className: '',
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (x) => classes.has(x),
      toggle: () => {},
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] ?? null; },
    removeAttribute(k) { delete this._attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this._children.push(c); return c; },
    removeChild() {}, insertBefore(c) { this._children.push(c); return c; },
    replaceChildren() { this._children = []; },
    append() {}, prepend() {}, remove() {}, focus() {}, blur() {}, click() {},
    scrollIntoView() {}, setSelectionRange() {},
    closest() { return null; }, querySelector() { return null; },
    querySelectorAll() { return []; }, contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }; },
  };
}

// The sandbox, with the composer bridge (send-button state) or the transcript
// bridge (rendered rows) published into, and a controllable interval clock so
// the /status poll's tick can be driven by hand.
function makeHarness({ transcript = false } = {}) {
  const composer = makeComposerBridge();
  const t = makeTranscriptBridge();
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
    addEventListener() {}, removeEventListener() {},
    body: makeElement('body'), documentElement: makeElement('html'),
    hidden: false, visibilityState: 'visible',
  };
  const storage = new Map();
  const intervals = [];
  class FakeEventSource {
    constructor(url) { this.url = url; this.readyState = 1; FakeEventSource.opened.push(url); }
    close() { this.readyState = 2; }
  }
  FakeEventSource.opened = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    document,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    navigator: { sendBeacon: () => true },
    EventSource: FakeEventSource,
    URL, Blob: class { constructor() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    PlatformUI: {
      isTouch: () => false, hasKit: () => false, toast: () => {},
      alert: async () => ({}), confirm: async () => true,
      transition: (fn) => fn(), attachScreenFx: () => {}, detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }), swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    addEventListener() {}, removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.UsernodeReact = { devChat: transcript ? t.bridge : composer.bridge };
  vm.createContext(sandbox);
  vm.runInContext(`${SUMMARY_SRC}\n${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.refreshBudget = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat._startHeartbeat = () => {};
  DevChat._setNotifyOnDone = () => {};
  DevChat.renderMarkdown = (s) => String(s || '');
  if (!transcript) DevChat.renderMessages = () => {};
  // renderChatView's DOM plumbing, neutralized as in
  // tests/openSession-streaming-reset.test.js.
  DevChat.initScrollTracking = () => {};
  DevChat.restoreSessionScroll = () => {};
  DevChat._setupTextareaResize = () => {};
  DevChat._setupKeyboardShortcuts = () => {};
  DevChat._restoreDraft = () => {};
  DevChat.renderSessionList = () => {};
  DevChat._renderBanners = () => {};
  DevChat._loadSpecViewer = () => {};
  // `_setStreamingUI(true)` also arms the 3s spend poll, so the LAST interval
  // registered after _startProgressPolling is the progress poll's tick.
  const pollTick = () => intervals[intervals.length - 1];
  return {
    DevChat, sandbox, intervals, pollTick,
    eventSources: FakeEventSource.opened,
    send: () => composer.state().send,
    html: () => t.html(),
    rows: () => t.state().rows,
  };
}

const statusAnswer = (busy, extra = {}) => async (url) => {
  if (/\/status$/.test(String(url))) {
    return { ok: true, json: async () => ({ busy, progress: [], phase: busy ? 'cc' : null, ...extra }) };
  }
  return {
    ok: true,
    json: async () => ({
      session: { id: 7, status: 'active', branch_name: 'dev/x', agent_backend: 'codex_openrouter' },
      messages: [],
    }),
  };
};

// A tab mid-turn: streaming, Stop showing, the poll armed.
function armLiveTurn(DevChat) {
  DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'codex_openrouter' };
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'cc');
}

// ── 1. the poll confirms, never contradicts ─────────────────────────────

test('a not-busy /status answer does NOT end the turn while the primary stream is live', async () => {
  const { DevChat, sandbox, intervals, pollTick, send } = makeHarness();
  armLiveTurn(DevChat);
  sandbox.fetch = statusAnswer(false);
  // The POST reader loop is running and the server wrote to it just now —
  // a heartbeat is enough.
  DevChat._primaryStreamOpen = true;
  DevChat._lastLiveEventAt = Date.now();

  const before = intervals.length;
  DevChat._startProgressPolling(7, []);
  assert.equal(intervals.length, before + 1, 'the poll was armed');
  await pollTick()();

  assert.equal(DevChat.isStreaming, true, 'the snapshot lost to the live stream');
  assert.equal(send().kind, 'stop', 'Stop stays up');
});

test('a not-busy /status answer issued BEFORE the latest live event is stale, streams or not', async () => {
  const { DevChat, sandbox, pollTick, send } = makeHarness();
  armLiveTurn(DevChat);
  DevChat._primaryStreamOpen = false;
  // The answer resolves after a live event landed — the event is newer than
  // the question, so the answer describes a moment that has passed.
  sandbox.fetch = async (url) => {
    DevChat._lastLiveEventAt = Date.now() + 5;
    return statusAnswer(false)(url);
  };
  DevChat._startProgressPolling(7, []);
  await pollTick()();

  assert.equal(DevChat.isStreaming, true, 'a snapshot older than the last event cannot end the turn');
  assert.equal(send().kind, 'stop');
});

test('a not-busy /status answer with the streams dead and quiet ends the turn (restart recovery)', async () => {
  const { DevChat, sandbox, pollTick, send } = makeHarness();
  armLiveTurn(DevChat);
  DevChat._primaryStreamOpen = false;
  DevChat._lastLiveEventAt = Date.now() - 10 * 60 * 1000;
  sandbox.fetch = statusAnswer(false);

  DevChat._startProgressPolling(7, []);
  await pollTick()();

  assert.equal(DevChat.isStreaming, false, 'nothing live contradicts the server: the turn is over');
  assert.deepEqual(send(), { kind: 'send' });
});

test('a primary stream silent past the quiet window no longer outranks the server', async () => {
  const { DevChat, sandbox, pollTick } = makeHarness();
  armLiveTurn(DevChat);
  DevChat._primaryStreamOpen = true;
  DevChat._lastLiveEventAt = Date.now() - DevChat.STREAM_QUIET_MS - 1000;
  sandbox.fetch = statusAnswer(false);

  DevChat._startProgressPolling(7, []);
  await pollTick()();

  assert.equal(DevChat.isStreaming, false, 'a dead-quiet stream is not evidence');
});

// ── 2. live evidence re-arms an idle transcript ─────────────────────────

test('a running-agent status on an idle transcript adopts the turn (Stop, live stream, poll)', () => {
  const { DevChat, intervals, eventSources, send } = makeHarness();
  DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'codex_openrouter' };
  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  DevChat.messages = [
    { id: 1, role: 'user', content: 'do it' },
    { id: 2, role: 'system', content: 'Starting OpenRouter (GLM 4.6)...', agentBackend: 'codex_openrouter' },
  ];
  assert.deepEqual(send(), { kind: 'send' }, 'precondition: idle');

  const adopted = DevChat._noteLiveTurnEvent(
    { type: 'status', text: 'OpenRouter is running...', agentBackend: 'codex_openrouter', _seq: 'a-3' }, 7,
  );

  assert.equal(adopted, true);
  assert.equal(DevChat.isStreaming, true, 'the event is proof the runner is live');
  assert.equal(send().kind, 'stop', 'Stop replaces Send — no spinner beside an enabled Send');
  assert.equal(eventSources.length, 1, 'the resumable stream is opened');
  assert.ok(DevChat._progressPollTimer, 'and the /status poll is armed to confirm');
  assert.ok(intervals.length >= 1);
});

test('a progress line on an idle transcript extends the persisted log — no second agent row', () => {
  const { DevChat } = makeHarness();
  DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'codex_openrouter' };
  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  // What a reload paints: the persisted running line and its log, neither
  // flagged live because a stale /status answer said idle.
  DevChat.messages = [
    { id: 1, role: 'user', content: 'do it' },
    { id: 2, role: 'system', content: 'OpenRouter is running...', agentBackend: 'codex_openrouter' },
    { id: 3, role: 'system', content: 'Claude Code progress', progressLog: ['[agent]', 'Reading a.js'], agentBackend: 'codex_openrouter' },
  ];

  DevChat._noteLiveTurnEvent({ type: 'cc_progress', text: 'Editing a.js', agentBackend: 'codex_openrouter' }, 7);
  DevChat._appendProgressLine('Editing a.js', { agentBackend: 'codex_openrouter' });

  const logs = DevChat.messages.filter((m) => m.progressLog);
  assert.equal(logs.length, 1, 'the live line went into the persisted log, not a fresh row');
  assert.deepEqual(logs[0].progressLog, ['[agent]', 'Reading a.js', 'Editing a.js']);
  assert.equal(DevChat.isStreaming, true);
});

test('a terminal status is not live evidence and does not adopt', () => {
  const { DevChat, send } = makeHarness();
  DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'codex_openrouter' };
  DevChat.isStreaming = false;
  DevChat._setStreamingUI(false);
  DevChat.messages = [];

  for (const data of [
    { type: 'status', text: 'OpenRouter finished', ccOutput: 'Done.' },
    { type: 'status', text: 'This turn failed: boom.', turnError: true },
    { type: 'status', text: 'OpenRouter stopped by @evan.', stopLanding: { headline: 'x' } },
    { type: 'status', text: 'OpenRouter is already running for this session. Please wait for it to finish.' },
    { type: 'mayor_reasoning', text: 'Here is the reply.' },
    { type: 'done' },
  ]) {
    assert.equal(DevChat._noteLiveTurnEvent(data, 7), false, `${data.type}: ${data.text || ''}`);
  }
  assert.equal(DevChat.isStreaming, false);
  assert.deepEqual(send(), { kind: 'send' });
});

test('board-level socket chatter is not live-turn evidence', () => {
  // `checks_ready` ticks once a second for a whole check run; if it counted,
  // a not-busy server could never be believed and the turn would never end.
  const { DevChat } = makeHarness();
  DevChat.currentSession = { id: 7 };
  DevChat.isStreaming = true;
  DevChat._lastLiveEventAt = 1;
  for (const type of ['checks_ready', 'visuals_ready', 'session_titled', 'pr_updated', 'headless_update']) {
    DevChat._noteLiveTurnEvent({ type, sessionId: 7 }, 7);
  }
  assert.equal(DevChat._lastLiveEventAt, 1, 'none of them moved the stamp');
  DevChat._noteLiveTurnEvent({ type: 'cc_progress', text: 'x' }, 7);
  assert.ok(DevChat._lastLiveEventAt > 1, 'a turn-stream event does');
});

test('a live event for a different session is ignored', () => {
  const { DevChat } = makeHarness();
  DevChat.currentSession = { id: 7 };
  DevChat.isStreaming = false;
  DevChat.messages = [];
  assert.equal(DevChat._noteLiveTurnEvent({ type: 'cc_progress', text: 'x' }, 8), false);
  assert.equal(DevChat.isStreaming, false);
});

// ── 3. a shared-channel `done` asks /status first ───────────────────────

test("a shared-channel 'done' while /status says busy keeps the turn live", async () => {
  const { DevChat, sandbox, send } = makeHarness();
  armLiveTurn(DevChat);
  DevChat.messages = [
    { id: 2, role: 'system', content: 'OpenRouter is running...', _active: true },
    // The refusal a second send on the busy session painted through the WS.
    { id: 3, role: 'system', content: 'OpenRouter is already running for this session. Please wait for it to finish.', _active: true },
  ];
  sandbox.fetch = statusAnswer(true);

  const idle = await DevChat._endTurnFromSharedChannel(7);

  assert.equal(idle, false, 'the done belonged to another request');
  assert.equal(DevChat.isStreaming, true, 'the turn this tab follows is still running');
  assert.equal(send().kind, 'stop');
  assert.equal(DevChat.messages[1]._active, false, "that request's own row stops spinning");
  assert.equal(DevChat.messages[0]._active, true, 'the live run keeps its arc');
});

test("a shared-channel 'done' with /status idle tears the turn down", async () => {
  const { DevChat, sandbox, send } = makeHarness();
  armLiveTurn(DevChat);
  DevChat.messages = [{ id: 2, role: 'system', content: 'OpenRouter is running...', _active: true }];
  sandbox.fetch = statusAnswer(false);

  const idle = await DevChat._endTurnFromSharedChannel(7);

  assert.equal(idle, true);
  assert.equal(DevChat.isStreaming, false);
  assert.deepEqual(send(), { kind: 'send' });
  assert.equal(DevChat.messages[0]._active, false, 'the run line is frozen with the turn');
});

test("a shared-channel 'done' on an idle transcript freezes the painted row and reports idle", async () => {
  const { DevChat, sandbox } = makeHarness();
  DevChat.currentSession = { id: 7 };
  DevChat.isStreaming = false;
  DevChat.messages = [{ id: 3, role: 'system', content: 'OpenRouter is already running for this session. Please wait for it to finish.', _active: true }];
  let statusReads = 0;
  sandbox.fetch = async (url) => { if (/\/status$/.test(String(url))) statusReads += 1; return statusAnswer(false)(url); };

  const idle = await DevChat._endTurnFromSharedChannel(7);

  assert.equal(idle, true, 'nothing live: the caller reloads the timeline as before');
  assert.equal(statusReads, 0, 'no round trip when there is nothing to tear down');
  assert.equal(DevChat.messages[0]._active, false);
});

// ── the resumable and WS arms route through the helper ──────────────────

test("the resumable 'done' and 'stopped' arms end the turn through the shared-channel helper", () => {
  const body = SRC.slice(
    SRC.indexOf('  _handleResumedEvent(data, sessionId) {'),
    SRC.indexOf('\n  _handleSpecUpdated(data) {'),
  );
  const arm = (type) => {
    const i = body.indexOf(`case '${type}':`);
    assert.ok(i > 0, `case '${type}' exists`);
    const rest = body.slice(i + 6);
    const next = rest.search(/\n\s*case '/);
    return (next === -1 ? rest : rest.slice(0, next)).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  };
  for (const type of ['done', 'stopped']) {
    assert.match(arm(type), /_endTurnFromSharedChannel\(sessionId\)/, `${type} confirms with /status`);
    assert.doesNotMatch(arm(type), /DevChat\._finishStreaming\(\)/, `${type} no longer tears down unconditionally`);
  }
  assert.match(body, /_noteLiveTurnEvent\(data, sessionId\)/, 'every resumable event is live evidence');
  const post = SRC.slice(
    SRC.indexOf('  async sendMessage(message, attachments = []) {'),
    SRC.indexOf('  _handleResumedEvent(data, sessionId) {'),
  );
  assert.match(post, /_noteLiveTurnEvent\(data, sessionId\)/, 'and so is every primary-stream event');
  assert.match(post, /DevChat\._primaryStreamOpen = true/, 'the reader loop marks the primary stream open');
  assert.match(post, /DevChat\._primaryStreamOpen = false/, 'and closed when it exits');
});

test('renderChatView repaints the turn with the phase and stoppability it already has', () => {
  const { DevChat, send } = makeHarness();
  DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'codex_openrouter', branch_name: 'dev/x' };
  DevChat.messages = [];
  DevChat.isStreaming = true;
  DevChat._setStreamingUI(true, 'cc', { stoppable: false });
  assert.equal(send().kind, 'busy', 'precondition: an unstoppable adopted turn paints the spinner');

  DevChat.renderChatView();

  assert.equal(send().kind, 'busy', 'a mid-turn re-render (session_titled) must not hand back a live Stop');
  assert.equal(DevChat._streamingStoppable, false);
});

// ── 4. the bootstrap log attaches to the live spin-up line ──────────────

test('a live spin-up line takes the bootstrap log and spins — no orphan ✓ row', () => {
  const { DevChat, html, rows } = makeHarness({ transcript: true });
  DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'codex_openrouter' };
  DevChat.isStreaming = true;
  DevChat.messages = [
    { id: 1, role: 'user', content: 'do it' },
    { id: 2, role: 'system', content: 'Starting OpenRouter (GLM 4.6)...', agentBackend: 'codex_openrouter', _active: true },
    // The worker's clone/checkout lines land before "OpenRouter is running…" exists.
    { role: 'system', content: 'Claude Code progress', progressLog: ['Cloning repository', 'Checking out dev/x'], _progress: true, _slug: 'live1', agentBackend: 'codex_openrouter' },
  ];
  DevChat.renderMessages();

  const out = html();
  assert.doesNotMatch(out, /ccrunorphan/, 'the log is not an orphan row');
  assert.doesNotMatch(out, /OpenRouter output/, 'no synthetic "OpenRouter output" line');
  const attached = rows().filter((r) => r.t === 'attached');
  assert.equal(attached.length, 1, 'one attached row: the spin-up line with the log under it');
  assert.equal(attached[0].icon, 'spinner', 'and it spins from the first line');
  assert.match(attached[0].text, /^Starting OpenRouter/);
  assert.equal(rows().filter((r) => r.icon === 'check').length, 0, 'nothing on the transcript claims the run is done');
});

test('once "OpenRouter is running…" arrives the log moves under it and the spin-up line freezes', () => {
  const { DevChat, rows } = makeHarness({ transcript: true });
  DevChat.currentSession = { id: 7, status: 'active', agent_backend: 'codex_openrouter' };
  DevChat.isStreaming = true;
  DevChat.messages = [
    { id: 1, role: 'user', content: 'do it' },
    { id: 2, role: 'system', content: 'Starting OpenRouter (GLM 4.6)...', agentBackend: 'codex_openrouter', _active: false },
    { role: 'system', content: 'Claude Code progress', progressLog: ['Cloning repository'], _progress: true, _slug: 'live1' },
    { role: 'system', content: 'OpenRouter is running...', agentBackend: 'codex_openrouter', _active: true, _slug: 'live2' },
  ];
  DevChat.renderMessages();

  const attached = rows().filter((r) => r.t === 'attached');
  assert.equal(attached.length, 1);
  // The stored content is still "OpenRouter is running..." (the pairing
  // rules key off it); the heading is rewritten at render time to the
  // venue-neutral sentence (#2597, DevChat._runningRowLabel).
  assert.match(attached[0].text, /^Coding agent is running/, 'the running line owns the log (forward pairing wins)');
  assert.equal(attached[0].icon, 'spinner');
  const spinUp = rows().find((r) => r.t === 'status' && /^Starting OpenRouter/.test(r.text));
  assert.ok(spinUp, 'the spin-up line is a plain status row again');
  assert.equal(spinUp.icon, 'check');
});

test('a historical run that died at bootstrap keeps its orphan row (the fallback is live-only)', () => {
  const { DevChat, html } = makeHarness({ transcript: true });
  DevChat.currentSession = { id: 7, status: 'active' };
  DevChat.isStreaming = false;
  DevChat.messages = [
    { id: 1, role: 'user', content: 'do it' },
    { id: 2, role: 'system', content: 'Spinning up coding agent (Sonnet)...' },
    { id: 3, role: 'system', content: 'Claude Code progress', progressLog: ['Cloning repository'] },
  ];
  DevChat.renderMessages();
  assert.match(html(), /ccrunorphan/, 'a finished spin-up line is not a home for the log');
});
