'use strict';

// Where the first-session tour's card goes (#4182):
// frontend/src/features/first-session/card-placement.ts, executed over
// numbers, and the measuring wrapper in ./index.tsx that feeds it.
//
// On a desktop browser the card sat at the top centre with its upper part
// off the screen: only Skip, Back and Next showed, under the browser's own
// bar (the hub step, and the chat with Homeroom bot). The card's foot was
// set from `#platform-tabs`' top edge, read as the top of the phone's bottom
// bar; from 768px up that element is the sidebar rail down the left edge,
// whose top is the header's foot. The home tour hit the same rail (#3240),
// and its `bottomBarInset` is what the card reads the bar through now.
//
// Run with: node --test tests/first-session-card-placement.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';

const { cardPosition, SAFE_TOP, MIN_CARD_ROOM } = loadTsx(`${DIR}/card-placement.ts`);
const { VIEWPORT_MARGIN } = loadTsx('frontend/src/features/home/tour/spotlight.ts');

// ./index.tsx PAD, the hole's padding round its target.
const PAD = 6;

const laptop = { width: 1280, height: 800 };
// From 768px up, #platform-tabs is the rail: from under the header to the floor.
const rail = { top: 56, left: 0, width: 224, height: 744 };
const phone = { width: 390, height: 844 };
// Below 768px it is the bottom bar.
const bar = { top: 761, left: 0, width: 390, height: 83 };

/**
 * The card's top and bottom edges, for a card of `height` px (the most its
 * max-height lets it be when it is taller), with the status bar `safeTop` px.
 */
function edges(style, viewport, height, safeTop = 0) {
  assert.equal(typeof style.bottom, 'number', 'hung by its foot');
  const cap = style.maxHeight.match(/^calc\((-?\d+(?:\.\d+)?)px - (.+)\)$/);
  assert.ok(cap, `max-height is a length less the status bar: ${style.maxHeight}`);
  assert.equal(cap[2], SAFE_TOP);
  assert.equal(style.overflowY, 'auto', 'a card taller than its room scrolls inside it');
  const drawn = Math.min(height, Number(cap[1]) - safeTop);
  const bottom = viewport.height - style.bottom;
  return { top: bottom - drawn, bottom };
}

test('the sidebar rail is not a bottom bar: on a laptop the card sits whole at the foot of the screen', () => {
  // The hub, its header drawn in: the whole screen is the cut-out.
  const hub = cardPosition({ left: 0, top: 0, width: 1280, height: 800 }, 'bottom', laptop, { bar: rail, aboveTop: null, pad: PAD });
  assert.equal(hub.bottom, 16, 'at the window\'s own bottom edge, not the rail\'s top');
  // The old arithmetic, H - rail.top + 16, hung it by a foot 40px from the
  // top of the window.
  assert.equal(laptop.height - (laptop.height - rail.top + 16), 40);
  for (const height of [150, 230, 400]) {
    const at = edges(hub, laptop, height);
    assert.ok(at.top >= VIEWPORT_MARGIN, `a ${height}px card starts on screen (${at.top})`);
    assert.ok(at.bottom <= laptop.height, `and ends on it (${at.bottom})`);
  }
  // The chat with Homeroom bot, the other step it was seen on.
  const chat = cardPosition({ left: 224, top: 0, width: 1056, height: 800 }, 'bottom', laptop, { bar: rail, aboveTop: null, pad: PAD });
  assert.deepEqual(chat, hub);

  // No target on screen yet (a screen still opening): the same foot.
  const none = cardPosition(null, 'bottom', laptop, { bar: rail, aboveTop: null, pad: PAD });
  assert.deepEqual(none, hub);
  const at = edges(none, laptop, 230);
  assert.ok(at.top >= VIEWPORT_MARGIN && at.bottom <= laptop.height);

  // The screenshots' width, with the rail at its widest.
  const wide = { width: 2000, height: 1100 };
  assert.equal(cardPosition(null, undefined, wide, { bar: { top: 56, left: 0, width: 280, height: 1044 }, aboveTop: null, pad: PAD }).bottom, 16);
});

test('on a phone the card still sits just above the bottom bar', () => {
  const hub = cardPosition({ left: 0, top: 0, width: 390, height: 748 }, 'bottom', phone, { bar, aboveTop: null, pad: PAD });
  assert.equal(hub.bottom, phone.height - bar.top + 16);
  const at = edges(hub, phone, 230);
  assert.equal(at.bottom, bar.top - 16, 'its foot 16px above the bar');
  assert.ok(at.top >= VIEWPORT_MARGIN);
  // No target, the same; no bar on the screen at all, the screen's foot.
  assert.deepEqual(cardPosition(null, 'bottom', phone, { bar, aboveTop: null, pad: PAD }), hub);
  assert.equal(cardPosition(null, 'bottom', phone, { bar: null, aboveTop: null, pad: PAD }).bottom, 16);
  assert.equal(cardPosition(null, 'bottom', phone, { bar: { top: 0, left: 0, width: 0, height: 0 }, aboveTop: null, pad: PAD }).bottom, 16);
  // In the app the status bar comes off the room above the card.
  assert.equal(hub.maxHeight, `calc(${phone.height - hub.bottom - VIEWPORT_MARGIN}px - ${SAFE_TOP})`);
  assert.ok(edges(hub, phone, 2000, 47).top >= VIEWPORT_MARGIN + 47, 'never under the status bar');
});

test('the other placements are what they were, and none can start above the screen', () => {
  // Over the composer, the group chat's last step.
  const chat = cardPosition({ left: 0, top: 300, width: 390, height: 400 }, { above: '#gc-form' }, phone, { bar, aboveTop: 700, pad: PAD });
  assert.equal(chat.bottom, phone.height - 700 + 12);
  // A composer that is not on the page leaves the card to the target's rules.
  const lost = cardPosition({ left: 0, top: 100, width: 390, height: 100 }, { above: '#gc-form' }, phone, { bar, aboveTop: null, pad: PAD });
  assert.equal(lost.top, `max(${100 + 100 + PAD + 12}px, calc(${VIEWPORT_MARGIN}px + ${SAFE_TOP}))`);
  // A tab in the bottom bar: above it.
  const tab = cardPosition({ left: 211, top: 763, width: 90, height: 52 }, undefined, phone, { bar, aboveTop: null, pad: PAD });
  assert.equal(tab.bottom, phone.height - 763 + PAD + 12);
  // A tall target: over its foot.
  const tall = cardPosition({ left: 0, top: 100, width: 390, height: 500 }, undefined, phone, { bar, aboveTop: null, pad: PAD });
  assert.equal(tall.bottom, phone.height - 600 + 20);

  // A target scrolled up past the top: the card stays under the status bar.
  const gone = cardPosition({ left: 0, top: -300, width: 390, height: 100 }, undefined, phone, { bar, aboveTop: null, pad: PAD });
  assert.equal(gone.top, `max(${-300 + 100 + PAD + 12}px, calc(${VIEWPORT_MARGIN}px + ${SAFE_TOP}))`);

  // A short window, and an anchor high up it: the card keeps room enough
  // for itself and sits lower, over its target, rather than off the top.
  const short = { width: 900, height: 420 };
  for (const [box, place, aboveTop] of [
    // Its middle below the window's: the card goes over its top edge.
    [{ left: 300, top: 120, width: 200, height: 188 }, undefined, null],
    [{ left: 0, top: 0, width: 900, height: 420 }, { above: '#gc-form' }, 0],
    [{ left: 0, top: 0, width: 900, height: 420 }, { above: '#gc-form' }, -50],
  ]) {
    const style = cardPosition(box, place, short, { bar: null, aboveTop, pad: PAD });
    const at = edges(style, short, 400);
    assert.ok(at.top >= VIEWPORT_MARGIN, `starts on screen: ${JSON.stringify(style)}`);
    assert.ok(at.bottom <= short.height - VIEWPORT_MARGIN);
    assert.ok(at.bottom - at.top >= MIN_CARD_ROOM, 'with room for itself');
  }
});

test('the tour reads the bar through the home tour\'s bottomBarInset, and draws the card where it says', () => {
  const src = read(`${DIR}/card-placement.ts`);
  // Imported, not copied: the two tours read the rail one way.
  assert.match(src, /import \{ bottomBarInset, type Box, VIEWPORT_MARGIN \} from '\.\.\/home\/tour\/spotlight';/);
  assert.doesNotMatch(src, /function bottomBarInset/);
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /const tabs = document\.getElementById\('platform-tabs'\);/);
  assert.match(index, /bar: tabs \? tabs\.getBoundingClientRect\(\) : null,/);
  assert.doesNotMatch(index, /tabsTop/);

  // The tour's first frame on a 1280x800 laptop, with the rail: no target
  // measured yet, so the card is at the foot of the window.
  const { Tour } = loadTsx(`${DIR}/index.tsx`);
  const { makerSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const steps = makerSteps({ slug: 'film', name: 'Friday Film Crew', conversationId: 12 });
  const railEl = { getBoundingClientRect: () => ({ ...rail, right: rail.left + rail.width, bottom: rail.top + rail.height }) };
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { innerWidth: laptop.width, innerHeight: laptop.height };
  globalThis.document = { getElementById: (id) => (id === 'platform-tabs' ? railEl : null), querySelector: () => null };
  let html;
  try {
    html = renderToHtml(createElement(Tour, { info: { slug: 'film', name: 'Friday Film Crew', conversationId: 12 }, steps, onEnd() {} }));
  } finally {
    for (const k of ['window', 'document']) { if (had[k]) globalThis[k] = before[k]; else delete globalThis[k]; }
  }
  const card = html.match(/<div role="dialog" aria-labelledby="first-session-tour-title" class="[^"]+" style="([^"]+)">/);
  assert.ok(card, 'the card is drawn');
  assert.equal(card[1], `bottom:16px;max-height:calc(772px - ${SAFE_TOP});overflow-y:auto`);
});
