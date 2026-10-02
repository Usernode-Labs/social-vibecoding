'use strict';

// The bell rows about an app's general discussion open the project page's
// DISCUSSION TAB (#3653), through the same door Recents presses (#3555): the
// side panel when an app is running beside it, then the page itself —
// AppView._landOnTab, which writes the remembered tab — then the workshop
// address as the fallback for a shell still starting. Homeroom's app-chat
// room is the exception: its Discussion tab embeds #general, not this room,
// so it keeps the Messages address, exactly like its Recents row.
//
// A mention, a reply or a reaction in an app's chat, and a message saved from
// it, opened the old full-screen `#app/<slug>/dev/chat` — a screen root of its
// own whose back arrow climbed to the app's Workshop, a screen the reader had
// never been on. The discussion became a thread of Messages (#2718 review,
// #2763), and now it is the project page's own Discussion tab again (#3653):
// the door Recents presses (#3555), the side panel taking it beside a running
// app. When the row names ONE message, GroupChat is asked to bring it into
// view as the discussion opens (see tests/group-chat-reveal-message.test.js
// for that half).
//
// And the "New issue #N" row opens ISSUE #N — it fell through to the chat.
//
// The REAL shipped notifications.js runs in a vm; the bundle's two imports
// are stood in for (the timestamp helper as before, and the platform-slug
// reader with the one line it is — the stub it reads is what the test sets),
// as the other notifications tests do.
//
// Run with: node --test tests/notifications-app-discussion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8',
).replace(/^import \{.*?\n/gm, '');
let platformSlugStub;

function load({ controller = true, groupChat = true, panelTakes = true } = {}) {
  const calls = [];
  const location = { search: '', hash: '' };
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams, location,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      title: '',
      getElementById: () => null,
      addEventListener: () => {},
      querySelectorAll: () => ({ forEach: () => {} }),
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    PlatformUI: { isTouch: () => false, toast() {} },
    App: {
      user: { id: 1 },
      openAppTab: (slug, tab, opts) => { calls.push(['openAppTab', slug, tab, opts || null]); },
      _isScreenVisible: () => false,
    },
    // The platform project's slug, read the way the real page reads it
    // (features/app-context/platform-target.js publishes window.PlatformTarget).
    PlatformTarget: { slug: () => platformSlugStub ?? null },
  };
  // The import stood in for: the platform project's slug, read the way the
  // real page reads it (see the PlatformTarget stub above).
  sandbox.platformSlug = () => sandbox.PlatformTarget.slug();
  sandbox.AppView = {
    _landOnTab: (slug, tab) => { calls.push(['land', slug, tab]); },
  };
  sandbox.UsernodeReact = {
    sidePanel: {
      take: (route, hint) => {
        calls.push(['panel', route, hint || null]);
        return panelTakes;
      },
    },
  };
  if (controller) {
    sandbox.UsernodeReact.messages = {
      openDiscussion: (slug) => calls.push(['discussion', slug]),
      open: (id) => calls.push(['conversation', id]),
      openAddress: (href) => calls.push(['address', href]),
    };
  }
  if (groupChat) {
    // A classic-script global lexical binding in the page: notifications.js
    // reaches it by a bare reference behind a typeof guard.
    sandbox.GroupChat = { revealMessage: (slug, id) => calls.push(['reveal', slug, id]) };
  }
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  vm.runInContext(SRC, sandbox);
  const N = sandbox.Notifications;
  N._renderBadge = () => {};
  N.refresh = async () => true;
  N._markOneRead = () => {};
  N._dismissSheetForNav = () => calls.push(['dismiss']);
  return { N, calls, location };
}

const row = (over) => ({ id: 1, readAt: null, appSlug: 'garden-ab12', ...over });
// Through JSON: the router's option objects are made in the vm's realm.
const nav = (calls) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] !== 'dismiss')));

for (const kind of ['mention', 'reply', 'reaction']) {
  test(`a ${kind} in an app's chat opens the project page's Discussion tab, on that message`, () => {
    const { N, calls } = load();
    N.items = [row({ kind, chatMessageId: 5552 })];
    N._onItemClick(1);
    assert.deepEqual(nav(calls), [['reveal', 'garden-ab12', 5552], ['panel', 'app/garden-ab12/workshop',
      { discussionHint: { slug: 'garden-ab12', messageId: 5552 } }]],
      'the message is named for the panel, and the route is the panel page — never the old full-screen chat');
    assert.equal(calls[0][0], 'dismiss', 'and the sheet is out of the way first (#1329)');
  });
}

// #2387: a message in a REPLY thread opens that thread beside the channel —
// at the address the server put on the row, or the one its ref spells when an
// older server sent none.
test('a thread reply opens its reply thread in Messages', () => {
  const { N, calls } = load();
  N.items = [row({ kind: 'thread_reply', chatMessageId: 88, threadType: 'message', threadRef: '70',
    href: '#messages/app/garden-ab12/thread/70' })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['address', '#messages/app/garden-ab12/thread/70']]);
  assert.equal(N._rowView({ ...N.items[0], createdAt: new Date().toISOString() }).label, 'Replied in thread');
});

test('a mention inside a reply thread opens the thread too, even without an href', () => {
  const { N, calls } = load();
  N.items = [row({ kind: 'mention', chatMessageId: 88, threadType: 'message', threadRef: '70' })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['address', '#messages/app/garden-ab12/thread/70']]);
});

test('a mention inside a topic thread still opens that topic, where the message is', () => {
  const { N, calls } = load();
  N.items = [row({ kind: 'mention', chatMessageId: 9, threadType: 'issue', threadRef: '44' })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['openAppTab', 'garden-ab12', 'dev', { subTab: 'topic', ref: { kind: 'issue', id: 44 } }]]);
});

test('the other rows that landed on the app chat land on the project page\'s Discussion tab too', () => {
  // The weekly card is a chat message; an app-health or a deletion-attempt
  // row has no page of its own and fell through to the chat. Its address is
  // the discussion's now — with nothing to reveal when the row names no message.
  for (const kind of ['weekly_digest', 'app_health', 'app_delete_attempted']) {
    const { N, calls } = load();
    N.items = [row({ kind })];
    N._onItemClick(1);
    assert.deepEqual(nav(calls), [['panel', 'app/garden-ab12/workshop',
      { discussionHint: { slug: 'garden-ab12', messageId: null } }]], kind);
  }
});

test('"New issue #N" opens issue #N, not the app chat', () => {
  const { N, calls } = load();
  N.items = [row({ kind: 'issue_opened', detail: '12' })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['openAppTab', 'garden-ab12', 'dev', { subTab: 'issues', ref: 12 }]]);
  // A row with no number to open has no better page than the discussion.
  const other = load();
  other.N.items = [row({ kind: 'issue_opened', detail: null })];
  other.N._onItemClick(1);
  assert.deepEqual(nav(other.calls), [['panel', 'app/garden-ab12/workshop',
    { discussionHint: { slug: 'garden-ab12', messageId: null } }]]);
});

test('a proposal row still opens its proposal', () => {
  const { N, calls } = load();
  N.items = [row({ kind: 'pr_proposed', sessionId: 77 })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['openAppTab', 'garden-ab12', 'dev', { subTab: 'proposals', ref: 77 }]]);
});

test('a saved app message opens the project page\'s Discussion tab on it, and stays saved', () => {
  const { N, calls } = load();
  N.saved = [{ messageId: 5540, appSlug: 'garden-ab12' }];
  N._onSavedClick(5540);
  assert.deepEqual(nav(calls), [['reveal', 'garden-ab12', 5540], ['panel', 'app/garden-ab12/workshop',
    { discussionHint: { slug: 'garden-ab12', messageId: 5540 } }]]);
  assert.equal(N.saved.length, 1, 'opening a save does not consume it');
  // …and one saved in a topic thread opens the topic, as before.
  const topic = load();
  topic.N.saved = [{ messageId: 8, appSlug: 'garden-ab12', threadType: 'session', threadRef: '31' }];
  topic.N._onSavedClick(8);
  assert.deepEqual(nav(topic.calls), [['openAppTab', 'garden-ab12', 'dev', { subTab: 'topic', ref: { kind: 'proposal', id: 31 } }]]);
});

test('accepting an invite opens the project page\'s Discussion tab, where the people are', async () => {
  const { N, calls } = load();
  N.invites = [{ appId: 5, appSlug: 'garden-ab12', kind: 'collab' }];
  N._removeInviteLocal = () => {};
  N.fetch = undefined;
  await N._acceptInvite(5, 'garden-ab12', 'collab');
  assert.deepEqual(nav(calls), [['panel', 'app/garden-ab12/workshop',
    { discussionHint: { slug: 'garden-ab12', messageId: null } }]]);
});

test('the door is pressed when the panel is not the moment, and the address follows it', () => {
  // The panel's take refused (no app running beside it): the door writes
  // the remembered tab and the page's own address opens it.
  const { N, calls, location } = load({ controller: false, panelTakes: false });
  N.items = [row({ kind: 'mention', chatMessageId: 3 })];
  N._onItemClick(1);
  assert.deepEqual(calls.filter((c) => c[0] === 'land'), [['land', 'garden-ab12', 'discussion']],
    'the door, exactly as Recents presses it');
  assert.equal(location.hash, '#app/garden-ab12/workshop', 'the page\'s own address');
  assert.deepEqual(nav(calls), [['reveal', 'garden-ab12', 3],
    ['panel', 'app/garden-ab12/workshop', { discussionHint: { slug: 'garden-ab12', messageId: 3 } }],
    ['land', 'garden-ab12', 'discussion']]);
});

test('without GroupChat the page still opens on the Discussion tab', () => {
  const { N, calls } = load({ groupChat: false });
  N.items = [row({ kind: 'mention', chatMessageId: 3 })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['panel', 'app/garden-ab12/workshop',
    { discussionHint: { slug: 'garden-ab12', messageId: 3 } }]]);
});

test("Homeroom's own app-chat room keeps the Messages address, like its Recents row", () => {
  // The platform project's Discussion tab embeds #general, not this room —
  // so a row about THIS room still opens it on the Messages screen.
  platformSlugStub = 'usernode-2d5619';
  const { N, calls, location } = load();
  N.items = [row({ appSlug: 'usernode-2d5619', kind: 'mention', chatMessageId: 3 })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['reveal', 'usernode-2d5619', 3], ['discussion', 'usernode-2d5619']],
    'the Messages address, through the same store call every other room used to take');
  assert.equal(location.hash, '', 'no page address');
});

test('no row sends a reader to the old full-screen chat any more — except a shared spec', () => {
  // The chat's own route still resolves (legacy links), and its back arrow
  // climbs to Messages now (features/header/platform-header.tsx). A private
  // spec share keeps it: it opens the spec's side panel over that chat.
  const chats = SRC.match(/subTab: 'chat'/g) || [];
  assert.equal(chats.length, 1, 'one door left, and it is the spec share\'s');
  const spec = SRC.slice(SRC.indexOf("if (item.kind === 'spec_shared'"));
  assert.ok(spec.indexOf("subTab: 'chat'") > 0 && spec.indexOf("subTab: 'chat'") < spec.indexOf('return;\n    }'));
});
