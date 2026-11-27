'use strict';

// What a Needs-you row carries for its picture: the run's own outlined
// screens, numbered as the changes are, in the page's mode, and each owed
// row's description. (The reel that drew them over a full-screen card is
// gone; the review flow draws the feed now.)
//
// Run with: node --test tests/workshop-needs-visual.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AppView = require('../public/js/app-view.js');
const { message } = require('./lib/platform-i18n');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const WORKSHOP = read('frontend/src/features/dev-board/workshop/workshop.tsx');
const APP_VIEW = read('public/js/app-view.js');
const CSS = read('public/css/app.css');

/** The text between two markers, the first occurrence. */
function body(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `missing ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `missing end of ${start}`);
  return src.slice(a, b);
}

const id = (char) => char.repeat(32);
const url = (char) => `/api/apps/demo/proposals/42/shots/${id(char)}`;
const context = (storyId, viewport, side, char, width, height) => ({
  id: id(char), storyId, viewport, side, variant: 'context', media: 'png', url: url(char), width, height,
});

function shots(overrides = {}) {
  return {
    state: 'verified',
    claims: [
      { id: 'well', claim: 'The menu has one full-width button.', viewports: ['desktop', 'phone'] },
      { id: 'list', claim: 'The session list is headed "Agent sessions".', viewports: ['desktop', 'phone'] },
    ],
    artifacts: [
      context('well', 'desktop', 'base', '1', 1280, 800), context('well', 'desktop', 'head', '2', 1280, 800),
      context('well', 'phone', 'base', '3', 390, 844), context('well', 'phone', 'head', '4', 390, 844),
    ],
    screens: [
      {
        viewport: 'desktop', shot: 'well', stories: ['well', 'list'], width: 1280, heightBefore: 800, heightAfter: 800,
        regions: [
          { story: 'well', b: [880, 83, 382, 48], a: [896, 87, 350, 36], bMark: null, aMark: null },
          { story: 'list', b: null, a: [875, 351, 392, 126], bMark: [875, 353, 392], aMark: null },
        ],
      },
      {
        viewport: 'phone', shot: 'well', stories: ['well'], width: 390, heightBefore: 844, heightAfter: 844,
        regions: [
          { story: 'well', b: [0, 556, 390, 48], a: [16, 479, 358, 37], bMark: null, aMark: null },
          { story: null, b: [0, 426, 390, 117], a: [0, 426, 390, 36], bMark: null, aMark: null },
        ],
      },
      // A screen whose shots this card does not have is never offered.
      { viewport: 'tablet', shot: 'list', stories: ['list'], width: 800, heightBefore: 600, heightAfter: 600, regions: [] },
    ],
    ...overrides,
  };
}

test('the feed picture carries the run\'s own screens, numbered as the changes are', () => {
  const v = AppView._workshopVisuals(null, shots());
  assert.equal(v.protected, true);
  assert.deepEqual(v.changes, [
    { n: 1, text: 'The menu has one full-width button.' },
    { n: 2, text: 'The session list is headed "Agent sessions".' },
  ]);
  assert.deepEqual(v.screens.map((s) => s.viewport), ['desktop', 'phone']);
  const [desktop, phone] = v.screens;
  assert.deepEqual(desktop.before, { url: url('1'), height: 800 });
  assert.deepEqual(desktop.after, { url: url('2'), height: 800 });
  assert.equal(desktop.width, 1280);
  assert.deepEqual(desktop.changes, [1, 2]);
  assert.deepEqual(desktop.regions, [
    { n: 1, b: [880, 83, 382, 48], a: [896, 87, 350, 36], bMark: null, aMark: null },
    { n: 2, b: null, a: [875, 351, 392, 126], bMark: [875, 353, 392], aMark: null },
  ]);
  assert.deepEqual(phone.changes, [1]);
  assert.equal(phone.regions[1].n, 0, 'a difference no change accounts for keeps no number');
  // The old fields are still there for the legacy picture and the full view.
  assert.equal(v.after, url('2'));
  // A run from before its screens were worked out has none, and the feed
  // falls back to the picture it always drew.
  assert.deepEqual(AppView._workshopVisuals(null, shots({ screens: undefined })).screens, []);
  assert.equal(AppView._workshopVisuals(null, shots({ state: 'failed' })), null);
});

// #7228: a still saved at another size than its screen (a browser left at
// its default window) keeps its own shape, and its outlines are scaled with
// it, instead of being squeezed into the declared screen's box.
test('a screen shot taken at another size is drawn at its own proportions', () => {
  const raw = shots();
  raw.screens[0] = {
    ...raw.screens[0], width: 1440, widthBefore: 1440, widthAfter: 3840,
    heightBefore: 1300, heightAfter: 2160,
    regions: [{ story: 'well', b: [880, 83, 382, 48], a: [2400, 240, 1000, 100], bMark: null, aMark: [2400, 240, 1000] }],
    frames: [{ story: 'well', b: [880, 83, 382, 48], a: [2400, 240, 1000, 100] }],
  };
  const [desktop] = AppView._workshopVisuals(null, raw).screens;
  assert.equal(desktop.width, 1440);
  // The before side is the declared screen; the after side is 3840×2160, so
  // it is drawn 1440 wide and 810 tall, its own 16:9 shape.
  assert.deepEqual([desktop.before.height, desktop.after.height], [1300, 810]);
  // Its boxes are scaled with it, so they still sit on the picture.
  assert.deepEqual(desktop.regions[0].a, [900, 90, 375, 38]);
  assert.deepEqual(desktop.regions[0].aMark, [900, 90, 375]);
  assert.deepEqual(desktop.regions[0].b, [880, 83, 382, 48], 'the declared side keeps its boxes');
  assert.deepEqual(desktop.frames[0].a, [900, 90, 375, 38]);
});

/** Run `fn` with the page drawn in `mode` ('light' or 'dark'). */
function asPage(mode, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {
    documentElement: { classList: { contains: (name) => mode === 'dark' && name === 'dark' } },
  };
  try {
    return fn();
  } finally {
    if (had) Object.defineProperty(globalThis, 'document', had);
    else delete globalThis.document;
  }
}

test('the picture follows the page\'s mode, whatever order the artifacts are in', () => {
  const darkShot = (storyId, viewport, side, char, width, height) => ({
    ...context(storyId, viewport, side, char, width, height), theme: 'dark',
  });
  // A run that took its dark shots in place lists them BEFORE the light
  // ones (PR #6792), which is what a plain `find` used to pick.
  const both = shots({
    artifacts: [
      darkShot('well', 'desktop', 'base', '5', 1280, 800), darkShot('well', 'desktop', 'head', '6', 1280, 800),
      darkShot('well', 'phone', 'base', '7', 390, 844), darkShot('well', 'phone', 'head', '8', 390, 844),
      context('well', 'desktop', 'base', '1', 1280, 800), context('well', 'desktop', 'head', '2', 1280, 800),
      context('well', 'phone', 'base', '3', 390, 844), context('well', 'phone', 'head', '4', 390, 844),
    ],
  });
  const light = asPage('light', () => AppView._workshopVisuals(null, both));
  assert.equal(light.before, url('1'), 'a light page takes the light shot');
  assert.equal(light.after, url('2'));
  assert.deepEqual(light.screens.map((s) => [s.before.url, s.after.url]), [
    [url('1'), url('2')], [url('3'), url('4')],
  ]);
  const dark = asPage('dark', () => AppView._workshopVisuals(null, both));
  assert.equal(dark.before, url('5'), 'a dark page takes the dark shot');
  assert.equal(dark.after, url('6'));
  assert.deepEqual(dark.screens.map((s) => [s.before.url, s.after.url]), [
    [url('5'), url('6')], [url('7'), url('8')],
  ]);
  // Only the image changes: the screen's geometry is the one record it was.
  assert.deepEqual(dark.screens, light.screens.map((s, k) => ({
    ...s,
    before: { ...s.before, url: dark.screens[k].before.url },
    after: { ...s.after, url: dark.screens[k].after.url },
  })));
  // A run from before modes were recorded counts as light, in either mode.
  assert.equal(asPage('light', () => AppView._workshopVisuals(null, shots())).after, url('2'));
  assert.equal(asPage('dark', () => AppView._workshopVisuals(null, shots())).after, url('2'));
  // One side's dark shot without the other's: each side falls back alone.
  const halfDark = shots({
    artifacts: [
      darkShot('well', 'desktop', 'head', '6', 1280, 800),
      context('well', 'desktop', 'base', '1', 1280, 800), context('well', 'desktop', 'head', '2', 1280, 800),
      context('well', 'phone', 'base', '3', 390, 844), context('well', 'phone', 'head', '4', 390, 844),
    ],
  });
  const half = asPage('dark', () => AppView._workshopVisuals(null, halfDark));
  assert.equal(half.before, url('1'));
  assert.equal(half.after, url('6'));
  // A light page never shows a dark shot: with none light, the side is absent.
  const darkOnly = shots({
    artifacts: [darkShot('well', 'desktop', 'base', '5', 1280, 800), darkShot('well', 'desktop', 'head', '6', 1280, 800)],
  });
  assert.equal(asPage('light', () => AppView._workshopVisuals(null, darkOnly)), null);
  assert.equal(asPage('dark', () => AppView._workshopVisuals(null, darkOnly)).after, url('6'));
  // Close-ups are taken light only and still lead the pair, in either mode.
  const crop = (side, char) => ({ ...context('well', 'desktop', side, char, 382, 48), variant: 'focus' });
  const cropped = shots({
    artifacts: [
      darkShot('well', 'desktop', 'base', '5', 1280, 800), darkShot('well', 'desktop', 'head', '6', 1280, 800),
      crop('base', '9'), crop('head', 'a'),
      context('well', 'desktop', 'base', '1', 1280, 800), context('well', 'desktop', 'head', '2', 1280, 800),
    ],
  });
  assert.equal(asPage('light', () => AppView._workshopVisuals(null, cropped)).before, url('9'));
  assert.equal(asPage('dark', () => AppView._workshopVisuals(null, cropped)).before, url('9'));
});

test('a mode switch repaints the open page and the Workshop, and re-shapes the review run', () => {
  // The theme module's change (which fires after the new theme is on <html>)
  // repaints what draws a card picture.
  assert.match(APP_VIEW, /window\.Theme\.onChange\(\(\) => AppView\._repaintShotsForTheme\(\)\);/);
  const repaint = body(APP_VIEW, '_repaintShotsForTheme() {', '\n  },\n');
  assert.match(repaint, /App\.currentTab === 'dev' && App\.currentSubTab === 'topic'/);
  assert.match(repaint, /AppView\._renderTopicHead\(\);/);
  assert.match(repaint, /document\.getElementById\('dev-workshop'\)\) AppView\._rerenderWorkshop\(\);/);
  // React re-shapes the run it already holds in the new mode.
  const reviewFlow = read('frontend/src/features/review-flow/review-flow.tsx');
  assert.match(reviewFlow, /const dark = usePageDark\(\);/);
  assert.match(reviewFlow, /toReviewItems\(items, shape\)\)\.map\(\(it\) => groundInMode\(it, dark\)\) : null\), \[items, dark\]\);/);
  assert.match(reviewFlow, /const fresh = new Map\(toReviewItems\(items, shape\)/);
});

test('each owed row carries its description, rendered where the page renders it', () => {
  assert.match(APP_VIEW, /descriptionHtml: x\.kind === 'proposal' \? AppView\._proposalSummaryHtml\(x\.item\) : '',/);
  // Requests are not in the feed, so neither is an issue's body.
  assert.doesNotMatch(APP_VIEW, /descriptionHtml: e\.item && e\.item\.body/);
});
