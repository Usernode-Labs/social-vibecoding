// Guards for the three ways a colour picked against the pre-reskin DARK shell
// goes wrong once the same markup renders on a light page.
//
// The reskin's palette is theme-following: #eaeaea page, white cards in light;
// #0b0b0c page, #1c1c1e cards in dark. Every rule below is here because a
// Playwright sweep over the running app — computing each text node's real
// contrast against the surface actually behind it, and each control's fill
// against the surface behind IT — measured a live failure of that exact shape.
// The numbers in each test are the ones that sweep reported before the fix.
//
// These are static assertions over source text, in the style of
// tests/dev-color-tokens.test.js and tests/admin-ui-registry.test.js. They
// cannot see layout, so they check the SPELLINGS that were wrong, not the
// rendered result. That is the cheap half; the sweep is the thorough half and
// it needs a live server.
//
// Run with: node --test tests/theme-ink-guards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// Every shell source that renders markup. The admin console is EXCLUDED on
// purpose — it is the other design system (AGENTS.md, "Two design systems"),
// it is gray/indigo rather than zinc/violet, and it is not part of the reskin.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || p.includes(path.join('features', 'admin'))) continue;
      walk(p, out);
    } else if (/\.(tsx?|js)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = [
  ...walk(path.join(root, 'frontend', 'src')),
  ...walk(path.join(root, 'frontend', '@')),
  ...walk(path.join(root, 'public', 'js')),
].filter((p) => !p.includes(path.join('features', 'admin')));

const SOURCES = FILES.map((p) => ({ path: path.relative(root, p), text: fs.readFileSync(p, 'utf8') }));

// A source whose own chrome is dark in BOTH themes. `hover:text-zinc-100` and
// a bare `-400` ink are correct there and a `dark:` variant would be a no-op
// that implies otherwise, so these files are exempt from the two ink rules.
const ALWAYS_DARK = [
  'staging-overlay.tsx',      // the staging dock, bg-zinc-950
  'visual-compare-overlay.tsx',
  'dev-console/index.tsx',    // the developer terminal, bg-zinc-950
];
const themed = (s) => !ALWAYS_DARK.some((n) => s.path.endsWith(n));

// Strip block and line comments: these files explain the very spellings the
// rules below ban, and prose about a class is not a class.
function code(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ');
}

// ── 1. A hover that moves UP the neutral ramp ───────────────────────────
//
// `text-zinc-400 hover:text-zinc-100` brightens the glyph on dark chrome and
// is right there. On a light page zinc-100 IS the page ground (#eaeaea), so
// the control disappeared exactly as the cursor reached it. Fourteen shipped
// like that: the header's back button, the drawer's ×, two dialogs' ×, the
// wallet link, two auth buttons and the dev-chat back arrow.

test('no hover brightens a control toward the light page ground', () => {
  const bad = [];
  for (const s of SOURCES.filter(themed)) {
    const src = code(s.text);
    const re = /hover:text-(?:zinc|violet)-(?:100|200|300)\b/g;
    let m;
    while ((m = re.exec(src))) {
      // A `dark:`-qualified one is the correct half of a themed pair.
      const at = src.lastIndexOf('dark:', m.index);
      if (at >= 0 && m.index - at <= 'dark:'.length) continue;
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${s.path}:${line} ${m[0]}`);
    }
  }
  assert.deepEqual(bad, [],
    'a hover state must darken on a light ground; put the brightening one behind dark:');
});

// ── 2. A -400 status ink with no light counterpart ──────────────────────
//
// emerald/amber/red/violet at -400 are dark-shell values. On the light page
// the credit line's "$0.00" measured 1.6:1, the "AI" role label 1.9:1, the
// fork dialog's three legend labels 2.0-2.3:1. The fix everywhere is the
// -700 in light with the -400 kept behind `dark:`.

test('no bare -400 status ink outside the always-dark chrome', () => {
  const bad = [];
  const HUES = 'emerald|amber|red|violet|sky|yellow|indigo|green|rose|orange|teal';
  for (const s of SOURCES.filter(themed)) {
    const src = code(s.text);
    const re = new RegExp(`(?<!dark:)\\btext-(${HUES})-400\\b`, 'g');
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${s.path}:${line} ${m[0]}`);
    }
  }
  // This one is a BUDGET rather than a ban: 200-odd of these predate the
  // reskin and most sit on surfaces the sweep has not reached (error states,
  // rarely-open panels). The number may only go DOWN — a new bare -400 is a
  // new light-mode contrast bug, and lowering this line is how a fix is
  // recorded.
  const BUDGET = 200;
  assert.ok(bad.length <= BUDGET,
    `bare -400 status inks: ${bad.length} > ${BUDGET}. Newly added:\n  ${bad.slice(0, 8).join('\n  ')}`);
});

// ── 3. An `outline` Button with no ink ──────────────────────────────────
//
// @/components/ui/button.tsx's `outline` variant carries a border and NO text
// colour, and the table's default ink is `solid` — white. So `variant="outline"`
// on its own renders white text on a white card. The three messages dialogs
// shipped their Cancel/Cancel/Done buttons that way: present, clickable and
// blank, at 1.00:1.

test('every outline Button states its ink', () => {
  const bad = [];
  for (const s of SOURCES) {
    if (!s.path.endsWith('.tsx')) continue;
    const src = code(s.text);
    // Each <Button …> opening tag, whichever way it is wrapped.
    const re = /<Button\b[^>]*>/g;
    let m;
    while ((m = re.exec(src))) {
      const tag = m[0];
      if (!/variant=["']outline["']/.test(tag)) continue;
      if (/\bink=/.test(tag)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      bad.push(`${s.path}:${line}`);
    }
  }
  assert.deepEqual(bad, [],
    'variant="outline" has no ink of its own and the default is white — pass ink="muted" or use variant="neutral"');
});

// ── 4. Every dark-block token has a light one, and vice versa ───────────
//
// --text-muted was the single variable in the .dark palette block with no
// dark value at all: it inherited #6c6c70 from :root, so on a near-black page
// it was as dark as on a near-white one. Ninety-two rules read it, and the
// create modal's unselected segment pills came out at 2.7:1 because of it.

test('the light and dark palettes declare the same variables', () => {
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8');
  const block = (marker) => {
    const i = css.indexOf(marker);
    assert.ok(i >= 0, `expected a ${marker} block`);
    const open = css.indexOf('{', i);
    return css.slice(open, css.indexOf('\n}', open));
  };
  const names = (b) => new Set(b.match(/--[a-z0-9-]+(?=\s*:)/g) || []);
  const light = names(block(':root {'));
  const dark = names(block('.dark {'));
  // Two documented exceptions, and the point of listing them here is that a
  // THIRD one has to be argued for rather than merely omitted.
  const THEME_INVARIANT = new Set([
    // An app's identity tint is its ICON, and an icon does not invert with the
    // page — see the header of frontend/@/components/ui/icon-tile.tsx. The ink
    // on them is pinned near-black in both themes for the same reason.
    '--tile-lime', '--tile-sky', '--tile-amber', '--tile-rose', '--tile-lilac',
    '--tile-sand', '--tile-ink',
    // Layout insets (env(safe-area-inset-*)), not colours.
    '--platform-safe-top', '--platform-safe-bottom',
  ]);
  const missing = [...light].filter((n) => !dark.has(n) && !THEME_INVARIANT.has(n)).sort();
  assert.deepEqual(missing, [],
    'a :root colour variable with no .dark counterpart renders its LIGHT value on a near-black page');
});
