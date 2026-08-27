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

// Every source that renders markup, the admin console INCLUDED.
//
// It used to be excluded, on the written rationale that it "is gray/indigo
// rather than zinc/violet, and is not part of the reskin". Both halves of that
// stopped being true when the widget-language reskin folded the console into
// this vocabulary — it is zinc/violet now and tests/admin-ui-registry.test.js
// asserts that no gray or indigo survives anywhere. The exclusion outlived its
// reason, and a live contrast sweep over the console then measured 114 failing
// text styles in light mode behind it, including inks at 1.5:1.
//
// The lesson is worth more than the fix: an exemption carries the assumption
// that justified it, and nothing re-checks that assumption when the world
// moves. This one was pinned open by a comment that was simply out of date.
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
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
];

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
  // This one is a BUDGET rather than a ban: these predate the reskin and most
  // sit on surfaces the live sweep has not reached (error states, rarely-open
  // panels). The number may only go DOWN — a new bare -400 is a new
  // light-mode contrast bug, and lowering this line is how a fix is recorded.
  //
  // It read 200 while the true count was 78, so 122 units of silent headroom
  // sat in front of it and the ratchet was not ratcheting. Set to the measured
  // number, admin included. If you are lowering it, say in the commit which
  // sweep run you measured against.
  //
  // 78 -> 58 with the product-wide ink correction: every light-side status ink
  // the live sweep measured under 4.5:1 on the page ground moved a shade or
  // two darker AND gained a `dark:` partner, so the remaining 58 are ones the
  // sweep has not reached rather than ones it forgave.
  const BUDGET = 58;
  assert.ok(bad.length <= BUDGET,
    `bare -400 status inks: ${bad.length} > ${BUDGET}. Newly added:\n  ${bad.slice(0, 8).join('\n  ')}`);
});

// ── 2b. A bare zinc-400 ink with no dark: partner ───────────────────────
//
// The neutral ramp's own version of rule 2, and the one that actually caught
// the admin console: `text-zinc-400` is #8e8e93, which is 2.71:1 on the light
// page ground (#eaeaea) — a fail at any text size. Paired as
// `text-zinc-500 dark:text-zinc-400` it is the shell's ordinary secondary ink.
//
// A run that already names a `dark:` ink is somebody's considered pair and is
// left alone; so is `placeholder:text-zinc-400`, which has its own contrast
// rules and its own ramp.

test('no unpaired zinc-400 ink outside the always-dark chrome', () => {
  const bad = [];
  for (const s of SOURCES.filter(themed)) {
    const src = code(s.text);
    for (const m of src.matchAll(/["'`]([^"'`\n]*\btext-zinc-400\b[^"'`\n]*)["'`]/g)) {
      const run = m[1];
      if (run.includes('placeholder:') || run.includes('dark:text-')) continue;
      bad.push(`${s.path}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  // This one RAN OUT of budget, which is the outcome a ratchet is for: 109
  // before the admin console was re-spelled, 52 after, and 0 once the
  // product-wide pass paired the rest. It is a ban now, not a budget — there
  // is no longer such a thing as an acceptable unpaired zinc-400 ink.
  assert.deepStrictEqual(bad, [],
    'unpaired zinc-400 inks are 2.71:1 on the light page ground. Pair them as '
    + `text-zinc-500 dark:text-zinc-400:\n  ${bad.slice(0, 8).join('\n  ')}`);
});

// ── 2c. A paired ink handed to classList, which takes TOKENS ────────────
//
// Pairing rule 2b's inks was a mechanical pass over string literals, and a
// class string is a class string wherever it appears — including inside
// `el.classList.remove('text-red-500')`, where the value is not a class
// string at all but a single DOMTokenList token. Appending ` dark:text-red-400`
// there turns a working call into `InvalidCharacterError: the token contains
// HTML space characters`, thrown at the first status message.
//
// It got past 9,725 tests: they render components and read markup, and no
// vm-based DOM stub in the suite implements DOMTokenList's validation. It
// surfaced in a browser, on the one route that writes a status line — and a
// console error on any route fails the platform's proposal checks.
//
// So the rule is spelled the way the mistake was made: a `classList.add` or
// `.remove` argument is ONE token. Pass a pair as two arguments.
test('no classList argument carries more than one class token', () => {
  const bad = [];
  const call = /classList\.(?:add|remove|toggle|contains|replace)\(([^()]*)\)/g;
  for (const s of SOURCES) {
    for (const m of s.text.matchAll(call)) {
      for (const arg of m[1].split(',')) {
        const lit = arg.trim().match(/^'([^']*)'$/);
        if (lit && /\s/.test(lit[1].trim()) === false) continue;
        if (lit && /\s/.test(lit[1])) {
          bad.push(`${s.path}:${s.text.slice(0, m.index).split('\n').length}  '${lit[1]}'`);
        }
      }
    }
  }
  assert.deepStrictEqual(bad, [],
    'classList takes tokens, not class strings — a space throws '
    + `InvalidCharacterError:\n  ${bad.slice(0, 8).join('\n  ')}`);
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
    // The seven `--tile-*` app-identity tints used to sit here, exempt because
    // an icon does not invert with the page. They are gone — the per-app tint
    // was removed and the tile is one neutral face now — so the exemption went
    // with them rather than outliving its subject.
    //
    // Layout insets (env(safe-area-inset-*)), not colours.
    '--platform-safe-top', '--platform-safe-bottom',
    // The mobile install strip's content-row height (#1372) — a length, and
    // the one number both `body`'s reserved padding and the strip's own
    // height read, so that the space held open and the space drawn cannot
    // drift apart. A height does not invert with the page.
    '--install-strip-h',
    // The five WeOS brand fills. This is the third exception, and it is the
    // same argument the retired `--tile-*` tints made: a brand colour does not
    // invert with the page. #FFEE6F is the brand's yellow on a white page and
    // on a near-black one; giving it a dark counterpart would mean shipping a
    // second, wrong yellow.
    //
    // What makes that SAFE here — and it is the only reason it is safe — is
    // that none of them is ever ink. Each is a fill carrying --brand-ink, and
    // measured as ink on a light ground they are 1.16:1 (yellow), 1.71:1
    // (sage) and 3.32:1 (blue), so there is no legible-on-white/illegible-on-
    // black failure mode for this exemption to hide. The pairing that matters
    // is black-on-fill, which is 17.71:1, 12.06:1 and 6.20:1 in BOTH themes
    // because both halves of it are theme-invariant.
    //
    // If a future change ever uses one of these as a text colour, this
    // exemption stops being true and the token needs a dark counterpart.
    '--brand-yellow', '--brand-sage', '--brand-blue', '--brand-cream',
    '--brand-ink',
  ]);
  const missing = [...light].filter((n) => !dark.has(n) && !THEME_INVARIANT.has(n)).sort();
  assert.deepEqual(missing, [],
    'a :root colour variable with no .dark counterpart renders its LIGHT value on a near-black page');
});
