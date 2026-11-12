'use strict';

// #6579: the Unread tab is one plain list of groups again.
//
// #5929 item 13 put a "3 need you · 96 unread" line over the groups; #6579
// reverses it, because the Unread (N) tab already says how many there are.
// #5929 item 1 split the groups under "Needs you" and "Everything else"
// labels; #6579 reverses that too. A group with something waiting on the
// reader still comes first (tests/notifications-group-urgency.test.js pins
// the order), but no label says so.
//
// These tests pin the removal on the shipped source and its render, and keep
// #5929 item 10: the sheet's close button names itself on hover too.
//
// Run with: node --test tests/notifications-catch-up-line.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const SHEET_PATH = 'frontend/src/features/notifications/notifications-sheet.tsx';
const SHEET_SOURCE = require('node:fs').readFileSync(SHEET_PATH, 'utf8');
const CATALOG = JSON.parse(require('node:fs').readFileSync(
  'frontend/locales/en/notifications.json', 'utf8'
));
const { createStore } = loadTsx('frontend/src/lib/plain-store.js');

if (!globalThis.PlatformI18n) globalThis.PlatformI18n = englishPlatformI18n();

const view = (id, overrides = {}) => ({
  id, kind: 'voted_change_merged', unread: true, label: 'Live', segments: [],
  createdAtMs: Date.now() - id * 60000, who: '', appLine: 'Notes', appName: 'Notes', appId: 5,
  storyKey: null, storyRef: null, ...overrides,
});
// The app-less group, with something waiting on the reader: the group that
// used to sit under "Needs you" and still comes first.
const asks = (id) => view(id, { kind: 'pr_proposed', needsYou: true, appId: null, appName: null, appLine: '' });

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

test('the catalog holds no catch-up line and no section labels', () => {
  for (const id of [
    'sheet.needsYou', 'sheet.everythingElse',
    'sheet.catchUp.needsYou_one', 'sheet.catchUp.needsYou_other',
    'sheet.catchUp.needsYouAtLeast_one', 'sheet.catchUp.needsYouAtLeast_other',
    'sheet.catchUp.unread_one', 'sheet.catchUp.unread_other', 'sheet.catchUp.unreadCapped',
  ]) {
    assert.equal(CATALOG[id], undefined, `${id} is gone`);
  }
  assert.doesNotMatch(JSON.stringify(CATALOG), /sheet\.catchUp\./);
});

test('the render has no catch-up line and no section labels, with both kinds of group present', () => {
  const html = render([asks(1), asks(2), view(3, { appId: 6, appName: 'Polls' })], { badgeTotal: 96 });
  assert.doesNotMatch(html, /data-notif-catch-up/, 'no summary line');
  assert.doesNotMatch(html, /data-notif-groups-head/, 'no "Needs you" / "Everything else" labels');
  assert.doesNotMatch(html, /0?96 unread/, 'the number stays on the Unread tab');
  // The groups themselves are still there, each under its own heading.
  const order = [...html.matchAll(/data-notif-app-group="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ['other', 'a:6'], 'grouped, with the group that waits on the reader first');
  assert.ok(html.includes(message('notifications:sheet.group.other')));
  assert.ok(html.includes('Polls'));
});

test('the source draws no catch-up line and no section labels', () => {
  assert.doesNotMatch(SHEET_SOURCE, /CatchUpLine/);
  assert.doesNotMatch(SHEET_SOURCE, /data-notif-catch-up/);
  assert.doesNotMatch(SHEET_SOURCE, /data-notif-groups-head/);
  assert.doesNotMatch(SHEET_SOURCE, /catchUp\./);
  assert.doesNotMatch(SHEET_SOURCE, /sheet\.needsYou|sheet\.everythingElse/);
  // One group per heading, in the group order, with no branch over urgency.
  assert.match(SHEET_SOURCE, /const renderAppGroups = \(\): ReactNode => appGroups\.map\(renderAppGroup\);/);
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
