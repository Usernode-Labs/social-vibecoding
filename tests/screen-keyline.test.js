// tests/screen-keyline.test.js — the CONTENT KEYLINE, guarded four ways.
//
// ── What the keyline is ────────────────────────────────────────────────
//
// `--screen-gutter` (public/css/app.css, aliased in tailwind.config.js as
// `spacing.gutter` so `px-gutter` / `mx-gutter` / `pl-gutter` compile) is the
// shell's CONTENT tier: lists, feeds, chats, transcripts. A screen-level
// scroll container or bar spells it ONCE, on itself; its children do not each
// self-inset. That is the defect this file exists for — #dc-messages had
// thirteen distinct first-content x-positions because every row picked its
// own number (a bubble at 0, a status line at 0, a card at 12, app.css's own
// margins at 12), and no two of them were spelled the same way.
//
// Three things are deliberately NOT the keyline, and each has already been
// broken by a sweep that did not check for its exception clause:
//
//   * CHROME-16 is a separate, CORRECT tier — the platform header, auth, the
//     reading columns, and every native-kit surface in the frozen /v1/
//     contract. The 12/16 jog between a back chevron and a screen's content
//     is that seam, not drift. Do not collapse it.
//   * ADMIN is `p-4 lg:px-6`, the far side of the density boundary. A 44px
//     tap target is right on #home and wrong in a table of 130 rows.
//     `px-gutter` must never cross into features/admin/.
//   * INTERIORS answer to their own surface. A chip's padding, a list's
//     content indent, a bubble's inner text inset. `.dc-msg` is
//     `padding: 8px 12px` and that 12 is a bubble's inset, not a gutter —
//     which is why test 4's ban is scoped to manifested containers and to
//     the AXIS each one carries its keyline on, rather than to "12px".
//
// ── What this CANNOT catch ─────────────────────────────────────────────
//
// This is static analysis over source text, in the style of
// tests/theme-ink-guards.test.js and tests/admin-ui-registry.test.js. It
// reads spellings, never rendered geometry, so it is blind to:
//
//   * RUNTIME STYLE WRITES. `el.style.paddingLeft = …`, a class added by
//     `classList.add`, or a kit control that insets itself from
//     public/usernode-native/v1/. Nothing here evaluates JavaScript.
//   * TRANSFORMS AND ABSOLUTE POSITIONING. A `translateX`, a `left:`, a
//     negative margin used as bleed — all of them move the rendered first
//     x-position without touching a padding declaration.
//   * innerHTML REGIONS THAT NEVER ENTER A .tsx FILE. The launchpad's card
//     is built in public/js/launchpad.js and arrives through
//     `dangerouslySetInnerHTML`; this file guards the SLOT that hosts it,
//     not the markup inside it.
//   * MANIFEST COMPLETENESS. Test 2 asserts that the containers listed below
//     still carry the token. It cannot know about a screen nobody has added
//     yet — the manifest IS the staging plan, and other screens join it
//     incrementally as they are swept. An unlisted screen is unguarded, and
//     that is a gap by construction rather than a pass.
//
// PROMOTION TRIGGER: the first keyline regression that ships while this file
// is green is the evidence that spellings are no longer enough, and it buys
// `scripts/audit-keylines.mjs` on the precedent of
// scripts/audit-react-ownership.mjs — a Playwright script living OUTSIDE
// `npm test`, walking the ROUTES list, measuring each screen container's real
// `getBoundingClientRect().left` against its first content child's, and
// exiting non-zero on a mismatch. Do not build it speculatively; the static
// half is cheap and the browser half is not.
//
// Run with: node --test tests/screen-keyline.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const APP_CSS = 'public/css/app.css';
const DEV_CHAT_DIR = 'frontend/src/features/dev-chat';

// ── Normalization ──────────────────────────────────────────────────────
//
// THE MULTI-SPELLING NORMALIZER IS THE LOAD-BEARING PART OF THIS FILE.
//
// The same 12px is currently spelled `px-3`, `p-3`, `12px`, `0.75rem` and
// `.75rem` across the tree, and a sweep matching ONE spelling misses the
// others — that is a proven failure here, not a hypothetical: the keyline
// pass that preceded this file found sites in all five forms. Every count and
// every ban below reduces to px through this one path, so there is exactly
// one place a new spelling has to be taught.

const REM = 16;          // the root font size the whole product renders at
const TW_STEP = 4;       // Tailwind's numeric spacing scale, in px
const GUTTER_PX = 12;    // 0.75rem — the value --screen-gutter resolves to

/** A CSS length token -> px, or `'TOKEN'` for the gutter variable, or null. */
function lengthToPx(tok) {
  if (!tok) return null;
  const t = String(tok).trim();
  if (/var\(\s*--screen-gutter\s*\)/.test(t)) return 'TOKEN';
  let m = /^(-?(?:\d+)?\.?\d+)px$/.exec(t);
  if (m) return Math.round(parseFloat(m[1]) * 100) / 100;
  m = /^(-?(?:\d+)?\.?\d+)rem$/.exec(t);
  if (m) return Math.round(parseFloat(m[1]) * REM * 100) / 100;
  if (t === '0') return 0;
  return null; // auto, %, calc(), em, another var() — not a fixed inset
}

/**
 * The LEFT component of a padding/margin declaration.
 *
 * The 1-to-4-value shorthand forms are the whole reason this exists: a bare
 * `padding: 12px` and a `padding: 8px 12px` and a `padding: 2px 0 4px 22px`
 * put their horizontal inset in three different argument positions, and a
 * regex for `padding:\s*12px` sees only the first.
 */
function leftComponent(prop, value) {
  // Split on whitespace that is not inside a function call, so
  // `var(--screen-gutter)` and `calc(1rem + 2px)` stay single tokens.
  const v = value.trim().split(/\s+(?![^(]*\))/).filter(Boolean);
  if (prop === 'padding' || prop === 'margin') {
    if (v.length === 1) return v[0];            // all four
    if (v.length === 2 || v.length === 3) return v[1]; // block / inline
    return v[3];                                 // top right bottom LEFT
  }
  if (prop === 'padding-inline' || prop === 'margin-inline') return v[0];
  return v[0];                                   // -left / -right / -start
}

const H_PROPS = new Set([
  'padding', 'padding-left', 'padding-right', 'padding-inline', 'padding-inline-start',
  'margin', 'margin-left', 'margin-right', 'margin-inline', 'margin-inline-start',
]);

const familyOf = (prop) => (prop.startsWith('padding') ? 'padding' : 'margin');

/** Every horizontal inset declared in a CSS declaration block, normalized. */
function cssInsets(body) {
  const out = [];
  for (const decl of body.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    if (!H_PROPS.has(prop)) continue;
    out.push({ prop, family: familyOf(prop), px: lengthToPx(leftComponent(prop, decl.slice(i + 1))) });
  }
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** Flat rule scan: `selector { body }`. Adequate — app.css nests only @media. */
function* cssRules(css) {
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(stripComments(css)))) {
    yield { selectors: m[1].split(',').map((s) => s.trim().replace(/\s+/g, ' ')), body: m[2] };
  }
}

// Tailwind horizontal-inset utility prefixes, per family. `p-3` and `m-3` set
// all four sides, so both count on the horizontal axis.
const TW_PREFIX = {
  padding: ['p', 'px', 'pl', 'pr', 'ps', 'pe'],
  margin: ['m', 'mx', 'ml', 'mr', 'ms', 'me'],
};

/**
 * Horizontal insets spelled as Tailwind utilities in a class run, normalized.
 * Handles the numeric scale (x4), the negative form (`-mx-3`) and arbitrary
 * values (`px-[12px]`, `mx-[0.75rem]`).
 */
function twInsets(src, family) {
  const alt = TW_PREFIX[family].join('|');
  const out = [];
  const numeric = new RegExp(`(?:^|[\\s'"\`{])(-?)(${alt})-(\\d+(?:\\.\\d+)?)(?=[\\s'"\`}]|$)`, 'g');
  const arbitrary = new RegExp(`(?:^|[\\s'"\`{])(-?)(${alt})-\\[([^\\]]+)\\]`, 'g');
  let m;
  while ((m = numeric.exec(src))) {
    out.push({ spelling: `${m[1]}${m[2]}-${m[3]}`, px: (m[1] ? -1 : 1) * parseFloat(m[3]) * TW_STEP });
  }
  while ((m = arbitrary.exec(src))) {
    const px = lengthToPx(m[3]);
    if (px !== null) out.push({ spelling: `${m[1]}${m[2]}-[${m[3]}]`, px: (m[1] ? -1 : 1) * (px === 'TOKEN' ? GUTTER_PX : px) });
  }
  return out;
}

/**
 * Horizontal insets spelled as a raw `style` string — a `style="…"` attribute
 * inside a JS template literal, or a `style={{ paddingLeft: '12px' }}` object.
 * These are invisible to any class-name scan, and public/js/** builds markup
 * this way, so leaving them out would be a hole shaped exactly like the
 * legacy renderer.
 */
function styleInsets(src, family) {
  const out = [];
  const re = new RegExp(`\\b${family}(-left|-right|-inline|-inline-start)?\\s*:\\s*([^;"'\`}]+)`, 'gi');
  const camel = new RegExp(`\\b${family}(Left|Right|Inline|InlineStart)?\\s*:\\s*['"\`]([^'"\`]+)['"\`]`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const prop = `${family}${(m[1] || '').toLowerCase()}`;
    const px = lengthToPx(leftComponent(prop, m[2]));
    if (px !== null) out.push({ spelling: m[0].trim(), px });
  }
  while ((m = camel.exec(src))) {
    const prop = `${family}${m[1] ? `-${m[1].toLowerCase()}` : ''}`;
    const px = lengthToPx(leftComponent(prop, m[2]));
    if (px !== null) out.push({ spelling: m[0].trim(), px });
  }
  return out;
}

// ── 1. THE TOKEN IS PINNED ─────────────────────────────────────────────

test('--screen-gutter is declared exactly once, and the Tailwind alias is a REFERENCE', () => {
  const css = read(APP_CSS);
  const declarations = [...stripComments(css).matchAll(/--screen-gutter\s*:/g)];
  assert.equal(declarations.length, 1,
    `--screen-gutter must be declared exactly once in ${APP_CSS} (found ${declarations.length}). `
    + 'A second declaration is a second number to drift, which is the whole failure the token prevents.');

  const value = /--screen-gutter\s*:\s*([^;]+);/.exec(stripComments(css));
  assert.ok(value, '--screen-gutter has a value');
  assert.equal(lengthToPx(value[1].trim()), GUTTER_PX,
    'the token resolves to 12px — the CONTENT tier. CHROME is 16 and is a separate, correct tier.');

  const alias = require(path.join(ROOT, 'tailwind.config.js')).theme.extend.spacing.gutter;
  assert.equal(alias, 'var(--screen-gutter)',
    'tailwind.config.js must alias the gutter BY REFERENCE. A literal (`0.75rem`, `12px`) here would '
    + 'compile `px-gutter` to a second, independent number — and the two would drift silently, because '
    + 'nothing renders them side by side.');
});

// ── 2. THE MANIFEST ────────────────────────────────────────────────────
//
// In the OWNED style of scripts/audit-react-ownership.mjs: an explicit list of
// keyline-bearing containers, each with a one-line reason, anchored on the
// element's id, the exporting const, or the CSS selector.
//
// `axis` is the property family the container carries its keyline on, and it
// is load-bearing for test 4 rather than decoration: the HINT card holds the
// keyline with `mx-gutter` and keeps its own `px-3` INTERIOR, and a ban that
// could not tell those apart would demand the interior be swept too. That
// over-application has shipped here three times.
//
// `expect` is what the container must spell: a class token, `'TOKEN'` for the
// CSS variable, or `'zero'` for a child that has SURRENDERED its inset to a
// parent that now spells the gutter once.
//
// THIS LIST IS THE STAGING PLAN. It starts at the dev chat because that is
// the screen the sweep fixed; other screens join it as they are swept.

const MANIFEST = [
  {
    id: 'dc-messages',
    file: `${DEV_CHAT_DIR}/view.tsx`,
    axis: 'padding',
    expect: 'px-gutter',
    why: 'the transcript scroller — the screen-level container that spells the keyline once so its rows do not each self-inset',
  },
  {
    const: 'BAR',
    file: `${DEV_CHAT_DIR}/view.tsx`,
    axis: 'padding',
    expect: 'px-gutter',
    why: "#dc-composer-bar's class run: a pinned bottom bar shares a left edge with the transcript above it (one of the four composer bars — all four move or none)",
  },
  {
    id: 'dc-session-header',
    file: `${DEV_CHAT_DIR}/view.tsx`,
    axis: 'padding',
    expect: 'px-4',
    why: "CHROME-16, not content: a titled bar with a border-b belongs to the header stack, and settings/leaderboard/profile/browse all put p-4 directly under the platform header. Measured in the browser: at px-gutter its title sat at 12 under a back disc at 16 — a 4px jog between two undivided rows. The tier change belongs ON the border-b",
  },
  {
    const: 'HINT',
    file: `${DEV_CHAT_DIR}/view.tsx`,
    axis: 'margin',
    expect: 'mx-gutter',
    why: 'the one-shot proposal hint: a floated card whose OUTER edge joins the keyline via margin, its px-3 interior untouched',
  },
  {
    rule: '.dc-launchpad-slot',
    file: APP_CSS,
    axis: 'padding',
    expect: 'TOKEN',
    why: 'the launchpad slot spans the chat pane and owns the inset for whatever public/js/launchpad.js mounts inside it',
  },
  {
    rule: '.dc-pr-card',
    file: APP_CSS,
    axis: 'margin',
    expect: 'zero',
    why: 'a CHILD of #dc-messages: its horizontal margin is 0 because the scroller now carries the keyline — a child that adds its own lands at 24px',
  },
  {
    rule: '.messages-composer',
    file: APP_CSS,
    axis: 'padding',
    expect: 'TOKEN',
    why: 'the messages screen composer — the second of the four composer bars that joined the keyline together',
  },
];

/** The `<tag …>` that carries `id="<id>"`. */
function jsxTagById(src, id) {
  const at = src.indexOf(`id="${id}"`);
  assert.notEqual(at, -1, `no element with id="${id}"`);
  const open = src.lastIndexOf('<', at);
  const close = src.indexOf('>', at);
  assert.ok(open !== -1 && close !== -1, `id="${id}" is not inside a tag`);
  const slice = src.slice(open, close + 1);
  assert.ok(slice.length < 800, `id="${id}" anchor ran away — ${slice.length} chars`);
  return slice;
}

/** The `const NAME = …;` declaration, up to its terminating semicolon. */
function constDecl(src, name) {
  const m = new RegExp(`const ${name}\\b[\\s\\S]*?;`).exec(src);
  assert.ok(m, `no \`const ${name}\` declaration`);
  assert.ok(m[0].length < 1200, `const ${name} anchor ran away — ${m[0].length} chars`);
  return m[0];
}

/** The declaration block of the rule whose selector list contains `sel`. */
function cssRuleBody(css, sel) {
  for (const rule of cssRules(css)) if (rule.selectors.includes(sel)) return rule.body;
  assert.fail(`no rule with selector \`${sel}\``);
}

/** One manifest entry -> the exact source text that container is spelled in. */
function sliceFor(entry) {
  const src = read(entry.file);
  if (entry.id) return jsxTagById(src, entry.id);
  if (entry.const) return constDecl(src, entry.const);
  return cssRuleBody(src, entry.rule);
}

const label = (e) => e.id ? `#${e.id}` : e.const ? `${e.const} (const)` : e.rule;

test('every manifested container still spells the keyline through the token', () => {
  for (const entry of MANIFEST) {
    const slice = sliceFor(entry);
    const where = `${label(entry)} in ${entry.file} — ${entry.why}`;
    if (entry.expect === 'TOKEN') {
      const insets = cssInsets(slice).filter((d) => d.family === entry.axis);
      assert.ok(insets.length > 0, `${where}: declares no ${entry.axis} at all`);
      assert.ok(insets.some((d) => d.px === 'TOKEN'),
        `${where}: must spell its ${entry.axis} through var(--screen-gutter), not a literal `
        + `(saw ${JSON.stringify(insets.map((d) => `${d.prop}: ${d.px}`))})`);
    } else if (entry.expect === 'zero') {
      const insets = cssInsets(slice).filter((d) => d.family === entry.axis);
      assert.ok(insets.length > 0, `${where}: declares no ${entry.axis} at all`);
      assert.ok(insets.every((d) => d.px === 0),
        `${where}: its horizontal ${entry.axis} must stay 0 — the scroller owns the keyline and a child `
        + `that adds its own lands at 24px (saw ${JSON.stringify(insets.map((d) => `${d.prop}: ${d.px}`))})`);
    } else {
      assert.ok(slice.includes(entry.expect),
        `${where}: must carry \`${entry.expect}\`. Got:\n${slice}`);
    }
  }
});

test('the manifest documents every entry', () => {
  for (const entry of MANIFEST) {
    assert.ok(entry.why && entry.why.length > 30,
      `${label(entry)} needs a one-line reason — an unexplained entry is one a future sweep deletes`);
    assert.ok(['padding', 'margin'].includes(entry.axis), `${label(entry)}: axis must be padding or margin`);
  }
});

// ── 3. THE NORMALIZED CENSUS — a RATCHET, not a ceiling ────────────────
//
// BUDGETS HERE ARE EQUALITIES, NOT `<=`, AND THAT IS DELIBERATE. This
// repository has twice watched a ratchet stop ratcheting because a budget
// carried silent headroom — 200 against a true 78, then 58 against a true 6 —
// and tests/theme-ink-guards.test.js condemns exactly that in its own
// comments, twice. An equality fails on the way DOWN as well as up, which
// forces the number to be lowered in the same commit as the fix that earned
// it. If you fix sites, lower the budget here and name the sweep you measured
// against.
//
// Measured 2026-08-28 against the tree as it stands, by the normalizer above.

// Distinct nonzero POSITIVE left-inset values declared across every `.dc-*`
// rule in app.css. This is a census of SPREAD, not a ban: most of these are
// legitimate interiors (a chip at 4, a code block at 12, a card at 14). The
// number is the point — a fourteenth distinct x-value on one screen has to be
// argued for, because thirteen is already how the transcript got into trouble.
const DC_DISTINCT_INSETS = 13;

// NEGATIVE left-margins are excluded: a negative margin is BLEED, not an
// inset, and it is one of the four named exception shapes in the
// containers-own-separation rule. `.dc-task-item { margin-left: -16px }` pulls
// a task bullet back under `.dc-ul`'s 20px indent and is correct.
const DC_NEGATIVE_INSETS = 1;

test('the .dc-* horizontal-inset census holds at its measured spread', () => {
  const css = read(APP_CSS);
  const positive = new Map();
  const negative = new Map();
  for (const rule of cssRules(css)) {
    if (!rule.selectors.some((s) => s.includes('.dc-'))) continue;
    for (const d of cssInsets(rule.body)) {
      if (d.px === null || d.px === 0 || d.px === 'TOKEN') continue;
      const bucket = d.px > 0 ? positive : negative;
      if (!bucket.has(d.px)) bucket.set(d.px, []);
      bucket.get(d.px).push(`${rule.selectors[0]} { ${d.prop} }`);
    }
  }
  const show = (m) => [...m.keys()].sort((a, b) => a - b)
    .map((k) => `${k}px x${m.get(k).length} (${m.get(k)[0]})`).join('\n  ');
  assert.equal(positive.size, DC_DISTINCT_INSETS,
    `the .dc-* surfaces spell ${positive.size} distinct positive horizontal insets, not ${DC_DISTINCT_INSETS}.\n  `
    + `${show(positive)}\n`
    + 'If you ADDED one: does that surface really need an x-position none of the other thirteen has, or is it '
    + 'a screen-level container that should spell --screen-gutter instead? If you REMOVED one: lower the '
    + 'budget in this commit — a budget with headroom is a ratchet that has stopped ratcheting.');
  assert.equal(negative.size, DC_NEGATIVE_INSETS,
    `the .dc-* surfaces spell ${negative.size} distinct negative horizontal margins, not ${DC_NEGATIVE_INSETS}.\n  `
    + `${show(negative)}\n`
    + 'Negative margins are deliberate bleed and are a named exception — but a NEW one is a new claim, so it '
    + 'gets counted rather than waved through.');
});

// Hand-written 12px-equivalents in the dev-chat sources — every spelling the
// normalizer knows (px-3, p-3, px-[12px], px-[0.75rem], an inline style),
// counted on BOTH axes, minus anything spelled through the token.
//
// All 16 of these are INTERIORS today: six banner strips, eight controls and
// cards inside dev-chat.js's agent-choice dialog, the session row's own
// padding, and the HINT card's inner text inset. None of them is a keyline
// and none should be swept. The count is here so that a NEW one is visible —
// a container reaching for `px-3` when it meant `px-gutter` is precisely the
// mistake the token exists to make impossible, and it is invisible in a class
// diff because the two compile to the same twelve pixels.
const DEV_CHAT_RAW_TWELVES = 16;

test('the dev-chat 12px-equivalent census holds at its measured count', () => {
  const dir = path.join(ROOT, DEV_CHAT_DIR);
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.(tsx?|js)$/.test(n))) {
    // Strip comments — this file's own prose names `px-3` repeatedly, and a
    // census that counted documentation would be counting the wrong thing.
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^\s*\/\/.*$/gm, ' ');
    for (const family of ['padding', 'margin']) {
      for (const hit of [...twInsets(src, family), ...styleInsets(src, family)]) {
        if (hit.px === GUTTER_PX) hits.push(`${f}: ${hit.spelling}`);
      }
    }
  }
  assert.equal(hits.length, DEV_CHAT_RAW_TWELVES,
    `${DEV_CHAT_DIR} spells ${hits.length} raw 12px-equivalents, not ${DEV_CHAT_RAW_TWELVES}.\n  `
    + `${hits.join('\n  ')}\n`
    + 'Every one of these must be an INTERIOR — a control, a chip, a card\'s own text inset. If a new one is '
    + 'a screen-level container or bar, it wants `px-gutter` and a MANIFEST entry above. If you converted one, '
    + 'lower the budget in the same commit.');
});

// ── 4. THE RAW-SPELLING BAN — scoped to manifested containers ──────────
//
// SCOPED NARROWLY ON PURPOSE. Banning 12px INSIDE `.dc-*` surfaces would hit
// `.dc-msg`'s `padding: 8px 12px`, which is a bubble's content inset and not a
// keyline; over-applying a keyline rule to interiors has shipped here three
// times. So the ban reaches exactly the containers the manifest names, and on
// each one only the AXIS it carries its keyline on. HINT's `px-3` survives
// because HINT holds the keyline in `margin`.

const RAW_SPELLINGS = ['px-3', 'pl-3', 'pr-3', 'p-3', 'mx-3', 'ml-3', 'mr-3', 'm-3', '12px', '0.75rem', '.75rem'];

test('a manifested container never spells the gutter raw on its keyline axis', () => {
  for (const entry of MANIFEST) {
    const slice = sliceFor(entry);
    const where = `${label(entry)} in ${entry.file}`;
    const raw = [];
    if (entry.file === APP_CSS) {
      for (const d of cssInsets(slice)) {
        if (d.family === entry.axis && d.px === GUTTER_PX) raw.push(`${d.prop} resolves to ${GUTTER_PX}px`);
      }
    } else {
      for (const hit of [...twInsets(slice, entry.axis), ...styleInsets(slice, entry.axis)]) {
        if (hit.px === GUTTER_PX) raw.push(hit.spelling);
      }
    }
    assert.deepEqual(raw, [],
      `${where} carries the keyline on its ${entry.axis} axis and must spell it through the token, not raw: `
      + `${raw.join(', ')}. One of ${RAW_SPELLINGS.join(' / ')} compiles to the same twelve pixels today and `
      + 'to a different twelve the day --screen-gutter is retuned — which is the entire point of the token.');
  }
});

// ── THE KEEP LIST ──────────────────────────────────────────────────────
//
// Values a future keyline sweep will read as drift and "correct". Each is
// pinned here so that correction fails loudly instead of landing.

test('KEEP: the cc-attached indent stays 22px — it is optical, not a gutter', () => {
  const css = read(APP_CSS);
  for (const sel of ['.dc-cc-attached-log', '.dc-cc-attached-md']) {
    const left = cssInsets(cssRuleBody(css, sel)).find((d) => d.family === 'padding');
    assert.equal(left && left.px, 22,
      `${sel} must keep its 22px left padding. Its own comment does the arithmetic: icon width (14) + gap (6) `
      + '+ 2px breathing room. It aligns log lines under the STATUS TEXT, not under the screen edge, so it is '
      + 'answering to a sibling glyph and not to the keyline.');
  }
});

test('KEEP: the full-bleed session row keeps px-3 — its TEXT holds the keyline', () => {
  const src = read(`${DEV_CHAT_DIR}/session-list.tsx`);
  const row = /className="dc-session-item[^"]*"/.exec(src);
  assert.ok(row, 'the session row still carries .dc-session-item');
  assert.ok(row[0].includes('px-3'),
    'the session row is FULL-BLEED: its hover ground runs edge to edge and only the text inside it sits on the '
    + 'keyline, so the 12px is padding ON the row rather than a gutter around it. Converting the row to '
    + '`px-gutter` would read identically today and break the moment the row gains an outer container.');
});

test('KEEP: CHROME-16 does not collapse into the content tier', () => {
  const src = read('frontend/src/features/header/platform-header.tsx');
  const tag = jsxTagById(src, 'platform-header');
  assert.ok(tag.includes('px-4'),
    '#platform-header is CHROME, which sits at 16px — a separate and correct tier alongside auth, the reading '
    + 'columns and every native-kit surface in the frozen /v1/ contract. The 12/16 jog between a back chevron '
    + "and a screen's content is that seam, not drift.");
  assert.ok(!/\bp[xlr]?-gutter\b/.test(tag),
    '#platform-header must not adopt the CONTENT keyline. Collapsing 16 into 12 would fight the kit and rewrite '
    + "two other tests' arithmetic for four pixels.");
});

test('KEEP: px-gutter never crosses the density boundary into the admin console', () => {
  const adminDir = path.join(ROOT, 'frontend/src/features/admin');
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|js)$/.test(e.name) && /\b-?[pm][xlr]?-gutter\b/.test(fs.readFileSync(p, 'utf8'))) {
        offenders.push(path.relative(ROOT, p));
      }
    }
  };
  walk(adminDir);
  assert.deepEqual(offenders, [],
    `the admin console is \`p-4 lg:px-6\`, the far side of the density boundary — a 44px tap target is right on `
    + '#home and wrong in a table of 130 rows on a 27" display. The content keyline must not reach it: '
    + offenders.join(', '));
});
