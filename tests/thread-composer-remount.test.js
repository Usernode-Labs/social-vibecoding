// #4517: a reply typed on one request's page was posted to another request's
// thread — the one opened earlier in the same visit.
//
// The topic page's thread shell is React's (thread-shell.tsx, mounted by
// `mountThreadShell`), so going from one request's page to another's in the
// same `#dev-topic-thread` host keeps the SAME form and textarea nodes.
// `GroupChat.mountThread` binds its submit, input, keydown and attachment
// listeners to those nodes, each closing over the mount's `{ type, ref }`.
// Nothing unbound the previous mount's, so the first page's submit handler
// ran first, sent the text to ITS thread and emptied the box, and the page on
// screen's own handler then found nothing to send.
//
// This replays that visit — open #4486, open #4417 in the same host, quote a
// message there and send — and requires the one write to name #4417.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { englishPlatformI18n } = require('./lib/platform-i18n');

const gcJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');

class Node extends EventTarget {
  constructor(id) {
    super();
    this.id = id;
    this.value = '';
    this.style = {};
    this.dataset = {};
    this.files = null;
    this.scrollHeight = 0;
  }
  click() { this.dispatchEvent(new Event('click')); }
}

function load() {
  // The nodes React keeps across a re-render of the shell.
  const nodes = {
    'gc-thread-form': new Node('gc-thread-form'),
    'gc-thread-input': new Node('gc-thread-input'),
    'gc-thread-messages': new Node('gc-thread-messages'),
    'gc-thread-attach-btn': new Node('gc-thread-attach-btn'),
    'gc-thread-file-input': new Node('gc-thread-file-input'),
  };
  const container = new Node('dev-topic-thread');
  container.querySelector = (sel) => nodes[sel.replace(/^#/, '')] || null;
  const document = {
    visibilityState: 'visible',
    activeElement: null,
    createElement: () => new Node(''),
    getElementById: (id) => nodes[id] || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const window = { matchMedia: () => ({ matches: false }), UsernodeReact: {} };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost', origin: 'http://localhost' },
    URL, URLSearchParams, EventTarget, Event, AbortController,
    document,
    window,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'evan' } },
    PlatformUI: { attachScreenFx() {} },
    PlatformI18n: englishPlatformI18n(),
    console,
    fetch: async () => ({ ok: true, json: async () => ({ messages: [] }) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  window.App = sandbox.App;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  const GroupChat = sandbox.__M.GroupChat;

  const sent = [];
  GroupChat.appSlug = 'usernode-2d5619';
  GroupChat._appSlug = () => 'usernode-2d5619';
  GroupChat.ws = { readyState: 1, send: (raw) => sent.push(JSON.parse(raw)) };
  GroupChat._react = () => ({ mountThreadShell() {}, unmountTranscript() {} });
  GroupChat.renderThread = () => {};
  GroupChat.loadThreadHistory = () => {};
  GroupChat._renderQuotePreview = () => {};
  GroupChat._renderAttachStrip = () => {};
  GroupChat._autoGrowTextarea = () => {};
  GroupChat.sendTyping = () => {};
  return { GroupChat, nodes, container, sent };
}

function openRequest(GroupChat, container, number) {
  GroupChat.mountThread({
    type: 'issue', ref: number, container, fullHeight: true, withHeader: true,
    language: 'request', placeholder: 'Reply…',
  });
}

function typeAndSend(nodes, text) {
  nodes['gc-thread-input'].value = text;
  const submit = new Event('submit', { cancelable: true });
  nodes['gc-thread-form'].dispatchEvent(submit);
}

test('a reply sent after moving between request pages goes to the request on screen', () => {
  const { GroupChat, nodes, container, sent } = load();
  openRequest(GroupChat, container, 4486);
  typeAndSend(nodes, 'plan v1');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].thread, { type: 'issue', ref: 4486 });

  // Over to #4417's page, in the same host: React keeps the form and input.
  openRequest(GroupChat, container, 4417);
  GroupChat.replyDraft = { id: 901, username: 'Bruno', content: 'Not sure, I think it would be something like this' };
  GroupChat.replyDraftScope = 'thread';
  typeAndSend(nodes, 'a quote-reply to Bruno');

  assert.equal(sent.length, 2, 'exactly one write for the one send');
  assert.deepEqual(sent[1].thread, { type: 'issue', ref: 4417 }, 'written to the thread on screen');
  assert.equal(sent[1].content, 'a quote-reply to Bruno');
  assert.ok(sent[1].quote, 'the staged quote rides along with it');
  assert.equal(nodes['gc-thread-input'].value, '');
});

test('a repaint of the same page binds one send, not one per mount', () => {
  const { GroupChat, nodes, container, sent } = load();
  openRequest(GroupChat, container, 4417);
  openRequest(GroupChat, container, 4417);
  openRequest(GroupChat, container, 4417);
  // A box that never empties, so every bound handler that runs would post.
  Object.defineProperty(nodes['gc-thread-input'], 'value', { get: () => 'once', set() {} });
  let handlers = 0;
  GroupChat.send = () => { handlers += 1; };
  nodes['gc-thread-form'].dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(handlers, 1);
  assert.equal(sent.length, 0);
});

test('leaving a thread drops its composer listeners', () => {
  const { GroupChat, nodes, container, sent } = load();
  openRequest(GroupChat, container, 4486);
  GroupChat.unmountThread();
  typeAndSend(nodes, 'typed after leaving');
  assert.equal(sent.length, 0, 'a left thread is never written to');
});

test('a picked file is added once, under the page on screen', () => {
  const { GroupChat, nodes, container } = load();
  const added = [];
  GroupChat._addFiles = (files, scope) => { added.push(`${scope.type}:${scope.ref}`); };
  openRequest(GroupChat, container, 4486);
  openRequest(GroupChat, container, 4417);
  const fileInput = nodes['gc-thread-file-input'];
  fileInput.files = [{ name: 'shot.png' }];
  fileInput.dispatchEvent(new Event('change'));
  assert.deepEqual(added, ['issue:4417']);
});
