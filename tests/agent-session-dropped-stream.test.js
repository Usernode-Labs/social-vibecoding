'use strict';

// A turn whose stream breaks is not a refused message
// (frontend/src/features/agent-session/store.ts: sendAgentMessage, and the
// read that settles every turn, requestSync).
//
// Every platform deploy replaces its one pod, and a turn's stream
// (POST /api/agent-sessions/:id/turns) goes with it. WebKit then throws
// "Error in input stream" from the stream's reader, though the server had the
// message and the turn carried on. The chat used to print that raw text, hand
// the sent message back to the composer (a resend runs it twice) and stop
// following the turn. Now it reads where the turn stands:
//
//   1. FINISHED while the stream was down: the saved reply shows, no error,
//      and the message is one row: the server's, carrying its client id.
//   2. STILL RUNNING: it follows the bus, and re-reads the conversation until
//      the server says the turn ended (a new pod's bus never hears the old).
//   3. NEVER RECORDED (broken before the server took it): sent again, under
//      the same id, a couple of times; then it stays in the conversation,
//      Not sent, in plain words, with Retry. Nothing goes back to the box.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTsx } = require('./lib/render-tsx');
const { withStateRead } = require('./lib/agent-session-state-read');

const encoder = new TextEncoder();

// A body that carries `frames`, then fails the way WebKit's reader does.
function brokenStream(frames) {
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
    },
    pull(controller) {
      controller.error(new TypeError('Error in input stream'));
    },
  });
}

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;
const user = (id, content, clientMessageId = null) => ({ id, role: 'user', content, createdAt: null, metadata: null, clientMessageId });
const reply = (id, content) => ({ id, role: 'assistant', content, createdAt: null, metadata: null });

function harness({ frames, after }) {
  const sources = [];
  const server = {
    busy: false,
    messages: [user(10, 'Earlier')],
  };
  const session = () => ({
    id: 7, title: 'x', status: 'open', focusApp: null, focusContext: {}, busy: server.busy, activeChange: null, changes: [],
  });
  globalThis.window = { location: { hash: '' }, App: { setHeaderTitle() {} }, UsernodeReact: {}, PlatformUI: { toast() {} } };
  globalThis.EventSource = class {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
  };
  globalThis.fetch = withStateRead(async (url, init = {}) => {
    if (/\/turns$/.test(url) && init.method === 'POST') {
      // What the server did with the message while the stream was down.
      after(server, JSON.parse(init.body));
      return { ok: true, status: 200, body: brokenStream(frames) };
    }
    const body = /\/messages\?/.test(url) ? { messages: server.messages, nextAfter: null }
      : /\/actions$/.test(url) ? { actions: [] }
        : /\/drafts$/.test(url) ? { drafts: [] }
          : /\/api\/agent-sessions$/.test(url) ? { sessions: [session()] }
            : { session: session(), turn: server.busy ? { phase: 'cc', stopping: false, changeId: 50, startedAt: 1 } : null };
    return { ok: true, status: 200, json: async () => body };
  });
  return { server, sources };
}

function cleanup() {
  delete globalThis.window;
  delete globalThis.fetch;
  delete globalThis.EventSource;
}

test('a turn that finished while its stream was down shows its reply, with no error and nothing handed back', async () => {
  harness({
    frames: [frame({ type: 'accepted', messageId: 11, turnId: 'abcdefgh-0000', _seq: 'abcdefgh-1' })],
    after(server, body) {
      server.messages = [...server.messages, user(11, 'Make it blue', body.clientMessageId), reply(12, 'Done: it is blue.')];
    },
  });
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });
    await api.sendAgentMessage('Make it blue');
    const state = api.getAgentSessionState();
    assert.equal(state.error, '', 'the browser\'s "Error in input stream" is not a message for the viewer');
    assert.equal(state.returnedText, null, 'the message was sent: nothing goes back to the box to be sent twice');
    assert.equal(state.turn.running, false);
    assert.deepEqual(state.outbox, [], 'one row for the message: the server\'s, which carries its client id');
    assert.deepEqual(state.messages.map((m) => m.id), [10, 11, 12], 'the saved reply is on screen');
  } finally {
    cleanup();
  }
});

test('a turn still running after its stream broke is followed, and settles when the server says it ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { server, sources } = harness({
    frames: [frame({ type: 'phase', phase: 'cc', startedAt: 1, _seq: 'abcdefgh-1' })],
    after(s, body) {
      s.busy = true;
      s.messages = [...s.messages, user(11, 'Make it blue', body.clientMessageId)];
    },
  });
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });
    await api.sendAgentMessage('Make it blue');
    let state = api.getAgentSessionState();
    assert.equal(state.error, '');
    assert.equal(state.returnedText, null);
    assert.equal(state.turn.running, true, 'still working, as the server says');
    assert.equal(state.turn.phase, 'cc');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].url, '/api/agent-sessions/7/events', 'follows the conversation\'s bus');

    // The old pod finished the turn; the new pod's bus never said so.
    server.busy = false;
    server.messages = [...server.messages, reply(12, 'Done: it is blue.')];
    t.mock.timers.tick(4000);
    for (let i = 0; i < 20 && api.getAgentSessionState().turn.running; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    state = api.getAgentSessionState();
    assert.equal(state.turn.running, false, 're-reading the session settles the turn');
    assert.equal(sources[0].closed, true);
    for (let i = 0; i < 20 && api.getAgentSessionState().messages.length < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    assert.deepEqual(api.getAgentSessionState().messages.map((m) => m.id), [10, 11, 12]);
  } finally {
    cleanup();
  }
});

test('a stream that broke before the server took the message is sent again, then stays in the conversation as Not sent, with Retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posts = [];
  harness({ frames: [], after(_server, body) { posts.push(body); } });
  try {
    const api = loadTsx('tests/fixtures/agent-session-api.ts');
    await api.openAgentSession({ id: 7, host: 'messages' });
    const sent = api.sendAgentMessage('Make it blue');
    for (let i = 0; i < 40 && posts.length < 3; i += 1) {
      t.mock.timers.tick(5000);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => { setImmediate(resolve); });
    }
    await sent;
    assert.equal(posts.length, 3, 'tried again, twice');
    assert.equal(new Set(posts.map((body) => body.clientMessageId)).size, 1, 'always the same message, under the same id');
    const state = api.getAgentSessionState();
    assert.equal(state.error, '', 'no raw browser words, and no second line for it');
    assert.doesNotMatch(JSON.stringify(state), /input stream/);
    assert.deepEqual(state.outbox.map((item) => [item.shown, item.status, item.error]),
      [['Make it blue', 'failed', 'Could not reach Homeroom, so this was not sent.']]);
    assert.equal(state.returnedText, null, 'kept where it was sent, not handed back to the box');
    assert.equal(state.turn.running, false);
  } finally {
    cleanup();
  }
});
