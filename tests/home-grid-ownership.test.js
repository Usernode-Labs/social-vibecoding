// Nothing outside React may write inside a launcher card.
//
// #1191 made `#app-list` React-owned. The stateful-island rule in AGENTS.md
// says a region may hold state only when its ENTIRE subtree is React-owned —
// React reconciling over DOM another owner also mutates is the failure mode
// the whole migration is designed to avoid.
//
// That rule is easy to break back open by accident, because breaking it looks
// like a bug fix. Two methods in home.js did exactly this and were caught only
// by reading: `updateAppCardIcon` set `tile.innerHTML`, and `updateAppCardLock`
// set `card.dataset.locked`. Both already updated the `Home._apps` cache, so
// both were one `Home.render()` away from correct — and both would have been
// silently temporary, since the next store push repaints the old value straight
// back over them. Nothing throws; the icon just flickers back.
//
// So this pins the seam by SOURCE. A write into a card node is a mistake
// whether or not a test happens to exercise that path.
//
// Run with: node --test tests/home-grid-ownership.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { HOME_RAW } = require('./helpers/home-modules');

const GRID_TSX = fs.readFileSync(
  path.join(__dirname, '..', 'frontend', 'src', 'features', 'home', 'app-grid.tsx'), 'utf8',
);

// Lines that resolve a card (or a node inside one) and then WRITE to it.
// Reads are fine and there are legitimate ones — the drag overlay locates the
// dragged tile with exactly this selector to measure its rect.
const WRITE = /\.(innerHTML|textContent)\s*=|\.dataset\.\w+\s*=|(classList|setAttribute)\s*[.(]/;

function offendingLines(src) {
  const lines = src.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    // A card handle is anything derived from `.app-card` or `[data-icon]`.
    const touchesCard = /\.app-card\b|\[data-icon\]/.test(line);
    if (!touchesCard) return;
    // Look at this line and the two after it — the pattern is
    // `const tile = card?.querySelector(...)` then a write on the next line.
    const window_ = lines.slice(i, i + 3).join('\n');
    if (WRITE.test(window_)) out.push(`${i + 1}: ${line.trim().slice(0, 90)}`);
  });
  return out;
}

test('home.js never writes into a launcher card', () => {
  const found = offendingLines(HOME_RAW).filter((l) => (
    // The featured/browse grids are NOT React-owned and are rendered by the
    // string path, so `_wireDiscoveryCards` may still address their cards.
    !/_wireDiscoveryCards|hrefFor|featured/.test(l)
  ));
  assert.deepEqual(found, [],
    'these lines write into a React-owned card node — update the Home._apps cache'
    + ' and call Home.render() instead; the store is the only way in');
});

test('the card markup keeps the contract four other consumers select on', () => {
  // None of these fail loudly, which is why they are pinned here:
  //   * the kit's placement recognizer needs data-yours / data-demo;
  //   * App._tileFor (public/js/app.js) finds the zoom-out rect by data-slug;
  //   * app.css styles .app-icon-tile[data-icon], .app-card-title,
  //     .app-card-status;
  //   * dapp.json's declared checks select these chains.
  for (const token of [
    'app-card', 'data-slug', 'data-status', 'data-locked', 'data-yours',
    'data-demo', 'app-icon-tile', 'app-card-title', 'app-card-status',
    'aria-haspopup', 'onContextMenu', 'onKeyDown',
  ]) {
    assert.ok(GRID_TSX.includes(token),
      `app-grid.tsx no longer renders \`${token}\` — one of the kit, app.js,`
      + ' app.css or dapp.json selects on it');
  }
});

test('the grid renders no bare whitespace expression and no inline glyph', () => {
  // Both are covered globally (tests/shell-build.test.js, shell-icon-set), but
  // this file is the one most likely to grow markup, and a hydration mismatch
  // here is a console error on the home route — which fails proposal checks.
  assert.doesNotMatch(GRID_TSX, /\{' '\}/, 'use {\' word…\'} instead');
  assert.doesNotMatch(GRID_TSX, /<path\s/, 'import the glyph from @/components/ui/icons');
});

// #1838: the desktop right-click path. This is asserted on the SOURCE for the
// same reason the rest of this file is — the tile's handlers are props on a
// React-rendered element and there is no vm harness that renders them, so the
// only cheap lock on "did somebody put the unconditional bail back?" is the
// text. The bail is the thing that broke desktop: it made a right-click a
// no-op whenever any other tile's menu was still open.
test('onContextMenu is pointer-type aware and toggles by anchor (#1838)', () => {
  const handler = GRID_TSX.slice(
    GRID_TSX.indexOf('onContextMenu={'),
    GRID_TSX.indexOf('onKeyDown={'),
  );
  assert.ok(handler.length > 0, 'onContextMenu handler not found');

  assert.match(handler, /_cardPointerType/,
    'the handler must branch on the pointer type recorded at pointerdown:'
    + ' Android Chrome emits contextmenu mid-hold and the _menu bail is the'
    + ' only thing stopping a double-open there');
  assert.match(handler, /_cardPointerType === 'touch'/,
    'touch must be the explicitly guarded branch, so its behaviour is'
    + ' unchanged by anything the mouse path does');
  assert.match(handler, /_menuAnchorAtPress/,
    'the mouse toggle must decide from the anchor snapshot — the kit has'
    + ' already dismissed the menu by the time contextmenu arrives');
  assert.match(handler, /closeCardMenu/,
    'a right-click on the tile the menu is already on must close it');
  assert.match(handler, /openCardMenu\?\.\(app\.slug, e\.currentTarget\)/,
    'the menu must stay anchored to the tile that was right-clicked');

  // The pre-#1838 shape: `if (!controller()?._menu) controller()?.open…`
  // as the WHOLE handler body, with no pointer-type branch above it.
  const bails = handler.match(/if \(!\w+[?.]*\._menu\)/g) || [];
  assert.equal(bails.length, 1,
    'exactly one open-menu bail should remain, inside the touch branch');
  assert.ok(handler.indexOf("_cardPointerType === 'touch'") < handler.indexOf('._menu)'),
    'the open-menu bail must sit INSIDE the touch branch, not above it —'
    + ' above it is the #1838 desktop regression');
});

test('the tile still advertises the hold gesture and no hamburger (#1838)', () => {
  assert.match(GRID_TSX, /Hold or right-click for app actions/,
    'the tooltip is the discovery affordance for both mouse entry points');
  assert.doesNotMatch(GRID_TSX, /card-menu-btn/,
    '#1740 removed the per-tile hamburger badge on purpose — the fix for'
    + ' #1838 is a reachable gesture, not a restored button');
});
