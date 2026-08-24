// #1375: the amount beside a Dev-chat model is one reply's cost in dollars,
// while the lower-right meter is today's cumulative spend. Both live usage
// events and reloaded DB rows arrive in fractional cents, under different
// field names; this test pins their shared rendering seam.
//
// Run with: node --test tests/dev-chat-message-cost.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

function makeDevChat() {
  let captured = '';
  const messagesEl = {
    set innerHTML(v) { captured = v; },
    get innerHTML() { return captured; },
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollTop: 0,
    scrollHeight: 0,
  };
  const noopEl = {
    style: {},
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {},
    setAttribute: () => {},
    removeAttribute: () => {},
    querySelector: () => null,
    querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {},
    innerHTML: '',
    textContent: '',
  };
  const sandbox = {
    console,
    escapeHtml: (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;'),
    document: {
      getElementById: (id) => (id === 'dc-messages' ? messagesEl : null),
      querySelector: () => null,
      querySelectorAll: () => ({ forEach: () => {} }),
      addEventListener: () => {},
      createElement: () => ({ ...noopEl }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    alert: () => {},
    PlatformUI: {
      isTouch: () => false,
      hasKit: () => false,
      toast: () => {},
      alert: async () => ({}),
      confirm: async () => true,
      transition: (fn) => fn(),
      attachScreenFx: () => {},
      detachScreenFx: () => {},
      pullToRefresh: () => ({ detach() {} }),
      swipeActions: () => ({ detach() {} }),
      gestures: () => null,
    },
    navigator: { sendBeacon: () => {} },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);

  const DevChat = sandbox.__DevChat;
  DevChat.renderMarkdown = (text) => String(text || '');
  DevChat.currentSession = { id: 7, status: 'active', pr_url: null, pr_number: null };
  return {
    DevChat,
    render(message) {
      DevChat.messages = [message];
      DevChat.renderMessages();
      return captured;
    },
  };
}

const assistant = (cost) => ({
  id: 42,
  role: 'assistant',
  content: 'The reply still renders.',
  model: 'claude-opus-5',
  created_at: '2026-08-24T00:00:00.000Z',
  ...cost,
});

test('live fractional cents render as a scoped dollar cost', () => {
  const { render } = makeDevChat();
  const html = render(assistant({ costCents: 23.775 }));

  assert.match(html, /claude-opus · reply \$0\.238/);
  assert.doesNotMatch(html, /\$23\.775/);
  assert.match(html, /The reply still renders\./);
});

test('reloaded snake-case numeric strings render identically', () => {
  const { render } = makeDevChat();
  const html = render(assistant({ cost_cents: '23.7750' }));

  assert.match(html, /claude-opus · reply \$0\.238/);
  assert.doesNotMatch(html, /\$23\.775/);
});

test('zero, missing, negative, and invalid costs render no label', () => {
  const { DevChat } = makeDevChat();
  const invalid = [
    {},
    { costCents: 0 },
    { cost_cents: '0.0000' },
    { costCents: -1 },
    { cost_cents: 'not-a-number' },
    { costCents: Infinity },
  ];

  for (const value of invalid) {
    assert.equal(DevChat._messageCostLabel(value), '', JSON.stringify(value));
  }
});
