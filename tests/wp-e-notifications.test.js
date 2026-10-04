'use strict';

// WP-E: the words of the new notifications, on a phone and in the bell.
//
//   - "Your builds": the Homeroom bot's four moments as their own kinds, so
//     turning Messages off does not silence "it's ready to try". Worded by
//     the moment the detail names, as its messages always were.
//   - "Your invites": an open (a count, never a name), a join and a first
//     hello, for the link's maker; a day's moments fold into one row.
//   - The invite page tells a visitor that the maker sees when they join, and
//     the made screen says about how long a build usually takes.
//
// Run with: node --test tests/wp-e-notifications.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const policy = require('../src/services/mobile-push-policy');
const dm = require('../src/services/homeroom-bot-dm');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('each ringing moment of the bot has its own kind; an answer stays a message', () => {
  assert.deepEqual({ ...dm.BUILD_KINDS }, {
    question: 'build_needs_you', ready: 'build_ready', stopped: 'build_stopped', held: 'build_stopped', live: 'build_live',
  });
  assert.equal(dm.BUILD_KINDS.reply, undefined);
  const src = read('src/services/homeroom-bot-dm.js');
  assert.match(src, /notificationKind: \(rings && BUILD_KINDS\[rings\]\) \|\| null,/);
  // Only a direct conversation takes the kind; a group or channel keeps its own.
  assert.match(read('src/services/conversations.js'),
    /if \(membership\.kind === 'direct' && notificationKind\) kind = notificationKind;/);
});

test('a build moment\'s push is worded by its moment, with a fallback per kind', () => {
  const copy = (kind, detail) => policy.buildNotificationCopy(kind, { detail, sourceUsername: 'homeroom_bot' });
  assert.deepEqual(copy('build_ready', 'hrbot:ready:Run Club'), { title: 'Homeroom bot', body: 'Run Club is ready to try' });
  assert.deepEqual(copy('build_needs_you', 'hrbot:question:Run Club'), { title: 'Homeroom bot', body: 'Run Club: I have a question' });
  assert.deepEqual(copy('build_live', 'hrbot:live_first:Run Club'), { title: 'Homeroom bot', body: 'Run Club is live' });
  assert.deepEqual(copy('build_stopped', null), { title: 'Homeroom bot', body: 'Your change stopped. I said why in our chat' });
});

test('invite news on a phone: an open is nobody, a join and a hello are the person', () => {
  const copy = (kind, extra) => policy.buildNotificationCopy(kind, { appName: 'Run Club', ...extra });
  assert.deepEqual(copy('invite_opened', { sourceUsername: null }),
    { title: 'Someone opened your invite to Run Club', body: 'You hear when they join' });
  assert.deepEqual(copy('member_joined', { sourceUsername: 'sam' }),
    { title: '@sam joined Run Club', body: 'They came in through your invite. Say hello' });
  assert.deepEqual(copy('first_message', { sourceUsername: 'sam', messageContent: 'hi **all**' }),
    { title: '@sam said hi in Run Club', body: 'hi all' });
});

let rowView = null;
function bellRow(n) {
  if (!rowView) {
    if (!globalThis.window) globalThis.window = globalThis;
    loadTsx('frontend/src/features/notifications/notifications.js');
    rowView = globalThis.window.Notifications._rowView;
  }
  const view = rowView({
    id: 1, createdAt: new Date().toISOString(), readAt: null, appName: 'Run Club', appSlug: 'run-club', ...n,
  });
  return {
    label: view.label,
    subject: view.segments.map((s) => s.v).join(' '),
    by: view.by,
  };
}

test('invite news in the bell, folded into a count', () => {
  assert.deepEqual(bellRow({ kind: 'invite_opened', detail: null, sourceUsername: null }),
    { label: 'Someone opened your invite', subject: '', by: null });
  assert.deepEqual(bellRow({ kind: 'invite_opened', detail: '3' }),
    { label: '3 people opened your invite', subject: '', by: null });
  assert.deepEqual(bellRow({ kind: 'member_joined', detail: null, sourceUsername: 'sam' }),
    { label: 'Joined through your invite', subject: '', by: 'sam' });
  assert.deepEqual(bellRow({ kind: 'member_joined', detail: '2', sourceUsername: 'alex' }),
    { label: 'Joined through your invite, with 1 other', subject: '', by: 'alex' });
  assert.deepEqual(bellRow({ kind: 'first_message', detail: '3', sourceUsername: 'sam', messageContent: 'hello!' }),
    { label: 'Said hi, with 2 others', subject: 'hello!', by: 'sam' });
});

test('a build moment in the bell is the bot\'s, in its own words', () => {
  const row = bellRow({
    kind: 'build_ready', detail: 'hrbot:ready:Run Club', appName: null, appSlug: null,
    conversationId: 7, conversationKind: 'direct', sourceUsername: 'homeroom_bot',
  });
  assert.deepEqual(row, { label: 'Homeroom bot', subject: 'Run Club is ready to try', by: null });
});

test('the invite page says the maker sees a join; the made screen says how long', () => {
  const { seenLine } = loadTsx('frontend/src/features/auth/invite-card.tsx');
  assert.equal(seenLine({ inviterName: 'Maya', inviter: 'maya' }), 'Maya will see that you joined.');
  assert.equal(seenLine({ inviter: 'maya' }), '@maya will see that you joined.');
  assert.equal(seenLine({}), '');
  assert.match(read('public/js/app.js'), /will see that you joined\./, 'and the signed-in confirm says it too');
  const { buildNote } = loadTsx('frontend/src/features/first-session/made.tsx');
  assert.equal(buildNote(true, 8), 'Homeroom bot messages you when it\'s ready to try, usually in about 8 minutes.');
  assert.equal(buildNote(true, null), 'Homeroom bot messages you when it\'s ready to try.');
  assert.equal(buildNote(false, 8), 'You or anyone you invite can build it from there.');
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.match(made, /useEffect\(\(\) => \{ if \(botBuilds\) askForPingWhileBotBuilds\(\); \}, \[botBuilds\]\);/);
  assert.match(read('src/routes/apps.js'), /\.\.\.\(mine && !state\.ready \? \{ typicalMinutes: await botDm\.typicalMinutesCached\(pool\) \} : \{\}\),/);
});

test('opens are counted from the page\'s own reads, once per browser, never from the unfurled HTML', () => {
  const routes = read('src/routes/community-invites.js');
  assert.match(routes, /if \(preview\.live\) countOpen\(req, res, req\.params\.token\);/);
  assert.match(routes, /if \(standing\.live && !standing\.mine\) countOpen\(req, res, req\.params\.token, req\.user\.id\);/);
  const page = routes.slice(routes.indexOf("router.get('/invite/:token'"));
  assert.doesNotMatch(page, /countOpen/);
  assert.match(read('src/services/community-invites.js'), /void require\('\.\/invite-activity'\)\.noteJoined\(pool, \{ inviteId: invite\.id, user \}\);/);
  assert.match(read('src/services/ws.js'), /void require\('\.\/invite-activity'\)\.noteFirstMessage\(pool, \{/);
});
