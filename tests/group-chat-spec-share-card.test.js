const { englishUiSource } = require("./lib/english-ui-source");
const { withLanguage } = require("./lib/platform-language");
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

/**
 * group-chat.js in a vm, with just enough shimmed to evaluate it. `over`
 * replaces any of the shims (a document with elements in it, a fetch that
 * answers, the React bridge).
 */
function loadGroupChat(over = {}) {
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
    ...over,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(withLanguage(sandbox));
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
  assert.match(englishUiSource(row), /const \[loading, setLoading\] = useState\(false\)/);
  assert.match(englishUiSource(row), /disabled=\{loading\}/);
  assert.match(englishUiSource(row), /\{loading \? 'Loading…' : 'View full spec'\}/);
  assert.match(englishUiSource(row), /openSharedSpec\?\.\(spec\.sessionId, spec\.version, spec\.previewTitle\)/);

  // …and everything that is not markup stayed put: the per-app open state,
  // the fetch, and all three failure wordings.
  const gc = read('public/js/group-chat.js');
  const open = gc.slice(gc.indexOf('  async openSharedSpec('), gc.indexOf('  _specPanelRaw:'));
  assert.match(englishUiSource(open), /_writeSpecPanelOpen\(GroupChat\.appSlug/);
  assert.match(englishUiSource(open), /\/api\/sessions\/\$\{sessionId\}\/specs\/\$\{version\}/);
  assert.match(englishUiSource(open), /This spec is no longer available/);
  assert.match(englishUiSource(open), /Failed to load spec \(HTTP \$\{resp\.status\}\)/);
  assert.match(englishUiSource(open), /Error: \$\{err\.message\}/);
  // The delegate that used to do all this is gone, along with the DOM
  // round-trip it needed to find the card's title.
  assert.doesNotMatch(englishUiSource(gc), /_attachSpecCardHandlers\(/);
  assert.doesNotMatch(englishUiSource(gc), /card\.dataset\.specTitle/);
});

// ── #3495: "View full spec" did nothing in a request's Discussion ─────────
//
// The Homeroom bot posts its spec as this card into a request's thread and
// into its proposal's, and a person's share can land there too. Both
// Discussions are threads in the Dev topic frame. The button calls
// `GroupChat.openSharedSpec`, which fills `#gc-spec-side-panel` and returns
// early when that slot is not in the document, and the slot was only in the
// general chat pane. So the button showed "Loading…" for a moment and then
// nothing happened, on every card in every request's and proposal's
// Discussion. The frame carries the general chat's row now.

const TOPIC_FRAME = 'frontend/src/features/dev-board/topic-frame.tsx';
const GENERAL_CHAT = 'frontend/src/features/group-chat/general-chat.tsx';

test('the topic frame carries the spec panel slot, as the general chat pane does', () => {
  const topic = renderComponent(TOPIC_FRAME, 'DevTopicSubView', {});
  const chat = renderComponent(GENERAL_CHAT, 'GeneralChat',
    { introAppName: null, readOnly: true, notice: null, maxLength: 4000 });

  // The general chat's row ends with the divider and the panel. That tail is
  // what app.css lays out (docked at 1024px and up, over the row below) and
  // what group-chat.js looks up by id, so the topic frame ends with it too.
  const at = chat.indexOf('<div id="gc-spec-resizer"');
  assert.ok(at > 0, 'the general chat pane still has its divider');
  const tail = chat.slice(at);
  assert.match(tail, /^<div id="gc-spec-resizer" class="gc-spec-resizer"[^>]*><\/div><div id="gc-spec-side-panel" class="gc-spec-side-panel"><\/div><\/div><\/div>$/);
  assert.ok(topic.endsWith(tail),
    'the topic frame ends with the same divider and panel, closing the same row');

  // …in the same kind of row, beside the topic's own host, which can shrink
  // to make room for the panel instead of pushing it off screen.
  assert.match(topic, /^<div class="flex flex-col h-full min-h-0 dc-lift dc-lift-strip"><div class="gc-tab-body flex-1 flex min-h-0"><div id="dev-topic-thread" class="flex-1 min-w-0 min-h-0">/);
  assert.match(chat, /<div class="gc-tab-body flex-1 flex min-h-0">/);
  // One slot per frame: the lookup is by id.
  assert.equal(topic.split('id="gc-spec-side-panel"').length, 2);
  assert.equal(topic.split('id="gc-spec-resizer"').length, 2);
});

/** A DOM element with just what the spec panel code touches. */
function fakeEl() {
  const classes = new Set();
  const listeners = {};
  return {
    style: {},
    dataset: {},
    classes,
    listeners,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
    getBoundingClientRect: () => ({ width: 560 }),
  };
}

test('View full spec opens the panel wherever the slot is, and binds its divider', async () => {
  // The topic frame never runs `GroupChat.mount`, which is where the general
  // chat binds the divider; opening the panel binds it instead.
  const panel = fakeEl();
  const handle = fakeEl();
  const ids = { 'gc-spec-side-panel': panel, 'gc-spec-resizer': handle };
  const published = [];
  const mounted = [];
  const fetched = [];
  const GC = loadGroupChat({
    document: {
      getElementById: (id) => ids[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      body: { appendChild() {}, style: {} },
    },
    fetch: async (url) => {
      fetched.push(url);
      return {
        ok: true,
        json: async () => ({ spec: { content: '# Hourly feed refresh\n\nFeeds refresh.', built_at: null, pr_number: null } }),
      };
    },
    UsernodeReact: {
      groupChat: {
        mountSpecPanel: (host) => mounted.push(host),
        publishSpecPanel: (state) => published.push(state),
      },
    },
  });

  await GC.openSharedSpec(7, 3, 'Hourly feed refresh');

  assert.deepEqual(fetched, ['/api/sessions/7/specs/3']);
  assert.equal(mounted[0], panel, 'the reader is mounted into the slot it found');
  const last = published[published.length - 1];
  assert.equal(last.open, true);
  assert.equal(last.title, 'Hourly feed refresh');
  assert.equal(last.subtitle, 'v3');
  assert.ok(panel.classes.has('gc-spec-side-panel-open'), 'the host is marked open');
  assert.ok(handle.classes.has('gc-spec-resizer-open'), 'and so is its divider');
  assert.equal((handle.listeners.pointerdown || []).length, 1, 'the divider drags');

  // Opening a second spec does not bind the divider twice.
  await GC.openSharedSpec(7, 4, 'Hourly feed refresh');
  assert.equal(handle.listeners.pointerdown.length, 1);
});
