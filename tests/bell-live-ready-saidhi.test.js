'use strict';

// What the bell's rows say once what they were about has moved on
// (5 October, Page Turners run-through):
//
//   - Mo's "Ready to try · Build the Page Turners club sc…" was still unread
//     and still asking 36 minutes after the first version went live. A
//     "ready to try" row now reads its change's status live: Live (a tap
//     opens the app), Going live, or Closed.
//   - His "Waiting for your approval · 1 change" counted a change that was
//     already live. A digest counts what still waits (`digestWaiting`), and
//     says so in words when nothing does.
//   - Alex's bell called Priya's first message, a request Homeroom bot
//     filed, "Said hi". It is "Asked for a change" once it is a request.
//     The rest of the group heard Mo's request in the discussion as
//     "@mo_t1006 in Page Turners": it is "@mo_t1006 asked for a change in
//     Page Turners" once it is one.
//   - Mo's invite by username said "Accepted your invite" where Priya's link
//     said "Joined through your invite": one phrase for one thing now.
//
// The REAL shipped notifications.js runs in a vm, as in
// tests/vote-digest-destination.test.js. The server half is
// tests/bell-live-ready-saidhi-postgres.test.js.
//
// Run with: node --test tests/bell-live-ready-saidhi.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const { agoStamp } = require('./lib/render-tsx').loadTsx('frontend/src/lib/timestamp.ts');
const SRC = read('frontend/src/features/notifications/notifications.js').replace(/^import \{ agoStamp \}.*$/m, '');

function load() {
  const calls = [];
  const location = { search: '', hash: '#home' };
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
    UsernodeReact: { workshop: { setTab: (tab) => calls.push(['setTab', tab]) } },
  };
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
  return { N, calls };
}

const nav = (calls) => JSON.parse(JSON.stringify(calls.filter((c) => c[0] !== 'dismiss')));
const subject = (view) => view.segments.map((s) => s.v).join(' ');
const ready = (extra) => ({
  id: 7, kind: 'change_ready', createdAt: new Date().toISOString(), readAt: null,
  appName: 'Page Turners', appSlug: 'page-turners', sourceUsername: 'alex_t1005',
  sessionId: 6346, prTitle: 'Build the Page Turners club screen', ...extra,
});

test('"ready to try" says what became of its change, from the change itself', () => {
  const { N } = load();
  const cases = [
    [undefined, 'Ready to try', '\u{1F440}'],
    ['promoted', 'Ready to try', '\u{1F440}'],
    ['merging', 'Going live', '\u{1F680}'],
    ['merged', 'Live', '\u{1F389}'],
    ['archived', 'Closed', '\u{1F5C2}\uFE0F'],
  ];
  for (const [status, label, icon] of cases) {
    const view = N._rowView(ready(status === undefined ? {} : { sessionStatus: status }));
    assert.equal(view.label, label, String(status));
    assert.equal(view.icon, icon, String(status));
    assert.equal(subject(view), 'Build the Page Turners club screen');
    assert.equal(view.by, 'alex_t1005', 'who asked for it, either way');
  }
  // Unread or read is the row's own state: Live is news while it is unread.
  assert.equal(N._rowView(ready({ sessionStatus: 'merged' })).unread, true);
});

test('a live one opens the app it is live in; one still asking opens the change', () => {
  const live = load();
  live.N.items = [ready({ sessionStatus: 'merged' })];
  live.N._onItemClick(7);
  assert.deepEqual(nav(live.calls), [['openAppTab', 'page-turners', 'app', null]]);
  assert.equal(live.calls[0][0], 'dismiss', 'the sheet gets out of the way first');

  const asking = load();
  asking.N.items = [ready({ sessionStatus: 'promoted' })];
  asking.N._onItemClick(7);
  assert.deepEqual(nav(asking.calls), [['openAppTab', 'page-turners', 'dev', { subTab: 'proposals', ref: 6346 }]]);

  const closed = load();
  closed.N.items = [ready({ sessionStatus: 'archived' })];
  closed.N._onItemClick(7);
  assert.deepEqual(nav(closed.calls), [['openAppTab', 'page-turners', 'dev', { subTab: 'proposals', ref: 6346 }]],
    'a closed change has no app to open: its page says what happened');
});

test('a digest counts what still waits, and says so when nothing does', () => {
  const { N } = load();
  const digest = (extra) => N._rowView({
    id: 9, kind: 'vote_digest', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Page Turners', appSlug: 'page-turners', sessionId: 6346, detail: '1', ...extra,
  });
  assert.equal(digest({}).label, 'Waiting for your approval', 'an older server: the count it was sent with');
  assert.equal(subject(digest({})), '1 change');
  assert.equal(subject(digest({ detail: '3', digestWaiting: 2 })), '2 changes', 'the live count wins');
  assert.equal(subject(digest({ detail: '3', digestWaiting: 1 })), '1 change');
  const none = digest({ digestWaiting: 0 });
  assert.equal(none.label, 'Nothing is waiting for your approval now');
  assert.equal(none.segments.length, 0, 'never "0 changes"');
});

test('a first message the bot filed is "Asked for a change"; a hello, or several, stays "Said hi"', () => {
  const { N } = load();
  const first = (extra) => N._rowView({
    id: 11, kind: 'first_message', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Page Turners', appSlug: 'page-turners', sourceUsername: 'priya_t1006',
    chatMessageId: 70, messageContent: 'Could it also keep a list of the books we\'ve already read?', ...extra,
  });
  const asked = first({ requestNumber: 2 });
  assert.equal(asked.label, 'Asked for a change');
  assert.equal(asked.by, 'priya_t1006');
  assert.match(subject(asked), /^Could it also keep a list/);
  assert.equal(first({ requestNumber: null }).label, 'Said hi');
  assert.equal(first({}).label, 'Said hi', 'an older server, or not a request');
  assert.equal(first({ requestNumber: 2, detail: '2' }).label, 'Said hi, with 1 other',
    'a day\'s hellos folded together stay hellos');
});

// The same run: Mo's message in Page Turners' discussion, which Homeroom bot
// filed as a request, reached the rest of the group as "@mo_t1006 in Page
// Turners · Could it also show whose plac…". It asked for a change.
test('a group discussion message the bot filed says who asked for a change; folded messages stay messages', () => {
  const { N } = load();
  const said = (extra) => N._rowView({
    id: 13, kind: 'channel_message', createdAt: new Date().toISOString(), readAt: null,
    appName: 'Page Turners', appSlug: 'page-turners', appId: 5, sourceUsername: 'mo_t1006',
    chatMessageId: 71, messageContent: 'Could it also show whose place we meet at next time?', ...extra,
  });
  const asked = said({ requestNumber: 4 });
  assert.equal(asked.label, '@mo_t1006 asked for a change in Page Turners');
  assert.equal(subject(asked), 'Could it also show whose place we meet at next time?', 'what they said, under it');
  assert.equal(asked.icon, '\u{1F4A1}', 'the first message\'s request icon');
  assert.equal(asked.appLine, 'Discussion', 'still a discussion row');
  assert.equal(said({ requestNumber: null }).label, '@mo_t1006 in Page Turners', 'not a request: what they said');
  assert.equal(said({}).label, '@mo_t1006 in Page Turners', 'an older server');
  assert.equal(said({ requestNumber: null }).icon, '💬');
  const folded = said({ requestNumber: 4, detail: '2' });
  assert.equal(folded.label, '2 new messages in Page Turners', 'two messages are not one request');
  assert.match(subject(folded), /^@mo_t1006: Could it also/);
});

test('an invite by username accepted reads as a link\'s join does', () => {
  const { N } = load();
  const row = (kind) => N._rowView({
    id: 12, kind, createdAt: new Date().toISOString(), readAt: null,
    appName: 'Page Turners', appSlug: 'page-turners', sourceUsername: 'mo_t1006',
  });
  assert.equal(row('collab_invite_accepted').label, 'Joined through your invite');
  assert.equal(row('member_joined').label, 'Joined through your invite');
  assert.doesNotMatch(read('frontend/src/features/notifications/notifications.js'), /Accepted your invite/);
});

test('every decision settles the bell: the merge, a carried change, every close, and a vote for digests', () => {
  const votes = read('src/routes/votes.js');
  assert.equal((votes.match(/notifications\.settleDecidedChange\?\.\(pool, session\.id\)/g) || []).length, 2,
    'the merge, and a merge whose deploy then failed');
  assert.match(votes, /notifications\.settleVoteDigests\?\.\(pool, \{ userIds: \[req\.user\.id\] \}\)/);
  assert.match(read('src/services/included-changes.js'), /d\.notifications\.settleDecidedChange\?\.\(pool, row\.id\)/);
  const lifecycle = read('src/services/session-lifecycle.js');
  const finalize = lifecycle.slice(lifecycle.indexOf('async function finalizeArchivedSession'));
  assert.match(finalize.slice(0, finalize.indexOf('\n}\n')), /settleDecidedChange\(pool, sessionId\)/);
  assert.match(read('src/services/homeroom-bot-chat.js'), /refreshFiledMessage\(pool, \{ appId, chatMessageId: messageId \}\)/);
  // The bell's three reads carry the live columns.
  const service = read('src/services/notifications.js');
  assert.equal((service.match(/\$\{LIVE_ROW_COLUMNS_SQL\}/g) || []).length, 3);
  assert.equal((service.match(/\$\{FILED_MESSAGE_JOIN_SQL\}/g) || []).length, 3);
});
