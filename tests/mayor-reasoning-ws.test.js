'use strict';

// #394: the Mayor's post-spec wrap-up summary (a `mayor_reasoning` event)
// must reach the live dev-chat over the GLOBAL WebSocket, not only the POST
// SSE / session bus. A long scout run often kills the POST SSE before
// phase-2, and the global-WS `done` used to tear down streaming before the
// resumable stream could replay the summary — so it landed in the DB but
// only showed after a manual refresh.
//
// These tests load the REAL App.handleSessionEvent from public/js/app.js in a
// VM (its only top-level side effects are `window.App = App` and a deferred
// DOMContentLoaded listener) and drive global-WS events against a controllable
// DevChat mock.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'app.js'),
  'utf8'
);

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
    _deactivateLastStatus() { this.deactivateCalls++; },
    renderMessages() { this.renderCalls++; },
    scrollToBottom() {},
    _flushStreamingFinal() { this.flushCalls++; },
    _renderStreamingMarkdown() {},
    _finishStreaming() { this.finishCalls++; this.isStreaming = false; },
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
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const DevChat = makeDevChat();
  sandbox.DevChat = DevChat; // resolved as a free var at call time
  return { App: sandbox.window.App, DevChat, sandbox };
}

// Convenience: a global-WS session_event payload as App.connectEvents would
// dispatch it (after JSON.parse, the `type` is consumed and `event` carries
// the inner event name).
function ev(event, extra) {
  return { type: 'session_event', sessionId: 999, event, _seq: `s-${event}-${Math.random()}`, ...extra };
}

test('phase-2 mayor_reasoning over the WS appends a NEW bubble after a status seal', () => {
  const { App, DevChat } = makeApp();

  // Phase-1 preamble bubble arrived (WS-only path: POST SSE already dropped),
  // not yet sealed.
  DevChat.messages.push({ role: 'user', content: 'add a thing' });
  DevChat.messages.push({ role: 'assistant', content: 'Let me scout the repo first.' });

  // Scout's final status lands over the WS — it must seal the preamble bubble
  // and carry the spec-preview card fields.
  App.handleSessionEvent.call(App, ev('status', {
    text: 'Scout drafted a 42-line spec from the codebase.',
    specPreview: '## User-facing changes\n…',
    specLines: 42,
    specVersion: 3,
    durationMs: 12345,
    scoutOutput: 'full spec text',
  }));

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
  App.handleSessionEvent.call(App, ev('mayor_reasoning', { text: summary }));

  const assistants = DevChat.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 2, 'summary opened a fresh bubble, did not overwrite the preamble');
  assert.equal(assistants[0].content, 'Let me scout the repo first.', 'preamble text preserved');
  assert.equal(assistants[1].content, summary, 'summary text rendered in the new bubble');

  // done finalizes streaming.
  App.handleSessionEvent.call(App, ev('done', {}));
  assert.equal(DevChat.isStreaming, false, 'done tears down streaming');
  assert.equal(DevChat.finishCalls, 1, '_finishStreaming called once');
});

test('mayor_reasoning reconciles an UNSEALED live bubble in place', () => {
  const { App, DevChat } = makeApp();
  DevChat.messages.push({ role: 'user', content: 'hi' });
  DevChat.messages.push({ role: 'assistant', content: 'partial strea' });

  App.handleSessionEvent.call(App, ev('mayor_reasoning', { text: 'partial stream complete.' }));

  const assistants = DevChat.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistants.length, 1, 'no extra bubble — reconciled the existing live one');
  assert.equal(assistants[0].content, 'partial stream complete.', 'content reconciled to authoritative text');
});

test('a mayor_reasoning _seq already seen on the POST SSE is deduped (no double render)', () => {
  const { App, DevChat } = makeApp();
  DevChat.messages.push({ role: 'user', content: 'hi' });

  const payload = ev('mayor_reasoning', { text: 'the summary' });
  // Pretend the POST SSE already delivered and recorded this seq.
  DevChat._seenSeqs.add(payload._seq);

  App.handleSessionEvent.call(App, payload);

  assert.equal(DevChat.messages.filter((m) => m.role === 'assistant').length, 0,
    'duplicate seq did not push a second copy of the summary');
});

test('assistant_message_end over the WS seals the current bubble', () => {
  const { App, DevChat } = makeApp();
  DevChat.messages.push({ role: 'assistant', content: 'preamble' });

  App.handleSessionEvent.call(App, ev('assistant_message_end', {}));

  assert.equal(DevChat.messages[0]._finalized, true, 'bubble sealed by assistant_message_end');
  assert.equal(DevChat.flushCalls, 1, 'flushed the throttled streaming render before sealing');

  // A following mayor_reasoning now opens a fresh bubble.
  App.handleSessionEvent.call(App, ev('mayor_reasoning', { text: 'wrap up' }));
  assert.equal(DevChat.messages.filter((m) => m.role === 'assistant').length, 2,
    'sealed bubble forces the next mayor_reasoning into a new bubble');
});

test('events for a different session are ignored', () => {
  const { App, DevChat } = makeApp();
  DevChat.currentSession = { id: 111 };
  App.handleSessionEvent.call(App, ev('mayor_reasoning', { text: 'not mine' }));
  assert.equal(DevChat.messages.length, 0, 'cross-session event dropped');
});
