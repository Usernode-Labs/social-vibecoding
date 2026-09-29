// #2599: the global WebSocket channel (App.handleSessionEvent in
// public/js/app.js) hands its evidence to the dev chat's one source of truth
// for "a turn is live" instead of deciding on its own.
//
//   - a running-agent status, a progress line, a phase or a stop request
//     goes through DevChat._noteLiveTurnEvent BEFORE the row is painted, so
//     an idle transcript re-arms the turn rather than showing a spinning
//     "OpenRouter is running…" row beside an enabled Send button;
//   - `done` and `stopped` go through DevChat._endTurnFromSharedChannel,
//     which asks /status first — the WS carries every request's events for
//     the session, and a second send refused with "already running" ends in
//     a `done` of its own — and the #446 reload only follows an idle answer.
//
// Harness: the REAL App from public/js/app.js in a vm, events fired through
// the real connectEvents `onmessage` dispatch, as in
// tests/mayor-reasoning-ws.test.js.
//
// Run with: node --test tests/session-event-live-turn.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');

function makeDevChat({ endResolves = true } = {}) {
  const calls = { note: [], end: [], finish: 0, reconcile: [], deactivate: 0 };
  return {
    calls,
    currentSession: { id: 999 },
    isStreaming: true,
    messages: [],
    _seenSeqs: new Set(),
    _lastSeenSeq: null,
    _noteLiveTurnEvent(data, sessionId) { calls.note.push([data.type, data.text || null, sessionId]); return false; },
    _endTurnFromSharedChannel(sessionId) { calls.end.push(sessionId); return Promise.resolve(endResolves); },
    _reconcileAfterFallbackDone(sessionId) { calls.reconcile.push(sessionId); },
    _deactivateLastStatus() { calls.deactivate++; },
    _finishStreaming() { calls.finish++; this.isStreaming = false; },
    _removeSpinner() {},
    renderMessages() {},
    scrollToBottom() {},
    _flushStreamingFinal() {},
    _showActivity() {},
    _hideActivity() {},
    _appendProgressLine() {},
    _startProgressPolling() {},
    _setStreamingUI() {},
    _enterStoppingState() {},
    _progressPollTimer: 1,
  };
}

function makeApp(opts) {
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math,
    Date,
    URLSearchParams,
    location: { search: '', protocol: 'http:', host: 'localhost' },
    document: { addEventListener() {}, querySelectorAll() { return []; } },
  };
  sandbox.WebSocket = function FakeWebSocket(url) { this.url = url; this.readyState = 1; };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const DevChat = makeDevChat(opts);
  sandbox.DevChat = DevChat;
  const App = sandbox.window.App;
  App.connectEvents();
  const ws = App.eventsWs;
  let n = 0;
  const fire = (event, extra = {}) => {
    n += 1;
    ws.onmessage({ data: JSON.stringify({ type: 'session_event', event, sessionId: 999, _seq: `t-${n}`, ...extra }) });
  };
  return { App, DevChat, fire };
}

const tick = () => new Promise((r) => setImmediate(r));

test('live events reach _noteLiveTurnEvent with the real event name, before the switch paints', () => {
  const { DevChat, fire } = makeApp();
  fire('status', { text: 'OpenRouter is running...', agentBackend: 'codex_openrouter' });
  fire('cc_progress', { text: 'Reading a.js' });
  fire('phase', { phase: 'cc' });
  fire('stopping', { by: 'evan' });
  assert.deepEqual(DevChat.calls.note, [
    ['status', 'OpenRouter is running...', 999],
    ['cc_progress', 'Reading a.js', 999],
    ['phase', null, 999],
    ['stopping', null, 999],
  ], 'the envelope\'s `event` is passed as the event `type` the helper reads');
});

test("'done' confirms through the shared-channel helper and reloads only on an idle answer", async () => {
  const { DevChat, fire } = makeApp({ endResolves: true });
  fire('done');
  assert.deepEqual(DevChat.calls.end, [999], 'the helper owns the teardown');
  assert.equal(DevChat.calls.finish, 0, 'no unconditional _finishStreaming');
  await tick();
  assert.deepEqual(DevChat.calls.reconcile, [999], 'idle → the #446 reload still happens');
});

test("'done' for a session /status still reports busy leaves the turn alone", async () => {
  const { DevChat, fire } = makeApp({ endResolves: false });
  fire('done');
  await tick();
  assert.equal(DevChat.calls.finish, 0);
  assert.deepEqual(DevChat.calls.reconcile, [], 'no reload of a timeline that is still being written');
  assert.equal(DevChat.isStreaming, true);
});

test("'stopped' goes through the same helper", async () => {
  const { DevChat, fire } = makeApp({ endResolves: true });
  fire('stopped', { by: 'evan' });
  assert.deepEqual(DevChat.calls.end, [999]);
  assert.equal(DevChat.calls.finish, 0);
});

test('events for another session never reach the helpers', () => {
  const { DevChat, App } = makeApp();
  App.eventsWs.onmessage({ data: JSON.stringify({ type: 'session_event', event: 'cc_progress', sessionId: 5, _seq: 'x-1', text: 'y' }) });
  App.eventsWs.onmessage({ data: JSON.stringify({ type: 'session_event', event: 'done', sessionId: 5, _seq: 'x-2' }) });
  assert.deepEqual(DevChat.calls.note, []);
  assert.deepEqual(DevChat.calls.end, []);
});

test('the WS arms keep their typeof guards (app.js can run before dev-chat.js)', () => {
  const body = SRC.slice(SRC.indexOf('  handleSessionEvent(data) {'), SRC.indexOf('\n  handleAppUpdate(data) {'));
  for (const name of ['_noteLiveTurnEvent', '_endTurnFromSharedChannel']) {
    const calls = (body.match(new RegExp(`DevChat\\.${name}\\(`, 'g')) || []).length;
    const guards = (body.match(new RegExp(`typeof DevChat\\.${name} === 'function'`, 'g')) || []).length;
    assert.ok(calls > 0, `${name} is wired`);
    assert.equal(guards, calls, `${name}: every call is guarded`);
  }
});
