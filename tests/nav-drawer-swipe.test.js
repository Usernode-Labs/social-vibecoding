'use strict';

// WHERE A FINGER MAY PAN THE PHONE'S DRAWER (Evan, 18 Oct 2026).
//
// On the drawer's own levels a sideways drag anywhere pans it, so its lists
// hand sideways on with `touch-action: pan-y` (touch-action stops at a
// scroller: without it the browser took the drag, a pointercancel, and the
// strip never moved under a finger). On the page a swipe right pans it back
// from anywhere that is not sideways UI, and from the left edge wherever
// that is the page's, which Safari on an iPhone keeps for its own Back.
//
// These pin the rule (frontend/src/features/nav-drawer/sideways.ts) and the
// CSS that lets the drag reach it.
//
// Run with: node --test tests/nav-drawer-swipe.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const sideways = loadTsx('frontend/src/features/nav-drawer/sideways.ts');
const { EDGE_PX } = loadTsx('frontend/src/features/nav-drawer/drawer-math.ts');

// A node of a pretend page: what the walk reads, and nothing else.
function node(tagName, style = {}, extra = {}) {
  return { tagName, parentElement: null, scrollWidth: 100, clientWidth: 100, style, ...extra };
}
function chain(...nodes) {
  for (let i = 0; i < nodes.length - 1; i += 1) nodes[i].parentElement = nodes[i + 1];
  return nodes;
}
const view = (selected = false) => ({
  getComputedStyle: (el) => ({ touchAction: 'auto', overflowX: 'visible', overflowY: 'visible', ...el.style }),
  getSelection: () => ({ isCollapsed: !selected }),
});

test('the edge is the page\'s where it may take it, and past it anywhere but sideways UI', () => {
  const at = (x, takesEdge, onSideways) => sideways.swipeBackMayStart({ x, takesEdge, sideways: onSideways });
  assert.equal(at(4, true, true), true, 'the edge wins over what is under it, as it did for the tray');
  assert.equal(at(EDGE_PX, false, false), false, 'Safari on an iPhone keeps its edge for Back');
  assert.equal(at(EDGE_PX + 1, false, false), true, 'and past it a swipe is the drawer\'s there too');
  assert.equal(at(200, true, false), true);
  assert.equal(at(200, true, true), false);
});

test('which touch-action claims the sideways drag for the element itself', () => {
  const claims = sideways.claimsSideways;
  assert.equal(claims('auto', false), false);
  assert.equal(claims('manipulation', false), false);
  assert.equal(claims('pan-x pan-y', false), false, 'html, body say both ways (no pinch zoom)');
  assert.equal(claims('pan-y', false), true, 'a swipe-to-vote card');
  assert.equal(claims('pan-y', true), false, 'a vertical scroller handing sideways on, as the drawers\' lists do');
  assert.equal(claims('none', true), true);
  assert.equal(claims('pan-x', false), true);
});

test('sideways UI: a swipe card, a sideways scroller, a field, a selection', () => {
  const page = node('DIV');
  const [plain] = chain(node('SPAN'), node('P'), page);
  assert.equal(sideways.startsOnSideways(plain, page, view()), false, 'words on the page');
  const [onCard] = chain(node('SPAN'), node('ARTICLE', { touchAction: 'pan-y' }), page);
  assert.equal(sideways.startsOnSideways(onCard, page, view()), true);
  const [onRail] = chain(node('BUTTON'), node('DIV', { overflowX: 'auto' }, { scrollWidth: 900, clientWidth: 390 }), page);
  assert.equal(sideways.startsOnSideways(onRail, page, view()), true);
  const [onFitting] = chain(node('BUTTON'), node('DIV', { overflowX: 'auto' }, { scrollWidth: 390, clientWidth: 390 }), page);
  assert.equal(sideways.startsOnSideways(onFitting, page, view()), false, 'a row that fits does not scroll');
  const [field] = chain(node('TEXTAREA'), page);
  assert.equal(sideways.startsOnSideways(field, page, view()), true);
  const [slider] = chain(node('INPUT', {}, { type: 'range' }), page);
  assert.equal(sideways.startsOnSideways(slider, page, view()), true);
  const [box] = chain(node('INPUT', {}, { type: 'checkbox' }), page);
  assert.equal(sideways.startsOnSideways(box, page, view()), false);
  assert.equal(sideways.startsOnSideways(plain, page, view(true)), true, 'text already selected');
  const [scrolled] = chain(node('SPAN'), node('DIV', { touchAction: 'pan-y', overflowY: 'auto' }), page);
  assert.equal(sideways.startsOnSideways(scrolled, page, view()), false, 'a vertical scroller saying pan-y');
  page.style = { touchAction: 'pan-y' };
  assert.equal(sideways.startsOnSideways(plain, page, view()), false, 'the walk stops below the page');
});

test('the lists and the page hand the sideways drag on while the drawer holds them', () => {
  const css = read('public/css/app.css');
  assert.match(css, /html\[data-nav-drawer\] #app-view \{ touch-action: pan-y; \}/);
  assert.match(css, /\.nav-drawer-places-scroll \{[^}]*touch-action: pan-y;/);
  assert.match(css, /\.nav-drawer-outer-list \{[^}]*touch-action: pan-y;/);
  const island = read('frontend/src/features/nav-drawer/nav-drawer.tsx');
  assert.match(island, /const sideways = touch\.clientX > EDGE_PX && startsOnSideways\(target, page, window\);/);
  // In the iPhone app a swipe's moves come uncancelable (WebKit decided at
  // touchstart, before the drawer's listener was there), so standing down on
  // them left the swipe dead on most of a page and every plain message. The
  // pan follows them, and holds the browser off only when it can.
  const conversation = read('frontend/src/features/messages/phone-drawer.tsx');
  for (const [name, source] of [['the page', island], ['a conversation', conversation]]) {
    assert.doesNotMatch(source, /if \(!e\.cancelable\)/, `${name}: an uncancelable move does not end the pan`);
    assert.match(source, /if \(e\.cancelable\) e\.preventDefault\(\);/, `${name}: a cancelable one is still held`);
  }
});

// Evan, 18 Oct 2026: on a page and in a conversation a swipe a little off
// level still panned, on the lists it caught the vertical unless it was very
// precise. The lists panned from pointer events, and a pointer is cancelled
// the moment the browser starts scrolling under it; the pages from touch
// events, which keep coming. So a finger is the touch handlers' everywhere,
// and the pointer handlers are a mouse's.
test('a finger pans the sidebars from touch events, as it does a page; the pointer handlers are a mouse\'s', () => {
  const island = read('frontend/src/features/nav-drawer/nav-drawer.tsx');
  assert.match(island, /if \(e\.pointerType !== 'mouse' \|\| !e\.isPrimary \|\| e\.button !== 0 \|\| s\.searching \|\| s\.level === 2\) return;/);
  assert.match(island, /if \(isPan\(dx, dy\) && \(p\.from !== 2 \|\| dx > 0\)\) \{/, 'either way on the drawer\'s own levels, right on the page');
  assert.match(island, /if \(s\.searching \|\| !surface \|\| !surface\.contains\(target\) \|\| startsOnSideways\(target, surface, window\)\) return;/,
    'anywhere on the communities and the places but a field');
  assert.match(island, /p = \{ x0: touch\.clientX, y0: touch\.clientY, w: screenWidth\(\), from: s\.level, on: false, dx: 0 \};/);
  assert.match(island, /go\(landing\(was\.from, offsetOf\(was\.from, was\.dx, was\.w\), was\.dx\)\);/);
  const conversation = read('frontend/src/features/messages/phone-drawer.tsx');
  assert.match(conversation, /if \(e\.pointerType !== 'mouse' \|\| !on \|\| level !== 0 \|\| !peekId \|\| !e\.isPrimary \|\| e\.button !== 0\) return;/);
  assert.match(conversation, /if \(isPan\(dx, dy\) && \(from === 0 \|\| dx > 0\)\) \{/, 'either way on the list, right in a conversation');
  assert.match(conversation, /landRef\.current\(from, offsetOf\(was\.dx, was\.w\), was\.dx\);/);
  for (const [name, source] of [['the drawer', island], ['Messages', conversation]]) {
    assert.match(source, /document\.addEventListener\('touchmove', move, \{ passive: false \}\);/, `${name}: the moves are followed from touch events`);
    assert.match(source, /swallow(?:Click)?\.current = true;/, `${name}: a row the pan started on is not pressed`);
  }
});
