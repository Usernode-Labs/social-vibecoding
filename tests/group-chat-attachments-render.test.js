// Frontend render tests for group-chat file attachments (#694): the per-kind
// bubble row, hostile filename escaping, the file-only message, and the
// _quoteFromRow "📎 filename" fallback.
//
// ── The row was empty, and this file said it was fine ──────────────────
//
// These assertions used to run against `GroupChat._attachmentsRowHtml`, an
// HTML string. The transcript's conversion to React left that method with no
// callers and put a bare `[data-gc-attachments]` host in its place — which
// nothing ever filled. So a message with files rendered an empty div, while
// every test here went on passing against a renderer no longer wired to
// anything, and the one integration test asserted the EMPTY HOST was present.
// That is the same failure the spec-share card had.
//
// So the split is now explicit and each half is checked where it lives: the
// module resolves the files (the app slug, the 32-hex id check, the sizes and
// the badges) in `_attachmentsView`, and features/group-chat/transcript.tsx's
// `Attachments` draws them. The module half still loads public/js/group-chat.js
// into a vm sandbox with a minimal DOM shim; the markup half renders the
// component for real.
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

const { renderComponent } = require('./lib/render-tsx');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';

const ID = (c) => c.repeat(32);

function rowFor(atts) {
  return { id: 9, metadata: { attachments: atts } };
}

// The two halves, run end to end: resolve in the module, draw in the
// component. Every assertion below is against what a reader would actually
// see, which is what the string-renderer version stopped being.
function renderAttachments(GroupChat, atts) {
  return renderComponent(TRANSCRIPT, 'Attachments', {
    items: JSON.parse(JSON.stringify(GroupChat._attachmentsView(rowFor(atts)))),
  });
}

test('image attachments render an inline thumbnail linking to full size', () => {
  const GroupChat = loadGroupChat();
  const html = renderAttachments(GroupChat, [
    { id: ID('a'), kind: 'image', filename: 'shot.png', sizeBytes: 1234 },
  ]);
  assert.match(html, /class="dc-msg-attachments"/);
  assert.match(html, /<img class="dc-msg-att-img" src="\/api\/apps\/demo-app\/chat-attachments\/a{32}"/);
  assert.match(html, /<a href="\/api\/apps\/demo-app\/chat-attachments\/a{32}" target="_blank" rel="noopener"/);
});

test('markdown attachments render a viewer chip plus a download link', () => {
  const GroupChat = loadGroupChat();
  const html = renderAttachments(GroupChat, [
    { id: ID('b'), kind: 'markdown', filename: 'notes.md', sizeBytes: 45 },
  ]);
  assert.match(html, /data-att-md="\/api\/apps\/demo-app\/chat-attachments\/b{32}"/);
  assert.match(html, />MD</, 'kind badge');
  assert.match(html, /download="notes.md"/);
});

test('html attachments render a sandboxed Preview link and a download link', () => {
  const GroupChat = loadGroupChat();
  const html = renderAttachments(GroupChat, [
    { id: ID('c'), kind: 'html', filename: 'page.html', sizeBytes: 512 },
  ]);
  assert.match(html, /href="\/api\/apps\/demo-app\/chat-attachments\/c{32}\/view" target="_blank" rel="noopener"/);
  assert.match(html, />Preview</);
  assert.match(html, /download="page.html"/);
  assert.ok(!/<iframe/.test(html), 'HTML is never embedded inline in the chat DOM');
});

test('text and binary attachments render download chips with name + size', () => {
  const GroupChat = loadGroupChat();
  const html = renderAttachments(GroupChat, [
    { id: ID('d'), kind: 'text', filename: 'a.txt', sizeBytes: 2048 },
    { id: ID('e'), kind: 'binary', filename: 'blob.bin', sizeBytes: 3 * 1024 * 1024 },
  ]);
  assert.match(html, /download="a.txt"/);
  assert.match(html, /2 KB/);
  assert.match(html, />BIN</);
  assert.match(html, /3\.0 MB/);
});

test('hostile filenames are escaped and bad ids are dropped', () => {
  const GroupChat = loadGroupChat();
  const html = renderAttachments(GroupChat, [
    { id: ID('f'), kind: 'text', filename: '<img src=x onerror=alert(1)>.txt', sizeBytes: 1 },
    { id: 'not-a-hex-id', kind: 'image', filename: 'x.png', sizeBytes: 1 },
    { id: `../..${ID('0')}`, kind: 'image', filename: 'y.png', sizeBytes: 1 },
  ]);
  assert.ok(!/<img src=x onerror/.test(html), 'filename markup neutralized (no raw tag)');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'renders as escaped text');
  assert.equal((html.match(/chat-attachments\//g) || []).length, 1, 'only the valid id rendered');
});

test('a double-quoted filename cannot break out of an attribute', () => {
  const GroupChat = loadGroupChat();
  const html = renderAttachments(GroupChat, [
    { id: ID('f'), kind: 'text', filename: 'x" onmouseover="alert(1)".txt', sizeBytes: 1 },
  ]);
  assert.ok(!/" onmouseover="/.test(html), 'quote escaped in attribute context');
  assert.match(html, /&quot; onmouseover=/);
});

test('no attachments (or foreign metadata) renders nothing', () => {
  const GroupChat = loadGroupChat();
  // (Lengths, not deepEqual: the arrays come back from the vm's realm.)
  assert.equal(GroupChat._attachmentsView({ id: 1, metadata: {} }).length, 0);
  assert.equal(GroupChat._attachmentsView({ id: 1, metadata: { attachments: [] } }).length, 0);
  assert.equal(GroupChat._attachmentsView({ id: 1 }).length, 0);
  // …and an empty list draws no container at all, not an empty one.
  assert.equal(renderComponent(TRANSCRIPT, 'Attachments', { items: [] }), '');
});

// The whole row, not just the chips: a message with nothing but a file still
// has to draw its body node AND its files. This is the assertion that used to
// pass against an empty `[data-gc-attachments]` host — it renders the row now,
// so it can only pass if the files are actually on screen.
test('a file-only message carries a body and its files', () => {
  const GroupChat = loadGroupChat();
  const view = JSON.parse(JSON.stringify(GroupChat._messageView({
    id: 9, userId: 2, username: 'bob', content: '',
    msgType: 'message', createdAt: '2026-07-20T12:00:00.000Z',
    metadata: { attachments: [{ id: ID('a'), kind: 'image', filename: 'shot.png', sizeBytes: 10 }] },
  })));
  assert.equal(view.kind, 'message');
  assert.equal(view.attachments.length, 1, 'the module resolved the file');

  const html = renderComponent(TRANSCRIPT, 'MessageRow', { msg: view });
  assert.match(html, /class="gc-msg-content"/, 'the body node is there for an empty message');
  assert.match(html, /class="dc-msg-attachments"/);
  assert.match(html, /<img class="dc-msg-att-img" src="\/api\/apps\/demo-app\/chat-attachments\/a{32}"/);
  // The two hooks `_quoteFromRow` reads to caption a reply to a file-only
  // message: `.dc-attach-name` inside `.dc-msg-attachments`, or an image alt.
  assert.match(html, /alt="shot.png"/);
  assert.match(
    renderAttachments(GroupChat, [{ id: ID('b'), kind: 'text', filename: 'notes.txt', sizeBytes: 1 }]),
    /class="dc-attach-name">notes.txt</,
  );
});

test('a thumbnail whose bytes are gone degrades to a chip, in React', () => {
  // Staging clones copy chat_messages but not attachment blobs, so this is a
  // routine state, not an edge case. It used to be `_attImgError` rewriting
  // the anchor's className and textContent — a write into a row React owns.
  const tsx = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/group-chat/transcript.tsx'), 'utf8');
  assert.match(tsx, /onError=\{\(\) => setBroken\(true\)\}/);
  assert.match(tsx, /className="dc-msg-att-chip">\s*\{`🖼 \$\{att\.name\}`\}/);
  const gcJs = fs.readFileSync(
    path.join(__dirname, '..', 'public/js/group-chat.js'), 'utf8');
  const code = gcJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /_attImgError/, 'the in-place rewrite is gone, not spare');
  assert.doesNotMatch(code, /_attachmentsRowHtml/, 'and so is the string renderer');
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
