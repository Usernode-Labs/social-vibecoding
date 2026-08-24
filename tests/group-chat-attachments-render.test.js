// Frontend render tests for group-chat file attachments (#694):
// GroupChat._attachmentsRowHtml (the per-kind bubble row), hostile
// filename escaping, the full renderMessageHtml integration for an
// attachments-only message, and the _quoteFromRow "📎 filename"
// fallback. Loads public/js/group-chat.js into a vm sandbox with a
// minimal DOM shim (same approach as tests/group-chat-markdown.test.js
// — no markdown libs, so renderMessageBody takes its escapeHtml
// fallback path, which is fine: these tests target the attachment row,
// which renders OUTSIDE the markdown pipeline by design).
//
// Run with: node --test tests/group-chat-attachments-render.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadGroupChat() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'group-chat.js'), 'utf8');
  // createElement supports the div-trick escapeHtml: innerHTML reads back
  // the text-node escape of textContent — & < > escaped, `"` NOT escaped,
  // mirroring real browser behaviour (which is exactly why the code under
  // test must quote-escape filenames separately; see the hostile-filename
  // test below).
  const document = {
    createElement: () => {
      let text = '';
      return {
        style: {},
        set textContent(v) { text = String(v); },
        get textContent() { return text; },
        get innerHTML() {
          return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },
      };
    },
    createTextNode: (v) => ({ nodeValue: v }),
    createDocumentFragment: () => ({ childNodes: [] }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    body: { appendChild() {} },
  };
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    window: { matchMedia: () => ({ matches: false }) },
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
  const { GroupChat } = sandbox.__M;
  GroupChat.appSlug = 'demo-app';
  return GroupChat;
}

const ID = (c) => c.repeat(32);

function rowFor(atts) {
  return { id: 9, metadata: { attachments: atts } };
}

test('image attachments render an inline thumbnail linking to full size', () => {
  const GroupChat = loadGroupChat();
  const html = GroupChat._attachmentsRowHtml(rowFor([
    { id: ID('a'), kind: 'image', filename: 'shot.png', sizeBytes: 1234 },
  ]));
  assert.match(html, /class="dc-msg-attachments"/);
  assert.match(html, /<img class="dc-msg-att-img" src="\/api\/apps\/demo-app\/chat-attachments\/a{32}"/);
  assert.match(html, /<a href="\/api\/apps\/demo-app\/chat-attachments\/a{32}" target="_blank" rel="noopener"/);
});

test('markdown attachments render a viewer chip plus a download link', () => {
  const GroupChat = loadGroupChat();
  const html = GroupChat._attachmentsRowHtml(rowFor([
    { id: ID('b'), kind: 'markdown', filename: 'notes.md', sizeBytes: 45 },
  ]));
  assert.match(html, /data-att-md="\/api\/apps\/demo-app\/chat-attachments\/b{32}"/);
  assert.match(html, />MD</, 'kind badge');
  assert.match(html, /download="notes.md"/);
});

test('html attachments render a sandboxed Preview link and a download link', () => {
  const GroupChat = loadGroupChat();
  const html = GroupChat._attachmentsRowHtml(rowFor([
    { id: ID('c'), kind: 'html', filename: 'page.html', sizeBytes: 512 },
  ]));
  assert.match(html, /href="\/api\/apps\/demo-app\/chat-attachments\/c{32}\/view" target="_blank" rel="noopener"/);
  assert.match(html, />Preview</);
  assert.match(html, /download="page.html"/);
  assert.ok(!/<iframe/.test(html), 'HTML is never embedded inline in the chat DOM');
});

test('text and binary attachments render download chips with name + size', () => {
  const GroupChat = loadGroupChat();
  const html = GroupChat._attachmentsRowHtml(rowFor([
    { id: ID('d'), kind: 'text', filename: 'a.txt', sizeBytes: 2048 },
    { id: ID('e'), kind: 'binary', filename: 'blob.bin', sizeBytes: 3 * 1024 * 1024 },
  ]));
  assert.match(html, /download="a.txt"/);
  assert.match(html, /2 KB/);
  assert.match(html, />BIN</);
  assert.match(html, /3\.0 MB/);
});

test('hostile filenames are escaped and bad ids are dropped', () => {
  const GroupChat = loadGroupChat();
  const html = GroupChat._attachmentsRowHtml(rowFor([
    { id: ID('f'), kind: 'text', filename: '<img src=x onerror=alert(1)>.txt', sizeBytes: 1 },
    { id: 'not-a-hex-id', kind: 'image', filename: 'x.png', sizeBytes: 1 },
    { id: `../..${ID('0')}`, kind: 'image', filename: 'y.png', sizeBytes: 1 },
  ]));
  assert.ok(!/<img src=x onerror/.test(html), 'filename markup neutralized (no raw tag)');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'renders as escaped text');
  assert.equal((html.match(/chat-attachments\//g) || []).length, 1, 'only the valid id rendered');
});

test('a double-quoted filename cannot break out of an attribute', () => {
  const GroupChat = loadGroupChat();
  const html = GroupChat._attachmentsRowHtml(rowFor([
    { id: ID('f'), kind: 'text', filename: 'x" onmouseover="alert(1)".txt', sizeBytes: 1 },
  ]));
  assert.ok(!/" onmouseover="/.test(html), 'quote escaped in attribute context');
  assert.match(html, /&quot; onmouseover=/);
});

test('no attachments (or foreign metadata) renders nothing', () => {
  const GroupChat = loadGroupChat();
  assert.equal(GroupChat._attachmentsRowHtml({ id: 1, metadata: {} }), '');
  assert.equal(GroupChat._attachmentsRowHtml({ id: 1, metadata: { attachments: [] } }), '');
  assert.equal(GroupChat._attachmentsRowHtml({ id: 1 }), '');
});

// The row's HOST, not the bubbles: the attachment strip is filled in place by
// `_renderMessageAttachments` after the row exists, so what the transcript has
// to get right is that a file-only message still emits a body AND the host.
// This was `renderMessageHtml`, which the transcript conversion retired; the
// same contract is now `_messageView`'s `hasAttachments` and the component's
// `[data-gc-attachments]`.
test('a file-only message still carries a body and the attachments host', () => {
  const GroupChat = loadGroupChat();
  const view = GroupChat._messageView({
    id: 9, userId: 2, username: 'bob', content: '',
    msgType: 'message', createdAt: '2026-07-20T12:00:00.000Z',
    metadata: { attachments: [{ id: ID('a'), kind: 'image', filename: 'shot.png', sizeBytes: 10 }] },
  });
  assert.equal(view.kind, 'message');
  assert.equal(view.hasAttachments, true, 'the host is emitted for this row');
  const tsx = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/group-chat/transcript.tsx'), 'utf8');
  assert.match(tsx, /msg\.hasAttachments \? <div data-gc-attachments=\{msg\.id \?\? ''\} \/> : null/);
  assert.match(tsx, /className="gc-msg-content"/, 'and the body it hangs under');
});

test('_quoteFromRow falls back to the 📎-filename snippet for a file-only message', () => {
  const GroupChat = loadGroupChat();
  const row = {
    dataset: { msgId: '42', username: 'bob' },
    classList: { contains: () => false },
    querySelector: (sel) => {
      if (sel === '.gc-msg-content') return { textContent: '  ' };
      return { textContent: 'notes.md', getAttribute: () => null };
    },
  };
  const quote = GroupChat._quoteFromRow(row);
  assert.equal(quote.source, 'message');
  assert.equal(quote.snippet, '\u{1F4CE} notes.md');
  assert.equal(quote.author, 'bob');
});
