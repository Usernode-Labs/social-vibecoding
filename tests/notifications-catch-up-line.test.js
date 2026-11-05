'use strict';

// #5929 item 13: one line over the Unread groups says the shape of a backlog,
// "3 need you · 96 unread". The total is the bell's number through the bell's
// cap (#5289) and includes the asks; the asks are counted in the rows in hand,
// so they say "At least" while the Unread pager has more to bring up. Zero
// says nothing, and nothing to catch up on draws no line.
//
// #5929 item 10: the sheet's close button names itself on hover too.
//
// Run with: node --test tests/notifications-catch-up-line.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');

if (!globalThis.PlatformI18n) globalThis.PlatformI18n = englishPlatformI18n();

const view = (id, overrides = {}) => ({
  id, kind: 'voted_change_merged', unread: true, label: 'Live', segments: [],
  createdAtMs: Date.now() - id * 60000, who: '', appLine: 'Notes', appName: 'Notes', appId: 5,
  storyKey: null, storyRef: null, ...overrides,
});
const asks = (id) => view(id, { kind: 'pr_proposed', needsYou: true });
const invite = {
  appId: 9, slug: 'polls', kind: 'collab', icon: '', who: '@ada', inviter: 'ada', appName: 'Polls',
  line: 'notifications:invite.line.approve', time: '', note: '', members: '',
};

function render(list, state = {}) {
  const notificationsStore = createStore({
    saved: [], invites: [], screenList: list, touch: false, loadingMore: false, screenCanLoadMore: false,
    badgeTotal: list.length, ...state,
  });
  const notificationsSheetStore = createStore({ open: true, adopted: false });
  const mod = loadTsx(SHEET_PATH, {
    stubs: {
      './notifications-store.js': { notificationsStore },
      './notifications-sheet-store.js': { notificationsSheetStore },
    },
  });
  const page = globalThis.window;
  delete globalThis.window;
  try { return renderToHtml(createElement(mod.NotificationsSheetView)); } finally { if (page) globalThis.window = page; }
}

// The line's words, with the separator's tags taken out.
function line(html) {
  const found = html.match(/<p[^>]*data-notif-catch-up[^>]*>(.*?)<\/p>/s);
  return found ? found[1].replace(/<[^>]+>/g, '') : null;
}

test('the catalog says the line in whole messages', () => {
  assert.equal(message('notifications:sheet.catchUp.needsYou', { count: 1 }), '1 needs you');
  assert.equal(message('notifications:sheet.catchUp.needsYou', { count: 3 }), '3 need you');
  assert.equal(message('notifications:sheet.catchUp.needsYouAtLeast', { count: 1 }), 'At least 1 needs you');
  assert.equal(message('notifications:sheet.catchUp.needsYouAtLeast', { count: 3 }), 'At least 3 need you');
  assert.equal(message('notifications:sheet.catchUp.unread', { count: 96 }), '96 unread');
  assert.equal(message('notifications:sheet.catchUp.unreadCapped'), '99+ unread');
});

test('it sits over the groups, muted, and names the asks and the bell\'s number', () => {
  const html = render([asks(1), asks(2), asks(3), view(4, { appId: 6, appName: 'Polls' })], { badgeTotal: 96 });
  assert.equal(line(html), '3 need you · 96 unread', 'the total is the bell\'s, not the total less the asks');
  assert.ok(html.indexOf('data-notif-catch-up') < html.indexOf('data-notif-groups-head="needs"'), 'above the first label');
  assert.match(html, /<p class="[^"]*text-\[13px\][^"]*text-zinc-500[^"]*" data-notif-catch-up/);
  assert.match(html, /<span aria-hidden="true"> · <\/span>/, 'a screen reader is not read the dot');
});

test('asks are counted only as far as the rows in hand reach', () => {
  const html = render([asks(1), asks(2), view(3)], { badgeTotal: 300, unreadCanLoadMore: true });
  assert.equal(line(html), 'At least 2 need you · 99+ unread', 'the pager has more: a floor, and the bell\'s cap');
  assert.equal(line(render([view(1)], { badgeTotal: 300, unreadCanLoadMore: true })), '99+ unread',
    'none seen yet claims nothing about the rest');
});

test('zero says nothing, and neither does a total that only repeats the asks', () => {
  assert.equal(line(render([view(1), view(2)])), '2 unread', 'no need-you clause at 0');
  assert.equal(line(render([asks(1)])), '1 needs you', 'one of one: the total adds nothing');
  assert.equal(line(render([asks(1), asks(2)], { badgeTotal: 1 })), '2 need you', 'a bell a beat behind cannot read as fewer unread than asks');
});

test('a row already read stops asking, and a pending invite asks', () => {
  assert.equal(line(render([view(1), { ...asks(2), unread: false }], { badgeTotal: 1 })), '1 unread');
  assert.equal(line(render([asks(1), view(2)], { badgeTotal: 3, invites: [invite] })), '2 need you · 3 unread',
    'the bell holds the invite, so the asks do too');
});

test('nothing unread draws no line', () => {
  const quiet = render([]);
  assert.equal(line(quiet), null);
  assert.ok(quiet.includes(message('notifications:sheet.empty.unread')));
  assert.equal(line(render([], { badgeTotal: 1, invites: [invite] })), null, 'no groups to sit over: "all caught up" stands');
});

test('the source draws the line only outside a search', () => {
  const source = require('node:fs').readFileSync(SHEET_PATH, 'utf8');
  assert.match(source, /\{!searching && appGroups\.length \? \(\s*<CatchUpLine /);
});

test('the close button names itself on hover as well as to a screen reader', () => {
  const html = render([]);
  const button = html.match(/<button[^>]*id="notifications-sheet-close"[^>]*>/);
  assert.ok(button);
  const close = message('core:common.close');
  assert.equal(close, 'Close');
  assert.match(button[0], new RegExp(`aria-label="${close}"`));
  assert.match(button[0], new RegExp(`title="${close}"`));
});
