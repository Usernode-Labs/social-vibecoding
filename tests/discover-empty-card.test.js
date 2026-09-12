'use strict';

// #1913: with nothing featured, Discover shows a card — the rail's tinted
// plate — that links on to the directory, instead of a grey 12px caption.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
const ENTRY = 'frontend/src/features/home/panels/discover.tsx';

function render(featured) {
  return renderComponent(ENTRY, 'DiscoverPanel', {
    view: { key: 'discover', featured, popular: [] },
  });
}

test('nothing featured renders one card that links to the directory', () => {
  const html = render([]);
  const m = html.match(/<a href="#apps" class="([^"]*home-discover-empty[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
  assert.ok(m, 'the empty state is an anchor to #apps');
  const classes = m[1].split(/\s+/);
  assert.ok(classes.includes('home-discover-lane'), 'it still fills the lane');
  assert.ok(classes.some((c) => /^home-tint-[1-5]$/.test(c)), 'in the rail\'s tint language');
  assert.match(m[2], /Nothing featured right now/, 'the wording the declared check reads');
  assert.match(m[2], /Browse the directory/);
  assert.match(m[2], /<svg/, 'with a chevron');
});

// The featured branch (no empty card) is covered by
// tests/home-panels-render.test.js, which renders the block with a full tile
// model.

test('the card is drawn as a card: tint plate, hairline, radius', () => {
  const i = CSS.indexOf('\n.home-discover-empty {');
  assert.ok(i >= 0);
  const body = CSS.slice(i, CSS.indexOf('\n}', i));
  assert.match(body, /background: var\(--tint-bg\);/);
  assert.match(body, /border: 1px solid var\(--tint-line\);/);
  assert.match(body, /border-radius: 0\.875rem;/, 'the Discover card radius');
});
