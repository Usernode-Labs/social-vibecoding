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
    'card-menu-btn', 'home-panel-slot',
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
