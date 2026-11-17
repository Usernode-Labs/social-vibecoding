// #6730 — one press of Send is one comment, even when the socket's answer
// never comes.
//
// public/js/group-chat.js makes a client key at the press. A comment sent on
// an open socket is remembered under that key until its echo (a `chat`
// frame), the server's `chat_ack`, or a refusal settles it. A socket that
// drops with comments still un-echoed puts them back on the offline queue,
// and the flush after the reconnect sends each one again with the key it was
// first sent under, so the server stores it once.
//
// Run with: node --test tests/group-chat-send-once.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { englishPlatformI18n } = require('./lib/platform-i18n');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// The server's own validation (conversations.normalizeIdempotencyKey).
const KEY_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

function loadGroupChat() {
  const document = {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, addEventListener() {}, appendChild() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  class FakeWS {
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      FakeWS.last = this;
    }
    send(raw) { this.sent.push(JSON.parse(raw)); }
    close() { this.readyState = 3; }
  }
  const sandbox = {
    PlatformI18n: englishPlatformI18n(),
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: FakeWS,
    App: { user: { id: 1, username: 'alice' } },
    fetch: () => Promise.reject(new Error('no fetch expected')),
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Notifications = { items: [], refresh() {} };
  sandbox.UsernodeReact = { groupChat: { patchTranscriptMessage() {} } };
  sandbox.PlatformUI = { toast() {} };
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/group-chat.js')}\nglobalThis.__M = { GroupChat };`, sandbox);
  const { GroupChat } = sandbox.__M;
  GroupChat.appSlug = 'demo';
  GroupChat.messages = [];
  GroupChat.render = () => {};
  GroupChat._renderStatusLine = () => {};
  GroupChat.resyncLoaded = () => {};
  GroupChat._isChannel = () => true;
  GroupChat._handleGeneralIncoming = () => {};
  return { GroupChat, FakeWS };
}

function open(GroupChat, FakeWS) {
  GroupChat._openSocket();
  return FakeWS.last;
}

test('send() marks the comment with a key and waits on its echo', () => {
  const { GroupChat, FakeWS } = loadGroupChat();
  const ws = open(GroupChat, FakeWS);
  GroupChat.send('hello');
  assert.equal(ws.sent.length, 1);
  const key = ws.sent[0].clientKey;
  assert.match(key, KEY_SHAPE);
  assert.equal(GroupChat._inFlight.size, 1);
  assert.equal(GroupChat._inFlight.get(key).content, 'hello');

  // The echo arrives: that comment is done.
  GroupChat.handleIncoming({ type: 'chat', clientKey: key, id: 7 });
  assert.equal(GroupChat._inFlight.size, 0);

  // Two separate presses are two comments with two keys.
  GroupChat.send('hello');
  GroupChat.send('hello');
  assert.equal(ws.sent.length, 3);
  assert.notEqual(ws.sent[1].clientKey, ws.sent[2].clientKey);
});

test('an ack dismisses a retry without drawing anything', () => {
  const { GroupChat, FakeWS } = loadGroupChat();
  const ws = open(GroupChat, FakeWS);
  GroupChat.send('already stored');
  const key = ws.sent[0].clientKey;
  GroupChat.handleIncoming({ type: 'chat_ack', clientKey: key, id: 9 });
  assert.equal(GroupChat._inFlight.size, 0);
});

test('a refusal names the key and stops waiting on it', () => {
  const { GroupChat, FakeWS } = loadGroupChat();
  const ws = open(GroupChat, FakeWS);
  GroupChat.send('nope');
  const key = ws.sent[0].clientKey;
  GroupChat.handleIncoming({ type: 'error', code: 'invalid_thread', clientKey: key });
  assert.equal(GroupChat._inFlight.size, 0);

  GroupChat.send('join me');
  const joinKey = ws.sent[1].clientKey;
  GroupChat.handleIncoming({
    type: 'join_required', app: { slug: 'demo' }, retry: { type: 'chat', content: 'join me', clientKey: joinKey },
  });
  assert.equal(GroupChat._inFlight.size, 0);
});

test('a dropped socket re-queues un-echoed comments, and the flush re-sends them with the same key', () => {
  const { GroupChat, FakeWS } = loadGroupChat();
  const ws = open(GroupChat, FakeWS);
  GroupChat.send('did it land?');
  const key = ws.sent[0].clientKey;
  assert.equal(GroupChat._inFlight.size, 1);

  // The connection dies before the echo.
  ws.readyState = 3;
  ws.onclose({ code: 1006 });
  assert.equal(GroupChat._inFlight.size, 0, 'nothing is left waiting on a dead socket');
  assert.equal(GroupChat._pendingOutgoing.length, 1);
  assert.equal(GroupChat._pendingOutgoing[0].clientKey, key);

  // Reconnect: the queued comment goes out again, key unchanged, and waits
  // on that key's echo.
  const next = open(GroupChat, FakeWS);
  next.onopen();
  assert.equal(next.sent.length, 1);
  assert.equal(next.sent[0].clientKey, key);
  assert.equal(next.sent[0].content, 'did it land?');
  assert.equal(GroupChat._inFlight.size, 1);

  // It is only ever queued once: a second close with the echo still missing
  // does not duplicate the payload.
  next.readyState = 3;
  next.onclose({ code: 1006 });
  assert.equal(GroupChat._pendingOutgoing.length, 1);
});

test('a comment typed while the socket is down is queued with its key, then sent once', () => {
  const { GroupChat, FakeWS } = loadGroupChat();
  const ws = open(GroupChat, FakeWS);
  ws.readyState = 3;
  GroupChat.send('queued');
  assert.equal(GroupChat._inFlight.size, 0);
  assert.equal(GroupChat._pendingOutgoing.length, 1);
  const key = GroupChat._pendingOutgoing[0].clientKey;
  assert.match(key, KEY_SHAPE);

  const next = open(GroupChat, FakeWS);
  next.onopen();
  assert.equal(next.sent[0].clientKey, key);
});

test('disconnect() drops what was in flight with the app it belonged to', () => {
  const { GroupChat, FakeWS } = loadGroupChat();
  const ws = open(GroupChat, FakeWS);
  GroupChat.send('going away');
  assert.equal(GroupChat._inFlight.size, 1);
  GroupChat.disconnect();
  assert.equal(GroupChat._inFlight.size, 0);
  assert.equal(GroupChat._pendingOutgoing.length, 0);
});
