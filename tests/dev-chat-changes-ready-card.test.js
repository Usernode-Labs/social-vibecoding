// #361: the "Changes ready" card (dc-pr-card) + "Propose to group" button
// must render whenever a turn produced a reviewable commit — driven by the
// staging-independent `changesReady` marker — NOT only when a staging
// preview built. This guards the three render shapes:
//   - changesReady + stagingFailed (no URL) → card, DISABLED Preview, Propose
//   - changesReady + stagingUrl            → full card (live Preview), Propose
//   - neither (a plain no-changes/spec/question status line) → NO card
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`). We load its
// source into a vm context, stub the browser globals it reaches at load
// (localStorage / document / window / fetch / navigator) plus the shared
// `escapeHtml`, drive DevChat.renderMessages() against a fake #dc-messages
// element whose innerHTML setter records the HTML, and assert on it.
//
// Run with: node --test tests/dev-chat-changes-ready-card.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'dev-chat.js'),
  'utf8'
);

// Build a DevChat in a sandbox with a fake #dc-messages whose innerHTML is
// captured. renderMessages() reads DevChat.messages + DevChat.currentSession.
function makeDevChat() {
  let captured = '';
  const messagesEl = {
    set innerHTML(v) { captured = v; },
    get innerHTML() { return captured; },
    querySelectorAll: () => ({ forEach: () => {} }),
    scrollTop: 0, scrollHeight: 0,
  };
  const noopEl = {
    style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    addEventListener: () => {}, setAttribute: () => {}, removeAttribute: () => {},
    querySelector: () => null, querySelectorAll: () => ({ forEach: () => {} }),
    appendChild: () => {}, innerHTML: '', textContent: '',
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
    navigator: { sendBeacon: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  // renderMarkdown is irrelevant to the card path; keep it cheap + safe.
  DevChat.renderMarkdown = (t) => String(t || '');
  return {
    DevChat,
    render(messages, session) {
      DevChat.messages = messages;
      DevChat.currentSession = session || null;
      DevChat.renderMessages();
      return captured;
    },
  };
}

const activeSession = (over) => ({
  id: 7, status: 'active', pr_url: null, pr_number: null, ...over,
});

test('changesReady WITHOUT stagingUrl renders the card with Propose + a disabled Preview', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging build failed',
      changesReady: true, stagingFailed: true,
      stagingErrorName: 'MissingSecretsError', stagingMissingKeys: ['EXAMPLE_KEY'],
      _slug: 'aaa111',
    },
  ], activeSession());

  assert.match(html, /dc-pr-card/, 'the Changes ready card renders');
  assert.match(html, /Propose to group/, 'Propose to group button present');
  // Preview button is present but disabled (no live URL to open).
  assert.match(html, /disabled[^>]*>Preview staging</, 'Preview staging is disabled');
  assert.doesNotMatch(html, /previewStaging\(/, 'no live preview click handler');
  // Missing-secret hint surfaces in the disabled note.
  assert.match(html, /EXAMPLE_KEY/, 'missing-secret hint surfaced');
  assert.match(html, /proposing will rebuild it/i, 'explains proposing rebuilds the preview');
});

test('stagingUrl renders the FULL card with a live Preview + Propose', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging deployed!',
      changesReady: true, stagingUrl: 'https://preview.example.org',
      _slug: 'bbb222',
    },
  ], activeSession());

  assert.match(html, /dc-pr-card/, 'card renders');
  assert.match(html, /Propose to group/, 'Propose to group present');
  assert.match(html, /previewStaging\('https:\/\/preview\.example\.org', false\)/, 'live Preview button wired');
  assert.doesNotMatch(html, /disabled[^>]*>Preview staging</, 'Preview is NOT disabled when a URL exists');
});

test('a plain no-changes status line renders NO card', () => {
  const { render } = makeDevChat();
  const html = render([
    { role: 'system', content: 'No changes were made by Claude Code.', _slug: 'ccc333' },
  ], activeSession());

  assert.doesNotMatch(html, /dc-pr-card/, 'no card for a no-changes status');
  assert.doesNotMatch(html, /Propose to group/, 'no Propose button');
});

test('a spec/question status line (no marker) renders NO card', () => {
  const { render } = makeDevChat();
  const html = render([
    { role: 'system', content: 'Auto session drafted a spec.', _slug: 'ddd444' },
  ], activeSession());
  assert.doesNotMatch(html, /dc-pr-card/, 'spec/question outcomes keep their non-card guidance');
});

test('View on GitHub uses the message-carried prUrl when the session row lacks one', () => {
  const { render } = makeDevChat();
  const html = render([
    {
      role: 'system', content: 'Staging build failed',
      changesReady: true, stagingFailed: true,
      prNumber: 123, prUrl: 'https://github.com/x/y/pull/123',
      _slug: 'eee555',
    },
  ], activeSession({ pr_url: null, pr_number: null }));
  assert.match(html, /View on GitHub/, 'GitHub link rendered from the marker');
  assert.match(html, /pull\/123/, 'links to the carried PR url');
});
