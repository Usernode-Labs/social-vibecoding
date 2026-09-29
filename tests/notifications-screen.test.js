'use strict';

// Frontend contract for the Streamlined Concept's Notifications SHEET.
//
// It was a full-screen root. The bell is in the header on every route, so
// "back" from that screen was a guess — and it guessed home, which was wrong
// every time it was opened from anywhere else. These pin the seams where a
// React-owned OVERLAY meets the classic hash router and the notifications
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
const screen = read('frontend/src/features/notifications/notifications-sheet.tsx');
const sheetCtl = read('frontend/src/features/notifications/notifications-sheet-controller.js');
const headerTsx = read('frontend/src/features/header/platform-header.tsx');
const controllerSrc = read('frontend/src/features/notifications/notifications.js');
const storeSrc = read('frontend/src/features/notifications/notifications-store.js');
const dapp = JSON.parse(read('dapp.json'));

test('Notifications is a React-owned SHEET, not a screen root', () => {
  // Always mounted, closed at rest, `data-open` rather than `hidden` — the
  // app-context sheet's contract, which it now shares a chassis with.
  assert.match(html, /id="notifications-sheet"/);
  assert.match(html, /id="notifications-sheet-overlay"/);
  assert.match(screen, /notificationsSheetStore/);
  assert.match(screen, /\{\.\.\.\(open \? \{ 'data-open': '' \} : \{\}\)\}/);
  assert.match(sheetCtl, /createSheetController\(/, 'on the shared sheet chassis');

  // OUT of both screen registries: an overlay is not a mutually exclusive
  // root, and nothing may hide it through the visibility store.
  assert.ok(!/'notifications-screen'/.test(app),
    'no screen id survives in app.js');
  assert.doesNotMatch(screen, /useVisibilityHiddenClass/,
    'a sheet is not revealed by the screen machinery');
});

test('the bell opens it in place, and the hash stays a deep link', () => {
  // A plain click presents over the current screen with NO hash write, so
  // there is no history entry to back out of — the whole reason it stopped
  // being a screen. A modified click still gets the anchor's href.
  assert.match(headerTsx, /id="notifications-btn"[\s\S]{0,400}href="#notifications"/);
  assert.match(headerTsx, /NavLink\?\.isNativeClick\?\.\(event\)[\s\S]{0,120}NotificationsSheet\?\.toggle/);

  // The hash resolves a real screen and presents OVER it, then puts the
  // address back — an overlay must never be what the address names.
  assert.match(app, /parts\[0\] === 'notifications'[\s\S]{0,900}openNotificationsSheet/);
  assert.match(app, /openNotificationsSheet\(\) \{[\s\S]{0,200}_restoreAddressUnderSheet/);
  // The address it puts back is `updateHash`'s, not one built by hand. A
  // hand-built `#app/<slug>/app` was wrong the moment the screen underneath
  // was a dev session: it claimed the app's default view and threw the
  // session's own address away.
  //
  // QA 2026-09-24 Q16: it REPLACES, and the sheet presents only after it. The
  // sheet claims the back button when it presents, which records the address
  // in the bar at that moment; presented first, that was `#notifications`,
  // and the rewrite then pushed the screen's own address over it, so Back
  // closed the sheet onto an address that opened it again.
  assert.match(app, /_restoreAddressUnderSheet\(present\) \{[\s\S]{0,900}App\.updateHash\(\{ replace: true \}\)/);
  assert.match(app, /_restoreAddressUnderSheet\(present\) \{[\s\S]{0,900}setTimeout\(/,
    'deferred one tick, because updateHash refuses to run while _isRestoring');
  assert.match(app,
    /App\.updateHash\(\{ replace: true \}\);[^\n]*\n\s*if \(typeof present === 'function'\) present\(\);/,
    'the sheet presents after the address is put back, in the same task');
  assert.match(app, /openNotificationsSheet\(\) \{\s*App\._restoreAddressUnderSheet\(\(\) => App\.openNotifications\(\)\);/);
  // QA 2026-09-24 Q30a: the PRERENDERED home under a cold #notifications is
  // settled like the bare root settles it, title included, rather than left
  // with whatever title the boot snapshot remembered (the last app's).
  assert.match(app,
    /_restoreAddressUnderSheet\(present\) \{[\s\S]{0,400}else if \(!App\.currentApp && App\._isScreenVisible\('home-screen'\)\) \{\s*App\._ensureHomeVisible\(\);\s*App\.setHeaderTitle\('Homeroom'\);/);
  // One declared check still renders it from that deep link.
  assert.ok(dapp.tests.some((entry) => entry.path === '/?demo=1#notifications'
    && /#notifications-sheet\[data-open\]/.test(entry.expectSelector)));
});

test('nothing tears it down as a screen any more', () => {
  // It had a navigate/exit pair and a place in every navigation prolog. A
  // sheet dismisses itself — on a row's own navigation (_dismissSheetForNav)
  // and on any hash change — so none of that machinery is left to go stale.
  assert.ok(!/_inNotifications/.test(app), 'no screen-state flag');
  assert.ok(!/_exitNotifications/.test(app), 'no exit helper');
  assert.doesNotMatch(app, /navigateToNotifications\(\) \{[\s\S]{0,200}PlatformUI\.transition/,
    'and no screen transition — there is no screen swap to animate');
});

test('the screen renders from the store: all rows, tabs, sections, pager', () => {
  // The controller publishes the FULL list for the screen — read and unread,
  // independent of the drawer's showOlder reveal — from both _renderList
  // branches.
  // Through screenViews now, which maps the same items and then collapses a
  // run of consecutive same-conversation rows into one counted row. Still
  // BOTH branches, which is what this count is protecting: publishing the
  // full list from only one of them is how the screen goes blank on an
  // otherwise-empty drawer.
  assert.equal((controllerSrc.match(/screenList: screenViews\(Notifications\.items\)/g) || []).length, 2);
  assert.match(controllerSrc, /function screenViews\(items\)/);
  assert.match(storeSrc, /screenList: null/);
  // rowView carries the screen's extra data; the drawer's renderer ignores it.
  assert.match(controllerSrc, /createdAtMs: Date\.parse\(n\.createdAt\) \|\| 0/);
  // The screen partitions client-side and acts through the controller.
  assert.match(screen, /tab === 'unread' \? unread\s*\n\s*: tab === 'messages' \? messages : all/);
  assert.match(screen, /at: view\.createdAtMs \|\| 0/);
  assert.match(screen, /entry\.at >= boundary/);
  assert.match(screen, /_onItemClick\(view\.id\)/);
  assert.match(screen, /markAllRead\(\)/);
  assert.match(screen, /loadOlder\(\)/);
  assert.match(screen, /screenCanLoadMore/);
});
