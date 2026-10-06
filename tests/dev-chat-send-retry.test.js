'use strict';

// #4012: a dev-chat send the server never took stays in the transcript
// marked Not sent, with Retry, and flushes itself when the connection
// comes back (DevChat.sendMessage / _retryFailedSend / _flushFailedSends
// in frontend/src/features/dev-chat/dev-chat.js).
//
// Until now a send that failed before `accepted` stranded its optimistic
// row looking sent, with the composer emptied and no way to push it again
// — a reload then dropped the words with the row. Now the row carries its
// client message id (`_clientKey`) and its raw text (`_retryText`), the
// failure marks it `_sendFailed`, and Retry re-POSTs the SAME id (so a
// message the server did store after all is answered by its duplicate
// `accepted` event, never a second turn), the same text and the same
// already-uploaded attachment ids.
//
// Drives the REAL sendMessage, _retryFailedSend and _flushFailedSends in a
// vm with a fake DOM — the harness of tests/dev-chat-accepted-delivery.test.js —
// with stubbed fetch bodies that throw the way an offline connection does,
// carry frames and then break, or answer the way a duplicate send does.
//
// Run with: node --test tests/dev-chat-send-retry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

const encoder = new TextEncoder();
const frame = (event) => `data: ${JSON.stringify(event)}\n\n`;

// A body that carries `frames`, then breaks like a dropped connection.
function brokenStream(frames) {
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f));
    },
    pull(controller) {
      controller.error(new TypeError('network error'));
    },
  });
}

function makeElement(id) {
  return {
    id,
    style: {},
    dataset: {},
    disabled: false,
    value: '',
    innerHTML: '',
    textContent: '',
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) { return c; },
    focus() {},
    querySelector() { return null },
    querySelectorAll() { return []; },
  };
}

function makeHarness() {
  const registry = new Map();
  const getEl = (id) => {
    if (!registry.has(id)) registry.set(id, makeElement(id));
    return registry.get(id);
  };
  const storage = new Map();
  const calls = { posts: [], removeSpinner: 0, resumed: [], polls: 0 };
  let fetchImpl = async () => { throw new TypeError('Failed to fetch'); };
  const sandbox = {
    console,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
    TextDecoder,
    AbortController,
    navigator: { onLine: true },
    document: {
      title: 'MyApp',
      getElementById: getEl,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => makeElement(`__created_${tag}`),
      addEventListener() {},
      removeEventListener() {},
      visibilityState: 'visible',
    },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    fetch: async (url, init) => {
      if (init && init.method === 'POST') {
        calls.posts.push({ url, body: JSON.parse(init.body) });
      }
      return fetchImpl(url, init);
    },
    escapeHtml: (s) => String(s == null ? '' : s),
    App: { currentTab: 'dev', currentSubTab: 'sessions' },
    Notifications: {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;

  DevChat.renderMessages = () => {};
  DevChat.scrollToBottom = () => {};
  DevChat.refreshBudget = () => {};
  DevChat._showSpinner = () => {};
  DevChat._removeSpinner = () => { calls.removeSpinner += 1; };
  DevChat._flushStreamingFinal = () => {};
  DevChat._stopProgressPolling = () => {};
  DevChat._closeResumableStream = () => {};
  DevChat._openResumableStream = (sessionId) => { calls.resumed.push({ sessionId, since: DevChat._lastSeenSeq }); };
  DevChat._startProgressPolling = () => { calls.polls += 1; };
  DevChat._setStreamingUI = () => {};
  DevChat._renderAttachStrip = () => {};

  return { DevChat, calls, getEl, sandbox, setFetch: (f) => { fetchImpl = f; } };
}

const SESSION_ID = 42;
const MSG = 'add a dark mode toggle';
const ATT = [{ id: 7, name: 'shot.png', kind: 'image', objectUrl: 'blob:x', contentType: 'image/png' }];

async function send(DevChat, message = MSG, attachments = []) {
  DevChat.currentSession = { id: SESSION_ID, status: 'active' };
  DevChat.messages = [];
  DevChat.isStreaming = false;
  await DevChat.sendMessage(message, attachments);
}

test('a fetch that throws before any response marks the row Not sent', async () => {
  const { DevChat, calls, getEl } = makeHarness();
  await send(DevChat);

  const row = DevChat.messages.find((m) => m.role === 'user');
  assert.ok(row, 'the optimistic row stays in the transcript');
  assert.equal(row._sendFailed, true, 'marked Not sent');
  assert.equal(row._retryText, MSG, 'the raw typed text lives on the row');
  assert.ok(row._clientKey, 'the row carries its client message id');
  assert.equal(DevChat.isStreaming, false, 'the never-started turn is torn down');
  assert.deepEqual(calls.resumed, [], 'the resumable stream is not armed');
  assert.equal(calls.polls, 0, 'the status poll is not armed');
  assert.equal(getEl('dc-input').value, '', 'the words live in the row, not handed back to the composer');
  assert.equal(calls.posts.length, 1, 'one POST went out');
  const id = calls.posts[0].body.clientMessageId;
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/, 'the POST carries a well-formed client message id');
  assert.equal(id, row._clientKey, 'the POST and the row carry the same id');
});

test('a stream that breaks before `accepted` marks the row Not sent too', async () => {
  const { DevChat, calls, setFetch } = makeHarness();
  setFetch(async () => ({ ok: true, status: 200, body: brokenStream([]) }));
  await send(DevChat);

  const row = DevChat.messages.find((m) => m.role === 'user');
  assert.ok(row, 'the optimistic row stays in the transcript');
  assert.equal(row._sendFailed, true, 'marked Not sent');
  assert.equal(DevChat.isStreaming, false, 'no live turn to follow');
  assert.deepEqual(calls.resumed, [], 'the resumable stream is not armed');
  assert.equal(calls.polls, 0, 'the status poll is not armed');
});

test('Retry re-sends the same id, text and attachments; a second failure re-marks it', async () => {
  const { DevChat, calls } = makeHarness();
  await send(DevChat, MSG, ATT);
  const key = DevChat.messages.find((m) => m.role === 'user')._clientKey;

  await DevChat._retryFailedSend(key);

  assert.equal(calls.posts.length, 2, 'the retry went out');
  assert.equal(calls.posts[1].body.clientMessageId, key, 'the SAME client message id');
  assert.equal(calls.posts[1].body.message, MSG, 'the same text');
  assert.deepEqual(calls.posts[1].body.attachmentIds, [7], 'the same uploaded attachment ids — no re-upload');
  const row = DevChat.messages.find((m) => m.role === 'user');
  assert.ok(row, 'the fresh row is in the transcript');
  assert.equal(row._sendFailed, true, 're-marked Not sent when the retry fails too');
  assert.equal(row._clientKey, key, 'under the same id, so nothing is lost');
});

test('Retry once the server answers is treated as accepted, never a second turn', async () => {
  const { DevChat, calls, setFetch } = makeHarness();
  await send(DevChat);
  const key = DevChat.messages.find((m) => m.role === 'user')._clientKey;
  const accepted = { type: 'accepted', _seq: 'lx9-1', messageId: 1001, clientMessageId: key };
  setFetch(async () => ({ ok: true, status: 200, body: brokenStream([frame(accepted)]) }));

  await DevChat._retryFailedSend(key);

  const row = DevChat.messages.find((m) => m.role === 'user');
  assert.ok(row, 'the fresh row is in the transcript');
  assert.equal(row._sendFailed, undefined, 'no Not sent mark once the server takes it');
  assert.equal(DevChat.isStreaming, true, 'the turn is followed live');
  assert.deepEqual(calls.resumed, [{ sessionId: SESSION_ID, since: 'lx9-1' }],
    'the resumable stream picks the turn up from the accepted event');
});

test('a duplicate answer (accepted, duplicate: true) is treated as accepted', async () => {
  const { DevChat, calls, setFetch } = makeHarness();
  await send(DevChat);
  const key = DevChat.messages.find((m) => m.role === 'user')._clientKey;
  // What chat-delivery.js answers a retry whose message the server already
  // stored: the original accepted event's _seq, marked duplicate, with the
  // turn's state.
  const dup = { type: 'accepted', _seq: 'lx9-1', messageId: 1001, clientMessageId: key, duplicate: true, state: 'running' };
  setFetch(async () => ({ ok: true, status: 200, body: brokenStream([frame(dup)]) }));

  await DevChat._retryFailedSend(key);

  const row = DevChat.messages.find((m) => m.role === 'user');
  assert.ok(row, 'the fresh row is in the transcript');
  assert.equal(row._sendFailed, undefined, 'no Not sent mark');
  assert.deepEqual(calls.resumed, [{ sessionId: SESSION_ID, since: 'lx9-1' }],
    'the recovery channels open as today, replaying from the original _seq');
});

test('_flushFailedSends retries a Not sent row when the connection is back', async () => {
  const { DevChat, calls, setFetch } = makeHarness();
  await send(DevChat);
  const key = DevChat.messages.find((m) => m.role === 'user')._clientKey;
  const accepted = { type: 'accepted', _seq: 'lx9-1', messageId: 1001, clientMessageId: key };
  setFetch(async () => ({ ok: true, status: 200, body: brokenStream([frame(accepted)]) }));

  await DevChat._flushFailedSends();

  assert.equal(calls.posts.length, 2, 'the flush sent it again');
  assert.equal(calls.posts[1].body.clientMessageId, key, 'under the same id');
  const row = DevChat.messages.find((m) => m.role === 'user');
  assert.equal(row._sendFailed, undefined, 'no Not sent mark left behind');
});

test('_flushFailedSends does nothing while a turn is streaming', async () => {
  const { DevChat, calls, setFetch } = makeHarness();
  await send(DevChat);
  setFetch(async () => ({ ok: true, status: 200, body: brokenStream([]) }));
  DevChat.isStreaming = true; // a live turn: Retry stays put

  await DevChat._flushFailedSends();

  assert.equal(calls.posts.length, 1, 'nothing was sent');
  assert.equal(DevChat.messages.find((m) => m.role === 'user')._sendFailed, true,
    'the row keeps its Not sent mark for the Retry button');
});

test('_flushFailedSends does nothing while offline', async () => {
  const { DevChat, calls, sandbox, setFetch } = makeHarness();
  await send(DevChat);
  setFetch(async () => ({ ok: true, status: 200, body: brokenStream([]) }));
  sandbox.navigator.onLine = false;

  await DevChat._flushFailedSends();

  assert.equal(calls.posts.length, 1, 'nothing was sent while offline');
  assert.equal(DevChat.messages.find((m) => m.role === 'user')._sendFailed, true,
    'the row keeps its Not sent mark');
});
