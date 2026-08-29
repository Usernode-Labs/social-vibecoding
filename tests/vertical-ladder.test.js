// tests/vertical-ladder.test.js — a CENSUS of every vertical dimension in the
// product, normalized across the six ways this codebase spells one.
//
// This is an INVENTORY, not a collapse. It does not say a height is wrong. It
// says the tree contains exactly these values, spelled exactly these ways, in
// exactly these files — and that nothing moved without somebody recording it.
//
// ── Why an inventory is the guard ────────────────────────────────────────
//
// The failure this project hits most often is a value spelled more than one
// way, so a sweep matching ONE spelling silently misses the rest and reports
// a census that is short. It has happened to type (23 distinct sizes, of which
// 13 existed only as arbitrary utilities and 5 only as a raw `font-size:` in
// app.css), to radius (sixteen distinct radii; 8px had no class at all and
// each of the three correct nestings spelled a bare `border-radius: 8px`), and
// to the ink budgets in tests/theme-ink-guards.test.js, whose own comments
// record a ratchet sitting at 200 against a true 78 and later at 58 against a
// true 6. In every one of those the sweep was not wrong about what it changed.
// It was wrong about what there was.
//
// So the deliverable here is the denominator. Six spellings, one normalizer,
// one baseline:
//
//   1. the Tailwind scale                 h-9 · min-h-4 · max-h-48
//   2. arbitrary utilities                min-h-[44px] · h-[1.125rem]
//   3. raw CSS                            height / min-height / max-height in
//                                         public/css/**
//   4. custom properties                  --home-panel-row-h and friends,
//                                         resolved where resolvable
//   5. JS style STRINGS and style objects screenshot-select.js spells
//                                         `height:36px` inside style.cssText,
//                                         and admin-analytics.tsx spells
//                                         `style={{ height: '90px' }}` — both
//                                         invisible to any class-name regex
//   6. calc() / viewport / env() / %      recorded UNRESOLVED but attributed,
//                                         because "we could not resolve it" is
//                                         a different fact from "it is absent"
//
// ── Budgets here are EQUALITIES ──────────────────────────────────────────
//
// Not `<=`. This repository has twice watched a ratchet stop ratcheting
// because a budget carried silent headroom, and tests/theme-ink-guards.test.js
// condemns that in its own commentary — twice. A census with slack in front of
// it is not a census. Every number below is the number measured against the
// tree at the commit that introduced this file, and a DECREASE fails just as
// loudly as an increase: a sweep that removes eleven `min-h-[36px]` should
// have to say so.
//
// Re-pinning is deliberate, in the same commit as the change, the way
// tests/baselines/shell-markup.json is re-pinned. It is regenerable —
//
//   VERTICAL_LADDER_SCAN_ONLY=1 node -e "\
//     const { scan, baselineShape } = require('./tests/vertical-ladder.test.js'); \
//     require('fs').writeFileSync('tests/baselines/vertical-heights.json', \
//       JSON.stringify(baselineShape(scan()), null, 2) + '\n')"
//
// (the env var suppresses test registration, so the module can be required as
// a library without the assertions running against the file being rewritten)
//
// — but regenerating it wholesale to go green throws away the only thing the
// file is for. Read the diff the failure prints; it names the values.
//
// ── DISTINCTIONS THAT ARE KEPT ON PURPOSE ────────────────────────────────
//
// These look like drift in a class diff and are not. Two independent analyses
// of this tree confirmed each one.
//
//   * `min-h-[44px]` and `h-11` are DIFFERENT LADDERS at the same 44px. All
//     four `h-11` sites are `w-11 h-11` — square avatars and icon tiles, where
//     44 is a BOX. The 26 `min-h-[44px]` are grow-with-text tap minimums,
//     where 44 is a FLOOR. Same for the 36px pair (`w-9 h-9` squares vs
//     `min-h-[36px]`). A future 44px sweep must therefore match ALL FOUR
//     spellings — `h-11`, `min-h-11`, `h-[44px]`, `min-h-[44px]` — plus the
//     raw `height: 44px` in app.css. Matching one of them and reporting a
//     count is the exact mistake this file exists to make impossible.
//
//   * `min-h-[44px] sm:min-h-[36px]` IS the density boundary — the tap
//     minimum stepping down once a pointer is assumed. The normalizer keeps
//     the variant chain in the spelling (`sm:min-h-[36px]` is a different
//     spelling from a bare `min-h-[36px]`) precisely so a sweep can tell the
//     nine responsive step-downs from the three unconditional ones.
//
//   * The iOS-metric components — feed, chat, chip, grouped-list, icon-tile,
//     page-header — keep their 40/56 heights. They sit on the ladder that
//     public/usernode-native/v1/ publishes as a frozen contract, not on the
//     shell's own. See "One language, two surfaces" in AGENTS.md.
//
//   * 28px (and every other sub-44 control box) is LEGAL, because
//     `.un-touch-target::after` expands the hit area to `max(100%, 44px)`
//     without touching the painted box. 17 sites carry that class. A guard
//     that flagged every sub-44 control would be flagging the kit working.
//
// ── WHAT THIS GUARD CANNOT CATCH ─────────────────────────────────────────
//
// Naming the blind spot is part of the design; a mechanism trusted past its
// reach is worse than no mechanism.
//
//   * IT NEVER MEASURES A RENDERED BOX. This is a regex over source text, in
//     the style of tests/admin-ui-registry.test.js. Even the repo's richest
//     render harness — tests/lib/render-tsx.js, esbuild plus
//     renderToStaticMarkup — has no DOM, no getBoundingClientRect, and never
//     runs effects. A height that is right in the class string and wrong on
//     screen (a parent's flex basis, a border-box vs content-box difference,
//     line-height, padding, a `transform: scale`) is invisible here. The
//     thorough half is a live sweep, exactly as it is for the ink guards.
//
//   * IT CANNOT RESOLVE calc(), viewport units, env() safe-area insets, or
//     percentages. Those land in `opaque` with their file, so they are
//     attributed but not comparable: two containers that resolve to the same
//     pixel height through different expressions read here as two values, and
//     one that changes meaning when the safe-area inset changes reads as one.
//
//   * IT CANNOT SEE A COMPUTED CLASS NAME — `h-${n}` — and neither can
//     Tailwind, whose extractor is the same kind of regex. That is not a
//     shared bug so much as the reason the codebase forbids the idiom.
//
//   * IT DOES NOT READ THE GENERATED OR FROZEN SURFACES. public/index.html and
//     public/shell/assets/shell.js are build outputs and gitignored;
//     public/css/tailwind.css is compiled; public/usernode-native/v1/** is a
//     published /v1/ contract served to every app on the platform. A height
//     introduced in any of them is outside this census by construction — and
//     for native.css that is correct, since re-theming the kit is done by
//     overriding --un-* variables from app.css, never by editing the kit.
//
//   * IT DOES NOT KNOW INTENT. It can tell you there are two 36px ladders. It
//     cannot tell you which row of the table a NEW 36px belongs to. Only the
//     `files` attribution can, which is why attribution is asserted rather
//     than merely recorded — attribution nothing re-checks is attribution that
//     rots, which is the same shape as the stale exemption comment that pinned
//     the admin console out of the ink guards for a year.
//
//   * IT IS NOT A POLICY. Nothing below says 44 is right or 34 is wrong. It
//     says the tree changed and the change was not written down.
//
// Run with: node --test tests/vertical-ladder.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'baselines', 'vertical-heights.json');

// ── The Tailwind spacing scale, in px ────────────────────────────────────
//
// v3.4.17's defaults, plus the one key this repo extends: `spacing.gutter`,
// which tailwind.config.js aliases to app.css's --screen-gutter (0.75rem =
// 12px, the content keyline). The scale is transcribed rather than required
// from the config because the config only carries the EXTENSION — requiring it
// would hand back one key out of thirty-six and look like it had them all.
const SCALE = {
  0: 0, px: 1, '0.5': 2, 1: 4, '1.5': 6, 2: 8, '2.5': 10, 3: 12, '3.5': 14,
  4: 16, 5: 20, 6: 24, 7: 28, 8: 32, 9: 36, 10: 40, 11: 44, 12: 48, 14: 56,
  16: 64, 20: 80, 24: 96, 28: 112, 32: 128, 36: 144, 40: 160, 44: 176,
  48: 192, 52: 208, 56: 224, 60: 240, 64: 256, 72: 288, 80: 320, 96: 384,
  gutter: 12,
};

// Every surface whose vertical values are the shell's own. The generated and
// frozen ones are absent on purpose — see the blind-spot note above.
const SOURCE_DIRS = [
  ['frontend/@', /\.(tsx?|js)$/],
  ['frontend/src', /\.(tsx?|js)$/],
  ['public/js', /\.js$/],
];
const CSS_FILES = [
  'public/css/app.css',
  'public/css/cli-authorize.css',
  'public/css/connect-authorize.css',
];

function walk(dir, re, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, re, out);
    } else if (re.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Comments explain the very spellings this file counts — prose about a class
// is not a class, and app.css derives several of its heights in prose
// arithmetic ("2 x 1.35 x 13.5px = 36.45px") that would otherwise be counted
// twice. Blanked rather than deleted so line attribution stays true.
const blank = (m) => m.replace(/[^\n]/g, ' ');
const stripJs = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, blank)
  .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
const stripCss = (t) => t.replace(/\/\*[\s\S]*?\*\//g, blank);

// ── The normalizer ───────────────────────────────────────────────────────
//
// One length token in, px or null out. `null` means "a real vertical value we
// could not reduce to a number" — it goes to `opaque` with its file, never
// silently dropped. Absence and unresolvability are different facts.
function toPx(raw) {
  const v = String(raw).trim().replace(/_/g, ' ');
  let m;
  if ((m = /^(-?[\d.]+)px$/.exec(v))) return round(parseFloat(m[1]));
  if ((m = /^(-?[\d.]+)(rem|em)$/.exec(v))) return round(parseFloat(m[1]) * 16);
  if (/^0$/.test(v)) return 0;
  return null;
}
const round = (n) => Math.round(n * 1000) / 1000;

const AXIS = { h: 'h', 'min-h': 'min-h', 'max-h': 'max-h' };

// Spellings 1, 2 and the keyword tail of 6. The leading group keeps the whole
// variant chain (`sm:`, `dark:`, `group-hover:`), because `sm:min-h-[36px]` is
// the density boundary and a bare `min-h-[36px]` is not.
const UTIL = /(?<![\w-])((?:[a-z][\w-]*:)*)(min-h|max-h|h)-(\[[^\]\s]+\]|[a-z0-9./]+)(?![\w[])/g;
// Spelling 3. The `(?<![-\w])` is what keeps `line-height` out.
const CSSPROP = /(?<![-\w])(min-height|max-height|height)\s*:\s*([^;}\n]+)/g;
// Spelling 4. Only properties that NAME themselves a height are read; a
// custom property holding one incidentally is beyond a regex's reach.
const CUSTOM = /(--[\w-]*(?:-h|height))\s*:\s*([^;}\n]+)/g;
// Spelling 5. The unit filter is load-bearing: it is what separates
// `style={{ height: '90px' }}` from an SVG attribute object's `height: '11'`
// and a canvas dimension's `height: 180`, neither of which is a CSS length.
const JSPROP = /(?<![-\w])(minHeight|maxHeight|height|min-height|max-height)\s*:\s*(['"`]?)([^;}\n,'"`]+)\2/g;
const HAS_UNIT = /(px|rem|em|vh|dvh|svh|lvh|%|calc|var\(|env\()/;

const SVG_PRIMITIVE = /^(svg|path|line|polyline|polygon|circle|rect|ellipse|g|use|image|foreignObject)$/;
const STROKE = /strokeWidth\s*=\s*[{]?["']([\d.]+)["'][}]?/g;
// A square box, in either written order. `w-11 h-11` and `h-11 w-11` are the
// same tile; `min-w-[1.125rem] h-[1.125rem]` is not one and must not match.
const SQUARE = /(?<![\w-])w-(\[[^\]\s]+\]|[a-z0-9./]+)\s+h-\1(?![\w[])|(?<![\w-])h-(\[[^\]\s]+\]|[a-z0-9./]+)\s+w-\2(?![\w[])/g;

function scan() {
  const records = [];   // resolved:  { axis, px, spelling, file }
  const opaque = [];    // unresolved: { axis, token, file }
  const strokeSites = [];
  const squares = new Map();
  let touchTargets = 0;

  const push = (axis, value, spelling, file) => {
    const px = toPx(value);
    if (px === null) opaque.push({ axis, token: String(value).trim(), file });
    else records.push({ axis, px, spelling, file });
  };

  const sources = [];
  for (const [rel, re] of SOURCE_DIRS) sources.push(...walk(path.join(root, rel), re));
  sources.sort();

  for (const p of sources) {
    const file = path.relative(root, p).split(path.sep).join('/');
    const src = stripJs(fs.readFileSync(p, 'utf8'));
    let m;

    UTIL.lastIndex = 0;
    while ((m = UTIL.exec(src))) {
      const [, variants, ax, arg] = m;
      const spelling = `${variants}${ax}-${arg}`;
      if (arg.startsWith('[')) push(AXIS[ax], arg.slice(1, -1), spelling, file);
      else if (Object.prototype.hasOwnProperty.call(SCALE, arg)) {
        records.push({ axis: AXIS[ax], px: SCALE[arg], spelling, file });
      } else {
        opaque.push({ axis: AXIS[ax], token: spelling, file });
      }
    }

    JSPROP.lastIndex = 0;
    while ((m = JSPROP.exec(src))) {
      const key = m[1];
      const raw = m[3].trim();
      if (!HAS_UNIT.test(raw)) continue;
      const axis = /^min/i.test(key) ? 'min-h' : /^max/i.test(key) ? 'max-h' : 'h';
      push(axis, raw, `${key}: ${raw}`, file);
    }

    STROKE.lastIndex = 0;
    while ((m = STROKE.exec(src))) {
      // Walk back to the tag this attribute sits on, so a chart's <line> is
      // never confused with an icon component's override.
      let i = m.index;
      while (i > 0 && !(src[i] === '<' && /[A-Za-z]/.test(src[i + 1] || ''))) i--;
      const tag = (src.slice(i + 1).match(/^[\w.]+/) || [''])[0];
      const box = [...src.slice(i, m.index).matchAll(/(?<![\w-])([wh])-(\[[^\]\s]+\]|[a-z0-9./]+)(?![\w[])/g)]
        .map((b) => b[0]).join(' ') || '(none)';
      strokeSites.push(`${SVG_PRIMITIVE.test(tag) ? 'svg-primitive' : 'icon'} ${file} <${tag}> ${box} strokeWidth=${m[1]}`);
    }

    SQUARE.lastIndex = 0;
    while ((m = SQUARE.exec(src))) {
      const arg = m[1] || m[2];
      const px = arg.startsWith('[') ? toPx(arg.slice(1, -1)) : SCALE[arg];
      const key = px == null ? `?${arg}` : String(px);
      const e = squares.get(key) || { count: 0, spellings: new Set(), files: new Set() };
      e.count++; e.spellings.add(m[0].trim()); e.files.add(file);
      squares.set(key, e);
    }

    touchTargets += (src.match(/un-touch-target/g) || []).length;
  }

  // ── Spelling 4, in two passes ──────────────────────────────────────────
  //
  // First every height-named custom property is collected, THEN the uses are
  // read, so a `height: var(--home-panel-row-h)` resolves to the 40px the
  // declaration carries. Resolution is deliberately conservative: it happens
  // only when the property has exactly ONE distinct px definition across the
  // whole stylesheet. --home-cell-h has two (7.75rem, and 7.25rem under a
  // media query), and a var with two values is not one value — resolving it to
  // whichever definition came last would be a census that lies rather than one
  // that admits it cannot see. Those stay in `opaque`, attributed.
  const varPx = new Map();
  const cssText = new Map();
  for (const rel of CSS_FILES) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const src = stripCss(fs.readFileSync(p, 'utf8'));
    cssText.set(rel, src);
    CUSTOM.lastIndex = 0;
    let m;
    while ((m = CUSTOM.exec(src))) {
      const set = varPx.get(m[1]) || new Set();
      set.add(toPx(m[2].trim()));
      varPx.set(m[1], set);
    }
  }
  const resolveVar = (name) => {
    const set = varPx.get(name);
    if (!set || set.size !== 1) return null;
    return [...set][0];
  };

  for (const [rel, src] of cssText) {
    let m;
    CSSPROP.lastIndex = 0;
    while ((m = CSSPROP.exec(src))) {
      const axis = m[1] === 'height' ? 'h' : m[1] === 'min-height' ? 'min-h' : 'max-h';
      const val = m[2].replace(/\s*!important\s*$/, '').trim();
      const spelling = `${m[1]}: ${val}`;
      // A bare `var(--x)` use — not one nested inside a calc(), which stays
      // unresolvable as a whole.
      const bare = /^var\((--[\w-]+)\)$/.exec(val);
      const via = bare ? resolveVar(bare[1]) : null;
      if (via != null) records.push({ axis, px: via, spelling, file: rel });
      else push(axis, val, spelling, rel);
    }
    CUSTOM.lastIndex = 0;
    while ((m = CUSTOM.exec(src))) {
      // Axis `var` is its own row: a custom property is a DECLARATION, not a
      // use. Both sides are counted, so a property whose value moves shows up
      // once as the declaration and once per resolved use.
      push('var', m[2].trim(), `${m[1]}: ${m[2].trim()}`, rel);
    }
  }

  const byPx = collect(records, (r) => `${r.axis}:${r.px}`, (r) => r.spelling);
  const byToken = collect(opaque, (r) => `${r.axis}:${r.token}`, null);

  const squareBoxes = {};
  for (const key of [...squares.keys()].sort(byNumberThenText)) {
    const e = squares.get(key);
    squareBoxes[key] = {
      count: e.count,
      spellings: [...e.spellings].sort(),
      files: [...e.files].sort(),
    };
  }

  return {
    values: byPx,
    opaque: byToken,
    squareIconBoxes: squareBoxes,
    strokeOverrides: strokeSites.sort(),
    touchTargetSites: touchTargets,
  };
}

function collect(list, keyOf, spellingOf) {
  const g = new Map();
  for (const r of list) {
    const k = keyOf(r);
    const e = g.get(k) || { count: 0, spellings: new Set(), files: new Set() };
    e.count++;
    if (spellingOf) e.spellings.add(spellingOf(r));
    e.files.add(r.file);
    g.set(k, e);
  }
  const out = {};
  for (const k of [...g.keys()].sort(byAxisThenNumber)) {
    const e = g.get(k);
    out[k] = {
      count: e.count,
      ...(spellingOf ? { spellings: [...e.spellings].sort() } : {}),
      files: [...e.files].sort(),
    };
  }
  return out;
}

function byAxisThenNumber(a, b) {
  const ia = a.indexOf(':');
  const ib = b.indexOf(':');
  const axa = a.slice(0, ia);
  const axb = b.slice(0, ib);
  if (axa !== axb) return axa < axb ? -1 : 1;
  return byNumberThenText(a.slice(ia + 1), b.slice(ib + 1));
}
function byNumberThenText(a, b) {
  const na = parseFloat(a);
  const nb = parseFloat(b);
  const numA = !Number.isNaN(na) && /^[\d.]+$/.test(a);
  const numB = !Number.isNaN(nb) && /^[\d.]+$/.test(b);
  if (numA && numB && na !== nb) return na - nb;
  if (numA !== numB) return numA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// The `containerCaps` section is a projection of `opaque`, kept in the
// baseline as its own block because it is the one slice somebody reads by
// hand. Derived in one place so the file and the assertion cannot disagree.
const vhCaps = (opaque) => Object.fromEntries(Object.entries(opaque)
  .filter(([k]) => /:\d+(?:\.\d+)?(?:d|s|l)?vh$/.test(k))
  .map(([k, v]) => [k, { count: v.count, files: v.files }]));

function baselineShape(c) {
  return {
    values: c.values,
    opaque: c.opaque,
    containerCaps: vhCaps(c.opaque),
    squareIconBoxes: c.squareIconBoxes,
    strokeOverrides: c.strokeOverrides,
    touchTargetSites: c.touchTargetSites,
  };
}

module.exports = { scan, baselineShape, toPx, SCALE };

// Requiring this module to regenerate the baseline must not run the
// assertions against the file being rewritten.
if (process.env.VERTICAL_LADDER_SCAN_ONLY) return;

const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const census = scan();

// A diff that names the values rather than dumping two objects — the failure
// message is the whole product of a baseline test.
function diff(actual, expected, render = (v) => JSON.stringify(v)) {
  const lines = [];
  for (const k of Object.keys(actual)) {
    if (!(k in expected)) lines.push(`  + ${k}  ${render(actual[k])}`);
    else if (JSON.stringify(actual[k]) !== JSON.stringify(expected[k])) {
      lines.push(`  ~ ${k}  was ${render(expected[k])}  now ${render(actual[k])}`);
    }
  }
  for (const k of Object.keys(expected)) {
    if (!(k in actual)) lines.push(`  - ${k}  ${render(expected[k])}`);
  }
  return lines;
}

const RE_PIN = 'Re-pin tests/baselines/vertical-heights.json in the SAME commit as the change, '
  + 'and say in that commit which values moved and why. Refreshing it wholesale to go green '
  + 'discards the census, which is the only thing this file produces.';

// ── 0. The normalizer is pinned before anything is measured with it ──────
//
// The same discipline the APCA port in tests/theme-ink-guards.test.js uses on
// itself: if this arithmetic drifts, every number in the baseline is measuring
// something else and the whole file passes while describing nothing.
test('the six-spelling normalizer reproduces its reference conversions', () => {
  assert.equal(toPx('44px'), 44, 'px');
  assert.equal(toPx('2.5rem'), 40, 'rem at the 16px root');
  assert.equal(toPx('0.5625rem'), 9, 'the --home-panel-bar-h derivation');
  assert.equal(toPx('1.4em'), 22.4, 'em, resolved at the root like rem — see the blind-spot note');
  assert.equal(toPx('0'), 0, 'unitless zero is a length');
  assert.equal(toPx('calc(100dvh - 3rem)'), null, 'calc is unresolvable, not absent');
  assert.equal(toPx('85vh'), null, 'viewport units are unresolvable, not absent');
  assert.equal(toPx('100%'), null, 'percentages are unresolvable, not absent');
  assert.equal(SCALE[11], 44, 'h-11 is 44px');
  assert.equal(SCALE.gutter, 12, 'spacing.gutter is the 0.75rem content keyline');

  // The scan must actually have read something. An empty walk would make every
  // deepEqual below compare two empty objects and pass in silence.
  const files = SOURCE_DIRS.reduce((n, [rel, re]) => n + walk(path.join(root, rel), re).length, 0);
  assert.ok(files > 200, `the source walk found only ${files} files — the scan roots have moved`);
  assert.ok(fs.existsSync(path.join(root, CSS_FILES[0])), 'public/css/app.css is in scope');
  assert.ok(Object.keys(census.values).length > 50, 'the census is empty — the normalizer stopped matching');

  // All six spellings must actually be reaching the census. If one of these
  // regexes stops matching, every row it fed shrinks silently and the file
  // still passes on the day the baseline is re-pinned — the exact failure
  // it exists to prevent, turned inward.
  const spellings = Object.values(census.values).flatMap((v) => v.spellings);
  const has = (re, what) => assert.ok(spellings.some((s) => re.test(s)), `spelling ${what} reached nothing`);
  has(/^h-9$/, '1 (Tailwind scale)');
  has(/^min-h-\[44px\]$/, '2 (arbitrary utility)');
  has(/^height: \d+px$/, '3 (raw CSS)');
  has(/^--[\w-]+: [\d.]+rem$/, '4a (custom-property declaration)');
  has(/^height: var\(--/, '4b (a use resolved THROUGH a custom property)');
  has(/^sm:min-h-\[36px\]$/, '2b (the variant chain, i.e. the density boundary)');
  assert.ok(Object.keys(census.opaque).some((k) => /calc\(|vh$/.test(k)), 'spelling 6 (calc / viewport) reached nothing');

  // Spelling 5 lives in exactly one place a class regex cannot see.
  assert.ok(census.values['h:36'].files.includes('frontend/src/features/dialogs/screenshot-select.js'),
    'spelling 5 (a `height:36px` inside style.cssText) is no longer being read');

  // A var with two definitions is not one value — see the resolution note.
  assert.ok(Object.keys(census.values).includes('var:116') && Object.keys(census.values).includes('var:124'),
    '--home-cell-h has two definitions and both must be recorded, not collapsed');
});

// ── 1. No NEW distinct vertical value ────────────────────────────────────
test('the set of distinct vertical values is exactly the baseline', () => {
  const now = Object.keys(census.values);
  const then = Object.keys(baseline.values);
  const added = now.filter((k) => !then.includes(k));
  const gone = then.filter((k) => !now.includes(k));
  assert.deepEqual({ added, gone }, { added: [], gone: [] },
    `the vertical ladder gained or lost a value.\n`
    + `${added.map((k) => `  + ${k}px  ${JSON.stringify(census.values[k].spellings)}`).join('\n')}\n`
    + `${gone.map((k) => `  - ${k}px  ${JSON.stringify(baseline.values[k].spellings)}`).join('\n')}\n`
    + `A NEW value is a rung nobody weighed — an unnamed size is decided by whoever typed last.\n${RE_PIN}`);
});

// ── 2. No value's site count moved ───────────────────────────────────────
test('every vertical value has exactly its baseline site count', () => {
  const now = mapValues(census.values, (v) => v.count);
  const then = mapValues(baseline.values, (v) => v.count);
  const lines = diff(now, then, (n) => `${n} sites`);
  assert.deepEqual(lines, [],
    `site counts moved:\n${lines.join('\n')}\n`
    + `These ARE the denominator a sweep reports against.\n${RE_PIN}`);
});

// ── 3. No value gained a new spelling ────────────────────────────────────
//
// The heart of it. 44px arriving as `h-[44px]` where the tree spells it
// `h-11` and `min-h-[44px]` is not a new value and not a new count — it is a
// new SPELLING, and it is precisely what a sweep matching one pattern misses.
test('every vertical value is spelled exactly the baseline ways', () => {
  const now = mapValues(census.values, (v) => v.spellings);
  const then = mapValues(baseline.values, (v) => v.spellings);
  const lines = diff(now, then);
  assert.deepEqual(lines, [],
    `spellings moved:\n${lines.join('\n')}\n`
    + `A value spelled a new way is a value the next census will undercount. `
    + `If this is a deliberate second ladder (a tap FLOOR beside a square BOX), `
    + `record it and say which ladder it joins.\n${RE_PIN}`);
});

// ── 4. Attribution is current ────────────────────────────────────────────
//
// Asserted, not merely recorded. The lesson tests/theme-ink-guards.test.js
// draws from its own stale admin-console exemption is that an unchecked note
// carries the assumption that justified it and nothing re-checks it when the
// world moves. A file list that rots is worse than no file list, because a
// sweep will trust it.
test('every vertical value is attributed to exactly the baseline files', () => {
  const now = mapValues(census.values, (v) => v.files);
  const then = mapValues(baseline.values, (v) => v.files);
  const lines = diff(now, then, (f) => `${f.length} files`);
  assert.deepEqual(lines, [],
    `attribution moved:\n${lines.join('\n')}\n`
    + `A file moving in or out of a value's row is the census changing shape even `
    + `when the count did not.\n${RE_PIN}`);
});

// ── 5. The unresolvable half ─────────────────────────────────────────────
//
// calc(), vh/dvh, env(), %, and the keyword heights (h-full, min-h-full).
// Never reduced to px — recorded and attributed, so "we could not resolve it"
// stays distinguishable from "it is not there".
test('the unresolved vertical expressions are exactly the baseline set', () => {
  const lines = diff(census.opaque, baseline.opaque, (v) => `${v.count}x`);
  assert.deepEqual(lines, [],
    `unresolved vertical expressions moved:\n${lines.join('\n')}\n`
    + `These are calc / viewport / env / % / keyword heights. This file cannot reduce them, `
    + `which is exactly why it has to remember them.\n${RE_PIN}`);
});

// ── 6. The container caps ────────────────────────────────────────────────
//
// Recorded as DATA, with one assertion attached: dialog.tsx's cap is the
// primitive's, 80vh is the convergence target the four 85vh sites should come
// down to, and THE PRIMITIVE IS NEVER RAISED to meet them. Raising it is the
// tempting fix and the wrong direction — it would move every dialog in the
// product to match four call sites.
test('the viewport container caps are the baseline set, and the dialog primitive is not raised', () => {
  const lines = diff(vhCaps(census.opaque), baseline.containerCaps, (v) => `${v.count}x ${JSON.stringify(v.files)}`);
  assert.deepEqual(lines, [],
    `viewport caps moved:\n${lines.join('\n')}\n`
    + `80vh (frontend/@/components/ui/dialog.tsx) is the convergence target; the four `
    + `max-h-[85vh] call sites come DOWN to it. The primitive is never raised.\n${RE_PIN}`);

  const dialog = fs.readFileSync(path.join(root, 'frontend/@/components/ui/dialog.tsx'), 'utf8');
  assert.match(stripJs(dialog), /max-h-\[80vh\]/,
    'the dialog primitive must still cap at 80vh — raising it moves every dialog to match a call site');
  assert.doesNotMatch(stripJs(dialog), /max-h-\[8[5-9]vh\]|max-h-\[9\dvh\]/,
    'the dialog primitive was raised past 80vh');
});

// ── 7. The strokeWidth-override allowlist ────────────────────────────────
//
// 60daf71e had to undo a sweep that dragged EIGHT icon sites which inherit
// stroke 2 onto the compensation table, sending each from w-3.5 at 2 to w-3
// at 3 — rendered stroke is strokeWidth x size / 24, so 1.167px became
// 1.500px: 29% heavier in a box 14% smaller, and on the home panel title bar
// three previously identical icons came out with a 33% size gap between them.
//
// The table governs ONLY the sites that ALREADY override. Enumerating them
// makes that sweep mechanically unrepeatable: adding a ninth site is a new row
// here and fails, and it fails whether the new override is right or wrong,
// which is the point — an override is an argument somebody has to make.
//
// The svg-primitive rows are chart geometry (axis rules, a spinner arc), not
// glyphs. They are listed so the icon rows cannot be confused with them.
test('exactly the enumerated sites override strokeWidth', () => {
  const added = census.strokeOverrides.filter((s) => !baseline.strokeOverrides.includes(s));
  const gone = baseline.strokeOverrides.filter((s) => !census.strokeOverrides.includes(s));
  assert.deepEqual(census.strokeOverrides, baseline.strokeOverrides,
    `the strokeWidth-override set moved.\n`
    + `${added.map((s) => `  + ${s}`).join('\n')}\n${gone.map((s) => `  - ${s}`).join('\n')}\n`
    + `The compensation table (w-4+ -> 2 · w-3.5 -> 2.5 · w-3 -> 3) governs the sites that `
    + `ALREADY override. A site that INHERITS stroke 2 is legible and is left alone.\n${RE_PIN}`);
});

// ── 8. The square icon-box ladder ────────────────────────────────────────
//
// 12 / 16 / 20 is the shell's icon ladder; the rest of the rows are avatars,
// tiles and discs. Recorded as data so the 44px note above is checkable: all
// four `h-11` sites appear here as `w-11 h-11`, which is what makes them a
// different ladder from the 26 `min-h-[44px]` tap floors.
test('the square icon-box ladder is exactly the baseline', () => {
  const lines = diff(census.squareIconBoxes, baseline.squareIconBoxes, (v) => `${v.count}x ${JSON.stringify(v.spellings)}`);
  assert.deepEqual(lines, [],
    `square boxes moved:\n${lines.join('\n')}\n${RE_PIN}`);
});

// ── 9. The sub-44 exemption's own denominator ────────────────────────────
test('the un-touch-target site count is exactly the baseline', () => {
  assert.equal(census.touchTargetSites, baseline.touchTargetSites,
    `un-touch-target sites: ${census.touchTargetSites}, baseline ${baseline.touchTargetSites}.\n`
    + `This is what makes every sub-44 control box legal: the kit expands the hit area to `
    + `max(100%, 44px) without touching the painted box. If it drops, some control lost its `
    + `tap target while keeping its 28px paint.\n${RE_PIN}`);
});

function mapValues(obj, f) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = f(v);
  return out;
}
