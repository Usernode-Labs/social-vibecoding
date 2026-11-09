// The nine looks of the one frame (docs/superpowers/plans/2026-11-09-frame-
// looks.md): glass and the eight others the 2026-11-06 screen tour kept.
// Each is one value of the head's window.Skin, drawn by app.css from
// html[data-skin="<id>"]: a token block in light and dark, a typeface from
// our own origin, and a few rules on the frame's hooks. This suite holds
// every look to the same contract, as a table; tests/glass-skin.test.js
// holds the Skin module, the hook and the picker.
//
// Run with: node --test tests/frame-looks.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

// id → what the look is made of. `family` leads the root font stack;
// `faces` are the families whose @font-face the look's block declares (a
// family another block already declares is used, not declared again).
const LOOKS = {
  glass: { family: 'Albert Sans', faces: ['albert-sans'], translucent: true },
  brandkit: { family: 'Geist', faces: ['source-serif-4'], translucent: false },
  workbench: { family: 'IBM Plex Sans', faces: ['ibm-plex-sans', 'ibm-plex-mono'], translucent: true },
  paper: { family: 'Instrument Sans', faces: ['instrument-sans'], translucent: false },
  pastel: { family: 'DM Sans', faces: ['dm-sans'], translucent: false },
  mosaic: { family: 'Urbanist', faces: ['urbanist'], translucent: true },
  sunrise: { family: 'Plus Jakarta Sans', faces: ['plus-jakarta-sans'], translucent: false },
  today: { family: 'Figtree', faces: ['figtree'], translucent: false },
  playground: { family: 'Nunito', faces: ['nunito'], translucent: false },
};

// directory under public/fonts → the family name and the files it ships.
const FONTS = {
  'albert-sans': { family: 'Albert Sans', files: ['AlbertSans-Variable.woff2', 'AlbertSans-Variable-latin-ext.woff2'] },
  'source-serif-4': { family: 'Source Serif 4', files: ['SourceSerif4-Variable.woff2', 'SourceSerif4-Variable-latin-ext.woff2'] },
  'ibm-plex-sans': { family: 'IBM Plex Sans', files: ['IBMPlexSans-Variable.woff2', 'IBMPlexSans-Variable-latin-ext.woff2'] },
  'ibm-plex-mono': { family: 'IBM Plex Mono', files: ['IBMPlexMono-500.woff2', 'IBMPlexMono-500-latin-ext.woff2'] },
  'instrument-sans': { family: 'Instrument Sans', files: ['InstrumentSans-Variable.woff2', 'InstrumentSans-Variable-latin-ext.woff2'] },
  'dm-sans': { family: 'DM Sans', files: ['DMSans-Variable.woff2', 'DMSans-Variable-latin-ext.woff2'] },
  urbanist: { family: 'Urbanist', files: ['Urbanist-Variable.woff2', 'Urbanist-Variable-latin-ext.woff2'] },
  'plus-jakarta-sans': { family: 'Plus Jakarta Sans', files: ['PlusJakartaSans-Variable.woff2', 'PlusJakartaSans-Variable-latin-ext.woff2'] },
  figtree: { family: 'Figtree', files: ['Figtree-Variable.woff2', 'Figtree-Variable-latin-ext.woff2'] },
  nunito: { family: 'Nunito', files: ['Nunito-Variable.woff2', 'Nunito-Variable-latin-ext.woff2'] },
};

// ── The typefaces ────────────────────────────────────────────────────────

test('every look\'s typeface is on our own origin with its licence and provenance beside it', () => {
  for (const [dir, { files }] of Object.entries(FONTS)) {
    for (const f of files) {
      const p = path.join(ROOT, 'public', 'fonts', dir, f);
      assert.ok(fs.existsSync(p), `public/fonts/${dir}/${f}`);
      assert.ok(fs.statSync(p).size > 5_000, `${dir}/${f} is a font file, not a stub`);
    }
    assert.match(read('public', 'fonts', dir, 'LICENSE.txt'), /SIL Open Font License/, `the OFL travels with ${dir}`);
    const readme = read('public', 'fonts', dir, 'README.md');
    assert.match(readme, /sha384/, `${dir}: the README carries each file's hash`);
    for (const f of files) assert.ok(readme.includes(`\`${f}\``), `${dir}: the README lists ${f}`);
    assert.match(readme, /@fontsource(-variable)?\/[a-z0-9-]+/, `${dir}: the README names the npm package it was copied from`);
  }
});

module.exports = { LOOKS, FONTS };
