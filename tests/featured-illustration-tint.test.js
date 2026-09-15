// The card colour a featured illustration is saved with.
//
// A Discover card has always worn one of five theme tints, picked by hashing
// its slug. That is still the DEFAULT. This covers the OVERRIDE: a colour
// chosen in the illustration editor, saved beside the framing, and rendered by
// the card after a reload.
//
// There are two sets behind that override, and the split is the thing this
// file exists to keep honest:
//
//   TONES — the twelve tone-50 colours of the HIG-muted palette, which is
//   what the picker offers. Named, not indexed, so the wire value survives
//   the palette being reordered.
//
//   LEGACY_TINTS — the five hashed tints, which the picker offered briefly
//   before the tones. They are no longer offered and are still stored, so
//   "previously saved values still render" is a property with a test rather
//   than an intention.
//
// Four things are worth pinning, and the last is why this file is separate
// from the framing suite:
//
//   1. The vocabulary is closed and its CSS exists. Twelve tones plus five
//      legacy tints, enumerable, no hex anywhere in the UI — an arbitrary
//      colour is precisely what this field is not.
//   2. The server's copy of the list matches the frontend's. It cannot
//      require a .tsx, so the duplication is real and this is what stops the
//      two drifting.
//   3. `cardTint` is ONE function taking the stored value and the key,
//      because the fallback has to be identical on the server prerender and
//      on the client. A colour that differed between them is a hydration
//      mismatch, which console-errors and fails the proposal checks.
//   4. The picker is staged, not applied: the editor writes nothing before
//      Save, so Cancel leaves the saved colour alone. Effects do not run
//      under renderToStaticMarkup and the picker only exists once an image is
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
const {
  TONES, LEGACY_TINTS, tintOf, cardTintClass, cardTint, toneLabel,
} = loadTsx('frontend/src/features/home/panels/ui.tsx');

// The palette as the attached reference states it: hue family -> tone 50,
// which is the colour the swatch shows and the card body wears. Written out
// rather than read back from the CSS, so a mistyped digit in either place is
// a failure rather than a shared truth.
const TONE_50 = {
  cream: '#fefdf5', yellow: '#fff9de', orange: '#fff0e0', coral: '#fde8e4',
  pink: '#f8e4ee', purple: '#ede4f4', indigo: '#e4e8f6', blue: '#deedf8',
  teal: '#deeeed', mint: '#e2f2e8', sage: '#eaf2e4', gray: '#f4f3f1',
};

const tile = (illustration) => ({
  slug: 'gym', name: 'Gym', status: 'ready', demo: false, added: false,
  icon: { kind: 'letter', letter: 'G' }, blurb: null, contributors: 0, illustration,
});
const art = (extra) => ({ url: '/app-illustrations/' + 'a'.repeat(32), zoom: 1, x: 0, y: 0, ...extra });

test('the palette is twelve tones plus the five legacy tints, and nothing else', () => {
  assert.deepEqual([...TONES], Object.keys(TONE_50));
  assert.deepEqual([...LEGACY_TINTS], [1, 2, 3, 4, 5]);
  for (const tone of TONES) assert.equal(cardTintClass(tone), `home-tone-${tone}`);
  for (const n of LEGACY_TINTS) assert.equal(cardTintClass(n), `home-tint-${n}`);
  assert.equal(toneLabel('cream'), 'Cream');
  // Everything outside the two sets is not a card colour, including a near
  // miss in the other set's shape: a tone is stored as its name and a legacy
  // tint as a number, and neither is read loosely.
  for (const bad of [0, 6, -1, 1.5, '3', 'Blue', 'lilac', '', null, undefined, NaN, {}, ['blue']]) {
    assert.equal(cardTintClass(bad), null, `not a card colour: ${JSON.stringify(bad)}`);
  }
  // Every class either set can produce is declared in the CSS, in both modes,
  // and each tone body is the exact tone-50 hex from the palette.
  const css = read('public/css/app.css');
  for (const [tone, hex] of Object.entries(TONE_50)) {
    assert.match(css, new RegExp(`\\.home-tone-${tone} \\{ --tone-50: ${hex};[^}]*--tone-light-line`), tone);
    assert.ok(css.includes(`.home-tone-${tone}`), `shared dark formula includes ${tone}`);
  }
  for (const n of LEGACY_TINTS) assert.match(css, new RegExp(`\\.home-tint-${n}[^{}]*\\{[^}]*--tint-bg`));
});

test('the server accepts exactly the colours the frontend can produce', () => {
  // Two copies of one list, because a route cannot require a .tsx. Drift here
  // is a colour the editor offers and the API rejects, which is a save that
  // fails on the one field the user just touched.
  const { TONES: serverTones, LEGACY_TINTS: serverTints, parseFraming } =
    require('../src/routes/app-illustrations');
  assert.deepEqual(serverTones, [...TONES]);
  assert.deepEqual(serverTints, [...LEGACY_TINTS]);
  const frame = { zoom: 1, x: 0, y: 0 };
  for (const tone of TONES) assert.deepEqual(parseFraming({ ...frame, tint: tone }), { ...frame, tint: tone });
  for (const n of LEGACY_TINTS) assert.deepEqual(parseFraming({ ...frame, tint: n }), { ...frame, tint: n });
});

test('a chosen colour wins, and the slug hash is what an app without one keeps', () => {
  assert.equal(cardTint('gym'), tintOf('gym'));
  assert.equal(cardTint('gym', null), tintOf('gym'));
  assert.equal(cardTint('gym', 'blue'), 'home-tone-blue');
  // Saved before the tones existed, and still rendered as it always was.
  assert.equal(cardTint('gym', 4), 'home-tint-4');
  // A stored value outside both sets falls back rather than rendering a class
  // with no rules behind it, which would paint the card's own text on white.
  assert.equal(cardTint('gym', 99), tintOf('gym'));
  assert.equal(cardTint('gym', 'chartreuse'), tintOf('gym'));
  // Deterministic: the prerender and the client must agree on every branch.
  for (const stored of [undefined, 'mint', 2, 99]) {
    assert.equal(cardTint('gym', stored), cardTint('gym', stored));
  }
});

test('the Discover card renders the saved colour, the legacy one, and the default', () => {
  const { DiscoverCard } = loadTsx('frontend/src/features/home/panels/discover.tsx');
  const chosen = renderToHtml(createElement(DiscoverCard, { tile: tile(art({ tint: 'teal' })), preview: true }));
  assert.match(chosen, /class="app-card home-discover-card home-tone-teal /);
  assert.ok(!/home-tint-[1-5] /.test(chosen), 'a tone card wears no tint class as well');
  const legacy = renderToHtml(createElement(DiscoverCard, { tile: tile(art({ tint: 5 })), preview: true }));
  assert.match(legacy, /class="app-card home-discover-card home-tint-5 /);
  for (const without of [tile(art()), tile(art({ tint: 0 })), tile(art({ tint: 'lilac' })), tile(null)]) {
    const html = renderToHtml(createElement(DiscoverCard, { tile: without, preview: true }));
    assert.match(html, new RegExp(`class="app-card home-discover-card ${tintOf('gym')} `));
  }
});

test('the editor offers the twelve tones, staged, and no arbitrary colour', () => {
  const editor = read('frontend/src/features/apps/featured-illustration-editor.tsx');
  // One palette, read from the shared vocabulary rather than re-listed here.
  assert.match(editor, /import \{ TONES, cardTintClass, toneLabel \} from '\.\.\/home\/panels\/ui'/);
  assert.ok(!/#[0-9a-fA-F]{6}|type="color"/.test(editor), 'no hex field and no arbitrary colour input');
  // A radiogroup, so the swatches are one control to a screen reader, and each
  // is labelled by the colour's own name rather than its position.
  assert.match(editor, /role="radiogroup" aria-label="Card colour"/);
  assert.match(editor, /TONES\.map\(tone => \{/);
  assert.match(editor, /aria-label=\{toneLabel\(tone\)\}/);
  // Selection is the stored value itself, so an illustration carrying a legacy
  // tint marks no swatch rather than marking a tone it is not wearing.
  assert.match(editor, /const chosen = art\.tint === tone;/);
  // Staged: the picker only ever calls setArt, and the single fetch that
  // writes is save(). Nothing here can persist before Save, so Cancel is
  // still "writes nothing".
  assert.match(editor, /onClick=\{\(\) => setArt\(\{ \.\.\.art, tint: tone \}\)\}/);
  assert.equal((editor.match(/await fetch\(/g) || []).length, 1);
  // Omitted when unset, which is what leaves the app on the slug hash.
  assert.match(editor, /\.\.\.\(art\.tint \? \{ tint: art\.tint \} : null\)/);
  // Reset position replaces the frame only, and replacing the image keeps the
  // colour that was picked to sit with the artwork.
  assert.match(editor, /setArt\(\{ \.\.\.art, \.\.\.DEFAULT_FRAME \}\)/);
  assert.match(editor, /a \? \{ \.\.\.a, url \} : \{ url, \.\.\.DEFAULT_FRAME, tint: null \}/);
});

test('dark harmonic colours are computed from tone 50 with readable shared text', () => {
  const css = read('public/css/app.css');
  assert.match(css, /--tone-dark-bg: color-mix\(in srgb, var\(--tone-50\) 10%, #0b0b0c\)/);
  assert.match(css, /--tone-dark-art: color-mix\(in srgb, var\(--tone-50\) 14%, #0b0b0c\)/);
  const rgb = hex => hex.slice(1).match(/../g).map(n => parseInt(n, 16) / 255);
  const luminance = rgb => rgb.map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4)
    .reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
  for (const [name, hex] of Object.entries(TONE_50)) {
    const dark = rgb(hex).map((c, i) => .1 * c + .9 * rgb('#0b0b0c')[i]);
    const contrast = (luminance(rgb('#8e8e93')) + .05) / (luminance(dark) + .05);
    assert.ok(contrast >= 4.5, `${name} dark secondary text contrast ${contrast}`);
  }
});

test('light and dark images render with the same crop and a single colour', () => {
  const { DiscoverCard } = loadTsx('frontend/src/features/home/panels/discover.tsx');
  const illustration = art({ darkUrl: '/app-illustrations/' + 'b'.repeat(32), zoom: 2, x: 12, y: -9, tint: 'mint' });
  for (const previewTheme of ['light', 'dark']) {
    const html = renderToHtml(createElement(DiscoverCard, { tile: tile(illustration), preview: true, previewTheme }));
    assert.match(html, new RegExp(`data-preview-theme="${previewTheme}"`));
    assert.equal((html.match(/translate\(12%, -9%\) scale\(2\)/g) || []).length, 2);
    assert.match(html, /home-tone-mint/);
    assert.match(html, /illustration-light/); assert.match(html, /illustration-dark/);
  }
  const old = renderToHtml(createElement(DiscoverCard, { tile: tile(art()) }));
  assert.ok(!old.includes('illustration-dark'), 'a single-image record remains visible in both themes');
});
