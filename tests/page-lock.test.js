'use strict';

// The page holds still under the first session's full-screen screens (#4893).
//
// Onboarding run, 12 Oct 2026, iPhone 17 Safari: on "What do you want to
// make?" and the screens after it, Home's cards showed through at the top,
// behind the status bar, and the Home page underneath could still be
// scrolled. Three parts:
//
//   1. frontend/src/lib/page-lock.ts, executed against a fake document: the
//      document stops scrolling (a class on <html>) and everything before the
//      screen on <body> is inert, and only that, until the last lock goes;
//   2. app.css: the class stops the paged document (lib/browser-scroll.ts)
//      scrolling, and in a phone browser on iOS the screens' ground runs on
//      above them, under the status bar;
//   3. the make screen, the made screen and "You're in" hold the page while
//      they are up, inert on the first session, scroll-locked only from
//      Create, where the header above them stays in use.
//
// What this cannot do is drag a real page on a real iPhone; the effect's
// wiring is pinned in the sources it lives in.
//
// Run with: node --test tests/page-lock.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const APP_CSS = read('public/css/app.css');
const DIR = 'frontend/src/features/first-session';
const MAKE = read(`${DIR}/make.tsx`);
const MADE = read(`${DIR}/made.tsx`);
const ISLAND = read(`${DIR}/index.tsx`);
const { lockPage, PAGE_LOCKED, PAGE_HIDDEN } = loadTsx('frontend/src/lib/page-lock.ts');

// A <body> of element children, in order, each knowing its previous sibling.
function page(...names) {
  const classes = new Set();
  const html = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } };
  const body = { tagName: 'BODY' };
  const doc = { documentElement: html, body };
  const els = names.map((name) => {
    const [tagName, id] = name.includes('#') ? name.split('#') : ['DIV', name];
    const attrs = new Map();
    return {
      id, tagName, ownerDocument: doc, parentElement: body, previousElementSibling: null,
      hasAttribute: (a) => attrs.has(a),
      setAttribute: (a, v) => attrs.set(a, String(v)),
      removeAttribute: (a) => attrs.delete(a),
    };
  });
  els.forEach((el, i) => { el.previousElementSibling = els[i - 1] || null; });
  const by = Object.fromEntries(els.map((el) => [el.id, el]));
  const inert = () => els.filter((el) => el.hasAttribute('inert')).map((el) => el.id);
  return { doc, html, by, inert, locked: () => classes.has(PAGE_LOCKED) };
}

test('lockPage: the document stops scrolling and everything before the screen is inert, until it lets go', () => {
  const p = page('platform-header', 'home-screen', 'platform-tabs', 'SCRIPT#boot', 'make', 'make-rule-sheet', 'un-toast');
  const release = lockPage(p.by.make);
  assert.equal(PAGE_LOCKED, 'platform-page-locked');
  assert.ok(p.locked(), '<html> takes the class');
  // The header, the screen and the bar behind it; not a script, not the
  // screen itself, and not what is put on <body> after it (a sheet it opens,
  // the kit's toasts).
  assert.deepEqual(p.inert(), ['platform-header', 'home-screen', 'platform-tabs']);
  release();
  assert.ok(!p.locked());
  assert.deepEqual(p.inert(), []);
  // Twice is once.
  release();
  assert.ok(!p.locked());
});

test('lockPage: a child that is inert already is someone else\'s, and stays as it was', () => {
  const p = page('home-screen', 'platform-parked', 'make');
  p.by['platform-parked'].setAttribute('inert', '');
  const release = lockPage(p.by.make);
  assert.deepEqual(p.inert(), ['home-screen', 'platform-parked']);
  release();
  assert.deepEqual(p.inert(), ['platform-parked'], 'the parked strip lets go of its own');
});

test('lockPage: what it makes inert is out of sight too, so Safari\'s toolbar band shows no Home (onboarding run three)', () => {
  assert.equal(PAGE_HIDDEN, 'data-page-locked');
  const p = page('platform-header', 'home-screen', 'platform-parked', 'make', 'make-rule-sheet');
  p.by['platform-parked'].setAttribute('inert', '');
  const hidden = () => Object.values(p.by).filter((el) => el.hasAttribute(PAGE_HIDDEN)).map((el) => el.id);
  const release = lockPage(p.by.make);
  assert.deepEqual(hidden(), ['platform-header', 'home-screen'], 'only what this lock made inert');
  // Nested: hidden until the last lock that hid it lets go.
  const again = lockPage(p.by['make-rule-sheet']);
  release();
  assert.ok(p.by['home-screen'].hasAttribute(PAGE_HIDDEN));
  again();
  assert.deepEqual(hidden(), []);
  // Without inert (from Create), nothing is hidden.
  const create = lockPage(p.by.make, { inert: false });
  assert.deepEqual(hidden(), []);
  create();
  // app.css draws it at no opacity, which no descendant can undo, while locked.
  assert.match(APP_CSS, /html\.platform-page-locked \[data-page-locked\] \{\s+opacity: 0 !important;\s+\}/);
});

test('lockPage: without inert, only the scrolling stops (from Create, under the header)', () => {
  const p = page('platform-header', 'home-screen', 'make');
  const release = lockPage(p.by.make, { inert: false });
  assert.ok(p.locked());
  assert.deepEqual(p.inert(), []);
  release();
  assert.ok(!p.locked());
});

test('lockPage: locks nest, so one screen handing over to the next never lets the page go', () => {
  // The made screen taking over from the make screen, either one first.
  for (const makeFirst of [true, false]) {
    const p = page('home-screen', 'platform-tabs', 'make', 'made');
    const make = lockPage(p.by.make);
    const made = lockPage(p.by.made);
    (makeFirst ? make : made)();
    assert.ok(p.locked(), 'still held');
    assert.ok(p.by['home-screen'].hasAttribute('inert') && p.by['platform-tabs'].hasAttribute('inert'), 'Home stays inert');
    (makeFirst ? made : make)();
    assert.ok(!p.locked());
    assert.deepEqual(p.inert(), []);
  }
  // React's own order, in one commit: the old screen lets go, the new one locks.
  const p = page('home-screen', 'made');
  lockPage(p.by.made)();
  const made = lockPage(p.by.made);
  assert.ok(p.locked());
  assert.deepEqual(p.inert(), ['home-screen']);
  made();
});

test('lockPage: nothing to hold without a screen in a document', () => {
  const release = lockPage(null);
  assert.equal(typeof release, 'function');
  release();
  // Not a child of <body>: the scrolling stops, nothing is made inert.
  const p = page('home-screen', 'make');
  p.by.make.parentElement = { tagName: 'DIV' };
  const off = lockPage(p.by.make);
  assert.ok(p.locked());
  assert.deepEqual(p.inert(), []);
  off();
  assert.ok(!p.locked());
});

test('lockPage holds from a layout effect, so the first frame is drawn over a held page', () => {
  const src = read('frontend/src/lib/page-lock.ts');
  assert.match(src, /export function usePageLock\(ref: RefObject<Element \| null>, \{ inert = true \}: \{ inert\?: boolean \} = \{\}\): void \{\s+useLayoutEffect\(\(\) => lockPage\(ref\.current, \{ inert \}\), \[ref, inert\]\);/);
});

test('app.css: the locked page does not scroll, the paged document included', () => {
  const at = APP_CSS.indexOf('html.platform-page-locked,\nhtml.platform-page-locked[data-browser-scroller] {');
  assert.ok(at > 0, 'the lock rule');
  const rule = APP_CSS.slice(at, APP_CSS.indexOf('}', at) + 1);
  // Only the scrolling: the paged document's overscroll stays #3565's
  // (tests/browser-scroll.test.js), and a root that does not scroll does not
  // bounce.
  assert.match(rule, /\{\s+overflow: hidden;\s+\}$/);
  // After the paged document's `overflow-y: auto` it overrides.
  assert.ok(APP_CSS.indexOf('html[data-browser-scroller] {\n  height: auto;') < at);
});

test('app.css: in a phone browser on iOS the first-run screens\' ground runs on under the status bar', () => {
  const block = APP_CSS.slice(APP_CSS.indexOf('/* AND OVER THEIR TOP, UNDER THE STATUS BAR'));
  const rule = /^[^]*?\*\/\n@media \(max-width: 767px\) \{\n  (.+) \{\n    box-shadow: ([^;]+);\n  \}\n\}\n/.exec(block);
  assert.ok(rule, 'phone only');
  // The make and made roots and the invite's held frame, not from Create (under the header).
  assert.equal(rule[1], 'html.un-ios.web-browser-chrome :is([data-first-session-make], [data-first-session-made], [data-first-session-welcome]):not(.platform-under-header)');
  // Straight up, 200px, the box's own size: nothing in the box moves.
  assert.equal(rule[2], '0 -200px 0 0 var(--home-ground, #f4f2e4)');
  // Next to the toolbar rule it mirrors.
  assert.ok(APP_CSS.indexOf('/* THE MAKE AND MADE SCREENS RUN ON UNDER SAFARI\'S TOOLBAR') < APP_CSS.indexOf('/* AND OVER THEIR TOP, UNDER THE STATUS BAR'));
  // Those are the roots the screens draw.
  assert.match(MAKE, /data-first-session-make=""/);
  assert.match(MADE, /data-first-session-made=""/);
  assert.match(ISLAND, /data-first-session-welcome="held"/);
});

test('the make and made screens hold the page: inert on the first session, scroll-locked only from Create', () => {
  for (const [name, src, root] of [['make', MAKE, 'data-first-session-make=""'], ['made', MADE, 'data-first-session-made=""']]) {
    assert.match(src, /import \{ usePageLock \} from '\.\.\/\.\.\/lib\/page-lock';/, name);
    assert.match(src, /const rootRef = useRef<HTMLDivElement>\(null\);\s+usePageLock\(rootRef, \{ inert: !underHeader \}\);/, name);
    // On the screen's own root.
    assert.match(src, new RegExp(`<div\\s+ref=\\{rootRef\\}\\s+role="dialog"\\s+aria-labelledby="first-session-${name}-title"\\s+${root}`), name);
  }
});

test('the invite\'s held frame holds the page too', () => {
  const frame = ISLAND.slice(ISLAND.indexOf('export function WelcomeHeld('), ISLAND.indexOf('export type Mode ='));
  assert.match(ISLAND, /import \{ usePageLock \} from '\.\.\/\.\.\/lib\/page-lock';/);
  assert.match(frame, /const rootRef = useRef<HTMLDivElement>\(null\);\s+usePageLock\(rootRef\);/);
  assert.match(frame, /<div\s+ref=\{rootRef\}\s+role="dialog"/);
  // The tour runs over the live page, which it scrolls to its targets: never
  // held. Nor is the app under the tip: it asks for nothing, and any tap
  // closes it.
  const tour = ISLAND.slice(ISLAND.indexOf('export function Tour('), ISLAND.indexOf('export function WelcomeHeld('));
  assert.doesNotMatch(tour, /usePageLock/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'frontend/src/features/first-session/app-tip.tsx'), 'utf8'), /usePageLock/);
});
