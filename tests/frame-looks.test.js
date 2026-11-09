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
// family another block already declares is used, not declared again);
// `title` is the page title's size on a phone and from 768px, and its
// weight, as the tour's theme file gives them.
const LOOKS = {
  glass: { family: 'Albert Sans', faces: ['albert-sans'], translucent: true, title: [28, 36, null] },
  brandkit: { family: 'Geist', faces: ['source-serif-4'], translucent: false, title: [31, 44, 460] },
  workbench: { family: 'IBM Plex Sans', faces: ['ibm-plex-sans', 'ibm-plex-mono'], translucent: true, title: [20, 22, 650] },
  paper: { family: 'Instrument Sans', faces: ['instrument-sans'], translucent: false, title: [26, 34, null] },
  pastel: { family: 'DM Sans', faces: ['dm-sans'], translucent: false, title: [30, 42, null] },
  mosaic: { family: 'Urbanist', faces: ['urbanist'], translucent: true, title: [30, 40, 800] },
  sunrise: { family: 'Plus Jakarta Sans', faces: ['plus-jakarta-sans'], translucent: false, title: [28, 36, 800] },
  today: { family: 'Figtree', faces: ['figtree'], translucent: false, title: [34, 44, 800] },
  playground: { family: 'Nunito', faces: ['nunito'], translucent: false, title: [30, 38, 900] },
};
const IDS = Object.keys(LOOKS);

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

// ── The stylesheet ───────────────────────────────────────────────────────
//
// app.css, in this order: the frame's token defaults; what every look of
// the frame shares; one block per look, in the registry's order; and last
// the New look's block (data-skin="brand"), which is not one of these.

const appCss = () => read('public', 'css', 'app.css');
const DEFAULTS_MARK = '/* ── SKIN TOKEN DEFAULTS';
const SHARED_MARK = '/* ── THE FRAME\'S LOOKS';
const BRAND_MARK = '/* ── THE NEW LOOK, AN EXPERIMENT';
const ANY_LOOK = 'html[data-skin]:not([data-skin="brand"])';

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// A look's block: from the heading that names its attribute to the next
// heading. Only a heading says `(data-skin="<id>")`.
function lookStart(id) {
  const css = appCss();
  const named = css.indexOf(`(data-skin="${id}")`);
  assert.ok(named > 0, `app.css has a block headed (data-skin="${id}")`);
  return css.lastIndexOf('/* ── ', named);
}
function lookBlock(id) {
  const css = appCss();
  const start = lookStart(id);
  const next = css.indexOf('\n/* ── ', start + 1);
  return css.slice(start, next);
}
function sharedBlock() {
  const css = appCss();
  const at = css.indexOf(SHARED_MARK);
  assert.ok(at > 0, 'app.css carries the looks\' shared section');
  return css.slice(at, css.indexOf('\n/* ── ', at + 1));
}

// Every selector of a block, the @media / @supports wrappers (which only
// narrow where a rule applies) dropped.
function selectorsOf(block) {
  const flat = stripComments(block).replace(/@(media|supports)[^{]*\{/g, '');
  const out = [];
  for (const rule of flat.split('}').map((r) => r.trim()).filter(Boolean)) {
    const head = rule.slice(0, rule.indexOf('{')).trim();
    if (!head) continue;
    for (const sel of head.split(',').map((x) => x.trim())) out.push(sel);
  }
  return out;
}

// The declarations of the rule whose selector is exactly `selector`.
function bodyOf(block, selector) {
  const flat = stripComments(block);
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|[}{\\n])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(flat);
  return m ? m[1] : null;
}
const tokensOf = (body) => [...body.matchAll(/(--fr-[a-z0-9-]+)\s*:/g)].map((m) => m[1]);

test('the registry, the head and the stylesheet agree on the nine looks, in the tour\'s order', () => {
  const mod = require('./lib/render-tsx').loadTsx('frontend/src/lib/skin.ts');
  assert.deepEqual([...mod.FRAME_SKINS], IDS);
  const css = appCss();
  const d = css.indexOf(DEFAULTS_MARK);
  const sh = css.indexOf(SHARED_MARK);
  const b = css.indexOf(BRAND_MARK);
  assert.ok(d > 0 && d < sh, 'the token defaults come first');
  let last = sh;
  for (const id of IDS) {
    const at = lookStart(id);
    assert.ok(at > last, `${id}'s block follows the one before it`);
    last = at;
  }
  assert.ok(last < b, 'and the New look\'s block stays last');
});

test('what the looks share is said once, for every look but New look', () => {
  const block = sharedBlock();
  for (const sel of selectorsOf(block)) assert.ok(sel.startsWith(ANY_LOOK), `"${sel}" must start from ${ANY_LOOK}`);
  const root = bodyOf(block, ANY_LOOK);
  assert.ok(root, 'the product\'s own tokens are retargeted on the root');
  for (const [token, from] of [
    ['--text-primary', '--fr-ink'], ['--text-secondary', '--fr-mut'], ['--text-muted', '--fr-faint'],
    ['--border', '--fr-line'], ['--border-light', '--fr-line'], ['--accent', '--fr-acc'], ['--accent-ink', '--fr-acc-ink'],
    ['--accent-tint-ink', '--fr-acc'], ['--lit-ink', '--fr-lit'], ['--lit-tint', '--fr-lit-t'], ['--lit-line', '--fr-line'],
    ['--dc-sheet', '--fr-surface'], ['--dc-sheet-solid', '--fr-surface'], ['--dc-sheet-raise', '--fr-surface'],
    ['--app-sheet-line', '--fr-sheet-line'],
  ]) {
    assert.ok(root.includes(`${token}: var(${from});`), `${token} follows ${from} under a look`);
  }
  assert.ok(!root.includes('--accent-tint:'), 'the tint is a literal in each look\'s own block (dev-chat-ground holds its alpha)');
  assert.match(bodyOf(block, `${ANY_LOOK} .fr-row-t`), /color: var\(--fr-ink\)/, 'a row\'s name is the look\'s ink');
  assert.match(bodyOf(block, `${ANY_LOOK} .fr-row-s`), /color: var\(--fr-mut\)/, 'and its line the muted ink');
  assert.match(bodyOf(block, `${ANY_LOOK} .fr-card .fr-row::after`), /background: var\(--fr-line\)/, 'the hairline between rows is the look\'s line');
});

for (const id of IDS) {
  const look = LOOKS[id];
  const FLAG = `html[data-skin="${id}"]`;

  test(`${id}: every rule starts from its flag, in light and in dark`, () => {
    const block = lookBlock(id);
    const sels = selectorsOf(block);
    assert.ok(sels.length > 4, 'the block is read whole');
    for (const sel of sels) assert.ok(sel === '@font-face' || sel.startsWith(FLAG), `"${sel}" must start from ${FLAG}`);
    const light = bodyOf(block, FLAG);
    const dark = bodyOf(block, `${FLAG}.dark`);
    assert.ok(light && dark, 'a root block and a .dark block');
    // A light value outranks the dark DEFAULT (the flag is more specific
    // than .dark), so what light sets, dark sets again. Three tokens do
    // not change with the mode.
    const same = new Set(['--fr-blur', '--fr-sheet-line', '--fr-grad']);
    const inDark = new Set(tokensOf(dark));
    for (const token of tokensOf(light)) {
      if (!same.has(token)) assert.ok(inDark.has(token), `${token} is set in light, so dark must set it too`);
    }
    for (const token of ['--fr-surface', '--fr-sunk', '--fr-ink', '--fr-mut', '--fr-faint', '--fr-line', '--fr-acc', '--fr-acc-ink', '--fr-acc-t', '--fr-lit', '--fr-lit-t']) {
      assert.ok(tokensOf(light).includes(token), `${token} is the look's own`);
    }
    for (const body of [light, dark]) {
      assert.match(body, /--accent-tint: rgba\([^)]*\);/, 'the tint is a literal rgba in both modes');
    }
  });

  test(`${id}: its typeface leads the root stack and loads from our own origin`, () => {
    const block = lookBlock(id);
    const fam = look.family.replace(/ /g, ' ');
    assert.match(bodyOf(block, FLAG), new RegExp(`font-family:\\s*'${fam}',\\s*system-ui`));
    for (const dir of look.faces) {
      const { family, files } = FONTS[dir];
      for (const f of files) {
        const face = new RegExp(`@font-face\\s*\\{[^}]*font-family:\\s*'${family}';[^}]*url\\('/fonts/${dir}/${f.replace(/[.]/g, '\\.')}'\\) format\\('woff2'\\)[^}]*unicode-range:`);
        assert.match(block, face, `${family}: ${f} by an absolute, same-origin path, with its unicode range`);
      }
    }
  });

  test(`${id}: its title is ${look.title[0]}px on a phone and ${look.title[1]}px from 768px`, () => {
    const block = stripComments(lookBlock(id));
    const title = bodyOf(block, `${FLAG} .fr-title`);
    assert.ok(title, 'a rule on the title hook');
    assert.match(title, new RegExp(`font-size: ${look.title[0]}px;`));
    if (look.title[2]) assert.match(title, new RegExp(`font-weight: ${look.title[2]};`));
    assert.match(block, new RegExp(`@media \\(min-width: 768px\\) \\{[^@]*html\\[data-skin="${id}"\\] \\.fr-title \\{ font-size: ${look.title[1]}px; \\}`));
  });

  test(`${id}: ${look.translucent ? 'opaque where backdrop-filter is missing' : 'its surface is opaque'}`, () => {
    const block = lookBlock(id);
    if (!look.translucent) {
      assert.match(bodyOf(block, FLAG), /--fr-surface: #[0-9a-f]{6};/);
      assert.match(bodyOf(block, `${FLAG}.dark`), /--fr-surface: #[0-9a-f]{6};/);
      return;
    }
    const at = block.indexOf('@supports not (backdrop-filter: blur(1px))');
    assert.ok(at > 0, 'a fallback for browsers without backdrop-filter');
    const fallback = block.slice(at);
    assert.match(fallback, new RegExp(`html\\[data-skin="${id}"\\]\\s*\\{[^}]*--fr-surface:\\s*#[0-9a-f]{6}`));
    assert.match(fallback, new RegExp(`html\\[data-skin="${id}"\\]\\.dark\\s*\\{[^}]*--fr-surface:\\s*#[0-9a-f]{6}`));
  });

  test(`${id}: leaves the counted wallpaper and frost tokens alone`, () => {
    const block = lookBlock(id);
    for (const token of ['--home-wallpaper:', '--home-washes:', '--home-star:', '--home-grain:', '--dc-sheet-fill:', '--dc-frost:']) {
      assert.ok(!block.includes(token), `${token} is counted elsewhere and must not be redeclared here`);
    }
    // The ground moves under one look only: the Brand kit's page is cream.
    assert.equal(block.includes('--home-ground:'), id === 'brandkit');
  });
}

// ── What makes each look itself ──────────────────────────────────────────

const rule = (id, selector) => bodyOf(lookBlock(id), `html[data-skin="${id}"] ${selector}`);
const wide = (id) => {
  const block = stripComments(lookBlock(id));
  const at = block.indexOf('@media (min-width: 768px)');
  assert.ok(at > 0, `${id} has rules from 768px`);
  return block.slice(at);
};

test('glass: sentence-case labels, 24px panes, a glow under the main button', () => {
  assert.match(rule('glass', '.fr-label'), /font-size: 13px;[^}]*font-weight: 650;[^}]*text-transform: none;/);
  assert.match(rule('glass', '.fr-card'), /border-radius: 24px;/);
  assert.match(rule('glass', '.fr-btn'), /box-shadow: 0 12px 24px -12px var\(--fr-acc\);/);
  assert.match(rule('glass', '.fr-btn-quiet'), /box-shadow: inset 0 0 0 1px var\(--fr-ring\);/);
  assert.match(bodyOf(lookBlock('glass'), 'html[data-skin="glass"]'), /--fr-sheet-line: var\(--fr-ring\);/, 'its sheets elsewhere keep the bright ring');
});

test('brandkit: a cream page, a serif title, labels in mono, a yellow button with a thin black edge', () => {
  const block = stripComments(lookBlock('brandkit'));
  assert.match(block, /html\[data-skin="brandkit"\]:not\(\.dark\):not\(\[data-app-tone="dark"\]\) body:has\(#platform-tabs\) \{[^}]*--home-ground: #fffeea;[^}]*background: #fffeea;/);
  assert.match(block, /html\[data-skin="brandkit"\]\.dark body:has\(#platform-tabs\) \{[^}]*background: #000000;/);
  assert.match(rule('brandkit', '.fr-title'), /font-family: 'Source Serif 4',/);
  assert.match(rule('brandkit', '.fr-label'), /font-family: 'Geist Mono',[^}]*text-transform: none;/);
  assert.match(rule('brandkit', '.fr-btn'), /background: #ffee6f;[^}]*color: #000000;[^}]*box-shadow: inset 0 0 0 1px rgba\(0, 0, 0, 0\.82\);/);
  assert.match(rule('brandkit', '.fr-card'), /border-radius: 14px;/);
});

test('workbench: one line per row from 768px, mono labels, small square controls', () => {
  assert.match(wide('workbench'), /html\[data-skin="workbench"\] \.fr-main \.fr-row-tx \{[^}]*display: flex;[^}]*align-items: baseline;/);
  assert.match(wide('workbench'), /html\[data-skin="workbench"\] \.fr-row \{ min-height: 42px; \}/);
  assert.doesNotMatch(wide('workbench'), /\.fr-side \.fr-row-tx/, 'the side column keeps two lines');
  assert.match(rule('workbench', '.fr-label'), /font-family: 'IBM Plex Mono',/);
  assert.match(rule('workbench', '.fr-card'), /border-radius: 10px;/);
  assert.match(rule('workbench', '.fr-btn'), /height: 32px;[^}]*border-radius: 8px;/);
  assert.match(wide('workbench'), /html\[data-skin="workbench"\] \.fr-cols \{[^}]*grid-template-columns: minmax\(0, 1fr\) 300px;/, 'a wider content column');
});

test('paper: the page is one white sheet, its groups grey panels with no outline', () => {
  assert.match(rule('paper', '.fr-page'), /background: var\(--fr-surface\);/);
  assert.match(wide('paper'), /html\[data-skin="paper"\] \.fr-page \{[^}]*border-radius: 22px;/);
  assert.match(rule('paper', '.fr-card'), /background: var\(--fr-sunk\);[^}]*border-radius: 16px;/);
  assert.match(bodyOf(lookBlock('paper'), 'html[data-skin="paper"]'), /--fr-ring: transparent;/);
});

test('pastel: the groups take lavender, pink and peach in turn', () => {
  const block = stripComments(lookBlock('pastel'));
  for (const [n, t] of [['3n+1', 't1'], ['3n+2', 't2'], ['3n', 't3']]) {
    assert.ok(block.includes(`html[data-skin="pastel"] .fr-group:nth-child(${n} of .fr-group) > .fr-card { background: var(--fr-${t}); }`), `${n} is --fr-${t}`);
  }
  assert.match(rule('pastel', '.fr-card'), /border-radius: 26px;/);
  assert.match(rule('pastel', '.fr-lead:not(.fr-lead-pic)'), /background: var\(--fr-in\);[^}]*border-radius: 50%;/);
});

test('mosaic: in the main column a list is a grid of tiles, two across from 768px', () => {
  const grid = rule('mosaic', '.fr-main .fr-card:has(> .fr-row)');
  assert.match(grid, /display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(grid, /background: none;/);
  assert.match(wide('mosaic'), /html\[data-skin="mosaic"\] \.fr-main \.fr-card:has\(> \.fr-row\) \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(rule('mosaic', '.fr-main .fr-card:has(> .fr-row) > .fr-row'), /border-radius: 20px;[^}]*background: var\(--fr-surface\);/);
  assert.match(rule('mosaic', '.fr-main .fr-card:has(> .fr-row) > .fr-row::after'), /content: none;/, 'a tile has no hairline under it');
  assert.doesNotMatch(stripComments(lookBlock('mosaic')), /\.fr-side \.fr-card:has/, 'the side column stays a list');
});

test('sunrise: one gradient, for the main button', () => {
  assert.match(bodyOf(lookBlock('sunrise'), 'html[data-skin="sunrise"]'), /--fr-grad: linear-gradient\(100deg, #ffb59c 0%, #ff93bb 52%, #bda2ff 100%\);/);
  assert.match(rule('sunrise', '.fr-btn'), /background: var\(--fr-grad\);[^}]*color: #17182f;/);
  assert.match(rule('sunrise', '.fr-btn-quiet'), /background: var\(--fr-sunk\);/, 'the quiet button never wears it');
});

test('today: 22px group names, 72px rows, 48px pictures', () => {
  assert.match(rule('today', '.fr-label'), /font-size: 22px;[^}]*font-weight: 800;[^}]*text-transform: none;[^}]*color: var\(--fr-ink\);/);
  assert.match(rule('today', '.fr-row'), /min-height: 72px;/);
  assert.match(rule('today', '.fr-lead'), /width: 48px;[^}]*height: 48px;/);
  assert.match(rule('today', '.fr-card'), /border-radius: 24px;/);
});

test('playground: everything is a block with a solid bottom edge, and nothing is thin', () => {
  assert.match(bodyOf(lookBlock('playground'), 'html[data-skin="playground"]'), /--fr-edge: 0 3px 0 rgba\(31, 42, 68, 0\.14\);/);
  assert.match(bodyOf(lookBlock('playground'), 'html[data-skin="playground"]'), /--fr-glow: 0 0 0 2px rgba\(31, 42, 68, 0\.08\), 0 3px 0 rgba\(31, 42, 68, 0\.14\);/);
  assert.match(rule('playground', '.fr-btn'), /font-weight: 900;[^}]*box-shadow: var\(--fr-edge\);/);
  assert.match(rule('playground', '.fr-card .fr-row::after'), /height: 2px;/, 'dividers are 2px, never hairlines');
});

// ── The section as a whole ───────────────────────────────────────────────

test('every hook a look\'s rule selects on is one the frame renders', () => {
  const css = appCss();
  const section = stripComments(css.slice(css.indexOf(SHARED_MARK), css.indexOf(BRAND_MARK)));
  const used = new Set([...section.matchAll(/\.(fr-[a-z-]+)/g)].map((m) => m[1]));
  const rendered = read('frontend', '@', 'components', 'ui', 'frame.tsx') + read('frontend', '@', 'components', 'ui', 'status.tsx')
    + read('frontend', 'src', 'features', 'home', 'frame', 'home-frame.tsx');
  assert.ok(used.size >= 10, 'the section is read');
  for (const hook of used) assert.match(rendered, new RegExp(`['"\` ]${hook}['"\` ]`), `.${hook} is selected on but no primitive renders it`);
});

test('the frame tokens are namespaced, so no existing var(--x, fallback) changes meaning', () => {
  // `--ring` was read as `var(--ring, currentColor)` by .platform-tab-ring:
  // a bare name on :root would have silently replaced that fallback. Every
  // token the frame declares carries the --fr- prefix, nothing else in the
  // sheet declares one, and nothing reads one with a fallback.
  const css = appCss();
  const d = css.indexOf(DEFAULTS_MARK);
  const b = css.indexOf(BRAND_MARK);
  const mine = css.slice(d, b);
  const declared = [...mine.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]);
  // The product's own tokens a look retargets, and the two the Brand kit's
  // cream page moves with the ground (as the New look's plate does).
  const newOnes = declared.filter((t) => !/^--(text-|border|accent|lit-|dc-|app-sheet|home-ground$|un-zoom-bg$)/.test(t));
  assert.ok(newOnes.length >= 16, 'the frame declares its tokens here');
  for (const token of newOnes) assert.match(token, /^--fr-/, `${token} must be namespaced`);
  const elsewhere = css.slice(0, d) + css.slice(b);
  assert.doesNotMatch(elsewhere, /^\s*--fr-[a-z0-9-]+\s*:/m, 'no --fr- token is declared outside the frame\'s own sections');
  assert.doesNotMatch(css, /var\(--fr-[a-z0-9-]+\s*,/, 'no reader relies on a fallback for a frame token');
  for (const f of ['frontend/@/components/ui/frame.tsx', 'frontend/@/components/ui/status.tsx', 'frontend/src/features/home/frame/home-frame.tsx']) {
    const src = read(...f.split('/'));
    const bare = src.match(/var\(--(surface|sunk|ink|mut|faint|line|acc|acc-ink|acc-t|lit|lit-t|ok|ok-t|wait|wait-t|bad|bad-t|ring|glow|glass-blur)\)/g);
    assert.equal(bare, null, `${f} reads an un-namespaced token: ${bare}`);
  }
});

test('the token defaults cover the standard look, in light and dark', () => {
  const css = appCss();
  const defaults = css.slice(css.indexOf(DEFAULTS_MARK), css.indexOf(SHARED_MARK));
  for (const token of ['--fr-surface:', '--fr-ink:', '--fr-mut:', '--fr-acc:', '--fr-acc-ink:', '--fr-lit:', '--fr-lit-t:', '--fr-ok:', '--fr-ok-t:', '--fr-wait:', '--fr-wait-t:', '--fr-bad:', '--fr-bad-t:', '--fr-ring:', '--fr-glow:', '--fr-blur:', '--fr-sheet-line:']) {
    assert.ok(defaults.includes(token), `${token} has a default for the standard look`);
  }
  assert.match(defaults, /\n\.dark\s*\{/, 'and dark defaults');
  assert.match(defaults, /--fr-glow: 0 0 #0000;/, 'a no-op shadow, not `none`: `none` inside a comma list voids the whole box-shadow');
  assert.match(defaults, /--fr-sheet-line: var\(--fr-line\);/, 'not var(--app-sheet-line): a look points that token back here');
});
