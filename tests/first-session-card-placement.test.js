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
// whose top is the header's foot. The home tour hit the same rail (#3240).
// `footTop` (./index.tsx) reads the bars along the screen's foot the same
// way: a bar counts only when it lies across the screen's foot.
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

const { cardPosition, clearOf, SAFE_TOP, SAFE_BOTTOM, MIN_CARD_ROOM, CARD_GAP } = loadTsx(`${DIR}/card-placement.ts`);
const { footTop, surfaceBox } = loadTsx(`${DIR}/index.tsx`);
const { VIEWPORT_MARGIN } = loadTsx('frontend/src/features/home/tour/spotlight.ts');
const { makerSteps, invitedSteps, privateSteps, lookAroundSteps, BOTTOM_BARS, APP_MENU } = loadTsx(`${DIR}/tour-steps.ts`);

// ./index.tsx PAD, the hole's padding round its target.
const PAD = 6;

const laptop = { width: 1280, height: 800 };
// From 768px up, #platform-tabs is the rail: from under the header to the floor.
const rail = { top: 56, left: 0, width: 224, height: 744 };
const phone = { width: 390, height: 844 };
// Below 768px it is the bottom bar.
const bar = { top: 761, left: 0, width: 390, height: 83 };

/** What ./index.tsx hands the arithmetic: the top of whatever lies along the foot. */
const anchors = (bars, viewport, rest = {}) => ({ foot: footTop(bars, viewport), aboveTop: null, belowBottom: null, pad: PAD, ...rest });

/** A CSS length the card's style spells, with the status bar and the home indicator `safeTop`/`safeBottom` px. */
function length(css, safeTop = 0, safeBottom = 0) {
  if (typeof css === 'number') return css;
  const js = css
    .replaceAll(SAFE_TOP, String(safeTop))
    .replaceAll(SAFE_BOTTOM, String(safeBottom))
    .replaceAll('px', '')
    .replaceAll('calc', '')
    .replaceAll('max', 'Math.max');
  return Function(`return (${js});`)();
}

/**
 * The card's top and bottom edges, for a card of `height` px (the most its
 * max-height lets it be when it is taller), hung by its foot or by its top.
 */
function edges(style, viewport, height, safeTop = 0, safeBottom = 0) {
  assert.equal(style.overflowY, 'auto', 'a card taller than its room scrolls inside it');
  const room = length(style.maxHeight, safeTop, safeBottom);
  const drawn = Math.min(height, room);
  if (style.bottom !== undefined) {
    const bottom = viewport.height - length(style.bottom, safeTop, safeBottom);
    return { top: bottom - drawn, bottom };
  }
  const top = length(style.top, safeTop, safeBottom);
  return { top, bottom: top + drawn };
}

/** The card is whole on the screen: under the status bar and the margin, above the foot's margin. */
function assertWhole(style, viewport, height, label, safeTop = 0, safeBottom = 0) {
  const at = edges(style, viewport, height, safeTop, safeBottom);
  assert.ok(at.top >= VIEWPORT_MARGIN + safeTop - 0.001, `${label}: a ${height}px card starts on screen (${at.top}), ${JSON.stringify(style)}`);
  assert.ok(at.bottom <= viewport.height - VIEWPORT_MARGIN + 0.001, `${label}: and ends on it (${at.bottom}), ${JSON.stringify(style)}`);
}

test('the sidebar rail is not a bottom bar: on a laptop the card sits whole at the foot of the screen', () => {
  assert.equal(footTop([rail], laptop), laptop.height, 'the rail lies down the side, not along the foot');
  // The hub, its header drawn in: the whole screen is the cut-out.
  const hub = cardPosition({ left: 0, top: 0, width: 1280, height: 800 }, 'bottom', laptop, anchors([rail], laptop));
  assert.equal(length(hub.bottom), CARD_GAP, 'at the window\'s own bottom edge, not the rail\'s top');
  // The old arithmetic, H - rail.top + 16, hung it by a foot 40px from the
  // top of the window.
  assert.equal(laptop.height - (laptop.height - rail.top + 16), 40);
  for (const height of [150, 230, 400]) assertWhole(hub, laptop, height, 'hub');
  // The chat with Homeroom bot, the other step it was seen on.
  const chat = cardPosition({ left: 224, top: 0, width: 1056, height: 800 }, 'bottom', laptop, anchors([rail], laptop));
  assert.deepEqual(chat, hub);

  // No target on screen yet (a screen still opening): the same foot.
  const none = cardPosition(null, 'bottom', laptop, anchors([rail], laptop));
  assert.deepEqual(none, hub);

  // The screenshots' width, with the rail at its widest.
  const wide = { width: 2000, height: 1100 };
  const wideRail = { top: 56, left: 0, width: 280, height: 1044 };
  assert.equal(length(cardPosition(null, undefined, wide, anchors([wideRail], wide)).bottom), CARD_GAP);

  // In the app the home indicator and the status bar come off the room.
  assertWhole(hub, laptop, 2000, 'in the app', 47, 34);
  assert.equal(length(hub.bottom, 47, 34), CARD_GAP + 34);
});

test('on a phone the card still sits just above the bottom bar', () => {
  const hub = cardPosition({ left: 0, top: 0, width: 390, height: 748 }, 'bottom', phone, anchors([bar], phone));
  assert.equal(hub.bottom, phone.height - bar.top + CARD_GAP);
  const at = edges(hub, phone, 230);
  assert.equal(at.bottom, bar.top - CARD_GAP, 'its foot clear of the bar');
  assert.ok(at.top >= VIEWPORT_MARGIN);
  // No target, the same; no bar on the screen at all, the screen's foot.
  assert.deepEqual(cardPosition(null, 'bottom', phone, anchors([bar], phone)), hub);
  assert.equal(length(cardPosition(null, 'bottom', phone, anchors([], phone)).bottom), CARD_GAP);
  // The Resume strip on the bar lifts it.
  const strip = { top: 709, left: 8, width: 374, height: 52 };
  assert.equal(cardPosition(null, 'bottom', phone, anchors([bar, strip], phone)).bottom, phone.height - strip.top + CARD_GAP);
  // In the app the status bar comes off the room above the card.
  assert.equal(hub.maxHeight, `calc(${phone.height - hub.bottom - VIEWPORT_MARGIN}px - ${SAFE_TOP})`);
  assert.ok(edges(hub, phone, 2000, 47).top >= VIEWPORT_MARGIN + 47, 'never under the status bar');
});

test('the other placements, and none can start above the screen or run off its foot', () => {
  // Over the composer, the group chat's last step.
  const chat = cardPosition({ left: 0, top: 300, width: 390, height: 400 }, { above: '#gc-form' }, phone, anchors([bar], phone, { aboveTop: 700 }));
  assert.equal(chat.bottom, phone.height - 700 + 12);
  // A composer that is not on the page leaves the card to the target's rules.
  const lost = cardPosition({ left: 0, top: 100, width: 390, height: 100 }, { above: '#gc-form' }, phone, anchors([bar], phone));
  assert.equal(lost.top, `max(${100 + 100 + PAD + 12}px, calc(${VIEWPORT_MARGIN}px + ${SAFE_TOP}))`);
  // A tab in the bottom bar: the card above the bar, never over it.
  const tab = cardPosition({ left: 211, top: 763, width: 90, height: 52 }, undefined, phone, anchors([bar], phone));
  assert.equal(tab.bottom, phone.height - bar.top + CARD_GAP);
  // A tall target: at the foot of the screen, above the bar.
  const tall = cardPosition({ left: 0, top: 100, width: 390, height: 500 }, undefined, phone, anchors([bar], phone));
  assert.equal(tall.bottom, phone.height - bar.top + CARD_GAP);
  // The plan in Homeroom bot's chat: under the chat's header.
  const below = cardPosition({ left: 0, top: 0, width: 390, height: 681 }, { below: '.messages-thread-header' }, phone, anchors([bar], phone, { belowBottom: 169 }));
  assert.equal(below.top, `max(${169 + 12}px, calc(${VIEWPORT_MARGIN}px + ${SAFE_TOP}))`);

  // A target scrolled up past the top: the card stays under the status bar.
  const gone = cardPosition({ left: 0, top: -300, width: 390, height: 100 }, undefined, phone, anchors([bar], phone));
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
    const style = cardPosition(box, place, short, anchors([], short, { aboveTop }));
    const at = edges(style, short, 400);
    assert.ok(at.top >= VIEWPORT_MARGIN, `starts on screen: ${JSON.stringify(style)}`);
    assert.ok(at.bottom <= short.height - VIEWPORT_MARGIN);
    assert.ok(at.bottom - at.top >= MIN_CARD_ROOM, 'with room for itself');
  }
});

test('every tour card, on every desktop and phone size, is whole on the screen', () => {
  const steps = [
    ...makerSteps({ slug: 'film', name: 'Friday Film Crew' }),
    ...invitedSteps({ slug: 'film', name: 'Friday Film Crew' }),
    ...privateSteps({ slug: 'film', name: 'Friday Film Crew' }),
    ...lookAroundSteps(),
    // No tour places a card under an element since the maker's stopped
    // ending in Homeroom bot's chat (Evan, 10 Oct 2026); the placement
    // still holds for one.
    { title: 'a card under a header', place: { below: '#platform-header' } },
  ];
  assert.ok(steps.some((s) => s.place === 'bottom'), 'the hub and app steps sit at the foot');

  const sizes = [
    { width: 1280, height: 800 }, { width: 1024, height: 700 }, { width: 768, height: 1024 }, { width: 1440, height: 900 },
    { width: 2000, height: 1100 }, { width: 1100, height: 520 },
    { width: 390, height: 844 }, { width: 320, height: 568 },
  ];
  let drawn = 0;
  for (const viewport of sizes) {
    const desktop = viewport.width >= 768;
    // The bars along the screen's foot: none beside the rail, the tab bar below 768px.
    const rails = desktop
      ? [{ top: 56, left: 0, width: Math.min(280, viewport.width * 0.2), height: viewport.height - 56 }]
      : [{ top: viewport.height - 83, left: 0, width: viewport.width, height: 83 }];
    const foot = footTop(rails, viewport);
    const whole = { left: 0, top: 0, width: viewport.width, height: foot };
    const tabTop = desktop ? 300 : viewport.height - 70;
    const boxes = [
      null,
      whole,
      { left: desktop ? 0 : 211, top: tabTop, width: desktop ? rails[0].width : 90, height: 52 },
      { left: 16, top: 160, width: 104, height: 124 },
      { left: 0, top: foot - 400, width: viewport.width, height: 400 },
      { left: 0, top: -300, width: viewport.width, height: 100 },
    ];
    for (const step of steps) {
      const place = step.place;
      const isBelow = place && typeof place === 'object' && 'below' in place;
      const isAbove = place && typeof place === 'object' && 'above' in place;
      const isClear = place && typeof place === 'object' && 'clear' in place;
      // The surfaces a `{ clear }` card keeps off: none drawn, a sheet along
      // the foot, a popover under the header, one the whole screen tall, and
      // one still sliding in below the screen.
      const surfaces = isClear ? [
        null,
        { left: 0, top: viewport.height - 380, width: viewport.width, height: 380 },
        { left: Math.max(0, viewport.width - 360), top: 56, width: Math.min(340, viewport.width), height: 420 },
        { left: 0, top: 40, width: viewport.width, height: viewport.height - 40 },
        { left: 0, top: viewport.height + 10, width: viewport.width, height: 380 },
      ] : [null];
      for (const box of boxes) {
        for (const belowBottom of isBelow ? [null, 100, 169, viewport.height - 30] : [null]) {
          for (const aboveTop of isAbove ? [null, 200, viewport.height - 70, -50] : [null]) {
            for (const clear of surfaces) {
              const style = cardPosition(box, place, viewport, { foot, aboveTop, belowBottom, clear, pad: PAD });
              for (const height of [150, 230, 400]) {
                for (const [safeTop, safeBottom] of [[0, 0], [47, 34]]) {
                  assertWhole(style, viewport, height, `${viewport.width}x${viewport.height} ${step.title}`, safeTop, safeBottom);
                  drawn += 1;
                }
              }
            }
          }
        }
      }
    }
  }
  assert.ok(drawn > 1000);
});

// Newcomer run six (14 Oct 2026, iPhone 17 Safari): the card on "Suggest an
// improvement" was hung just over the button, partway down the Homeroom
// menu's sheet, and covered the sheet's top: its grabber, its rounded
// corners and the app's name in small caps showed as a clipped sliver under
// the card. Now the card stands clear of the whole sheet, with a gap.
test('run six: Suggest an improvement\'s card stands over the whole menu sheet, with a clear gap', () => {
  for (const steps of [
    makerSteps({ slug: 'club-votes', name: 'Club Votes', firstVersion: 'building' }),
    invitedSteps({ slug: 'club-votes', name: 'Club Votes' }),
    privateSteps({ slug: 'club-votes', name: 'Club Votes' }),
  ]) {
    const suggest = steps.find((s) => s.target === '#improve-row-feedback');
    assert.deepEqual(suggest.place, { clear: APP_MENU }, 'clear of the menu, not of the button alone');
  }
  // Safari on a phone: no tab bar under an open app, the menu a kit sheet
  // along the foot, the button a third of the way down it.
  const safari = { width: 402, height: 678 };
  const sheet = { left: 0, top: 318, width: 402, height: 360 };
  const button = { left: 16, top: 372, width: 370, height: 50 };
  const style = cardPosition(button, { clear: APP_MENU }, safari, anchors([], safari, { clear: sheet }));
  assert.equal(style.bottom, safari.height - sheet.top + CARD_GAP, 'its foot CARD_GAP over the sheet\'s top edge');
  for (const height of [140, 190]) {
    const at = edges(style, safari, height);
    assert.ok(at.bottom <= sheet.top - CARD_GAP, `a ${height}px card ends clear of the sheet`);
    assert.ok(at.top >= VIEWPORT_MARGIN, 'and starts on screen');
  }
  // What it was: hung by the button, its foot inside the sheet's top.
  const before = cardPosition(button, undefined, safari, anchors([], safari));
  assert.ok(safari.height - before.bottom > sheet.top, 'the old card ran over the sheet\'s top');
  // In the app the status bar comes off the room over the sheet.
  assertWhole(style, safari, 160, 'in the app', 47, 34);

  // A wide window: the menu is a popover under the mark, at the top. No
  // room over it, so the card goes under it, CARD_GAP clear.
  const popover = { left: 920, top: 60, width: 340, height: 420 };
  const wide = cardPosition({ left: 932, top: 120, width: 316, height: 44 }, { clear: APP_MENU }, laptop, anchors([rail], laptop, { clear: popover }));
  assert.equal(wide.top, `max(${popover.top + popover.height + CARD_GAP}px, calc(${VIEWPORT_MARGIN}px + ${SAFE_TOP}))`);
  // A menu that leaves room neither over nor under it, or none drawn yet:
  // the card goes where `auto` puts it, clear of the button.
  const tall = { left: 0, top: 40, width: 390, height: 804 };
  const target = { left: 16, top: 500, width: 358, height: 50 };
  assert.equal(clearOf(tall, phone.height), null);
  assert.deepEqual(cardPosition(target, { clear: APP_MENU }, phone, anchors([], phone, { clear: tall })),
    cardPosition(target, undefined, phone, anchors([], phone)));
  assert.deepEqual(cardPosition(target, { clear: APP_MENU }, phone, anchors([], phone)),
    cardPosition(target, undefined, phone, anchors([], phone)));
  // Room over it needs room for a whole card: MIN_CARD_ROOM and the gaps.
  const edge = MIN_CARD_ROOM + CARD_GAP + VIEWPORT_MARGIN;
  assert.ok(clearOf({ left: 0, top: edge, width: 390, height: 300 }, phone.height).bottom !== undefined, 'over it');
  assert.ok(clearOf({ left: 0, top: edge - 1, width: 390, height: 300 }, phone.height).top !== undefined, 'under it');
});

test('run six: the surface is the kit\'s sheet the menu is presented in, else the menu itself', () => {
  const rect = (r) => () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height });
  const kit = { getBoundingClientRect: rect({ left: 0, top: 300, width: 390, height: 380 }) };
  const inKit = { closest: (sel) => (sel === '.un-sheet' ? kit : null), getBoundingClientRect: rect({ left: 0, top: 318, width: 390, height: 362 }) };
  assert.deepEqual(surfaceBox(APP_MENU, { querySelectorAll: () => [inKit] }), { left: 0, top: 300, width: 390, height: 380 },
    'the grabber and the rounded top are the kit sheet\'s, above the menu\'s own box');
  const own = { closest: () => null, getBoundingClientRect: rect({ left: 920, top: 60, width: 340, height: 420 }) };
  assert.deepEqual(surfaceBox(APP_MENU, { querySelectorAll: () => [own] }), { left: 920, top: 60, width: 340, height: 420 });
  const closed = { closest: () => null, getBoundingClientRect: rect({ left: 0, top: 0, width: 0, height: 0 }) };
  assert.equal(surfaceBox(APP_MENU, { querySelectorAll: () => [closed] }), null);
  assert.equal(surfaceBox(APP_MENU, { querySelectorAll: () => [] }), null);
  // The tour measures it for a `{ clear }` step and hands it to the arithmetic.
  const src = read(`${DIR}/index.tsx`);
  assert.match(src, /const clear = place && typeof place === 'object' && 'clear' in place \? surfaceBox\(place\.clear\) : null;/);
  assert.match(src, /belowBottom: below \? below\.top \+ below\.height : null,\s+clear,/);
});

test('the tour measures the foot by footTop, and draws the card where cardPosition says', () => {
  const src = read(`${DIR}/card-placement.ts`);
  // One arithmetic: the tour wraps it, it does not keep a second copy.
  assert.match(read(`${DIR}/index.tsx`), /import \{ cardPosition \} from '\.\/card-placement';/);
  assert.match(read(`${DIR}/index.tsx`), /return cardPosition\(box, place, viewport, \{/);
  assert.doesNotMatch(read(`${DIR}/index.tsx`), /const aboveFoot/);
  assert.doesNotMatch(src, /function bottomBarInset/);
  assert.match(BOTTOM_BARS, /#platform-tabs/);

  // The tour's first frame on a 1280x800 laptop, with the rail: no target
  // measured yet, so the card is at the foot of the window.
  const { Tour } = loadTsx(`${DIR}/index.tsx`);
  const steps = makerSteps({ slug: 'film', name: 'Friday Film Crew' });
  const railEl = { getBoundingClientRect: () => ({ ...rail, right: rail.left + rail.width, bottom: rail.top + rail.height }) };
  const had = { window: Object.hasOwn(globalThis, 'window'), document: Object.hasOwn(globalThis, 'document') };
  const before = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { innerWidth: laptop.width, innerHeight: laptop.height };
  globalThis.document = {
    getElementById: (id) => (id === 'platform-tabs' ? railEl : null),
    querySelector: () => null,
    querySelectorAll: (selectors) => (selectors === BOTTOM_BARS ? [railEl] : []),
  };
  let html;
  try {
    html = renderToHtml(createElement(Tour, { info: { slug: 'film', name: 'Friday Film Crew', conversationId: 12 }, steps, onEnd() {} }));
  } finally {
    for (const k of ['window', 'document']) { if (had[k]) globalThis[k] = before[k]; else delete globalThis[k]; }
  }
  const card = html.match(/<div role="dialog" aria-labelledby="first-session-tour-title" class="[^"]+" style="([^"]+)">/);
  assert.ok(card, 'the card is drawn');
  assert.ok(card[1].startsWith('bottom:calc(20px + '), `at the window's foot: ${card[1]}`);
  assert.doesNotMatch(card[1], /top:/);
});
