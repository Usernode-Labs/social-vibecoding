'use strict';

// #3566: "Should be able to over scroll on home page down, doesn't feel as
// native because can't." The installed shell holds its document still, so
// each page scrolls in its own element scroller, and iOS rubber-bands such a
// scroller only when it can scroll (#3520's measured finding). A page whose
// content is shorter than the screen has no range: the drag stops dead. One
// invisible pixel hung 1px below a page scroller's bottom edge gives it that
// range, the technique #3544 shipped for the project Hub, applied to every
// page scroller through one `data-page-bounce` attribute instead of one
// bespoke selector.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SCROLLERS = [
  ['Home', 'frontend/src/features/home/index.tsx', 'id="home-screen"'],
  ['Discover', 'frontend/src/features/apps/browse-screen.tsx', 'id="browse-screen"'],
  ['Communities', 'frontend/src/features/workshop/index.tsx', 'id="workshop-screen"'],
  ['Standings', 'frontend/src/features/leaderboard/index.tsx', 'id="leaderboard-screen"'],
  ['Me', 'frontend/src/features/profile/index.tsx', 'id="profile-screen"'],
  ['Your changes', 'frontend/src/features/profile/my-proposals.tsx', 'id="profile-proposals-screen"'],
  ['Settings', 'frontend/src/features/settings/index.tsx', 'id="settings-screen"'],
  ['Admin', 'frontend/src/features/admin/index.tsx', 'id="admin-screen"'],
];

test('every page scroller carries data-page-bounce on its root', () => {
  for (const [name, file, id] of SCROLLERS) {
    assert.match(read(file), new RegExp(`${id}[\\s\\S]{0,200}?data-page-bounce`), `${name} (${file})`);
  }
  // The Messages list is a scroller inside its screen rather than a screen
  // root, and is marked the same way.
  assert.match(read('frontend/src/features/messages/index.tsx'),
    /className="messages-list-scroll platform-safe-scroll"\s*\n\s*data-page-bounce/);
});

test('app.css gives every marked scroller the 1px sentinel, on touch only, out of a phone browser', () => {
  const CSS = read('public/css/app.css');
  const at = CSS.indexOf('@media (pointer: coarse) {\n  html:not([data-browser-scroller]) [data-page-bounce] {');
  assert.ok(at > -1, 'a coarse-pointer block for the marked scrollers');
  const block = CSS.slice(at, CSS.indexOf('\n}\n', CSS.indexOf('pointer-events: none;', at)) + 3);

  assert.match(block, /html:not\(\[data-browser-scroller\]\) \[data-page-bounce\] \{\s*position: relative;\s*\}/,
    'the scroller is the sentinel\'s containing block');
  assert.match(block, /html:not\(\[data-browser-scroller\]\) \[data-page-bounce\]::after \{\s*content: '';\s*position: absolute; left: 0; bottom: -1px;\s*width: 1px; height: 1px;\s*pointer-events: none;\s*\}/,
    'a 1px box hung 1px below the scroller\'s bottom edge');
  // The Communities screen's Needs you reel owns the vertical swipe (#3534)
  // and is fitted to the window on purpose (#3516): no outer page bounce
  // while it is up.
  assert.match(block, /html:not\(\[data-browser-scroller\]\) #workshop-screen:has\(\[data-workshop-pane="needs"\]\)::after \{\s*content: none;\s*\}/);

  // No percentage: a percentage floor in a flex chain is what Firefox
  // dropped (tests/dev-workshop.test.js), and the grow would absorb a spacer
  // in flow. Nor the scroller's padding, which is the tab-bar clearance
  // (#3053). Nor a z-index, which would stack the sentinel over content.
  assert.doesNotMatch(block, /%/);
  assert.doesNotMatch(block, /padding|z-index/);
});

test('the rule keeps a phone browser and a mouse out', () => {
  const CSS = read('public/css/app.css');
  // Every selector in the block sits under html:not([data-browser-scroller]):
  // a phone browser pages the document, where the pixel would only lengthen
  // the page, and its bottom edge already bounces (#3565).
  const at = CSS.indexOf('html:not([data-browser-scroller]) [data-page-bounce]');
  assert.ok(at > -1);
  const block = CSS.slice(at, CSS.indexOf('\n}\n', CSS.indexOf('pointer-events: none;', at)) + 3);
  for (const line of block.split('\n')) {
    if (/::?after \{/.test(line)) assert.match(line, /html:not\(\[data-browser-scroller\]\)/, line);
  }
  // The block sits inside @media (pointer: coarse): a mouse has no bounce to
  // gain, and the pixel would put a scrollbar on a desktop window.
  const media = CSS.lastIndexOf('@media (pointer: coarse)', at);
  assert.ok(media > -1, 'inside a pointer: coarse block');
  assert.ok(CSS.slice(media, at).includes('{'), 'the block opens before the rule');
});

test('the two conditions the rule answers still hold', () => {
  const CSS = read('public/css/app.css');
  // The installed shell's still document, which is why a short scroller has
  // no range of its own.
  assert.match(CSS, /html, body \{\s*height: 100dvh;\s*overflow: hidden;[\s\S]*?overscroll-behavior-y: none;\s*\}/);
  // Home's feed keeps `contain` at its top edge, handing the pull to the
  // kit's pull-to-refresh rather than to the page bounce.
  assert.match(CSS, /#home-screen,\s*#auth-landing-scroll \{\s*overscroll-behavior-y: contain;\s*overflow-x: hidden;\s*\}/);
});
