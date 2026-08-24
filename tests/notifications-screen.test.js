'use strict';

// Frontend contract for the Streamlined Concept's full-screen Notifications
// view. Like tests/messages-screen.test.js, these pin the seams where a
// React-owned screen meets the classic hash router and the notifications
// controller; the controller's own behaviour stays covered by the
// notifications-* suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const html = read('public/index.html');
const app = read('public/js/app.js');
const screen = read('frontend/src/features/notifications/notifications-screen.tsx');
const controllerSrc = read('frontend/src/features/notifications/notifications.js');
const storeSrc = read('frontend/src/features/notifications/notifications-store.js');
const dapp = JSON.parse(read('dapp.json'));

test('Notifications is a hidden React-owned top-level screen with global navigation', () => {
  assert.match(html, /<main id="notifications-screen" class="hidden /);
  assert.match(screen, /useVisibilityHiddenClass\(screenRef, 'notifications-screen', false\)/);
  assert.match(app, /REACT_SCREEN_IDS:[\s\S]*?'notifications-screen'/);
  assert.match(app, /SCREEN_IDS: \[[\s\S]*?'notifications-screen'\]/,
    'the screen is one of the mutually exclusive full-screen roots');
  assert.match(app, /parts\[0\] === 'notifications'[\s\S]{0,400}navigateToNotifications/);
  // Two declared checks render the screen with the staging seeds.
  assert.ok(dapp.tests.some((entry) => entry.path === '/?demo=1#notifications'
    && /#notifications-screen/.test(entry.expectSelector)));
});

test('every navigation prolog that exits Messages also exits Notifications', () => {
  // The two screens share the exact teardown discipline: any prolog that
  // would strand _inMessages would strand _inNotifications identically.
  const messagesExits = (app.match(/if \(App\._inMessages\) App\._exitMessages\(\);/g) || []).length;
  const notificationExits = (app.match(/if \(App\._inNotifications\) App\._exitNotifications\(\);/g) || []).length;
  // navigateToNotifications itself exits Messages but (guarded by the early
  // return) never needs to exit itself — hence exactly one extra site.
  assert.equal(notificationExits, messagesExits - 1,
    'notifications teardown mirrors the messages exit chain');
});

test('the screen renders from the store: all rows, tabs, sections, pager', () => {
  // The controller publishes the FULL list for the screen — read and unread,
  // independent of the drawer's showOlder reveal — from both _renderList
  // branches.
  assert.equal((controllerSrc.match(/screenList: Notifications\.items\.map\(rowView\)/g) || []).length, 2);
  assert.match(storeSrc, /screenList: null/);
  // rowView carries the screen's extra data; the drawer's renderer ignores it.
  assert.match(controllerSrc, /createdAtMs: Date\.parse\(n\.createdAt\) \|\| 0/);
  // The screen partitions client-side and acts through the controller.
  assert.match(screen, /tab === 'unread' \? unread : all/);
  assert.match(screen, /createdAtMs >= boundary/);
  assert.match(screen, /_onItemClick\(view\.id\)/);
  assert.match(screen, /markAllRead\(\)/);
  assert.match(screen, /loadOlder\(\)/);
  assert.match(screen, /screenCanLoadMore/);
});
