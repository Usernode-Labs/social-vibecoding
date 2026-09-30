'use strict';

// #3538: swipe-to-clear / hover-to-clear on the Notifications sheet.
//
// Two halves, in the suites' established style:
//
//   1. The CONTROLLER. `clearOne(id)` is the row's no-navigate dismissal:
//      mark-as-read, optimistic, the same reconcile a row's own tap takes.
//      The body is extracted from the shipped source and run against stubs,
//      as tests/notifications-mark-all.test.js does for markAllRead — so the
//      test cannot drift from what actually runs.
//   2. The VIEW. The sheet's ScreenRow offers the gesture only where the
//      spec puts it: a swipe tray on touch unread rows, a hover-revealed ×
//      on desktop, nothing at all on a read row.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const controllerSrc = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'notifications', 'notifications.js'),
  'utf8'
);
const sheetSrc = fs.readFileSync(
  path.join(ROOT, 'frontend', 'src', 'features', 'notifications', 'notifications-sheet.tsx'),
  'utf8'
);

// ── 1. the controller ───────────────────────────────────────────────────

// Pull a 2-space-indented object method's body out of the source so it can
// be rebuilt as a standalone callable closing over injected stubs. Shared
// shape with the mark-all suite's extractor.
function methodBody(name) {
  const re = new RegExp(name + '\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n  \\},');
  const m = controllerSrc.match(re);
  assert.ok(m, name + '() definition found in notifications.js');
  return m[1];
}

function buildClearOne(body) {
  return new Function('Notifications', 'id', `return (async () => {${body}})();`);
}

test('clearOne delegates to _markOneRead — no second server path', async () => {
  const body = methodBody('async clearOne');
  let marked = 0;
  const N = { _markOneRead(id) { marked++; assert.equal(id, 9); } };
  const clearOne = buildClearOne(body);
  await clearOne(N, 9);
  assert.equal(marked, 1, 'the mark-one path is the only thing clearOne calls');
});

test('clearOne on an already-read id stays the existing no-op', async () => {
  const body = methodBody('async _markOneRead');
  const N = {
    unread: 3,
    items: [{ id: 9, readAt: '2026-01-01T00:00:00Z' }],
    _reconcileCompletionTitle() { throw new Error('read rows must not re-render'); },
    _renderBadge() {},
    _renderList() { throw new Error('read rows must not re-render'); },
  };
  let fetched = 0;
  const fetchStub = () => { fetched++; return Promise.resolve({ ok: true, json: () => ({}) }); };
  const markOneRead = new Function('Notifications', 'fetch', 'console', 'id',
    `return (async () => {${body}})();`);
  await markOneRead(N, fetchStub, console, 9);
  assert.equal(fetched, 1, 'the reconcile request still goes out (existing behaviour)');
  assert.equal(N.unread, 0, 'the server\'s authoritative total is adopted (existing behaviour)');
});

// ── 2. the view ─────────────────────────────────────────────────────────

test('ScreenRow wires a Clear swipe on touch, unread rows only', () => {
  assert.match(sheetSrc, /function SwipeSlot/, 'the touch swipe tray has its own slot');
  assert.match(sheetSrc, /label: 'Clear'/, 'the swipe action is named Clear');
  assert.match(sheetSrc, /ui\.swipeActions\(el, \{[\s\S]{0,200}label: 'Clear'/,
    'wired through the platform kit the Saved/Invite rows use');
  assert.match(sheetSrc, /handler: \(\) => \{[\s\S]{0,600}controller\(\)\?\.clearOne\(id\)[\s\S]{0,200}\}/,
    'the swipe clears through the controller');
  // The kit re-parents the row it wraps, so the row must sit inside a
  // React-owned slot div — a row handed over directly would throw
  // NotFoundError the first time React removed one.
  assert.match(sheetSrc, /function SwipeSlot[\s\S]{0,1400}return <div/,
    'the slot is a React-owned div the kit may wrap the row inside');
  assert.match(sheetSrc, /return <div key=\{round\} ref=\{ref\}>\{children\}<\/div>/,
    'the slot is keyed, so a fresh wrap follows a re-mount');
  // Gated on unread and touch — read rows render bare.
  assert.match(sheetSrc, /const swipeable = !!view\.unread && !!touch/);
});

test('the desktop × is hover-revealed, touch-hidden, and stops propagation', () => {
  assert.match(sheetSrc, /function ClearButton/, 'the hover twin has its own component');
  assert.match(sheetSrc, /data-notif-clear=\{view\.id\}/);
  assert.match(sheetSrc, /aria-label="Clear"/, 'named Clear for screen readers too');
  assert.match(sheetSrc, /onMouseEnter=\{\(\) => setHidden\(false\)\}/,
    'hover reveals it');
  assert.match(sheetSrc, /useHiddenClass\(ref, hidden\)/,
    'the hidden attribute is React-managed (the shell’s rule for toggled classes)');
  assert.match(sheetSrc, /controller\(\)\?\.clearOne\(view\.id\)[\s\S]{0,40}\}/,
    'it clears through the controller');
  // It must not open the row: the click stops before the row's handler.
  const btn = sheetSrc.slice(sheetSrc.indexOf('function ClearButton'),
    sheetSrc.indexOf('function ScreenRow('));
  assert.match(btn, /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*controller\(\)\?\.clearOne/,
    'stopPropagation precedes the clear');
  assert.doesNotMatch(btn, /_onItemClick/,
    'the × is a clear, not a second way to open');
});

test('read rows render neither affordance', () => {
  const row = sheetSrc.slice(sheetSrc.indexOf('function ScreenRow('),
    sheetSrc.indexOf('function ScreenRowInner('));
  // The slot only wraps a swipeable row; the × only mounts with `withClear`;
  // a read row fails both gates.
  assert.match(row, /if \(swipeable\) \{/, 'the swipe slot is behind the unread+touch gate');
  assert.match(row, /withClear=\{!touch\}/, 'the × is behind the desktop gate');
  assert.doesNotMatch(row, /view\.unread \?[\s\S]{0,200}ClearButton/,
    'the × never rides the unread dot');
  // The bare button branch — the one a read row falls through to — carries
  // neither affordance.
  const bare = row.slice(row.indexOf('return (', row.indexOf('if (withClear)')));
  assert.doesNotMatch(bare, /ClearButton|SwipeSlot/, 'a read row is untouched');
});
