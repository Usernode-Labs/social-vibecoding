// #4640: the Workshop side panel's discussion was drawn into a hidden
// Messages reply pane's thread shell, and never into the panel's own box.
//
// A mounted thread's transcript is looked up by document id —
// `document.getElementById('gc-thread-messages')`. But #messages-screen is
// always in the document, only hidden, and when its route holds a reply
// thread its pane keeps a thread shell with its own `#gc-thread-messages`.
// The side panel (workshop/side-panel.tsx) is portalled to the END of
// <body>, so the id lookup found the earlier, hidden pane's host: the
// panel's Discussion stayed empty until a refresh dropped the reply thread.
//
// `mountThread` now records the container it was given (`_threadHost`) and
// every thread lookup scopes to it. This page has BOTH shells in it — the
// hidden reply pane's, which a document-wide lookup finds first, and the
// panel's container's — and requires the transcript to be mounted into the
// container's element. It also holds connect() to its promise: a thread open
// on the same app survives the reset, a thread of another app does not.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
    this.scrollTop = 0;
    this.clientHeight = 0;
  }
}

function load() {
  // The hidden Messages reply pane's host: what a document-wide id lookup
  // returns for #gc-thread-messages, because the pane's shell is earlier in
  // the document than anything portalled to the end of <body>.
  const paneMessages = new Node('gc-thread-messages');
  // The side panel's own thread shell, inside the container it is mounted in.
  const panelMessages = new Node('gc-thread-messages');
  const panelScroll = new Node('gc-thread-scroll');
  const panelForm = new Node('gc-thread-form');
  const panelInput = new Node('gc-thread-input');
  const container = new Node('dev-topic-thread');
  container.querySelector = (sel) => ({
    '#gc-thread-messages': panelMessages,
    '#gc-thread-scroll': panelScroll,
    '#gc-thread-form': panelForm,
    '#gc-thread-input': panelInput,
  }[sel] || null);

  const transcripts = [];
  const document = {
    getElementById: (id) => (id === 'gc-thread-messages' ? paneMessages : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    visibilityState: 'visible',
    activeElement: null,
    createElement: () => new Node(''),
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
    console,
    fetch: async () => ({ ok: true, json: async () => ({ messages: [] }) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    // A socket that never opens by itself; _openSocket's handshake is not
    // what these tests are about.
    WebSocket: class {
      constructor() { this.readyState = 0; }
      close() { this.readyState = 3; }
      send() {}
    },
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  window.App = sandbox.App;
  vm.createContext(sandbox);
  vm.runInContext(`${gcJs}\nglobalThis.__M = { GroupChat };`, sandbox);
  const GroupChat = sandbox.__M.GroupChat;

  GroupChat.appSlug = 'usernode-2d5619';
  GroupChat._appSlug = () => 'usernode-2d5619';
  GroupChat.ws = { readyState: 1, send: () => {}, close() {} };
  GroupChat._react = () => ({
    mountThreadShell() {},
    unmountTranscript() {},
    mountTranscript: (el, key) => transcripts.push({ el, key }),
    publishTranscript() {},
    appendTranscriptMessage() {},
  });
  GroupChat._messageView = (m) => ({ id: m.id });
  GroupChat._renderQuotePreview = () => {};
  GroupChat._autoGrowTextarea = () => {};
  return { GroupChat, container, panelMessages, paneMessages, transcripts };
}

function openInPanel(GroupChat, container, kind, ref) {
  GroupChat.mountThread({
    type: kind, ref, container, fullHeight: true, withHeader: true,
    ...(kind === 'issue' ? { language: 'request', placeholder: 'Reply…' } : {}),
  });
}

test('the panel thread renders into the panel host, not the hidden reply pane the id lookup finds', () => {
  const { GroupChat, container, panelMessages, paneMessages, transcripts } = load();
  openInPanel(GroupChat, container, 'issue', 4640);
  const mounts = transcripts.filter((t) => t.key === 'thread');
  assert.ok(mounts.length, 'the thread transcript was mounted');
  assert.equal(mounts.at(-1).el, panelMessages,
    'the transcript is mounted into the container\'s own #gc-thread-messages');
  assert.notEqual(panelMessages, paneMessages, 'the page really holds two hosts');
  // And unmounting gives the document-wide lookup back.
  GroupChat.unmountThread();
  assert.equal(GroupChat._threadEl('gc-thread-messages'), paneMessages);
});

test('connect() for the same app keeps the open thread and re-reads it; another app clears it', () => {
  const { GroupChat, container } = load();
  const reloaded = [];
  const repainted = [];
  GroupChat.loadThreadHistory = (type, ref) => reloaded.push({ type, ref });
  GroupChat.renderThread = () => repainted.push(true);
  GroupChat.attachScrollHandlers = () => {};
  openInPanel(GroupChat, container, 'issue', 4640);
  // A plain copy: the module's objects live in the vm realm.
  const open = JSON.parse(JSON.stringify(GroupChat.activeThread));
  reloaded.length = 0; repainted.length = 0; // the mount's own load already ran

  // The socket dropped and connect() runs again for the SAME app: the open
  // thread is not orphaned.
  GroupChat.connect('usernode-2d5619', null);
  assert.deepEqual(JSON.parse(JSON.stringify(GroupChat.activeThread)), open, 'the open thread survives the reset');
  assert.equal(GroupChat._threadHost, container, 'its host travels with it');
  assert.deepEqual(reloaded, [{ type: 'issue', ref: 4640 }], 'and its history is re-read');
  assert.equal(repainted.length, 1);

  // A different app: the thread goes, as before.
  GroupChat.connect('another-app', null);
  assert.equal(GroupChat.activeThread, null);
  assert.deepEqual(reloaded, [{ type: 'issue', ref: 4640 }], 'no re-read for another app');
});

test('a mount that reconnects replaces the open thread instead of restoring it', () => {
  const { GroupChat, container } = load();
  const reloaded = [];
  GroupChat.loadThreadHistory = (type, ref) => reloaded.push({ type, ref });
  GroupChat.renderThread = () => {};
  GroupChat.attachScrollHandlers = () => {};
  openInPanel(GroupChat, container, 'issue', 1);
  reloaded.length = 0; // the mount's own load already ran

  // The next mount finds the socket dead, so it reconnects — and connect()
  // must not keep the thread being replaced alive.
  GroupChat.ws = { readyState: 3, send: () => {}, close() {} };
  openInPanel(GroupChat, container, 'issue', 2);
  assert.deepEqual(JSON.parse(JSON.stringify(GroupChat.activeThread)), { type: 'issue', ref: 2, language: 'request' });
  assert.deepEqual(reloaded, [{ type: 'issue', ref: 2 }]);
});