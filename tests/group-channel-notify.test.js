'use strict';

// A small private group's discussion reaches the rest of the group
// (src/services/group-channel-notify.js, kind 'channel_message').
//
// The production case: a private project with two people. One asked the
// other a direct question in the project's discussion and the other heard
// nothing (no bell row, no push), and the answer went back the same way.
// In a group that small the discussion IS the group chat.
//
// Pinned here, without a database (the rule's SQL runs against the full
// schema in tests/group-channel-notify-postgres.test.js):
//   * the rule: private, not the platform's own, 2 to 8 people;
//   * the push copy, one message and a folded run, plain text;
//   * the switch: "Every message in the discussion", on by default, offered
//     only on a small group's own dialog, the user's explicit choice wins;
//   * the push category: Messages;
//   * the bell row and where it opens: the project's Discussion, on the
//     message; a folded row coming back is not a second unread;
//   * what can never ring it: a thread, a connector post, the bot.
//
// Run with: node --test tests/group-channel-notify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n } = require('./lib/platform-i18n');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const group = require('../src/services/group-channel-notify');
const prefs = require('../src/services/notification-preferences');
const pushPrefs = require('../src/services/mobile-push-preferences');
const { buildNotificationCopy, buildMessage } = require('../src/services/mobile-push-policy');
const notifications = require('../src/services/notifications');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ── The rule ────────────────────────────────────────────────────────────

const people = (n) => Array.from({ length: n }, (_, i) => i + 1);
const project = (over = {}) => ({
  view_visibility: 'private', self_hosted: false, moderation_suspended_at: null, people: people(2), ...over,
});

test('a private project of 2 to 8 people is a small group, and nothing else is', () => {
  assert.equal(group.MAX_GROUP_PEOPLE, 8);
  assert.equal(group.isSmallPrivateGroup(project()), true, 'the two-person group from production');
  assert.equal(group.isSmallPrivateGroup(project({ people: people(8) })), true, '8 is still small');
  assert.equal(group.isSmallPrivateGroup(project({ people: people(9) })), false, '9 keeps today\'s mention-only behaviour');
  assert.equal(group.isSmallPrivateGroup(project({ people: people(1) })), false, 'just you: nobody to tell');
  assert.equal(group.isSmallPrivateGroup(project({ view_visibility: 'public' })), false, 'a public community is not a group chat');
  assert.equal(group.isSmallPrivateGroup(project({ self_hosted: true })), false, 'the platform\'s own channel is read-only');
  assert.equal(group.isSmallPrivateGroup(project({ moderation_suspended_at: new Date() })), false);
  assert.equal(group.isSmallPrivateGroup(null), false);
});

test('a failed read hides the switch rather than throwing', async () => {
  const exploding = { query: async () => { throw new Error('database on fire'); } };
  assert.equal(await group.isSmallGroup(exploding, 5), false);
  assert.equal(await group.isSmallGroup({ query: async () => ({ rows: [] }) }, 5), false, 'a missing project');
});

// ── The push ────────────────────────────────────────────────────────────

const CONTEXT = {
  appName: 'Flat 4B Chores',
  sourceUsername: 'jordan',
  messageContent: 'Thanks for spotting the tick bug Sam! Which one do we go with?',
};

test('one message: the person and the project over what they said', () => {
  assert.deepEqual(buildNotificationCopy('channel_message', CONTEXT), {
    title: '@jordan in Flat 4B Chores',
    body: 'Thanks for spotting the tick bug Sam! Which one do we go with?',
  });
  // Plain text: a push shows no markdown.
  assert.equal(
    buildNotificationCopy('channel_message', { ...CONTEXT, messageContent: '**Bins** go out on [Tuesday](https://x.test)' }).body,
    'Bins go out on Tuesday',
  );
});

test('a folded run says how many, and who wrote the newest', () => {
  assert.deepEqual(buildNotificationCopy('channel_message', {
    ...CONTEXT, detail: '3', sourceUsername: 'sam', messageContent: 'The blue one.',
  }), {
    title: '3 new messages in Flat 4B Chores',
    body: '@sam: The blue one.',
  });
});

test('the copy holds up without its context, and never uses an em dash', () => {
  // No author is not a message from a person: the generic copy.
  assert.deepEqual(buildNotificationCopy('channel_message', { appName: 'Flat 4B Chores' }),
    { title: 'Homeroom', body: 'You have new activity' });
  // An attachment-only message has no words: the title alone.
  assert.deepEqual(buildNotificationCopy('channel_message', { ...CONTEXT, messageContent: '' }),
    { title: '@jordan in Flat 4B Chores' });
  const long = buildNotificationCopy('channel_message', { ...CONTEXT, appName: 'A'.repeat(200) });
  assert.ok(long.title.length <= 80);
  for (const copy of [buildNotificationCopy('channel_message', CONTEXT), long]) {
    assert.doesNotMatch(JSON.stringify(copy), /\u2014/);
  }
});

test('it is push-eligible, under Messages', () => {
  assert.equal(pushPrefs.KIND_TO_CATEGORY.get('channel_message'), 'messages');
  assert.equal(pushPrefs.isKindEnabled('channel_message'), true, 'on by default');
  assert.equal(pushPrefs.isKindEnabled('channel_message', { messages: false }), false,
    'turning message pushes off silences it on the phone');
  const message = buildMessage({
    token: 't', notificationId: 9, kind: 'channel_message', environment: 'prod',
    installationId: '00000000-0000-4000-8000-000000000001', userId: 4,
    expiresAt: new Date(Date.now() + 60000), context: CONTEXT,
  });
  assert.equal(message.notification.title, '@jordan in Flat 4B Chores');
  assert.deepEqual(Object.keys(message.data).sort(),
    ['environment', 'notification_id', 'recipient_binding', 'schema', 'source'],
    'the data payload stays opaque');
});

// ── The switch ──────────────────────────────────────────────────────────

test('"Every message in the discussion" is on by default and gates the kind', () => {
  const def = prefs.definitionFor('channel_messages');
  assert.equal(def.label, 'Every message in the discussion');
  assert.match(def.description, /8 people or fewer/);
  assert.match(def.description, /Mentions reach you either way/);
  assert.equal(prefs.categoryForKind('channel_message'), 'channel_messages');
  assert.equal(prefs.isKindEnabled('channel_message', {}), true);
  // The user's explicit choice wins, per project over account-wide.
  assert.equal(prefs.isKindEnabled('channel_message', { appOverrides: { channel_messages: false } }), false);
  assert.equal(prefs.isKindEnabled('channel_message', { accountOverrides: { channel_messages: false } }), false,
    'quiet in every group');
  assert.equal(prefs.isKindEnabled('channel_message', {
    appOverrides: { channel_messages: true }, accountOverrides: { channel_messages: false },
  }), true, 'except this one');
  // Mentions are not this switch: being named is a direct address.
  assert.equal(prefs.isKindEnabled('mention', { appOverrides: { channel_messages: false } }), true);
});

test('a project offers the switch only while it is a small group', () => {
  const keys = (opts) => prefs.serializeAppCategories(opts).map((c) => c.key);
  assert.ok(keys({ smallGroup: true }).includes('channel_messages'));
  assert.ok(!keys({ smallGroup: false }).includes('channel_messages'),
    'nothing else ever sends it, so a switch anywhere else would do nothing');
  assert.ok(!keys({}).includes('channel_messages'));
  assert.equal(prefs.offeredOn(prefs.definitionFor('channel_messages'), { smallGroup: true }), true);
  assert.equal(prefs.offeredOn(prefs.definitionFor('app_health'), { smallGroup: true }), false, 'still admin-only');
  // The account roll-up carries it: that is where "quiet in every group" is set.
  const account = prefs.serializeAccountCategories({}).find((c) => c.key === 'channel_messages');
  assert.equal(account.enabled, true);
  assert.equal(account.appScoped, true);
});

test('the preference routes compute the offer from the project, for read and write', () => {
  const src = read('src/routes/notifications.js');
  const get = src.slice(src.indexOf("router.get('/api/apps/:slug/notification-preferences'"));
  const patch = src.slice(src.indexOf("router.patch('/api/apps/:slug/notification-preferences'"));
  assert.match(get.slice(0, 900), /groupChannelNotify\.isSmallGroup\(pool, app\.id\)/);
  assert.match(get.slice(0, 900), /smallGroup,/);
  assert.match(patch.slice(0, 1600), /notificationPreferences\.offeredOn\(category, \{ isAdmin: app\.isAdmin, smallGroup \}\)/,
    'a write for a switch the project does not offer is refused like app_health is');
});

// ── Where it opens ──────────────────────────────────────────────────────

test('its Messages address is the message in the project\'s discussion', () => {
  assert.equal(notifications.notificationHref({
    kind: 'channel_message', app_slug: 'flat-4b', chat_message_id: 812, thread_type: null,
  }), '#messages/app/flat-4b/m/812');
});

const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const CLIENT = read('frontend/src/features/notifications/notifications.js')
  .replace(/^import \{ agoStamp \}.*$/m, '');

function loadClient() {
  const calls = [];
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Promise, setTimeout, clearTimeout, URLSearchParams, location: { search: '', hash: '' },
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
    App: { user: { id: 1 }, openAppTab: (...args) => calls.push(['openAppTab', ...args]), _isScreenVisible: () => false },
    UsernodeReact: { messages: { openDiscussion: (slug) => calls.push(['discussion', slug]) } },
    GroupChat: { revealMessage: (slug, id) => calls.push(['reveal', slug, id]) },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  sandbox.agoStamp = agoStamp;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.runInContext(CLIENT, sandbox);
  const N = sandbox.Notifications;
  N._renderBadge = () => {};
  N._renderList = () => {};
  N.refresh = async () => true;
  N._markOneRead = () => {};
  N._dismissSheetForNav = () => {};
  return { N, calls };
}

const AT = new Date().toISOString();
const ROW = {
  id: 41, kind: 'channel_message', readAt: null, createdAt: AT,
  appSlug: 'flat-4b', appName: 'Flat 4B Chores', chatMessageId: 812,
  sourceUsername: 'jordan', messageContent: CONTEXT.messageContent, detail: null,
};
const plain = (v) => JSON.parse(JSON.stringify(v));

test('the bell row: who and where, over what they said', () => {
  const { N } = loadClient();
  const view = plain(N._rowView(ROW));
  assert.equal(view.label, '@jordan in Flat 4B Chores');
  assert.deepEqual(view.segments, [{ t: 'strong', v: CONTEXT.messageContent }]);
  assert.equal(view.appLine, 'Discussion', 'the surface, so the project is not named twice');
  assert.equal(view.by, null);
  assert.equal(view.unread, true);
});

test('a folded row counts in words, the newest author before the newest message', () => {
  const { N } = loadClient();
  const view = plain(N._rowView({ ...ROW, detail: '3', sourceUsername: 'sam', messageContent: 'The blue one.' }));
  assert.equal(view.label, '3 new messages in Flat 4B Chores');
  assert.deepEqual(view.segments, [{ t: 'strong', v: '@sam: The blue one.' }]);
  // An attachment-only message: the label stands alone on the subject line.
  const bare = plain(N._rowView({ ...ROW, messageContent: '' }));
  assert.deepEqual(bare.segments, []);
  assert.equal(bare.label, '@jordan in Flat 4B Chores');
  for (const v of [view, bare]) assert.doesNotMatch(JSON.stringify(v), /\u2014/);
});

test('tapping it (or its push) opens the project\'s Discussion, on the message', () => {
  const { N, calls } = loadClient();
  N.items = [{ ...ROW }];
  N._onItemClick(41);
  assert.deepEqual(plain(calls), [['reveal', 'flat-4b', 812], ['discussion', 'flat-4b']]);
});

test('a row that comes back grown is not a second unread, and moves to the top', () => {
  const { N } = loadClient();
  const older = new Date(Date.now() - 60000).toISOString();
  N.items = [{ id: 7, kind: 'mention', readAt: null, createdAt: AT }, { ...ROW, createdAt: older }];
  N.unread = 2;
  N.handleIncoming({ ...ROW, detail: '2', createdAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(N.unread, 2, 'it was already unread');
  assert.deepEqual(N.items.map((n) => n.id), [41, 7], 'newest first, where the feed puts it');
  assert.equal(N.items[0].detail, '2');
  // A replay of the same row (a reconnect) stays where it is.
  N.handleIncoming({ ...N.items[0] });
  assert.deepEqual(N.items.map((n) => n.id), [41, 7]);
  assert.equal(N.unread, 2);
  // A fresh row is one more.
  N.handleIncoming({ ...ROW, id: 42, createdAt: new Date(Date.now() + 2000).toISOString() });
  assert.equal(N.unread, 3);
});

// ── What can never ring it ──────────────────────────────────────────────

test('only a person typing in the main stream rings it', () => {
  const ws = read('src/services/ws.js');
  const call = ws.indexOf('groupChannelNotify.notifyChannelMessage(');
  assert.ok(call > 0, 'the chat handler rings it');
  const guard = ws.lastIndexOf("if (!thread && postedVia !== 'agent') {", call);
  assert.ok(guard > 0 && call - guard < 700,
    'never a reply thread or a topic thread, never a connector\'s post');
  assert.match(ws.slice(call, call + 300), /excludeUserIds: \[\.\.\.directlyNotified\]/,
    'whoever a mention, a quote or "said hi" already reached is not told twice');
  assert.match(ws.slice(guard, call), /directlyNotified\.add\(Number\(said\.row\.user_id\)\)/);
  // The bot's own posts are sendBotMessage, which never rings it, and its
  // private cards are never chat_messages at all.
  const bot = ws.slice(ws.indexOf('async function sendBotMessage'), ws.indexOf('function getOnlineUsers'));
  assert.ok(bot.length > 0);
  assert.doesNotMatch(bot, /groupChannelNotify|notifyChannelMessage/);
  assert.doesNotMatch(read('src/services/homeroom-bot-chat.js'), /INSERT INTO chat_messages/,
    'the requester\'s card is read from chat_bot_requests, never written to the room');
  // And the service checks the message itself: a person's, in the main stream.
  const svc = read('src/services/group-channel-notify.js');
  for (const clause of ['m.thread_type IS NULL', "m.msg_type = 'message'", 'm.posted_via IS NULL', 'u.is_synthetic = FALSE']) {
    assert.ok(svc.includes(clause), clause);
  }
});

test('reading the discussion, or writing in it, clears the row', () => {
  const ws = read('src/services/ws.js');
  assert.match(ws, /cleared \+= await groupChannelNotify\.markChannelRead\(\s*pool, client\.user\.id, client\.appId, rows\[0\]\.id\s*\)/);
  const chat = read('src/routes/chat.js');
  assert.match(chat, /if \(move === 'read'\) \{[\s\S]*?groupChannelNotify\.markChannelRead\(pool, req\.user\.id, app\.id, messageId\)/);
  assert.match(chat, /pushNotificationToUser\(req\.user\.id, \{ type: 'notifications_changed' \}\)/);
});
