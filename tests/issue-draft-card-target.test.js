// #1037: the draft card must say WHERE the issue will be filed, because
// the tap is irreversible and the Mayor picks the destination from the
// user's wording. An app-targeted card reads "Issue draft — <app>" with a
// "File issue" button; a platform-targeted one keeps the historical
// "Suggested platform report" / "Report to platform" copy — and so does a
// card with NO target at all, which is every draft written before #1037
// plus the staging fixture's three legacy rows.
//
// Same vm harness as tests/platform-issue-card-expand.test.js: load
// dev-chat.js into a sandbox, drive renderMessages() against a fake
// #dc-messages, assert on the captured HTML.
//
// Run with: node --test tests/issue-draft-card-target.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const issueDraft = require('../src/services/issue-draft');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

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
    escapeHtml,
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
  DevChat.renderMarkdown = (t) => String(t || '');
  return {
    DevChat,
    render(messages) {
      DevChat.messages = messages;
      DevChat.currentSession = { id: 7, status: 'active' };
      DevChat.renderMessages();
      return captured;
    },
  };
}

const card = (draft, content) => ({
  role: 'system',
  content: content || issueDraft.CONTENT_AGENT,
  id: 42,
  created_at: '2026-08-07T00:00:00Z',
  platformIssueDraft: {
    title: 'Something is wrong',
    body: 'Short detail.',
    status: 'pending',
    msgId: 42,
    appName: 'Demo App',
    ...draft,
  },
});

test('a draft with NO target keeps the platform copy (legacy + fixture rows)', () => {
  const { render } = makeDevChat();
  const html = render([card({})]);

  assert.match(html, /Suggested platform report/);
  assert.match(html, /resolvePlatformIssueDraft\(42, 'confirm', this\)[^>]*>Report to platform</);
  assert.doesNotMatch(html, /Issue draft —/);
});

test('an explicit platform target renders identically to an untargeted draft', () => {
  const { render } = makeDevChat();
  const untargeted = render([card({})]);
  const explicit = render([card({ target: 'platform' })]);
  assert.equal(explicit, untargeted, 'target:platform is the default, not a variant');
});

test('an app target names the app and offers "File issue"', () => {
  const { render } = makeDevChat();
  const html = render([card({ target: 'app', appName: 'Demo App' })]);

  assert.match(html, /Issue draft — Demo App/, 'the destination is on the card');
  assert.match(html, /resolvePlatformIssueDraft\(42, 'confirm', this\)[^>]*>File issue</);
  assert.doesNotMatch(html, /Report to platform/, 'the platform wording is gone');
  assert.match(html, /resolvePlatformIssueDraft\(42, 'dismiss', this\)[^>]*>Dismiss</,
    'Dismiss is unchanged for both targets');
});

test('an app-targeted card with no app name still reads sensibly', () => {
  const { render } = makeDevChat();
  const html = render([card({ target: 'app', appName: undefined })]);
  assert.match(html, /Issue draft — this app/);
});

test('an app name containing markup is escaped in the header', () => {
  const { render } = makeDevChat();
  const html = render([card({ target: 'app', appName: '<img src=x onerror=1>' })]);
  assert.ok(html.includes('&lt;img'), 'escaped');
  assert.ok(!html.includes('<img src=x'), 'no raw tag from a model/DB-supplied app name');
});

test('the resolved-state label follows the target too', () => {
  const { render } = makeDevChat();
  const platform = render([card({ status: 'filed' })]);
  assert.match(platform, /Reported to the platform/);

  const app = render([card({ status: 'filed', target: 'app' })]);
  assert.match(app, /Filed on this app's repo/);

  // A filed card WITH a url still links out, whichever target it used.
  const linked = render([card({
    status: 'filed', target: 'app', issueUrl: 'https://github.com/acme/demo/issues/9', issueNumber: 9,
  })]);
  assert.match(linked, /Reported — issue #9/);
});

test('a user-requested card reads as fulfilment, an agent one as a suggestion', () => {
  const { render } = makeDevChat();

  const agent = render([card({}, issueDraft.CONTENT_AGENT)]);
  assert.ok(agent.includes(escapeHtml(issueDraft.CONTENT_AGENT)));

  const user = render([card({ target: 'app', source: 'user_request' }, issueDraft.CONTENT_USER)]);
  assert.ok(user.includes(escapeHtml(issueDraft.CONTENT_USER)),
    'the status line comes from the persisted row content, set by the service');
  assert.ok(!user.includes(escapeHtml(issueDraft.CONTENT_AGENT)),
    'a card the user asked for does not read as the AI suggesting something');
});
