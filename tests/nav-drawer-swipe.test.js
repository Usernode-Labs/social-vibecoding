'use strict';

// WHERE A FINGER MAY PAN A PHONE'S DRAWER (Evan, 18 Oct 2026).
//
// In a Messages conversation a swipe right pans it back from anywhere that
// is not sideways UI, and from the left edge wherever that is the page's,
// which Safari on an iPhone keeps for its own Back. A community's page had a
// drawer of its own, panned the same way, until 3 Nov 2026: its places are
// the Hub's rows now.
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

test('a conversation hands the sideways drag on, and the swipe back follows uncancelable moves', () => {
  // 3 Nov 2026: a community's page has no drawer to pan (its places are the
  // Hub's rows), so nothing claims the page's sideways drag any more.
  const css = read('public/css/app.css');
  assert.doesNotMatch(css, /html\[data-nav-drawer\] #app-view \{ touch-action: pan-y; \}/);
  assert.doesNotMatch(css, /\.nav-drawer-places-scroll|\.nav-drawer-outer-list/, 'the drawer\'s lists are gone');
  const island = read('frontend/src/features/nav-drawer/nav-drawer.tsx');
  assert.doesNotMatch(island, /addEventListener\('touchstart'/, 'the community header pans nothing');
  // The edge and the swipe direction are the inline-start one: the left in
  // English, the right in Arabic.
  const conversation = read('frontend/src/features/messages/phone-drawer.tsx');
  assert.match(conversation, /const pastEdge = rtl \? touch\.clientX < window\.innerWidth - EDGE_PX : touch\.clientX > EDGE_PX;/);
  assert.match(conversation, /const sideways = pastEdge && startsOnSideways\(target, layout, window\);/);
  // In the iPhone app a swipe's moves come uncancelable (WebKit decided at
  // touchstart), so standing down on them left the swipe dead on every plain
  // message. The pan follows them, and holds the browser off only when it can.
  assert.doesNotMatch(conversation, /if \(!e\.cancelable\)/, 'an uncancelable move does not end the pan');
  assert.match(conversation, /if \(e\.cancelable\) e\.preventDefault\(\);/, 'a cancelable one is still held');
});

// Evan, 18 Oct 2026: in a conversation a swipe a little off level still
// panned, because it pans from touch events, which keep coming while the
// browser scrolls under the finger. 3 Nov 2026: the list has nothing beside
// it to pan to, so only a conversation pans, and only back.
test('a finger pans a conversation back from touch events; the list has nothing to pan to', () => {
  const conversation = read('frontend/src/features/messages/phone-drawer.tsx');
  assert.match(conversation, /if \(!on \|\| level === 0\) return undefined;/);
  assert.match(conversation, /if \(isPan\(dx, dy\) && dx > 0\) \{/, 'right, in reading direction: back');
  assert.match(conversation, /landRef\.current\(from, offsetOf\(was\.dx, was\.w\), was\.dx\);/);
  assert.doesNotMatch(conversation, /onPointerDown|pointerType !== 'mouse'/, 'no mouse pan toward a peek');
  assert.match(conversation, /document\.addEventListener\('touchmove', move, \{ passive: false \}\);/, 'the moves are followed from touch events');
  assert.match(conversation, /swallow\.current = true;/, 'a row the pan started on is not pressed');
});
