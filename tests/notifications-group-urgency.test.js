'use strict';

// #5929 item 2: "Group order is arbitrary". The Unread tab groups its
// notifications by project, newest group first, so a project whose newest
// row was Homeroom bot's "On hold" sat above "Across Homeroom" holding
// "Waiting for your approval". Urgency comes first now: a group holding a
// row that waits on the reader goes above every group that holds none, and
// each side keeps its newest-first order.
//
// These tests pin, on the shipped sources:
//
//   1. rowView's `needsYou`: a change asking for the reader's vote
//      (VOTE_ASK_KINDS, less the author's stale warning), the vote digest while something still waits,
//      Homeroom bot's needs-you (not the one waiting on somebody else) and a
//      friend request still to answer; nothing else.
//   2. groupUnreadByApp: groups with such a row first, recency otherwise.
//   3. The rendered sheet, from real rowView output: the reporter's case.
//
// Run with: node --test tests/notifications-group-urgency.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const notifyCopy = require('../src/services/homeroom-bot-notify-copy');

const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');
const sheet = loadTsx(SHEET_PATH);

if (!globalThis.window) globalThis.window = globalThis;
globalThis.PlatformI18n = englishPlatformI18n();
loadTsx('frontend/src/features/notifications/notifications.js');
const N = globalThis.window.Notifications;

const MIN = 60 * 1000;
const t = (id, values) => message(id, values);
const ago = (minutes) => new Date(Date.now() - minutes * MIN).toISOString();
const bot = (metadata) => notifyCopy.botNotificationDetail({ appName: 'Plant Pal', requestTitle: 'Dark mode', ...metadata });

const row = (id, minutes, overrides = {}) => ({
  id, createdAt: ago(minutes), readAt: null, kind: 'voted_change_merged',
  appId: 5, appName: 'Notes', appSlug: 'notes', sessionId: 40 + id, sessionTitle: `Change ${id}`,
  ...overrides,
});
const botRow = (id, minutes, metadata, overrides = {}) => row(id, minutes, {
  kind: 'conversation_message', detail: bot(metadata), conversationId: 9, conversationKind: 'direct',
  sourceUsername: 'homeroom_bot', messageContent: 'x', appId: 1, appName: 'Plant Pal', sessionId: null, ...overrides,
});

// ── 1. what waits on the reader ─────────────────────────────────────────

test('rowView marks the rows that wait on the reader, and only those', () => {
  const needs = (n) => N._rowView(n).needsYou === true;
  for (const kind of ['pr_proposed', 'revision_recheck', 'change_ready']) {
    assert.ok(needs(row(1, 1, { kind })), `${kind} asks for the reader's vote`);
  }
  assert.ok(needs(row(1, 1, { kind: 'vote_digest', appId: null, detail: '3', digestWaiting: 3 })), 'the digest while changes wait');
  assert.ok(!needs(row(1, 1, { kind: 'vote_digest', appId: null, detail: '3', digestWaiting: 0 })), 'the digest once nothing waits');
  assert.ok(needs(botRow(1, 1, { moment: 'needs_you', said: 'question' })), 'the bot asking the reader');
  assert.ok(needs(botRow(1, 1, { moment: 'needs_you', said: 'plan' })), 'a plan to approve');
  assert.ok(!needs(botRow(1, 1, { moment: 'needs_you', said: 'decide_others', deciders: '@ada' })), 'waiting on somebody else');
  assert.ok(!needs(botRow(1, 1, { moment: 'on_hold', said: 'allowance' })), 'on hold');
  assert.ok(!needs(botRow(1, 1, { moment: 'live', said: 'live' })), 'live');
  assert.ok(needs(row(1, 1, { kind: 'build_needs_you', detail: null, conversationId: 7, conversationKind: 'direct' })), 'a needs-you without its detail');
  assert.ok(needs(row(1, 1, { kind: 'friend_request', appId: null, sourceUsername: 'ada', friendRequestPending: true })), 'a friend request to answer');
  assert.ok(!needs(row(1, 1, { kind: 'friend_request', appId: null, sourceUsername: 'ada', friendRequestPending: false })), 'one answered');
  // The author's warning: others have not voted, or the merge stands still.
  assert.ok(!needs(row(1, 1, { kind: 'stale_pr' })), 'a quiet proposal is its author\'s news');
  assert.ok(!needs(row(1, 1, { kind: 'stale_pr', detail: 'blocked' })), 'so is a blocked one');
  for (const sessionStatus of ['merged', 'merging', 'archived']) {
    assert.ok(!needs(row(1, 1, { kind: 'change_ready', sessionStatus })), `a ready change once ${sessionStatus} stops asking`);
  }
  for (const kind of ['voted_change_merged', 'check_failed', 'pr_merged', 'session_done']) {
    assert.ok(!needs(row(1, 1, { kind })), `${kind} is news`);
  }
});

// ── 2. the order ────────────────────────────────────────────────────────

const view = (id, overrides = {}) => ({
  id, kind: 'voted_change_merged', unread: true, label: 'Live', segments: [],
  createdAtMs: Date.now() - id * MIN, who: '', appLine: 'Notes', appName: 'Notes', appId: 5,
  storyKey: null, storyRef: null, ...overrides,
});
const keys = (groups) => groups.map((group) => group.key);

test('a group holding a row that waits on the reader comes first; recency otherwise', () => {
  const list = [
    view(1, { appId: 1, appName: 'Homeroom' }),
    view(2, { appId: 2, appName: 'Polls' }),
    view(3, { appId: null, appName: null, appLine: '', kind: 'vote_digest', needsYou: true }),
    view(4, { appId: 4, appName: 'Notes' }),
    view(5, { appId: 2, appName: 'Polls', kind: 'pr_proposed', needsYou: true }),
    view(6, { appId: 6, appName: 'Kanban' }),
  ];
  assert.deepEqual(keys(sheet.groupUnreadByApp(list, t)), ['a:2', 'other', 'a:1', 'a:4', 'a:6'],
    'the two groups waiting on the reader, newest first, then the rest, newest first');
  const calm = list.map((v) => ({ ...v, needsYou: false }));
  assert.deepEqual(keys(sheet.groupUnreadByApp(calm, t)), ['a:1', 'a:2', 'other', 'a:4', 'a:6'], 'nothing waiting: newest first, as before');
});

test('the group keeps its rows in feed order and its ask counts however deep it sits', () => {
  const list = [
    view(1, { appId: 1, appName: 'Homeroom' }),
    view(2, { appId: 2, appName: 'Polls', storyKey: 's:2:9' }),
    view(3, { appId: 2, appName: 'Polls', storyKey: 's:2:9', kind: 'pr_proposed', needsYou: true }),
  ];
  const groups = sheet.groupUnreadByApp(list, t);
  assert.deepEqual(keys(groups), ['a:2', 'a:1']);
  assert.equal(groups[0].entries.length, 1, 'the story still folds into one card');
  assert.deepEqual(groups[0].entries[0].view.groupIds, [2, 3]);
});

test('an ask answered while the sheet is open keeps its group in place until it closes', () => {
  const sets = { held: new Set(), released: new Set(), asked: new Set() };
  const asked = (v) => !!v.needsYou || sets.asked.has(v.id);
  const before = [
    view(1, { appId: 1, appName: 'Homeroom' }),
    view(2, { appId: null, appName: null, appLine: '', kind: 'friend_request', needsYou: true }),
  ];
  sheet.holdUnread(sets, true, before);
  assert.deepEqual(keys(sheet.groupUnreadByApp(before, t, asked)), ['other', 'a:1']);
  // Accepted: the row comes back read and no longer asking, still held.
  const after = [before[0], { ...before[1], unread: false, needsYou: false }];
  sheet.holdUnread(sets, true, after);
  assert.deepEqual(keys(sheet.groupUnreadByApp(after, t, asked)), ['other', 'a:1'], 'it stays where it was');
  sheet.holdUnread(sets, false, after);
  assert.deepEqual(keys(sheet.groupUnreadByApp(after, t, asked)), ['a:1', 'other'], 'the next visit orders it as news');
});

// ── 3. the sheet, as the reporter saw it ────────────────────────────────

function renderSheet(list) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch: false, loadingMore: false, screenCanLoadMore: false, badgeTotal: list.length,
  });
  const notificationsSheetStore = createStore({ open: true, adopted: false });
  const mod = loadTsx(SHEET_PATH, {
    stubs: {
      './notifications-store.js': { notificationsStore },
      './notifications-sheet-store.js': { notificationsSheetStore },
    },
  });
  return renderToHtml(createElement(mod.NotificationsSheetView));
}

// The bell module ran with `window` standing in for the page; the sheet
// renders as the prerender does, with none.
function renderWithoutWindow(list) {
  const page = globalThis.window;
  delete globalThis.window;
  try { return renderSheet(list); } finally { globalThis.window = page; }
}

test('"Waiting for your approval" heads the list above a newer "On hold"', () => {
  const list = [
    botRow(1, 1, { moment: 'on_hold', said: 'allowance', appName: 'Homeroom' }, { appName: 'Homeroom' }),
    row(2, 30, { kind: 'vote_digest', appId: null, appName: null, appSlug: null, sessionId: null, detail: '37', digestWaiting: 37 }),
  ].map(N._rowView);
  const html = renderWithoutWindow(list);
  const order = [...html.matchAll(/data-notif-app-group="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['other', 'a:1']);
  assert.ok(html.indexOf(message('notifications:row.voteDigest.label')) < html.indexOf(message('notifications:row.bot.label.onHold')));
});
