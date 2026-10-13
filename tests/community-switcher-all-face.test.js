'use strict';

// #3663 — "All communities" in "Your communities" wears the Communities tab's
// own face, not a dark tile.
//
// The switcher behind the header's community name (and the lit tab) leads
// with All communities. Its tile was filled near-black with a white people
// glyph, and the same list holds Homeroom's own community, whose icon is a
// cream H on near-black: two dark squares in one list, the first reading as
// a second Homeroom. The tab already drew All communities differently, as the
// people glyph in a square ring (`.platform-tab-ring-all`), and the owner
// asked for that one in the switcher too.
//
// Pinned, each a way the two can drift apart again:
//
//   1. THE SAME GLYPH. The switcher's All tile draws the very icon the tab
//      draws for All communities, path for path.
//   2. THE SAME RING, NOT A FILL. The tile is transparent with the tab's 2px
//      inset ring in the ink it sits in; no colour of its own, so it follows
//      the theme the way the tab does, and no dark fill in either theme.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const CSS = read('public/css/app.css');

const fixedStore = (state) => ({ get: () => state, set() {}, subscribe: () => () => {} });

function switcherAllTile() {
  const real = loadTsx('frontend/src/features/workshop/community-scope.ts');
  const mod = loadTsx('frontend/src/features/workshop/community-switcher.tsx', {
    stubs: {
      './community-scope': {
        ...real,
        communityScopeStore: fixedStore({ slug: null, info: {}, list: [], totalNeeds: 0, switcher: 'header', anchor: null }),
      },
    },
  });
  const html = renderToHtml(createElement(mod.SwitcherBody, {}));
  const row = html.match(/<button[^>]*data-switcher-community="all"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(row, 'the All communities row renders');
  const tile = row[0].match(/<span class="community-switcher-tile community-switcher-tile-all" aria-hidden="true">([\s\S]*?)<\/span>/);
  assert.ok(tile, 'with its tile first');
  return tile[1];
}

function tabAllFace() {
  const ui = loadTsx('tests/fixtures/tab-bar-api.ts');
  const html = renderToHtml(createElement(ui.PlatformTabs, {}));
  const face = html.match(/<span class="platform-tab-ring platform-tab-ring-all" aria-hidden="true">([\s\S]*?)<\/span>/);
  assert.ok(face, 'the tab draws All communities as its ring (the prerender)');
  return face[1];
}

const pathsOf = (svg) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);
const ruleFor = (selector) => {
  const at = CSS.indexOf(`\n${selector} {`);
  assert.ok(at >= 0, `${selector} has a rule`);
  return CSS.slice(at, CSS.indexOf('}', at));
};

// ── 1. The same glyph ─────────────────────────────────────────────────

test('the switcher\'s All communities tile draws the tab\'s All communities glyph', () => {
  const tile = switcherAllTile();
  const face = tabAllFace();
  assert.ok(pathsOf(tile).length > 0, 'the tile holds a drawn glyph');
  assert.deepEqual(pathsOf(tile), pathsOf(face), 'path for path the people glyph the tab draws');
  assert.doesNotMatch(tile, /class="/, 'sized by app.css with the tile, as the tab sizes its own, not by a utility');
});

// ── 2. The same ring, not a fill ──────────────────────────────────────

test('the tile is the tab\'s ring in the row\'s own ink, with no dark fill in either theme', () => {
  const tile = ruleFor('.community-switcher-tile-all');
  assert.match(tile, /background: transparent;/, 'no fill of its own');
  assert.match(tile, /color: inherit;/, 'the row\'s ink, which follows the theme');
  assert.match(tile, /box-shadow: inset 0 0 0 2px currentColor;/, 'a 2px ring in that ink');
  assert.match(ruleFor('.platform-tab-ring'), /box-shadow: inset 0 0 0 2px var\(--ring, currentColor\);/,
    'the same ring the tab draws (which takes a community\'s colour when it has one)');
  assert.doesNotMatch(tile, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'no fixed colour, so no near-black tile');
  assert.doesNotMatch(CSS, /\.dark \.community-switcher-tile-all/, 'and no dark-theme twin to keep in step');
  // The glyph keeps the tab's proportion (18px in a 28px ring) at both sizes.
  assert.match(CSS, /\n\.community-switcher-tile-all > svg \{ width: 26px; height: 26px; stroke-width: 1\.8; \}/,
    '26px in the sheet\'s 40px tile, with the tab glyph\'s stroke');
  assert.match(CSS, /\n\.community-switcher-menu \.community-switcher-tile-all > svg \{ width: 22px; height: 22px; \}/,
    '22px in the wide menu\'s 34px tile');
});
