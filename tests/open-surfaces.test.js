// #6981: one open panel at a time.
//
// The Homeroom menu, Notifications, a dialog, the "Your feedback" card and the
// welcome tour each close themselves; none of them knew about the others, so
// opening Notifications over the menu left both up, the shared backdrop then
// covered the menu's button, and Escape could close two at once. The registry
// in frontend/src/lib/open-surfaces.ts is the one list they all join.
//
// Executed rather than grepped: the ordering and the exemptions are behaviour,
// and a source assertion cannot tell a claim that spares dialogs from one that
// does not.
//
// Run with: node --test tests/open-surfaces.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadTsx } = require('./lib/render-tsx');

const ENTRY = 'frontend/src/lib/open-surfaces.ts';
// Each load gets its own module instance (and so its own empty registry).
const load = () => loadTsx(ENTRY);

test('a claim closes every other surface through its own close, in order', () => {
  const { claimSurface, openSurfaceKeys } = load();
  const closed = [];
  // Two dialogs coexist, so both are still in the list when the sheet claims.
  claimSurface('dialog:app-settings', 'dialog', () => closed.push('app-settings'));
  claimSurface('dialog:who-decides', 'dialog', () => closed.push('who-decides'));
  assert.deepEqual(openSurfaceKeys(), ['dialog:app-settings', 'dialog:who-decides']);

  claimSurface('notifications-sheet', 'sheet', () => closed.push('notifications'));

  assert.deepEqual(closed, ['app-settings', 'who-decides']);
  assert.deepEqual(openSurfaceKeys(), ['notifications-sheet']);
});

test('a dialog claim spares the other dialogs', () => {
  const { claimSurface, openSurfaceKeys } = load();
  let closed = 0;
  claimSurface('dialog:first', 'dialog', () => { closed += 1; });
  claimSurface('dialog:second', 'dialog', () => { closed += 1; });
  assert.equal(closed, 0, 'the hand-off between dialogs still works');
  assert.deepEqual(openSurfaceKeys(), ['dialog:first', 'dialog:second']);
});

test('a sheet claim closes the menu, and the menu and the tour spare each other', () => {
  const { claimSurface, openSurfaceKeys } = load();
  let menuClosed = 0;
  claimSurface('apps-switcher-sheet', 'sheet', () => { menuClosed += 1; });
  // The tour opens while the menu is up (its own menu step) and closes nothing.
  claimSurface('tour', 'tour', () => {});
  assert.equal(menuClosed, 0);
  assert.deepEqual(openSurfaceKeys(), ['apps-switcher-sheet', 'tour']);

  // A notification, which is neither, closes both. Only the menu and the tour
  // spare each other; a third surface ends the pair.
  claimSurface('notifications-sheet', 'sheet', () => {});
  assert.equal(menuClosed, 1);
  assert.deepEqual(openSurfaceKeys(), ['notifications-sheet']);
});

test('the tour never closes the menu it drives', () => {
  const { claimSurface, openSurfaceKeys } = load();
  let menuClosed = 0;
  claimSurface('notifications-sheet', 'sheet', () => {});
  claimSurface('apps-switcher-sheet', 'sheet', () => { menuClosed += 1; });
  claimSurface('tour', 'tour', () => {});
  assert.equal(menuClosed, 0, 'the tour spares the menu, so its steps still work');
  assert.deepEqual(openSurfaceKeys(), ['apps-switcher-sheet', 'tour']);
});

test('release is idempotent and a released surface is not closed later', () => {
  const { claimSurface, openSurfaceKeys } = load();
  let closed = 0;
  const release = claimSurface('dialog:one', 'dialog', () => { closed += 1; });
  release();
  release();
  assert.deepEqual(openSurfaceKeys(), []);
  claimSurface('notifications-sheet', 'sheet', () => {});
  assert.equal(closed, 0, 'a surface that already left is never closed twice');
});

test('a release still works after the claim swept it away', () => {
  const { claimSurface, openSurfaceKeys } = load();
  let closed = 0;
  const release = claimSurface('dialog:one', 'dialog', () => { closed += 1; });
  claimSurface('notifications-sheet', 'sheet', () => {});
  assert.equal(closed, 1);
  release();
  release();
  assert.deepEqual(openSurfaceKeys(), ['notifications-sheet']);
});

test('a close that throws does not stop the rest', () => {
  const { claimSurface, openSurfaceKeys } = load();
  const closed = [];
  claimSurface('dialog:throws', 'dialog', () => { throw new Error('boom'); });
  claimSurface('dialog:second', 'dialog', () => closed.push('second'));

  assert.doesNotThrow(() => {
    claimSurface('notifications-sheet', 'sheet', () => closed.push('notifications'));
  });
  assert.deepEqual(closed, ['second']);
  assert.deepEqual(openSurfaceKeys(), ['notifications-sheet']);
});

test('isTopSurface follows claim order, with the tour above the menu', () => {
  const { claimSurface, isTopSurface } = load();
  claimSurface('dialog:one', 'dialog', () => {});
  assert.equal(isTopSurface('dialog:one'), true);
  claimSurface('dialog:two', 'dialog', () => {});
  assert.equal(isTopSurface('dialog:one'), false);
  assert.equal(isTopSurface('dialog:two'), true);

  claimSurface('apps-switcher-sheet', 'sheet', () => {});
  assert.equal(isTopSurface('apps-switcher-sheet'), true);

  claimSurface('tour', 'tour', () => {});
  assert.equal(isTopSurface('tour'), true,
    'the tour overlay (z-[9993]) is above the menu, so Escape is the tour\'s');
  assert.equal(isTopSurface('apps-switcher-sheet'), false);
  assert.equal(isTopSurface('notifications-sheet'), false);
});

test('claiming an open key replaces it and moves it to the top', () => {
  const { claimSurface, openSurfaceKeys, isTopSurface } = load();
  claimSurface('dialog:one', 'dialog', () => {});
  claimSurface('dialog:two', 'dialog', () => {});
  claimSurface('dialog:one', 'dialog', () => {});
  assert.deepEqual(openSurfaceKeys(), ['dialog:two', 'dialog:one']);
  assert.equal(isTopSurface('dialog:one'), true);
});
