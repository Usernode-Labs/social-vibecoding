// Guards for the ways a colour picked against the pre-reskin DARK shell goes
// wrong once the same markup renders on a light page.
//
// The reskin's palette is theme-following: the zinc-100 page ground with
// white cards in light; the zinc-950 ground with zinc-900 cards in dark
// (the hexes are READ from tailwind.config.js below rather than copied here —
// they have moved with each retune while these rules held, and a guard that
// hardcodes a hex is a guard that silently stops describing the product).
// Every rule below is here because a Playwright sweep over the running app —
// computing each text node's real contrast against the surface actually behind
// it, and each control's fill against the surface behind IT — measured a live
// failure of that exact shape.
//
// These are static assertions over source text, in the style of
// tests/dev-color-tokens.test.js and tests/admin-ui-registry.test.js. They
// cannot see layout, so they check the SPELLINGS that were wrong, not the
// rendered result. That is the cheap half; the sweep is the thorough half and
// it needs a live server.
//
// ── THE STANDARD IS APCA (Lc), NOT WCAG ────────────────────────────────
//
// This file used to quote WCAG ratios — "2.71:1", "4.5:1", "1.00:1". The
// branch no longer tracks WCAG at all, and the numbers were doing real damage
// while they sat here: a ratio has no sign, so it cannot tell a light-on-dark
// ink from a dark-on-light one, and it has no notion of the two themes being
// the SAME ink at different polarities. Rule 2b's prescription had gone stale
// for exactly that reason — see the note there.
//
// What replaced them:
//
//   * Lc is SIGNED. Positive is dark text on a light ground, negative is light
//     text on a dark one. Only the MAGNITUDE is compared.
//   * The ladder, in |Lc|: 90 body-preferred and the floor for small labels ·
//     75 body minimum · 60 larger-or-bolder · 45 large headline only · 30
//     non-content and disabled · under 15 invisible. The rungs are 15 apart,
//     which is why 15 is the tolerance rule 5 uses for "these two are not the
//     same ink".
//   * THE TARGET IS PARITY, NOT A FLOOR, wherever a rule is about a
//     light/dark pair. A dark value is right when its |Lc| matches its light
//     counterpart's — that is self-calibrating, it survives the next retune of
//     the ramp, and it is what the palette itself was solved to (see the
//     red/amber note in tailwind.config.js: 700 is the light ink at Lc 80 on
//     white and 200 is the dark ink at Lc -80 on the zinc-900 card, parity to
//     a decimal). An absolute floor is used ONLY where the rule genuinely is
//     one: a single value rendering into BOTH themes has no counterpart to be
//     at parity with, so it has to clear the ladder on its own.
//
// Run with: node --test tests/theme-ink-guards.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// ── APCA-W3 0.1.9 (Somers / Myndex) ────────────────────────────────────
//
// Transcribed rather than depended on, for the same reason the icon set is
// (see AGENTS.md): this is ~15 lines of arithmetic and a dependency here would
// be a supply-chain surface on a test that only ever multiplies six constants.
// The port is pinned by its own test below — the three reference values are
// the ones the algorithm is conventionally sanity-checked against, and they
// agree to two decimals with the Python implementation this was ported from.
//
// Do not "simplify" the exponents. The asymmetric pairs (0.56/0.57 for dark
// text on light, 0.65/0.62 for light on dark) are what make Lc polarity-aware,
// which is the entire reason this replaced a WCAG ratio.

function luminance(hex) {
  const h = hex.replace('#', '');
  const channel = (i) => parseInt(h.slice(i, i + 2), 16) / 255;
  return 0.2126729 * channel(0) ** 2.4
    + 0.7151522 * channel(2) ** 2.4
    + 0.0721750 * channel(4) ** 2.4;
}

// Near-black loses contrast faster than the power curve predicts; APCA lifts
// it back with a soft clamp before the difference is taken.
function clampBlack(y) {
  return y < 0.022 ? y + (0.022 - y) ** 1.414 : y;
}

function apca(textHex, bgHex) {
  const text = clampBlack(luminance(textHex));
  const bg = clampBlack(luminance(bgHex));
  if (Math.abs(bg - text) < 0.0005) return 0;
  if (bg > text) { // dark text on a light ground
    const s = (bg ** 0.56 - text ** 0.57) * 1.14;
    return s < 0.1 ? 0 : (s - 0.027) * 100;
  }
  const s = (bg ** 0.65 - text ** 0.62) * 1.14; // light text on a dark ground
  return s > -0.1 ? 0 : (s + 0.027) * 100;
}

const lc = (textHex, bgHex) => Math.abs(apca(textHex, bgHex));

test('the APCA port reproduces its reference values', () => {
  // If these move, every threshold in this file is measuring something else.
  assert.equal(apca('#000000', '#FFFFFF').toFixed(2), '106.04', 'black on white');
  assert.equal(apca('#FFFFFF', '#000000').toFixed(2), '-107.88', 'white on black');
  assert.equal(apca('#888888', '#FFFFFF').toFixed(2), '63.06', 'mid grey on white');
  // Polarity is the property WCAG could not express: same pair, opposite sign.
  assert.ok(apca('#000000', '#FFFFFF') > 0 && apca('#FFFFFF', '#000000') < 0,
    'Lc must be signed — positive dark-on-light, negative light-on-dark');
});

// The APCA use-case ladder. Named so a threshold below reads as the rung it
// is, not as a number somebody picked.
const BODY_MIN = 75;      // body text minimum
const NON_CONTENT = 30;   // disabled / decorative; under this is not content
const RUNG = 15;          // the spacing of the ladder, and rule 5's tolerance

// The palette, READ from the config rather than copied. tailwind.config.js is
// the source of truth for every hex in the product and it has been retuned
// repeatedly (zinc-500 alone moved #6B6B64 -> #595953 when the branch adopted
// APCA). Requiring it means these guards re-measure themselves after the next
// retune instead of asserting against a snapshot nobody remembers taking.
const PALETTE = require(path.join(root, 'tailwind.config.js')).theme.extend.colors;
const shade = (scale, step) => PALETTE[scale] && PALETTE[scale][step];

// The four surfaces the shell actually draws text on.
const LIGHT_PAGE = shade('zinc', 100);
const LIGHT_CARD = '#FFFFFF';
const DARK_CARD = shade('zinc', 900);

// Every source that renders markup, the admin console INCLUDED.
//
// It used to be excluded, on the written rationale that it "is gray/indigo
// rather than zinc/violet, and is not part of the reskin". Both halves of that
// stopped being true when the widget-language reskin folded the console into
// this vocabulary — it is zinc/violet now and tests/admin-ui-registry.test.js
// asserts that no gray or indigo survives anywhere. The exclusion outlived its
// reason, and a live contrast sweep over the console then measured 114 failing
// text styles in light mode behind it, including inks that measure Lc 40 and
// under on the page ground.
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
// that implies otherwise, so these files are exempt from the ink rules.
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

const lineAt = (src, index) => src.slice(0, index).split('\n').length;

// ── 1. A hover that moves UP the neutral ramp ───────────────────────────
//
// `text-zinc-400 hover:text-zinc-100` brightens the glyph on dark chrome and
// is right there. On a light page zinc-100 IS the page ground, so the control
// disappeared exactly as the cursor reached it. Fourteen shipped like that:
// the header's back button, the drawer's ×, two dialogs' ×, the wallet link,
// two auth buttons and the dev-chat back arrow.
//
// The banned set used to be the literal `(100|200|300)` on `zinc|violet`,
// which was a transcription of what that sweep happened to find. It is DERIVED
// now: a shade is banned as a light-mode hover ink when it cannot clear the
// non-content rung against the light page ground — i.e. when hovering makes
// the control less legible than not hovering. Deriving it is what generalized
// the rule past the sweep's sample, and it earns its keep immediately:
//
//   * it reaches every scale, not the two the sweep looked at (azure, meadow,
//     red and amber all have pale steps that vanish on the page ground too);
//   * on the YELLOW ramp it bans 400, 500 AND 600 — a literal list stopping at
//     300 would have missed them, and violet-600 is the CTA fill, the single
//     most likely shade for someone to reach for as an accent hover. It
//     measures Lc 15 on the page ground. tailwind.config.js says the same
//     thing in prose ("nothing may spell text-violet-600"); this is the
//     mechanism that enforces it.

const HOVER_BANNED = (() => {
  const byScale = {};
  for (const [scale, steps] of Object.entries(PALETTE)) {
    if (!steps || typeof steps !== 'object') continue;
    const weak = Object.keys(steps).filter((n) => lc(steps[n], LIGHT_PAGE) < NON_CONTENT);
    if (weak.length) byScale[scale] = weak;
  }
  return byScale;
})();

test('no hover brightens a control toward the light page ground', () => {
  const alternation = Object.entries(HOVER_BANNED)
    .map(([scale, steps]) => `${scale}-(?:${steps.join('|')})`)
    .join('|');
  assert.ok(alternation, 'the palette produced no banned hover shades — check the config loaded');

  const bad = [];
  for (const s of SOURCES.filter(themed)) {
    const src = code(s.text);
    const re = new RegExp(`hover:text-(?:${alternation})\\b`, 'g');
    let m;
    while ((m = re.exec(src))) {
      // A `dark:`-qualified one is the correct half of a themed pair.
      const at = src.lastIndexOf('dark:', m.index);
      if (at >= 0 && m.index - at <= 'dark:'.length) continue;
      const [, scale, step] = m[0].match(/hover:text-([a-z]+)-(\d+)/);
      bad.push(`${s.path}:${lineAt(src, m.index)} ${m[0]} (Lc ${lc(shade(scale, step), LIGHT_PAGE).toFixed(1)} on the page ground)`);
    }
  }
  assert.deepEqual(bad, [],
    `a hover state must darken on a light ground — under Lc ${NON_CONTENT} it is not content at all. `
    + `Put the brightening one behind dark::\n  ${bad.slice(0, 8).join('\n  ')}`);
});

// ── 2. A -400 status ink with no light counterpart ──────────────────────
//
// emerald/amber/red/violet at -400 are dark-shell values. A bare one is a
// single declaration rendering into BOTH themes, so it has no counterpart to
// be at parity with and the ABSOLUTE floor is the right test: measured on the
// light page ground the credit line's "$0.00", the "AI" role label and the
// fork dialog's three legend labels all landed between Lc 30 and 47 — under
// the 75 body minimum, and the weakest of them under the non-content rung.
//
// The fix everywhere is a PAIR: the light-mode ink down-ramp with the -400
// kept behind `dark:`. Which dark step makes parity is rule 5's business —
// for the tuned status ramps it is 200, not 400.

test('no bare -400 status ink outside the always-dark chrome', () => {
  const bad = [];
  const HUES = 'emerald|amber|red|violet|sky|yellow|indigo|green|rose|orange|teal';
  for (const s of SOURCES.filter(themed)) {
    const src = code(s.text);
    const re = new RegExp(`(?<!dark:)\\btext-(${HUES})-400\\b`, 'g');
    let m;
    while ((m = re.exec(src))) {
      const hex = shade(m[1], '400');
      const measured = hex ? ` (Lc ${lc(hex, LIGHT_PAGE).toFixed(1)} on the page ground)` : ' (stock Tailwind hue)';
      bad.push(`${s.path}:${lineAt(src, m.index)} ${m[0]}${measured}`);
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
  // the live sweep measured as failing on the page ground moved a shade or two
  // darker AND gained a `dark:` partner, so the remaining 58 are ones the
  // sweep has not reached rather than ones it forgave.
  //
  // 58 -> 6 with the APCA neutral-ink sweep. That run removed 29 net bare
  // `text-red-400`, and the measured count against the post-sweep tree is 6:
  // admin-codes.tsx x2, dev-chat/session-list.tsx x2, admin-featured-apps.tsx,
  // and public/js/app-view.js:9973. Left at 58 the ratchet had 52 units of
  // slack in front of it — a larger relative gap than the 200-vs-78 incident
  // this comment already records, which is exactly how it stops ratcheting.
  //
  // 6 -> 6 on the WCAG-to-APCA rebase. Re-measured against the tree at
  // 60daf71: the same six sites, unmoved. Restating an unchanged budget is
  // the point of a re-measure — the alternative is a number nobody has
  // confirmed in three retunes, which is how the 200-vs-78 gap opened.
  const BUDGET = 6;
  assert.ok(bad.length <= BUDGET,
    `bare -400 status inks: ${bad.length} > ${BUDGET}. Newly added:\n  ${bad.slice(0, 8).join('\n  ')}`);
});

// ── 2b. A bare zinc-400 ink with no dark: partner ───────────────────────
//
// The neutral ramp's own version of rule 2, and the one that actually caught
// the admin console. `text-zinc-400` measures Lc 46.6 on the light page
// ground: below the 75 body minimum, below the 60 larger-or-bolder rung, and
// clearing only the 45 large-headline rung — which is not what a secondary ink
// is for. The shade has stayed a decorative-only ink through every retune of
// the ramp. (The number is the one thing that changed here: this rule used to
// quote "2.71:1" for the #8e8e93-on-#eaeaea ramp of that era. That pair
// measures Lc 47.5 — so the failure was always the same size, and the ratio
// was simply a less legible way of saying it.)
//
// A run that already names a `dark:` ink is somebody's considered pair and is
// left alone HERE; rule 5 is what re-checks that assumption, and it exists
// because this exemption is the same shape as the admin-console one above —
// an escape hatch that nothing was re-measuring. It is not hypothetical: six
// sites spell `text-zinc-400 dark:text-zinc-300`, which satisfies this rule
// and still leaves the LIGHT half at Lc 46.6.
//
// `placeholder:text-zinc-400` is also left alone — it has its own contrast
// rules and its own ramp.

test('no unpaired zinc-400 ink outside the always-dark chrome', () => {
  const bad = [];
  for (const s of SOURCES.filter(themed)) {
    const src = code(s.text);
    for (const m of src.matchAll(/["'`]([^"'`\n]*\btext-zinc-400\b[^"'`\n]*)["'`]/g)) {
      const run = m[1];
      if (run.includes('placeholder:') || run.includes('dark:text-')) continue;
      bad.push(`${s.path}:${lineAt(src, m.index)}`);
    }
  }
  // This one RAN OUT of budget, which is the outcome a ratchet is for: 109
  // before the admin console was re-spelled, 52 after, and 0 once the
  // product-wide pass paired the rest. It is a ban now, not a budget — there
  // is no longer such a thing as an acceptable unpaired zinc-400 ink.
  // Re-measured at 60daf71 and still 0.
  //
  // THE PRESCRIPTION MOVED, and it is the clearest thing WCAG was hiding.
  // This message used to say "pair them as text-zinc-500 dark:text-zinc-400",
  // which was the WCAG-era answer: both halves cleared 4.5:1 against their own
  // ground, so the ratio called it done. Under Lc that pair is 74.8 light and
  // 43.5 dark — a 31-point parity failure, with the dark half two full rungs
  // below the light one. The partner that makes parity is zinc-300 (Lc 75.2 on
  // the dark card, 0.4 off the light half), and the product has already moved:
  // 824 un-backgrounded runs spell `text-zinc-500 dark:text-zinc-300` against
  // 8 still on -400. Prescribing the old pair here would have pushed new code
  // back onto the failing one.
  const zinc500 = lc(shade('zinc', 500), LIGHT_PAGE);
  const zinc300 = lc(shade('zinc', 300), DARK_CARD);
  assert.deepStrictEqual(bad, [],
    `unpaired zinc-400 inks measure Lc ${lc(shade('zinc', 400), LIGHT_PAGE).toFixed(1)} on the light page ground, `
    + `under the ${BODY_MIN} body minimum. Pair them as text-zinc-500 dark:text-zinc-300 `
    + `(Lc ${zinc500.toFixed(1)} / ${zinc300.toFixed(1)}, parity to ${Math.abs(zinc500 - zinc300).toFixed(1)}):\n  `
    + bad.slice(0, 8).join('\n  '));
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
//
// Nothing here is a contrast measurement and nothing here changed in the APCA
// rebase — it is the mechanical hazard the other rules' fixes walk into, and
// it sits next to them for that reason. Re-measured at 60daf71: still 0.
test('no classList argument carries more than one class token', () => {
  const bad = [];
  const call = /classList\.(?:add|remove|toggle|contains|replace)\(([^()]*)\)/g;
  for (const s of SOURCES) {
    for (const m of s.text.matchAll(call)) {
      for (const arg of m[1].split(',')) {
        const lit = arg.trim().match(/^'([^']*)'$/);
        if (lit && /\s/.test(lit[1].trim()) === false) continue;
        if (lit && /\s/.test(lit[1])) {
          bad.push(`${s.path}:${lineAt(s.text, m.index)}  '${lit[1]}'`);
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
// blank.
//
// This is the one threshold in the file that is neither parity nor a ladder
// rung, and it is worth saying why: white on white is Lc 0.0 exactly. Not
// "below the floor" — the two luminances are equal, APCA returns zero, and
// there is no rung beneath the bottom rung. It used to read "1.00:1", which is
// the same fact in the units of a standard that cannot say "invisible" without
// the reader converting first. Asserted below rather than asserted about, so
// the claim cannot rot.

test('every outline Button states its ink', () => {
  assert.equal(apca(LIGHT_CARD, LIGHT_CARD), 0,
    'white on white is Lc 0 — the failure this rule prevents has no lower bound');

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
      bad.push(`${s.path}:${lineAt(src, m.index)}`);
    }
  }
  // A ban since the three dialogs were fixed; re-measured at 60daf71 and
  // still 0.
  assert.deepEqual(bad, [],
    'variant="outline" has no ink of its own and the default is white, which is Lc 0 on a white card — '
    + `pass ink="muted" or use variant="neutral":\n  ${bad.slice(0, 8).join('\n  ')}`);
});

// ── 4. Every dark-block token has a light one, and vice versa ───────────
//
// --text-muted was the single variable in the .dark palette block with no
// dark value at all: it inherited #6c6c70 from :root, so on a near-black page
// it was as dark as on a near-white one. Ninety-two rules read it, and the
// create modal's unselected segment pills came out unreadable because of it.
//
// In Lc that incident is the file's cleanest example of why parity is the
// target and a floor is not. ONE declaration, measured on the two grounds it
// actually rendered against: Lc 63.5 on the light page — mediocre but legible,
// a floor-based check aimed at the light theme would have passed it — and Lc
// 23.8 on the dark card, below the non-content rung, i.e. not text any more.
// A 39.7-point parity gap produced by a variable that simply wasn't there.
//
// A missing declaration is a parity failure that no per-value threshold can
// catch, because there is no second value to measure. So the assertion is over
// the NAME SETS, and it is the one rule here that runs against app.css.

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
    // The shell's content keyline — a LENGTH, and the one number both the
    // Tailwind alias (`spacing.gutter: var(--screen-gutter)`) and every raw
    // `padding: … var(--screen-gutter)` rule read, so a utility and a CSS rule
    // cannot drift to two different gutters. An inset does not invert with the
    // page: a 12px edge is 12px in both themes, and giving it a `.dark`
    // counterpart would be inventing a second number for the sake of a rule
    // about colour.
    '--screen-gutter',
  ]);
  const missing = [...light].filter((n) => !dark.has(n) && !THEME_INVARIANT.has(n)).sort();
  assert.deepEqual(missing, [],
    'a :root colour variable with no .dark counterpart renders its LIGHT value on a near-black page, '
    + 'which is a parity gap no per-value threshold can catch');
});

// ── 5. A themed ink pair whose two halves are not the same ink ──────────
//
// Rules 2 and 2b ask whether a `dark:` partner EXISTS. Under a ratio that was
// the whole question, because each half was then checked against its own
// ground and either cleared 4.5:1 or did not. Lc asks the question that
// actually matters: are the two halves the SAME INK — does the dark theme
// render the emphasis the light theme rendered?
//
// This is the rule that re-checks rule 2b's exemption, and the file's own
// history says why one is needed. Twice now an exemption here has been pinned
// open by a comment nobody re-measured: the admin console's, and rule 2b's
// prescription of `dark:text-zinc-400`. Both were true when written. Neither
// was re-checked. A pair that "has a dark: partner" is exactly that shape of
// claim, and this is the assertion that keeps testing it.
//
// WHAT IT CAN AND CANNOT SEE. It still cannot see layout, so it is scoped to
// be conservative rather than complete:
//
//   * only class runs that name NO background of their own — those inherit the
//     theme ground, so the surface is knowable. A run carrying `bg-amber-50`
//     or `dark:bg-zinc-100` is skipped: the first may be completed by a
//     `dark:bg-` in a run concatenated at runtime, and the second is the
//     selected-tab chip, which deliberately inverts its SURFACE too and is
//     correct (frontend/@/components/ui/tabs.tsx SECTION_TAB_ACTIVE).
//   * a pair is flagged only when it fails on EVERY surface it could be
//     sitting on — the page ground in each theme, and a card in each theme.
//     The minimum of the two gaps is used, so anything reported here is wrong
//     wherever it is mounted. That costs some real failures and buys no false
//     ones, which is the right trade for a guard that cannot look.
//
// THE TOLERANCE IS ONE RUNG. The APCA ladder steps every 15 Lc, so two halves
// more than 15 apart are in different readability classes — the light theme
// shows body text where the dark theme shows a disabled label. It is not a
// number tuned to the tree: the measured gaps fall in a natural valley there
// (the worst passing spelling is 11.2, the best failing one 15.5), so anything
// from 12 to 15 selects the identical set.

test('a themed ink pair renders the same ink in both themes', () => {
  // The surface pairings an un-backgrounded run could occupy: the page ground
  // in each theme, and a card in each theme.
  const SURFACES = [[LIGHT_PAGE, DARK_CARD], [LIGHT_CARD, DARK_CARD]];
  const seen = new Map();
  let total = 0;

  for (const s of SOURCES.filter(themed)) {
    const src = code(s.text);
    for (const m of src.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      const run = m[1];
      if (/\bbg-/.test(run)) continue; // names its own surface: ground unknowable
      const light = run.match(/(?:^|\s)text-([a-z]+)-(\d{2,3})(?![\w/])/);
      const dark = run.match(/(?:^|\s)dark:text-([a-z]+)-(\d{2,3})(?![\w/])/);
      if (!light || !dark) continue;
      const lightHex = shade(light[1], light[2]);
      const darkHex = shade(dark[1], dark[2]);
      if (!lightHex || !darkHex) continue; // a stock Tailwind hue: no hex to read
      total++;
      const gap = Math.min(...SURFACES.map(([lg, dg]) => Math.abs(lc(lightHex, lg) - lc(darkHex, dg))));
      if (gap <= RUNG) continue;
      const key = `text-${light[1]}-${light[2]} dark:text-${dark[1]}-${dark[2]}`;
      if (!seen.has(key)) seen.set(key, { gap, n: 0 });
      seen.get(key).n++;
    }
  }

  assert.ok(total > 500, `expected the pair census to find the product's ink pairs, got ${total}`);
  const offenders = [...seen.entries()].sort((a, b) => b[1].n - a[1].n);
  const count = offenders.reduce((a, [, v]) => a + v.n, 0);

  // A RATCHET, and a live one: this tracks a migration that is half finished.
  // The tuned status ramps pair 700 with 200 — tailwind.config.js solved those
  // two steps to Lc 80 and -80 precisely so the pair would be at parity — and
  // the tree still holds the WCAG-era `700 dark:400` spelling in most places.
  // Both forms are present today, which is what makes this measurable rather
  // than aspirational: `text-red-800 dark:text-red-200` is 0.3 apart and
  // `text-red-700 dark:text-red-400` is 27.5 apart.
  //
  // Measured against the tree at 60daf71: 122 occurrences across 7 spellings.
  // The four that carry it are text-red-700 dark:text-red-400 (67),
  // text-amber-800 dark:text-amber-400 (35), text-zinc-500 dark:text-zinc-400
  // (8) and text-zinc-400 dark:text-zinc-300 (6, the one whose LIGHT half is
  // the failure). Set to the true count and not a round number above it: this
  // file has already recorded what a budget with slack in front of it does —
  // 200 against a true 78 — and a ratchet that cannot be tripped is a comment.
  //
  // Retuning a ramp can move this without anyone touching a call site, which
  // is deliberate. If it goes UP after a palette change, the palette moved the
  // two halves apart and the fix is in tailwind.config.js, not here.
  const BUDGET = 122;
  const report = offenders.slice(0, 8)
    .map(([k, v]) => `${k}  x${v.n}  (${v.gap.toFixed(1)} Lc apart)`)
    .join('\n  ');
  assert.ok(count <= BUDGET,
    `ink pairs more than ${RUNG} Lc apart: ${count} > ${BUDGET}. `
    + `The two themes are not rendering the same emphasis:\n  ${report}`);
});
