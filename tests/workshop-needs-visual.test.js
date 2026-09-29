'use strict';

// The Needs-you card as a picture first: who over the title, the run's own
// outlined screen in place of the summary, the facts as one line, and a
// Description sheet on the rail for everything the card leaves out.
//
// Run with: node --test tests/workshop-needs-visual.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AppView = require('../public/js/app-view.js');

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

test('each owed row carries its description, rendered where the page renders it', () => {
  assert.match(APP_VIEW, /descriptionHtml: x\.kind === 'proposal' \? AppView\._proposalSummaryHtml\(x\.item\) : '',/);
  assert.match(APP_VIEW, /descriptionHtml: e\.item && e\.item\.body \? AppView\._issueBodyHtml\(e\.item\) : '',/);
});

test('the card reads who, then the title, then the picture, then one line of facts', () => {
  const item = body(WORKSHOP, 'const FeedItem = memo(function FeedItem(', '\n});\n');
  const order = ['<ItemBy row={row} />', 'className="dev-ws-item-title"', 'className="dev-ws-item-caption"'];
  const at = order.map((s) => item.indexOf(s));
  assert.ok(at.every((x) => x >= 0) && at[0] < at[1] && at[1] < at[2], 'who, then the title, then the caption');
  // With the run's screens the picture replaces the summary.
  assert.match(item, /const shots = !!\(row\.visuals && row\.visuals\.screens && row\.visuals\.screens\.length\);/);
  assert.match(item, /\{shots \? null : summary \? \(/);
  assert.match(item, /\{shots && row\.visuals \? <ShotsPicture v=\{row\.visuals\} near=\{near\} wide=\{wide\} \/>/);
  // The facts are one line, and a door to the sheet that has them in full.
  assert.match(item, /<button type="button" className="dev-ws-item-facts" data-ws-facts="" aria-haspopup="dialog" onClick=\{onDescribe\}>/);
  assert.doesNotMatch(item, /dev-ws-item-chips/, 'no row of chips on the card');
  const facts = body(WORKSHOP, 'function factsFor(', '\n}\n');
  assert.ok(facts.indexOf("key: 'tally'") < facts.indexOf("key: 'state'"), 'where the vote stands comes first');
});

test('the switch sits above the picture, never on it', () => {
  const legacy = body(WORKSHOP, 'function BeforeAfter(', '\n}\n');
  assert.ok(legacy.indexOf('dev-ws-media-bar') < legacy.indexOf('dev-ws-media-view'), 'the bar leads the legacy picture');
  const shotsPic = body(WORKSHOP, 'function ShotsPicture(', '\n}\n');
  assert.ok(shotsPic.indexOf('dev-ws-media-bar') < shotsPic.indexOf('className="dev-ws-media-view"'));
  assert.match(shotsPic, /<span className="dev-ws-media-size">\{size\}<\/span>/);
  const rule = (sel) => {
    const m = new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(CSS);
    assert.ok(m, `rule ${sel}`);
    return m[1];
  };
  assert.doesNotMatch(rule('.dev-ws-seg'), /position: absolute/);
  assert.doesNotMatch(rule('.dev-ws-media-full'), /position: absolute/);
  assert.match(rule('.dev-ws-media-bar'), /margin: 0 74px 8px 0;/, 'clear of the rail on a phone');
  assert.match(rule('.dev-ws-item-facts'), /white-space: nowrap; overflow: hidden; text-overflow: ellipsis;/);
});

test('the picture is the reader\'s own screen size, cropped to the run\'s outlines', () => {
  const pick = body(WORKSHOP, 'function pickScreen(', '\n}\n');
  assert.match(pick, /screens\.find\(\(s\) => \(wide \? !isPhoneScreen\(s\) : isPhoneScreen\(s\)\)\) \|\| screens\[0\] \|\| null/);
  const shotsPic = body(WORKSHOP, 'function ShotsPicture(', '\n}\n');
  // The crop covers both sides' outlines, so a flip never moves it.
  assert.match(shotsPic, /screen\.regions\.flatMap\(\(r\) => \[regionRect\(r, 'before'\), regionRect\(r, 'after'\)\]\)/);
  // Nothing loads for an item far from view.
  assert.match(shotsPic, /\{near && place \? <img src=\{shot\.url\}/);
  // Tapping the picture flips it, from the keyboard too.
  assert.match(shotsPic, /onClick=\{flip\}/);
  assert.match(shotsPic, /if \(e\.key === ' ' \|\| e\.key === 'Enter'\) \{ e\.preventDefault\(\); flip\(\); \}/);
  // Only the changes this screen shows are listed under it.
  assert.match(shotsPic, /const changes = \(v\.changes \|\| \[\]\)\.filter\(\(c\) => shown\.has\(c\.n\)\);/);
});

test('Description is on the rail, second, with its key and its sheet', () => {
  const rail = body(WORKSHOP, '<aside className="dev-ws-rail" data-ws-rail="" aria-label="This item" ref={railRef}>', '</aside>');
  const at = ['data-ws-rail-btn="vote"', 'data-ws-rail-btn="description"', 'data-ws-rail-btn="comments"'].map((s) => rail.indexOf(s));
  assert.ok(at[0] < at[1] && at[1] < at[2], 'after Vote, before Comments');
  assert.match(rail, /onClick=\{\(\) => toggleSheet\('description'\)\}/);
  assert.match(rail, /<DescriptionIcon aria-hidden="true" \/>/);
  assert.match(WORKSHOP, /if \(k === 'd' \|\| k === 'D'\) \{ toggleSheet\('description'\); return; \}/);
  assert.match(WORKSHOP, /keys\.push\(\[\['D'\], 'description'\]/);
  const sheet = body(WORKSHOP, '<div className="dev-ws-sheet-modal dev-ws-sheet-description"', '\n      ) : null}');
  assert.match(sheet, /<Html className="dev-ws-desc-body" html=\{row\.descriptionHtml\} \/>/);
  assert.match(sheet, /<h4 className="dev-ws-desc-head">What changes<\/h4>/);
  assert.match(sheet, /<ItemBy row=\{row\} \/>/);
  assert.match(sheet, /className=\{chipTone\(f\.tone\)\}/, 'the facts in full, as chips');
  // A panel beside the rail on a wide window, like Ask and the comments.
  assert.match(CSS, /\.dev-ws-sheet-ask, \.dev-ws-sheet-comments, \.dev-ws-sheet-description \{\s*position: relative;/);
  assert.match(read('frontend/@/components/ui/icons.tsx'), /export const DescriptionIcon = stroked\('DescriptionIcon', 'M4 6h16M4 12h16M4 18h10'\);/);
});

test('the deck\'s top by-line does not move the change page\'s', () => {
  // The change page's hero reuses `.dev-ws-item-by`; the deck's rules are
  // scoped to the item.
  assert.match(CSS, /\n\.dev-ws-item > \.dev-ws-item-by \{ margin: 14px 74px 0 0; \}/);
  assert.doesNotMatch(CSS, /\n\.dev-ws-item-by \{[^}]*margin: 14px/);
});
