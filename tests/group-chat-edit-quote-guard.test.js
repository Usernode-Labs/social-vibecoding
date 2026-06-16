// Regression test for issue #336: clicking inside an open inline editor
// (.gc-edit) must NOT be misread as a tap-to-quote on the message row.
//
// public/js/group-chat.js is a browser script (no module.exports). We load
// it into a vm sandbox (like chat-edit-render.test.js) with a tiny DOM that
// supports just enough of closest()/contains()/querySelector to drive the
// delegated click handler attached in _attachQuoteHandlers. We then dispatch
// a click whose target lives inside a .gc-edit subtree and assert the
// handler short-circuits (setQuote is never called, replyDraft stays null),
// while a clean tap on an ordinary message row still stages a quote.
//
// Run with: node --test tests/group-chat-edit-quote-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// --- Tiny DOM ------------------------------------------------------------

function matchOne(el, token) {
  token = token.trim();
  if (!token) return false;
  if (token.startsWith('.')) return el._classes.has(token.slice(1));
  if (token.startsWith('[') && token.endsWith(']')) {
    const attr = token.slice(1, -1);
    if (attr.startsWith('data-')) {
      const key = attr
        .slice(5)
        .replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(el.dataset, key);
    }
    return false;
  }
  return el.tagName === token.toUpperCase();
}

function matchesSel(el, sel) {
  return sel.split(',').some((t) => matchOne(el, t));
}

function makeEl(tag, classes = []) {
  const classSet = new Set(classes);
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    children: [],
    parentNode: null,
    textContent: '',
    _classes: classSet,
    _listeners: {},
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c),
    },
    appendChild(child) {
      child.parentNode = el;
      el.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      (el._listeners[type] || (el._listeners[type] = [])).push(fn);
    },
    matches(sel) {
      return matchesSel(el, sel);
    },
    closest(sel) {
      let n = el;
      while (n) {
        if (matchesSel(n, sel)) return n;
        n = n.parentNode;
      }
      return null;
    },
    contains(node) {
      let n = node;
      while (n) {
        if (n === el) return true;
        n = n.parentNode;
      }
      return false;
    },
    querySelector(sel) {
      const stack = [...el.children];
      while (stack.length) {
        const n = stack.shift();
        if (matchesSel(n, sel)) return n;
        stack.push(...n.children);
      }
      return null;
    },
  };
  return el;
}

// --- Load group-chat.js into a sandbox -----------------------------------

function loadGroupChat() {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'group-chat.js'),
    'utf8'
  );
  const document = {
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    window: { matchMedia: () => ({ matches: false }), getSelection: () => null },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.__M = { GroupChat };', sandbox);
  return sandbox.__M.GroupChat;
}

// Build the delegated click handler over a fresh container, returning the
// container plus a spy that records setQuote calls.
function setup(GroupChat) {
  const container = makeEl('div', ['gc-messages']);
  // Neutralise side effects the clean-tap path touches so the test stays
  // focused on whether setQuote is reached.
  GroupChat.replyDraft = null;
  GroupChat._longPressed = false;
  GroupChat._tap = null;
  GroupChat._clearMessageDot = () => {};
  const calls = [];
  GroupChat.setQuote = (q) => {
    calls.push(q);
    GroupChat.replyDraft = q || null;
  };
  GroupChat._attachQuoteHandlers(container);
  const handler = container._listeners.click[0];
  const click = (target) => handler({ target, clientX: 0, clientY: 0 });
  return { container, calls, click };
}

// A normal own-message row with the standard content node.
function makeMsgRow(container, id) {
  const row = makeEl('div', ['gc-msg']);
  row.dataset.msgId = String(id);
  row.dataset.username = 'alice';
  const content = makeEl('div', ['gc-msg-content']);
  content.textContent = 'hello world';
  row.appendChild(content);
  container.appendChild(row);
  return row;
}

const { GroupChat } = { GroupChat: loadGroupChat() };

test('clean tap on an ordinary message row stages a quote', () => {
  const { container, calls, click } = setup(GroupChat);
  const row = makeMsgRow(container, 42);
  click(row.querySelector('.gc-msg-content'));
  assert.equal(calls.length, 1, 'setQuote called once');
  assert.ok(GroupChat.replyDraft, 'replyDraft is set');
  assert.equal(GroupChat.replyDraft.refMsgId, 42);
});

test('click inside an open editor textarea does NOT stage a quote', () => {
  const { container, calls, click } = setup(GroupChat);
  const row = makeMsgRow(container, 7);
  // Mount an inline editor inside the row, mirroring _startEdit's structure.
  const editor = makeEl('div', ['gc-edit']);
  const textarea = makeEl('textarea', ['gc-edit-textarea']);
  const notice = makeEl('span', ['gc-edit-notice']);
  editor.appendChild(textarea);
  editor.appendChild(notice);
  row.appendChild(editor);

  click(textarea);
  assert.equal(calls.length, 0, 'setQuote not called for a textarea click');
  assert.equal(GroupChat.replyDraft, null, 'replyDraft stays null');

  click(notice);
  assert.equal(calls.length, 0, 'setQuote not called for a notice-span click');
  assert.equal(GroupChat.replyDraft, null, 'replyDraft still null');
});

test('replying to a different (non-editing) message still works while one row is being edited', () => {
  const { container, calls, click } = setup(GroupChat);
  // Row A is open for editing…
  const rowA = makeMsgRow(container, 100);
  const editor = makeEl('div', ['gc-edit']);
  editor.appendChild(makeEl('textarea', ['gc-edit-textarea']));
  rowA.appendChild(editor);
  // …Row B is an ordinary message. Tapping it should still quote.
  const rowB = makeMsgRow(container, 200);

  click(rowB.querySelector('.gc-msg-content'));
  assert.equal(calls.length, 1, 'tapping a different row still stages a quote');
  assert.equal(GroupChat.replyDraft.refMsgId, 200);
});
