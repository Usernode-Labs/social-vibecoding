'use strict';

// #394 / #437: the Mayor's post-spec wrap-up summary (a `mayor_reasoning`
// event) must reach the live dev-chat over the GLOBAL WebSocket, not only the
// POST SSE / session bus. A long scout run often kills the POST SSE before
// phase-2, and the global-WS `done` used to tear down streaming before the
// resumable stream could replay the summary — so it landed in the DB but only
// showed after a manual refresh.
//
// #437 root cause: the server's send() broadcast spread the inner event LAST
// (`{ type: 'session_event', …, ...event }`), so `...event` re-added the inner
// `type` (e.g. 'mayor_reasoning') and clobbered the `session_event` envelope —
// the client's `connectEvents` `switch (data.type)` then never routed to
// handleSessionEvent at all, and the entire global-WS backup channel was dead.
//
// These tests load the REAL App from public/js/app.js in a VM and drive events
// through the REAL `connectEvents` WebSocket `onmessage` dispatch
// (`switch (data.type)`), using a payload BUILT FROM the real server-side
// broadcastGlobal({…}) literal in src/routes/sessions.js. If a refactor lets
// the envelope `type` get clobbered again, the payload's `type` stops being
// 'session_event', the dispatch no longer reaches handleSessionEvent, and the
// routing assertions below fail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);
const SESSIONS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'routes', 'sessions.js'),
  'utf8'
);

// Build the global-WS payload EXACTLY the way the server's send() helper does,
// by evaluating the real broadcastGlobal({ ... }) object literal from the route
// source against the same locals it has in scope (`event`, `type`, `session`).
// The first match is the interactive dev-chat send() (the one #437 fixes).
function buildBroadcastPayload(type, data, seq, sessionId) {
  const m = SESSIONS_SRC.match(/broadcastGlobal\(\s*(\{[\s\S]*?\})\s*\)/);
  assert.ok(m, 'found the broadcastGlobal({ ... }) call literal in sessions.js');
  const event = { type, _seq: seq, ...data }; // eslint-disable-line no-unused-vars
  const session = { id: sessionId }; // eslint-disable-line no-unused-vars
  // eslint-disable-next-line no-eval
  return eval(`(${m[1]})`);
}

// A controllable stand-in for the real DevChat global. handleSessionEvent
// treats DevChat as an external object, so a plain mock fully exercises the
// branch logic under test (bubble sealing, dedup, push-vs-reconcile).
function makeDevChat() {
  return {
    currentSession: { id: 999 },
    isStreaming: true,
    messages: [],
    _seenSeqs: new Set(),
    _lastSeenSeq: null,
    renderCalls: 0,
    finishCalls: 0,
    flushCalls: 0,
    deactivateCalls: 0,
    removeSpinnerCalls: 0,
    setStreamingUICalls: [],
    applyEstimateCalls: [],
    _deactivateLastStatus() { this.deactivateCalls++; },
    renderMessages() { this.renderCalls++; },
    scrollToBottom() {},
    _flushStreamingFinal() { this.flushCalls++; },
    _renderStreamingMarkdown() {},
    _finishStreaming() { this.finishCalls++; this.isStreaming = false; },
    _removeSpinner() { this.removeSpinnerCalls++; },
    _setStreamingUI(streaming, phase) { this.setStreamingUICalls.push([streaming, phase]); },
    _applyEstimate(text, remainingSeconds) { this.applyEstimateCalls.push([text, remainingSeconds]); },
    _appendProgressLine() {},
    _startProgressPolling() {},
    renderChatView() {},
    _handleSpecUpdated() {},
  };
}

function makeApp() {
  let seq = 0;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Math: { random: () => { seq += 1; return seq / 1000; } },
    Date,
    // app.js's object literal evaluates `_bootToken: new
    // URLSearchParams(location.search)...` at load time, so both must exist.
    URLSearchParams,
    location: { search: '', protocol: 'http:', host: 'localhost' },
    document: {
      addEventListener() {},
      querySelectorAll() { return []; },
    },
  };
  // Fake WebSocket so App.connectEvents() can wire up its onmessage handler;
  // we never actually open a socket — we synthesize message events by hand.
  sandbox.WebSocket = function FakeWebSocket(url) { this.url = url; this.readyState = 1; };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const DevChat = makeDevChat();
  sandbox.DevChat = DevChat; // resolved as a free var at call time
  const App = sandbox.window.App;

  // Stand up the real global-WS connection plumbing, then capture the socket.
  App.connectEvents();
  const ws = App.eventsWs;

  // Fire an event through the REAL connectEvents onmessage dispatch
  // (`switch (data.type)`), built from the real server broadcast literal.
  // Returns the _seq used so dedup tests can pre-seed it.
  function fireWs(event, extra = {}, seqOverride) {
    const seqVal = seqOverride || `s-${event}-${Math.random()}`;
    const payload = buildBroadcastPayload(event, extra, seqVal, 999);
    ws.onmessage({ data: JSON.stringify(payload) });
    return seqVal;
  }

  return { App, DevChat, ws, fireWs };
}

test('the source broadcast literal yields a session_event envelope (routing precondition)', () => {
  const payload = buildBroadcastPayload('mayor_reasoning', { text: 'hi' }, 'x-1', 999);
  assert.equal(payload.type, 'session_event',
    "envelope MUST be type 'session_event' — connectEvents routes on data.type");
  assert.equal(payload.event, 'mayor_reasoning', 'real event name carried in `event`');
  assert.equal(payload._seq, 'x-1', '_seq preserved');
  assert.equal(payload.text, 'hi', 'data fields preserved');
});

test('phase-2 mayor_reasoning over the WS appends a NEW bubble after a status seal', () => {
  const { DevChat, fireWs } = makeApp();

  // Phase-1 preamble bubble arrived (WS-only path: POST SSE already dropped),
  // not yet sealed.
  DevChat.messages.push({ role: 'user', content: 'add a thing' });
  DevChat.messages.push({ role: 'assistant', content: 'Let me scout the repo first.' });

  // Scout's final status lands over the WS — it must seal the preamble bubble
  // and carry the spec-preview card fields.
  fireWs('status', {
    text: 'Scout drafted a 42-line spec from the codebase.',
    specPreview: '## User-facing changes\n…',
    specLines: 42,
    specVersion: 3,
    durationMs: 12345,
    scoutOutput: 'full spec text',
  });

  const preamble = DevChat.messages.find((m) => m.role === 'assistant');
  assert.equal(preamble._finalized, true, 'phase-1 preamble bubble is sealed on status');

  const statusMsg = DevChat.messages.find((m) => m.role === 'system');
  assert.equal(statusMsg.specPreview, '## User-facing changes\n…', 'specPreview carried onto the status row');
  assert.equal(statusMsg.specLines, 42, 'specLines carried');
  assert.equal(statusMsg.specVersion, 3, 'specVersion carried');
  assert.equal(statusMsg.durationMs, 12345, 'durationMs carried');
  assert.equal(statusMsg.scoutOutput, 'full spec text', 'scoutOutput carried');

  // Phase-2 wrap-up summary arrives over the WS.
  const summary = "_Spec updated — it's in the spec viewer. Tell me to build it whenever you're ready._";
  fireWs('mayor_reasoning', { text: summary });

  const assistants = DevChat.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 2, 'summary opened a fresh bubble, did not overwrite the preamble');
  assert.equal(assistants[0].content, 'Let me scout the repo first.', 'preamble text preserved');
  assert.equal(assistants[1].content, summary, 'summary text rendered in the new bubble');

  // done finalizes streaming.
  fireWs('done', {});
  assert.equal(DevChat.isStreaming, false, 'done tears down streaming');
  assert.equal(DevChat.finishCalls, 1, '_finishStreaming called once');
});

test('mayor_reasoning reconciles an UNSEALED live bubble in place', () => {
  const { DevChat, fireWs } = makeApp();
  DevChat.messages.push({ role: 'user', content: 'hi' });
  DevChat.messages.push({ role: 'assistant', content: 'partial strea' });

  fireWs('mayor_reasoning', { text: 'partial stream complete.' });

  const assistants = DevChat.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, 'no extra bubble — reconciled the existing live one');
  assert.equal(assistants[0].content, 'partial stream complete.', 'content reconciled to authoritative text');
});

test('a mayor_reasoning _seq already seen on the POST SSE is deduped (no double render)', () => {
  const { DevChat, fireWs } = makeApp();
  DevChat.messages.push({ role: 'user', content: 'hi' });

  // Pretend the POST SSE already delivered and recorded this seq.
  const seq = 'dup-seq-1';
  DevChat._seenSeqs.add(seq);

  fireWs('mayor_reasoning', { text: 'the summary' }, seq);

  assert.equal(DevChat.messages.filter((m) => m.role === 'assistant').length, 0,
    'duplicate seq did not push a second copy of the summary');
});

test('assistant_message_end over the WS seals the current bubble', () => {
  const { DevChat, fireWs } = makeApp();
  DevChat.messages.push({ role: 'assistant', content: 'preamble' });

  fireWs('assistant_message_end', {});

  assert.equal(DevChat.messages[0]._finalized, true, 'bubble sealed by assistant_message_end');
  assert.equal(DevChat.flushCalls, 1, 'flushed the throttled streaming render before sealing');

  // A following mayor_reasoning now opens a fresh bubble.
  fireWs('mayor_reasoning', { text: 'wrap up' });
  assert.equal(DevChat.messages.filter((m) => m.role === 'assistant').length, 2,
    'sealed bubble forces the next mayor_reasoning into a new bubble');
});

test('events for a different session are ignored', () => {
  const { DevChat, fireWs } = makeApp();
  DevChat.currentSession = { id: 111 };
  fireWs('mayor_reasoning', { text: 'not mine' });
  assert.equal(DevChat.messages.length, 0, 'cross-session event dropped');
});

// #437 secondary: phase/stopped/cc_estimate/cc_log are broadcast on the WS but
// previously had no case in handleSessionEvent. Because the handler records
// `data._seq` into _seenSeqs BEFORE the switch, an unhandled type arriving
// first on the now-live WS would mark the seq seen and get the POST-SSE /
// resumable copy deduped-and-swallowed. These must now be handled.
test('phase over the WS toggles the streaming UI (handled, not swallowed)', () => {
  const { DevChat, fireWs } = makeApp();
  fireWs('phase', { phase: 'mayor2' });
  assert.deepEqual(DevChat.setStreamingUICalls.at(-1), [true, 'mayor2'],
    '_setStreamingUI(true, "mayor2") invoked for the phase event');
});

test('stopped over the WS tears down the streaming UI (handled, not swallowed)', () => {
  const { DevChat, fireWs } = makeApp();
  fireWs('stopped', { phase: 'cc', by: '@evan' });
  assert.equal(DevChat.finishCalls, 1, '_finishStreaming called for stopped');
  assert.equal(DevChat.isStreaming, false, 'streaming torn down');
  assert.ok(DevChat.removeSpinnerCalls >= 1, 'spinner removed');
});

test('cc_estimate over the WS applies the estimate (handled, not swallowed)', () => {
  const { DevChat, fireWs } = makeApp();
  fireWs('cc_estimate', { text: '~2 min remaining', remainingSeconds: 120 });
  assert.deepEqual(DevChat.applyEstimateCalls.at(-1), ['~2 min remaining', 120],
    '_applyEstimate invoked with text + remainingSeconds');
});

test('cc_log over the WS pushes a log row (handled, not swallowed)', () => {
  const { DevChat, fireWs } = makeApp();
  fireWs('cc_log', { log: 'claude code raw log output' });
  const logMsg = DevChat.messages.find((m) => m.ccLog);
  assert.ok(logMsg, 'a system message carrying ccLog was pushed');
  assert.equal(logMsg.ccLog, 'claude code raw log output', 'log content carried');
});
