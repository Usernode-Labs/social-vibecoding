'use strict';

// The bell rows about an app's general discussion open it IN MESSAGES.
//
// A mention, a reply or a reaction in an app's chat, and a message saved from
// it, opened the old full-screen `#app/<slug>/dev/chat` — a screen root of its
// own whose back arrow climbed to the app's Workshop, a screen the reader had
// never been on. The discussion is a thread of Messages (#2718 review, #2763):
// `#messages/app/<slug>`, two panes on a desktop, with the side panel taking it
// beside a running app (#2854). When the row names ONE message, GroupChat is
// asked to bring it into view as the discussion opens (see
// tests/group-chat-reveal-message.test.js for that half).
//
// And the "New issue #N" row opens ISSUE #N — it fell through to the chat.
//
// The REAL shipped notifications.js runs in a vm; the bundle's one import is
// stood in for, as tests/notifications-sheet-dismiss-on-nav.test.js does.
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
).replace(/^import \{ agoStamp \}.*$/m, '');

function load({ controller = true, groupChat = true } = {}) {
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
  };
  if (controller) {
    sandbox.UsernodeReact = {
      messages: {
        openDiscussion: (slug) => calls.push(['discussion', slug]),
        open: (id) => calls.push(['conversation', id]),
        openAddress: (href) => calls.push(['address', href]),
      },
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
  test(`a ${kind} in an app's chat opens its discussion in Messages, on that message`, () => {
    const { N, calls } = load();
    N.items = [row({ kind, chatMessageId: 5552 })];
    N._onItemClick(1);
    assert.deepEqual(nav(calls), [['reveal', 'garden-ab12', 5552], ['discussion', 'garden-ab12']],
      'asked to bring the message into view, then the discussion opened — never the old full-screen chat');
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

test('the other rows that landed on the app chat land on the discussion too', () => {
  // The weekly card is a chat message; an app-health or a deletion-attempt
  // row has no page of its own and fell through to the chat. Its address is
  // the discussion's now — with nothing to reveal when the row names no message.
  for (const kind of ['weekly_digest', 'app_health', 'app_delete_attempted']) {
    const { N, calls } = load();
    N.items = [row({ kind })];
    N._onItemClick(1);
    assert.deepEqual(nav(calls), [['discussion', 'garden-ab12']], kind);
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
  assert.deepEqual(nav(other.calls), [['discussion', 'garden-ab12']]);
});

test('a proposal row still opens its proposal', () => {
  const { N, calls } = load();
  N.items = [row({ kind: 'pr_proposed', sessionId: 77 })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['openAppTab', 'garden-ab12', 'dev', { subTab: 'proposals', ref: 77 }]]);
});

test('a saved app message opens the discussion on it, and stays saved', () => {
  const { N, calls } = load();
  N.saved = [{ messageId: 5540, appSlug: 'garden-ab12' }];
  N._onSavedClick(5540);
  assert.deepEqual(nav(calls), [['reveal', 'garden-ab12', 5540], ['discussion', 'garden-ab12']]);
  assert.equal(N.saved.length, 1, 'opening a save does not consume it');
  // …and one saved in a topic thread opens the topic, as before.
  const topic = load();
  topic.N.saved = [{ messageId: 8, appSlug: 'garden-ab12', threadType: 'session', threadRef: '31' }];
  topic.N._onSavedClick(8);
  assert.deepEqual(nav(topic.calls), [['openAppTab', 'garden-ab12', 'dev', { subTab: 'topic', ref: { kind: 'proposal', id: 31 } }]]);
});

test('accepting an invite opens the app\'s discussion, where the people are', async () => {
  const { N, calls } = load();
  N.invites = [{ appId: 5, appSlug: 'garden-ab12', kind: 'collab' }];
  N._removeInviteLocal = () => {};
  N.fetch = undefined;
  await N._acceptInvite(5, 'garden-ab12', 'collab');
  assert.deepEqual(nav(calls), [['discussion', 'garden-ab12']]);
});

test('before the Messages island publishes, the address is the fallback', () => {
  // A native exact-open can land during shell startup; the hash routes it.
  const { N, calls, location } = load({ controller: false });
  N.items = [row({ kind: 'mention', chatMessageId: 3 })];
  N._onItemClick(1);
  assert.equal(location.hash, '#messages/app/garden-ab12');
  assert.deepEqual(nav(calls), [['reveal', 'garden-ab12', 3]]);
});

test('without GroupChat the discussion still opens', () => {
  const { N, calls } = load({ groupChat: false });
  N.items = [row({ kind: 'mention', chatMessageId: 3 })];
  N._onItemClick(1);
  assert.deepEqual(nav(calls), [['discussion', 'garden-ab12']]);
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
