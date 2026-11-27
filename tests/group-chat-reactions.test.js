// Reactions on a group chat message: the pills under a row, and the unread
// dot beside its name.
//
// ── Why this file is new ──────────────────────────────────────────────
//
// Both of these survived the transcript's conversion to React by looking
// right and doing nothing, and neither had a test that could have said so:
//
//   * A pill's click called `GroupChat.toggleReaction`, which does not exist
//     — the module's method is `sendReact`. Clicking your own reaction to
//     take it back, or someone else's to join it, was a no-op. The delegated
//     branch it replaced dispatched on `.gc-react-pill`, a class the reskin
//     retired, so nothing caught the pill on the way past either.
//   * "Yours" was `.gc-react-mine` in app.css: an accent BORDER over a pill
//     whose border width is zeroed by Tailwind's preflight, and a background
//     Tailwind's own `bg-zinc-100` then won on the cascade (app.css loads
//     before tailwind.css, deliberately). It rendered nothing at all.
//   * The unread dot's two paths — clear-one and reconcile-from-notifications
//     — still looked for `[data-unread-dot]`, an attribute React does not
//     render, and the reconcile path then `insertAdjacentHTML`'d a dot into a
//     row React owns. So a dot never cleared, and a newly-arrived mention
//     either did nothing or wrote into somebody else's subtree.
//
// Run with: node --test tests/group-chat-reactions.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const { loadTsx, renderComponent, renderToHtml, createElement } = require('./lib/render-tsx');

const TRANSCRIPT = 'frontend/src/features/group-chat/transcript.tsx';
const FEED = 'frontend/@/components/ui/feed.tsx';

const reaction = (emoji, mine, users = ['bob']) => ({ emoji, count: users.length, users, mine });
const REACTIONS = 'frontend/src/features/message-actions/reactions.tsx';
// A row of the transcript, carrying what the view model gives it.
const row = (reactions) => ({
  id: 7, kind: 'message', username: 'bob', senderId: 2, time: '10:00', timeTitle: 'Nov 1, 2026, 10:00 AM', at: '2026-11-01T10:00:00Z',
  bodyHtml: '<p>hi</p>', text: 'hi', mine: false, unread: false, bookmarked: false, reactions, quote: null,
  editedTitle: null, attachments: [], voteRowClass: '', specShare: null,
});

// ── The pills ─────────────────────────────────────────────────────────
//
// Dedupe step 2: the pills are the one reaction chip every message row
// draws (../message-actions/reactions.tsx MessageReactions, the feed
// primitive's ReactionPill), in Messages' own container under a person's
// message; the old `Reactions` here and its always-present empty container
// are gone with the transcript's own row.

test('one pill per reaction, carrying its emoji, count and who', () => {
  const html = renderComponent(TRANSCRIPT, 'MessageRow', {
    msg: row([reaction('👍', false, ['bob', 'carol']), reaction('🎉', true, ['alice'])]),
  });
  const pills = html.slice(html.indexOf('<div class="messages-reactions">'));
  assert.ok(pills.length > 0, 'the row draws the shared chip in Messages\' container');
  assert.equal((pills.match(/<button type="button" class="inline-flex[^"]*rounded-full/g) || []).length, 2);
  assert.match(pills, /data-emoji="👍"/);
  assert.match(pills, /data-emoji="🎉"/);
  assert.match(pills, /title="bob, carol"/);
  // The count rides beside the emoji, the emoji is aria-hidden, and the
  // chip's name says both in words.
  assert.match(pills, /aria-label="thumbs up: 2 reactions"/);
  assert.match(pills, /<span aria-hidden="true">👍<\/span><span>2<\/span>/);
});

test('a row with no reactions draws no reaction row', () => {
  const html = renderComponent(TRANSCRIPT, 'MessageRow', { msg: row([]) });
  assert.doesNotMatch(html, /messages-reactions|gc-reactions/);
});

test('"yours" is a visible state, in both themes', () => {
  const html = renderComponent(REACTIONS, 'MessageReactions', {
    className: 'messages-reactions',
    reactions: [reaction('👍', false), reaction('🎉', true, ['alice'])],
  });
  const [theirs, mine] = html.split('<button').slice(1);
  assert.ok(theirs.includes('data-emoji="👍"') && mine.includes('data-emoji="🎉"'));

  // Not merely "different classes": the ground and the ink both move to the
  // accent ramp, and each has a dark counterpart. `.gc-react-mine` — the
  // border-only rule this replaces — is gone from app.css entirely.
  assert.match(mine, /bg-violet-100/);
  assert.match(mine, /text-violet-700/);
  assert.match(mine, /dark:bg-violet-950/);
  assert.match(mine, /dark:text-violet-300/);
  assert.match(mine, /aria-pressed="true"/);
  assert.ok(!theirs.includes('violet'), 'someone else’s pill stays neutral');
  assert.match(theirs, /bg-zinc-100/);
  assert.match(theirs, /dark:bg-zinc-800/);

  assert.doesNotMatch(read('public/css/app.css'), /^\.gc-react-mine\s*\{/m);
  assert.doesNotMatch(read('public/css/app.css'), /^\.gc-react-pill/m);
});

test('the accent tone corrects its own hover ink', () => {
  // Accent ink on the light hover ground is 3.86:1 without the correction.
  const html = renderToHtml(createElement(
    loadTsx(FEED).ReactionPill,
    { emoji: '👍', count: 1, tone: 'accent' },
  ));
  assert.match(html, /hover:bg-violet-200/);
  assert.match(html, /hover:text-violet-800/);
  assert.match(html, /dark:hover:bg-violet-900/);

  // Every class in the table is a complete literal — Tailwind's extractor is
  // a regex over source text, so a computed one compiles to nothing.
  const feed = read(FEED);
  const table = feed.slice(feed.indexOf('tone: {'), feed.indexOf('},', feed.indexOf('tone: {')));
  assert.doesNotMatch(table, /\$\{/, 'no interpolation inside the variant table');
});

test('clicking a pill calls the method the module actually has', () => {
  // The bug this pins: `toggleReaction` does not exist on GroupChat, so the
  // handler was a no-op that type-checked and rendered fine. A pill's tap is
  // the row's `toggleReaction`, the shared controls' react act, which the
  // transcript wires to `sendReact`.
  const { MessageReactions } = loadTsx(REACTIONS);
  const calls = [];
  // Drawn inside a render (the chip reads its words with a hook), and its
  // element kept, so its taps can be made for real.
  let element = null;
  const Probe = () => {
    element = MessageReactions({
      className: 'gc-reactions',
      reactions: [reaction('👍', false), reaction('🎉', true, ['alice'])],
      onToggle: (emoji) => calls.push(emoji),
    });
    return null;
  };
  renderToHtml(createElement(Probe));
  const pills = element.props.children;
  assert.equal(pills.length, 2);
  for (const pill of pills) pill.props.onClick();
  assert.deepEqual(calls, ['👍', '🎉']);

  const transcript = read(TRANSCRIPT);
  assert.match(transcript, /react: \(emoji\) => chat\?\.sendReact\?\.\(id, emoji\)/);
  assert.match(transcript, /<MessageReactions className="messages-reactions" reactions=\{msg\.reactions\} onToggle=\{controls\.toggleReaction\} \/>/);

  // …and the method it names is a real one, fire-and-forget over the socket.
  assert.match(read('public/js/group-chat.js'), /\n {2}sendReact\(messageId, emoji\) \{/);
  assert.doesNotMatch(read('public/js/group-chat.js'), /\n {2}toggleReaction\(/);
});

// ── The unread dot ────────────────────────────────────────────────────

// group-chat.js is a classic script with no exports; load it into a vm with
// enough of a window to answer, and record every DOM lookup it makes.
function loadGroupChat({ notifications = [], messages = [] } = {}) {
  const lookups = [];
  const document = {
    createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, addEventListener() {}, appendChild() {} }),
    getElementById: (id) => { lookups.push(`#${id}`); return null; },
    querySelector: (sel) => { lookups.push(sel); return null; },
    querySelectorAll: (sel) => { lookups.push(sel); return []; },
    addEventListener() {},
    body: { appendChild() {} },
  };
  const patches = [];
  const sandbox = {
    location: { search: '', protocol: 'http:', host: 'localhost' },
    URLSearchParams,
    document,
    navigator: {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    App: { user: { id: 1, username: 'alice' } },
    fetch: () => Promise.resolve({ ok: false }),
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, JSON,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.Notifications = { items: notifications, refresh() {} };
  sandbox.UsernodeReact = {
    groupChat: { patchTranscriptMessage: (id, patch) => patches.push([id, patch]) },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${read('public/js/group-chat.js')}\nglobalThis.__M = { GroupChat };`, sandbox);
  const { GroupChat } = sandbox.__M;
  GroupChat.messages = messages;
  lookups.length = 0; // ignore whatever module setup looked at
  // The patch objects are the sandbox realm's, so `deepEqual` would compare
  // their prototypes and not their contents. Cross the realm once, here.
  const seen = () => JSON.parse(JSON.stringify(patches));
  return { GroupChat, patches, seen, lookups };
}

test('clearing one dot patches the row instead of removing a node', () => {
  const { GroupChat, patches, seen, lookups } = loadGroupChat({
    messages: [{ id: 42, has_unread_notification: true }],
  });
  GroupChat._clearMessageDot(42);
  assert.deepEqual(seen(), [[42, { unread: false }]]);
  assert.equal(GroupChat.messages[0].has_unread_notification, false);
  assert.ok(!lookups.some((s) => s.includes('unread-dot')),
    'nothing goes looking for the span React renders');

  // A message with no dot is left alone — no patch, no request.
  patches.length = 0;
  GroupChat._clearMessageDot(42);
  assert.deepEqual(seen(), []);
});

test('reconciling from the notification list patches both directions', () => {
  const { GroupChat, patches, seen, lookups } = loadGroupChat({
    notifications: [
      { kind: 'mention', chatMessageId: 1, readAt: null },      // → dotted
      { kind: 'reaction', chatMessageId: 2, readAt: '2026-01-01' }, // → cleared
      { kind: 'chat', chatMessageId: 3, readAt: null },          // wrong kind
    ],
    messages: [
      { id: 1, has_unread_notification: false },
      { id: 2, has_unread_notification: true },
      { id: 3, has_unread_notification: false },
      { id: 4, has_unread_notification: true }, // unreferenced — untouched
    ],
  });
  GroupChat.reconcileDotsFromNotifications();
  assert.deepEqual(seen(), [[1, { unread: true }], [2, { unread: false }]]);
  assert.deepEqual(GroupChat.messages.map((m) => !!m.has_unread_notification),
    [true, false, false, true]);
  assert.deepEqual(lookups, [], 'the DOM is never consulted');

  // Idempotent: a second pass with nothing changed publishes nothing.
  patches.length = 0;
  GroupChat.reconcileDotsFromNotifications();
  assert.deepEqual(seen(), []);
});

test('the dot itself is rendered, and the module no longer spells it', () => {
  const dotted = renderComponent(TRANSCRIPT, 'MessageRow', {
    msg: {
      id: 5, kind: 'message', username: 'bob', time: '10:00', bodyHtml: 'hi',
      mine: false, unread: true, bookmarked: false, reactions: [], quote: null,
      editedTitle: null, attachments: [], voteRowClass: '', specShare: null,
    },
  });
  assert.match(dotted, /<span class="gc-unread-dot" aria-label="Unread mention"><\/span>/);

  const gcJs = read('public/js/group-chat.js');
  const code = gcJs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /_unreadDotHtml/, 'the string renderer is gone, not spare');
  assert.doesNotMatch(code, /insertAdjacentHTML\([^)]*_unreadDotHtml/);
});
