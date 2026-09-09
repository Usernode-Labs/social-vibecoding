// #699: the "Suggested platform report" card must let the user read the
// FULL report text before confirming or dismissing it. Bodies over the
// 300-char preview render as a <details> whose summary carries the preview
// + a "Show full report" cue and whose content carries the remainder —
// combined they contain the whole body, and the data-persist-id (suffix
// ':pireport') hooks the open state into _applyDetailsPersistence so a
// re-render mid-turn doesn't collapse it. Short bodies keep the old
// single-div render; filed/dismissed cards get the same expandable body.
//
// dev-chat.js is a plain browser script (`const DevChat = {…}`). We load
// its source into a vm context, stub the browser globals it reaches at
// load, drive DevChat.renderMessages() against a fake #dc-messages element
// whose innerHTML setter records the HTML, and assert on it — same harness
// as tests/dev-chat-changes-ready-card.test.js.
//
// Run with: node --test tests/platform-issue-card-expand.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { makeTranscriptBridge } = require('./lib/dev-transcript-html');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'dev-chat', 'dev-chat.js'),
  'utf8'
);

const escapeHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

function makeDevChat() {
  // #1078: the rows are a React island. `renderMessages` publishes a view
  // model instead of writing this element's innerHTML, so the element is only
  // the portal's host and the markup comes back from the component.
  const t = makeTranscriptBridge();
  const messagesEl = {
    innerHTML: '',
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
  sandbox.UsernodeReact = { devChat: t.bridge };
  vm.createContext(sandbox);
  vm.runInContext(`${SRC}\n;globalThis.__DevChat = DevChat;`, sandbox);
  const DevChat = sandbox.__DevChat;
  DevChat.renderMarkdown = (t) => String(t || '');
  return {
    DevChat,
    render(messages, session) {
      DevChat.messages = messages;
      DevChat.currentSession = session || { id: 7, status: 'active' };
      DevChat.renderMessages();
      return t.html();
    },
    // The confirm / dismiss wiring was an inline onclick, because an
    // innerHTML card had nowhere else to put a handler. A React card holds
    // the closure, so the wiring is read off the MODEL.
    draftRows: () => t.state().rows.filter((r) => r.t === 'issueDraft'),
  };
}

// A body comfortably over the 300-char clip whose tail is a distinctive
// sentence, so asserting the tail proves the remainder actually renders.
const LONG_TAIL = 'THE-VERY-LAST-WORDS-OF-THE-REPORT.';
const LONG_BODY = `${'The staging preview never boots when the bridge is loaded from a stale cache. '.repeat(12)}${LONG_TAIL}`;

const draftMsg = (draft, over) => ({
  role: 'system',
  content: 'The AI suggests reporting this to the platform',
  id: 42,
  created_at: '2026-07-21T00:00:00Z',
  platformIssueDraft: { title: 'Bridge cache bug', msgId: 42, status: 'pending', ...draft },
  ...over,
});

// Pull the summary preview and the remainder back out of the card HTML so
// we can assert their concatenation is the whole (escaped) body.
function extractParts(html) {
  const sum = html.match(/<summary class="dc-pi-report-summary">([\s\S]*?)<span class="dc-pi-report-cue">/);
  const rest = html.match(/<div class="dc-pi-report-rest">([\s\S]*?)<\/div>/);
  return { summary: sum && sum[1], rest: rest && rest[1] };
}

test('a >300-char pending draft renders an expandable <details> carrying the full body', () => {
  const { render } = makeDevChat();
  const html = render([draftMsg({ body: LONG_BODY })]);

  assert.match(html, /<details class="dc-pi-report" data-persist-id="42:pireport">/,
    'details present with the :pireport persist id (hooks _applyDetailsPersistence)');
  assert.match(html, /Show full report/, 'the expand cue renders');

  const { summary, rest } = extractParts(html);
  assert.ok(summary && rest, 'both the summary preview and the remainder render');
  assert.equal(summary + rest, escapeHtml(LONG_BODY),
    'summary + remainder concatenate into the full body — nothing lost past the clip');
  assert.ok(rest.includes(escapeHtml(LONG_TAIL)), 'the tail of the report is readable');
});

test('a body at or under 300 chars keeps the plain single-div render (no toggle)', () => {
  const { render } = makeDevChat();
  const shortBody = 'The file picker never opens inside the native WebView.';
  const html = render([draftMsg({ body: shortBody })]);

  assert.doesNotMatch(html, /dc-pi-report/, 'no expandable details for a short body');
  assert.doesNotMatch(html, /Show full report/, 'no cue for a short body');
  assert.ok(html.includes(escapeHtml(shortBody)), 'the full short body renders inline');
});

test('filed and dismissed cards with long bodies stay expandable', () => {
  const { render, draftRows } = makeDevChat();
  const html = render([
    draftMsg(
      { body: LONG_BODY, status: 'filed', issueUrl: 'https://github.com/x/y/issues/9', issueNumber: 9 },
      { id: 42 }
    ),
    draftMsg({ body: LONG_BODY, status: 'dismissed' }, { id: 43 }),
  ]);

  assert.match(html, /data-persist-id="42:pireport"/, 'filed card is expandable');
  assert.match(html, /data-persist-id="43:pireport"/, 'dismissed card is expandable');
  assert.match(html, /Reported: issue #9/, 'filed state still renders its link');
  assert.match(html, /Dismissed/, 'dismissed state still renders its label');
  assert.ok(draftRows().every((r) => r.action.kind !== 'buttons'),
    'no confirm/dismiss buttons on resolved cards');
  assert.doesNotMatch(html, />Dismiss</, 'and none in the markup either');
});

test('confirm/dismiss buttons still render for pending drafts with the msgId wiring', () => {
  const { render, draftRows } = makeDevChat();
  const html = render([draftMsg({ body: LONG_BODY, msgId: 42 })]);

  const [row] = draftRows();
  assert.deepEqual(row.action, { kind: 'buttons', confirmLabel: 'Report to platform' });
  assert.equal(row.msgId, 42, 'the row both buttons resolve');
  assert.match(html, /class="dc-pr-btn dc-pr-btn-promote">Report to platform</);
  assert.match(html, /class="dc-pr-btn dc-pr-btn-preview">Dismiss</);
});

test('a body containing markup is entity-escaped in both the preview and the remainder', () => {
  const { render } = makeDevChat();
  const evil = '<script>alert(1)</script>';
  // Put the injection in BOTH halves of the clip.
  const body = `${evil} ${'padding words to push the body well past the preview clip. '.repeat(8)}${evil}`;
  const html = render([draftMsg({ body })]);

  const { summary, rest } = extractParts(html);
  assert.ok(summary.includes('&lt;script&gt;'), 'preview half is escaped');
  assert.ok(rest.includes('&lt;script&gt;'), 'remainder half is escaped');
  assert.ok(!html.includes('<script>'), 'no raw script tag anywhere in the card');
});
