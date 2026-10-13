// Deleting a message in a project's chat when the delete does not go
// through. The row turns into its "Message deleted" placeholder at once; a
// REST delete that the server refuses, or whose fetch throws (offline), must
// put the message back before the caller toasts "Couldn't delete this
// message." — as Messages' own store already does. The thrown fetch used to
// skip the rollback and leave the placeholder beside the toast.
//
// Over the live connection the same holds: a delete the server refuses is
// answered to this socket as `delete_error` (src/services/ws.js), which puts
// the message back and rejects deleteMessage's promise — the rejection the
// transcript's menu already turns into that toast. Its `chat_delete`
// resolves it; a frame about another id changes nothing.
//
// Run with: node --test tests/group-chat-delete-rollback.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// group-chat.js is a classic script with no exports; load it into a vm with
// enough of a window to answer, and the fetch the case needs.
function loadGroupChat(fetchImpl) {
  const document = {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, addEventListener() {}, appendChild() {} }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const fetches = [];
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    fetch: (url, opts) => { fetches.push([url, opts && opts.method]); return fetchImpl(); },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Notifications = { items: [], refresh() {} };
  sandbox.UsernodeReact = { groupChat: { patchTranscriptMessage() {} } };
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/group-chat.js')}\nglobalThis.__M = { GroupChat };`, sandbox);
  const { GroupChat } = sandbox.__M;
  GroupChat.appSlug = 'demo';
  GroupChat.ws = null; // the socket is not open: the REST route is taken
  GroupChat.activeThread = null;
  GroupChat.messages = [{ id: 42, content: 'hello there', reactions: [], metadata: {}, deleted: false }];
  let renders = 0;
  GroupChat.render = () => { renders += 1; };
  GroupChat.renderThread = () => {};
  return { GroupChat, fetches, renders: () => renders };
}

test('a delete whose fetch throws (offline) puts the message back and rejects', async () => {
  const { GroupChat, fetches, renders } = loadGroupChat(() => Promise.reject(new TypeError('Failed to fetch')));
  await assert.rejects(GroupChat.deleteMessage(42), /Failed to fetch/);
  assert.deepEqual(fetches, [['/api/apps/demo/messages/42', 'DELETE']]);
  const m = GroupChat.messages[0];
  assert.equal(m.deleted, false);
  assert.equal(m.content, 'hello there');
  assert.equal(renders(), 1);
});

test('a delete the server refuses puts the message back and rejects', async () => {
  const { GroupChat, renders } = loadGroupChat(() => Promise.resolve({ ok: false, status: 403 }));
  await assert.rejects(GroupChat.deleteMessage(42), /Delete failed \(403\)/);
  assert.equal(GroupChat.messages[0].deleted, false);
  assert.equal(GroupChat.messages[0].content, 'hello there');
  assert.equal(renders(), 1);
});

test('a delete that succeeds keeps the placeholder', async () => {
  const { GroupChat, renders } = loadGroupChat(() => Promise.resolve({ ok: true, status: 200 }));
  await GroupChat.deleteMessage(42);
  assert.equal(GroupChat.messages[0].deleted, true);
  assert.equal(GroupChat.messages[0].content, '');
  assert.equal(renders(), 0);
});

// The socket is open: the delete goes over it and waits for the answer.
function openSocket(GroupChat) {
  const sent = [];
  GroupChat.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  return sent;
}

test('a socket delete the server refuses puts the message back and rejects', async () => {
  const { GroupChat, fetches, renders } = loadGroupChat(() => Promise.reject(new Error('no fetch expected')));
  const sent = openSocket(GroupChat);
  const pending = GroupChat.deleteMessage(42);
  assert.deepEqual(sent, [{ type: 'delete', id: 42 }]);
  assert.equal(GroupChat.messages[0].deleted, true, 'the placeholder shows at once');
  GroupChat.handleIncoming({ type: 'delete_error', id: 42, code: 'not_author' });
  await assert.rejects(pending, /Delete failed \(not_author\)/);
  assert.deepEqual(fetches, []);
  assert.equal(GroupChat.messages[0].deleted, false);
  assert.equal(GroupChat.messages[0].content, 'hello there');
  assert.equal(renders(), 1);
});

test('a delete_error about another id changes nothing', async () => {
  const { GroupChat, renders } = loadGroupChat(() => Promise.reject(new Error('no fetch expected')));
  openSocket(GroupChat);
  const pending = GroupChat.deleteMessage(42);
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  GroupChat.handleIncoming({ type: 'delete_error', id: 7, code: 'not_author' });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false);
  assert.equal(GroupChat.messages[0].deleted, true);
  assert.equal(renders(), 0);
  GroupChat.handleIncoming({ type: 'chat_delete', id: 42 });
  await pending;
});

test('a socket delete the server confirms keeps the placeholder and resolves', async () => {
  const { GroupChat, renders } = loadGroupChat(() => Promise.reject(new Error('no fetch expected')));
  openSocket(GroupChat);
  const pending = GroupChat.deleteMessage(42);
  GroupChat.handleIncoming({ type: 'chat_delete', id: 42 });
  await pending;
  // A late refusal for it no longer applies.
  GroupChat.handleIncoming({ type: 'delete_error', id: 42, code: 'not_found' });
  assert.equal(GroupChat.messages[0].deleted, true);
  assert.equal(renders(), 0);
});

test('a socket delete nobody answers settles quietly', async () => {
  const { GroupChat } = loadGroupChat(() => Promise.reject(new Error('no fetch expected')));
  openSocket(GroupChat);
  GroupChat.DELETE_SETTLE_MS = 5;
  await GroupChat.deleteMessage(42);
  assert.equal(GroupChat.messages[0].deleted, true);
});

// A socket delete over the sender's write budget (admitSocketFrame in
// src/services/ws.js) is refused the same way, with code `rate_limited`, so
// the message comes back and the menu's toast says it was not deleted.
test('a socket delete refused for coming too fast puts the message back and rejects', async () => {
  const { GroupChat, renders } = loadGroupChat(() => Promise.reject(new Error('no fetch expected')));
  openSocket(GroupChat);
  const pending = GroupChat.deleteMessage(42);
  GroupChat.handleIncoming({ type: 'delete_error', id: 42, code: 'rate_limited', retryAfterSeconds: 20 });
  await assert.rejects(pending, /Delete failed \(rate_limited\)/);
  assert.equal(GroupChat.messages[0].deleted, false);
  assert.equal(GroupChat.messages[0].content, 'hello there');
  assert.equal(renders(), 1);
});
