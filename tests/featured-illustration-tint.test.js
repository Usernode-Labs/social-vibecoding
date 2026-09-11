// The card colour a featured illustration is saved with.
//
// A Discover card has always worn one of five theme tints, picked by hashing
// its slug. That is still the default, and it stays the default — this covers
// the OVERRIDE: a tint chosen in the illustration editor, saved beside the
// framing, and rendered by the card after a reload.
//
// Three things are worth pinning, and the third is the reason this file is
// separate from the framing suite:
//
//   1. The vocabulary is closed. Five tints, enumerable, no hex anywhere —
//      an arbitrary colour is precisely what this field is not.
//   2. `cardTint` is ONE function taking the stored value and the key,
//      because the fallback has to be identical on the server prerender and
//      on the client. A tint that differed between them is a hydration
//      mismatch, which console-errors and fails the proposal checks.
//   3. The picker is staged, not applied: the editor writes nothing before
//      Save, so Cancel leaves the saved tint alone. Effects do not run under
//      renderToStaticMarkup and the picker only exists once an image is
//      staged, so that half is asserted against the source.
//
// Run with: node --test tests/featured-illustration-tint.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const { TINTS, tintOf, tintClass, cardTint } = loadTsx('frontend/src/features/home/panels/ui.tsx');

const tile = (illustration) => ({
  slug: 'gym', name: 'Gym', status: 'ready', demo: false, added: false,
  icon: { kind: 'letter', letter: 'G' }, blurb: null, contributors: 0, illustration,
});
const art = (extra) => ({ url: '/app-illustrations/' + 'a'.repeat(32), zoom: 1, x: 0, y: 0, ...extra });

test('the palette is five tints and nothing else is a tint', () => {
  assert.deepEqual([...TINTS], [1, 2, 3, 4, 5]);
  for (const n of TINTS) assert.equal(tintClass(n), `home-tint-${n}`);
  // Everything outside the set is not a tint, including the string form of
  // one: the API stores a number and the card must not accept a near-miss.
  for (const bad of [0, 6, -1, 1.5, '3', null, undefined, NaN, {}, [1]]) {
    assert.equal(tintClass(bad), null, `not a tint: ${JSON.stringify(bad)}`);
  }
  // Every class the picker and the card can produce is declared in the CSS.
  const css = read('public/css/app.css');
  for (const n of TINTS) assert.match(css, new RegExp(`\\.home-tint-${n} \\{[^}]*--tint-bg`));
});

test('a chosen tint wins, and the slug hash is what an app without one keeps', () => {
  assert.equal(cardTint('gym'), tintOf('gym'));
  assert.equal(cardTint('gym', null), tintOf('gym'));
  assert.equal(cardTint('gym', 4), 'home-tint-4');
  // A stored value outside the five falls back rather than rendering a class
  // with no rules behind it, which would paint the card's own text on white.
  assert.equal(cardTint('gym', 99), tintOf('gym'));
  // Deterministic: the prerender and the client must agree on both branches.
  for (const stored of [undefined, 2, 99]) assert.equal(cardTint('gym', stored), cardTint('gym', stored));
});

test('the Discover card renders the saved tint, and the default without one', () => {
  const { DiscoverCard } = loadTsx('frontend/src/features/home/panels/discover.tsx');
  const chosen = renderToHtml(createElement(DiscoverCard, { tile: tile(art({ tint: 5 })), preview: true }));
  assert.match(chosen, /class="app-card home-discover-card home-tint-5 /);
  assert.ok(!/home-tint-[1-4] /.test(chosen), 'exactly one tint class on the card');
  for (const without of [tile(art()), tile(art({ tint: 0 })), tile(null)]) {
    const html = renderToHtml(createElement(DiscoverCard, { tile: without, preview: true }));
    assert.match(html, new RegExp(`class="app-card home-discover-card ${tintOf('gym')} `));
  }
});

test('the editor stages the tint with the framing and sends it only once picked', () => {
  const editor = read('frontend/src/features/apps/featured-illustration-editor.tsx');
  // One palette, read from the shared vocabulary rather than re-listed here.
  assert.match(editor, /import \{ TINTS, cardTint, tintClass \} from '\.\.\/home\/panels\/ui'/);
  assert.ok(!/#[0-9a-fA-F]{6}|type="color"/.test(editor), 'no hex field and no arbitrary colour input');
  // A radiogroup, so the five swatches are one control to a screen reader.
  assert.match(editor, /role="radiogroup" aria-label="Card colour"/);
  assert.match(editor, /TINTS\.map\(n => \{/);
  // The chosen swatch is derived from what the card will actually wear, so an
  // app that never picked one opens with its default already marked.
  assert.match(editor, /tintClass\(n\) === cardTint\(app\.slug, art\.tint\)/);
  // Staged: the picker only ever calls setArt, and the single fetch that
  // writes is save(). Nothing here can persist before Save, so Cancel is
  // still "writes nothing".
  assert.match(editor, /onClick=\{\(\) => setArt\(\{ \.\.\.art, tint: n \}\)\}/);
  assert.equal((editor.match(/await fetch\(/g) || []).length, 1);
  // Omitted when unset, which is what leaves the app on the slug hash.
  assert.match(editor, /\.\.\.\(art\.tint \? \{ tint: art\.tint \} : null\)/);
  // Reset position replaces the frame only, and replacing the image keeps the
  // colour that was picked to sit with the artwork.
  assert.match(editor, /setArt\(\{ \.\.\.art, \.\.\.DEFAULT_FRAME \}\)/);
  assert.match(editor, /\.\.\.DEFAULT_FRAME, tint: a\?\.tint \?\? null/);
});
