// The shared-spec card in the group chat — restored, and covered for the
// first time.
//
// ── What was wrong ────────────────────────────────────────────────────
//
// The card's only renderer was `GroupChat.renderSpecShareCard`, reached from
// `GroupChat.renderMessageHtml`. The transcript conversion replaced that
// pipeline with `_messageView` + features/group-chat/transcript.tsx and left
// `renderMessageHtml` with NO CALLERS — so a spec_share row rendered as
// `<div data-gc-spec-share="…"></div>`: an empty, invisible host that nothing
// filled. Sharing a spec into the chat produced a blank line.
//
// Nothing caught it. The share ENDPOINT is well covered
// (tests/spec-user-share.test.js: the share row, the notification, the WS
// push) and the card was not covered at all, so the row could vanish without
// a single assertion changing colour. This file is that missing half.
//
// Run with: node --test tests/group-chat-spec-share-card.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { renderComponent } = require('./lib/render-tsx');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';

/** group-chat.js in a vm, with just enough shimmed to evaluate it. */
function loadGroupChat() {
  const sandbox = {
    console,
    App: { user: { id: 1, username: 'admin' } },
    document: {
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
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild() {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    setTimeout, clearTimeout, setInterval, clearInterval,
    location: { search: '', hash: '', origin: 'https://sv.test' },
    URL, URLSearchParams, Date,
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/group-chat.js')}\n;globalThis.__GC = GroupChat;`, sandbox);
  return sandbox.__GC;
}

const GroupChat = loadGroupChat();

const shareMsg = (over = {}) => ({
  id: 42,
  username: 'admin',
  user_id: 1,
  created_at: '2026-06-16T18:00:00.000Z',
  msg_type: 'spec_share',
  content: 'admin shared a spec',
  metadata: {
    specShare: {
      sessionId: 5,
      version: 2,
      title: 'Sticky header',
      builtAt: '2026-06-16T17:00:00.000Z',
      prNumber: 77,
      snippet: '## Goal',
      sharedBy: { username: 'admin' },
      ...over,
    },
  },
});

const card = (msg) => renderComponent(TRANSCRIPT, 'SpecShareRow',
  { msg: GroupChat._messageView(msg) });

test('a spec_share row renders a CARD, not an empty host', () => {
  const html = card(shareMsg());
  assert.match(html, /class="gc-spec-card"/, 'the row that had gone missing');
  assert.match(html, /gc-spec-card-title">Sticky header</);
  assert.match(html, /Shared by <strong>admin<\/strong>/);
  assert.match(html, /v2/);
  assert.match(html, /PR #77/);
  assert.match(html, /View full spec/);
  // The host it replaced is gone from the tree entirely.
  assert.doesNotMatch(read(TRANSCRIPT), /data-gc-spec-share=\{/);
});

test('an older share with no title falls back to the version label', () => {
  // `metadata.specShare.title` is set by the share endpoint only when the
  // content starts with an H1; shares that predate it have none.
  const html = card(shareMsg({ title: undefined }));
  assert.match(html, /gc-spec-card-title">Spec v2</);
  assert.match(html, /data-spec-title="spec v2"/, 'and the panel preview follows it');
});

test('the optional parts are omitted, not drawn empty', () => {
  const bare = card(shareMsg({ builtAt: null, prNumber: null, snippet: null }));
  assert.doesNotMatch(bare, /gc-spec-pr/, 'no PR link without a PR number');
  assert.doesNotMatch(bare, /gc-spec-card-snippet/, 'no snippet block without a snippet');
  // …and the attribution still reads as a sentence rather than trailing a
  // dangling separator.
  assert.match(bare, /Shared by <strong>admin<\/strong> · v2<\/div>/);
});

test('the snippet is markdown when dev-chat is loaded, and text when it is not', () => {
  // This vm has no DevChat, which is the fallback path: the snippet arrives as
  // a text child and React escapes it. The markdown path is the same field
  // through `dangerouslySetInnerHTML`, chosen by the module.
  const view = GroupChat._messageView(shareMsg({ snippet: '<b>bold</b>' })).specShare;
  assert.equal(view.snippetHtml, null, 'no DevChat here');
  assert.equal(view.snippetText, '<b>bold</b>');
  const html = card(shareMsg({ snippet: '<b>bold</b>' }));
  assert.ok(!html.includes('<b>bold</b>'), 'the fallback never lands as markup');
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  // Both fields exist on the view model, and exactly one is ever set.
  assert.match(read('public/js/group-chat.js'), /snippetHtml: meta\.snippet && renderMd/);
  assert.match(read('public/js/group-chat.js'), /snippetText: meta\.snippet && !renderMd/);
});

test('a spec_share with no metadata degrades to a system line', () => {
  // Older servers, or a share whose snapshot context is missing. The row must
  // still appear rather than vanishing — which is what the string renderer's
  // `if (!meta)` branch did, and is now a `kind` the view builder never sets.
  const view = GroupChat._messageView({
    id: 43, username: 'admin', created_at: '2026-06-16T18:00:00.000Z',
    msg_type: 'spec_share', content: 'admin shared a spec', metadata: {},
  });
  assert.equal(view.kind, 'system');
  assert.equal(view.specShare, null);
  assert.equal(view.systemText, 'admin shared a spec');
});

test('View full spec owns its in-flight state, and the module owns the fetch', () => {
  const tsx = read(TRANSCRIPT);
  const row = tsx.slice(tsx.indexOf('function SpecShareRow('), tsx.indexOf('function SpecSnippet('));
  // The button's disabled/label were written onto it by a click delegate on
  // the messages container — two writes into a row React owns. They are its
  // own state now, bracketing the module's promise.
  assert.match(row, /const \[loading, setLoading\] = useState\(false\)/);
  assert.match(row, /disabled=\{loading\}/);
  assert.match(row, /\{loading \? 'Loading…' : 'View full spec'\}/);
  assert.match(row, /openSharedSpec\?\.\(spec\.sessionId, spec\.version, spec\.previewTitle\)/);

  // …and everything that is not markup stayed put: the per-app open state,
  // the fetch, and all three failure wordings.
  const gc = read('public/js/group-chat.js');
  const open = gc.slice(gc.indexOf('  async openSharedSpec('), gc.indexOf('  _specPanelRaw:'));
  assert.match(open, /_writeSpecPanelOpen\(GroupChat\.appSlug/);
  assert.match(open, /\/api\/sessions\/\$\{sessionId\}\/specs\/\$\{version\}/);
  assert.match(open, /This spec is no longer available/);
  assert.match(open, /Failed to load spec \(HTTP \$\{resp\.status\}\)/);
  assert.match(open, /Error: \$\{err\.message\}/);
  // The delegate that used to do all this is gone, along with the DOM
  // round-trip it needed to find the card's title.
  assert.doesNotMatch(gc, /_attachSpecCardHandlers\(/);
  assert.doesNotMatch(gc, /card\.dataset\.specTitle/);
});
