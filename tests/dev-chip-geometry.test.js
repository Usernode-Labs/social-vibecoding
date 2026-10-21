// The shared badge-row chip geometry (public/css/app.css).
//
// The card-as-pointer pass collapsed three chip sizes — Tailwind-sized
// attribute chips, the 💬 count and the linked-issue pills — into ONE box,
// `.dev-badge`, so a row of them sits on a single baseline. That box owns
// the height, padding, radius AND type size.
//
// It shipped with a real regression. `.attr-chip` sits AFTER `.dev-badge` in
// the same file at equal specificity and carried `font: inherit` — the
// SHORTHAND, which resets font-size, font-weight and line-height to their
// initial values. So every interactive chip (priority "High", assignee
// "@evan", category "bug") silently threw away the 10.5px/500/1 geometry and
// rendered at the card's 14px body text, tall enough to strain the 20px box
// and out of scale with its inert `<span>` neighbours. It went unnoticed for
// exactly one release because those chips USED to carry a Tailwind
// `text-[0.65rem]` utility, and tailwind.css loads after app.css.
//
// This file is a CSS-text assertion in the style of dev-color-tokens.test.js:
// cheap insurance that the box keeps its 20px height and its small label,
// and that no `font` shorthand creeps back in to take one of them away.
//
// Run with: node --test tests/dev-chip-geometry.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

// The later of two rules with the same selector: the size geometry and the
// fit are declared separately, and the fit is the one that comes after.
function lastRule(selector) {
  const i = CSS.lastIndexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

// ── The shared box ──────────────────────────────────────────────────────

test('.dev-badge keeps the uniform 20px box', () => {
  const badge = rule('.dev-badge');
  assert.match(badge, /height: 20px/, 'one height for every chip in the row');
  assert.match(badge, /box-sizing: border-box/, 'padding lives inside that 20px');
  assert.match(badge, /display: inline-flex/);
  assert.match(badge, /align-items: center/, 'flex centring, not a line-height hack');
});

test('.dev-badge sets the small label size the row was designed around', () => {
  const badge = rule('.dev-badge');
  const size = badge.match(/font-size:\s*([\d.]+)px/);
  assert.ok(size, '.dev-badge declares its own font-size');
  const px = parseFloat(size[1]);
  // The pre-collapse chips were `text-[0.65rem]` (10.4px). Anything near the
  // card's 13.5px title or the 14px body is the regression coming back.
  assert.ok(px >= 9.5 && px <= 11.5,
    `chip label should stay ~10.5px, got ${px}px — too large for a 20px box`);
  assert.match(badge, /line-height: 1/);
  assert.match(badge, /font-weight: 500/);
});

// ── The regression itself ───────────────────────────────────────────────

test('.attr-chip overrides only the UA font FAMILY, never the shorthand', () => {
  const chip = rule('.attr-chip');
  assert.doesNotMatch(chip, /(^|[\s;{])font:\s/,
    'the `font` shorthand here resets .dev-badge\'s size/weight/line-height '
    + '— an attribute chip then renders at the card\'s body size');
  assert.match(chip, /font-family: inherit/,
    'the <button> still needs its UA font family overridden');
  assert.doesNotMatch(chip, /font-size:/,
    'size belongs to .dev-badge, so the two can never disagree');
});

test('.attr-chip comes after .dev-badge, which is why the shorthand mattered', () => {
  // If someone reorders these, the shorthand stops being load-bearing and
  // this test\'s reasoning goes stale — so pin the order the fix assumes.
  assert.ok(CSS.indexOf('\n.dev-badge {') < CSS.indexOf('\n.attr-chip {'),
    '.attr-chip is the later rule at equal specificity');
});

test('no chip rule re-declares a competing font-size', () => {
  for (const sel of ['.attr-chip', '.dev-badge-name', '.dev-badge-label', '.attr-avatar']) {
    const r = rule(sel);
    if (sel === '.attr-avatar') {
      // The avatar is a nested circle with its own deliberate 0.6rem glyph.
      assert.match(r, /font-size: 0\.6rem/);
      continue;
    }
    assert.doesNotMatch(r, /font-size:/, `${sel} must not fight .dev-badge`);
  }
});

// ── A chip that does not fit stays a whole pill (#5755) ─────────────────
//
// The card's two bands and the folded row's band clip at ONE line. With
// every chip `flex-shrink: 0` and the category chip's label a bare text
// child, the chip that did not fit was sliced at the card's right edge
// instead of ending in an ellipsis inside a whole, rounded pill.

test('.dev-badge-label is the span that carries a chip\'s own words', () => {
  const label = rule('.dev-badge-label');
  assert.match(label, /overflow: hidden/);
  assert.match(label, /text-overflow: ellipsis/);
  assert.match(label, /min-width: 0/,
    'a flex item defaults to min-width: auto and would never shrink');
  assert.match(label, /white-space: nowrap/);
  // Only the row limits it: no cap of its own, and no type size to fight
  // `.dev-badge` with.
  assert.doesNotMatch(label, /max-width:/);
});

test('the clipped chip rows let a chip shrink into what is left', () => {
  for (const sel of [
    ':is(.dev-card-dense, .dev-card-topic) :is(.dev-card-status, .dev-card-facts) > .dev-badge',
    '.dev-ws-row-band > .dev-badge',
  ]) {
    const r = lastRule(sel);
    assert.match(r, /flex-shrink: 1|flex: 0 1 auto/, `${sel} may shrink`);
    assert.match(r, /min-width: 0/, `${sel} can shrink past its content`);
    assert.match(r, /overflow: hidden/, `${sel} clips inside its rounded box`);
  }
});

test('only the words give way: a chip\'s dot, avatar and bar keep their size', () => {
  for (const sel of [
    ':is(.dev-card-dense, .dev-card-topic) :is(.dev-card-status, .dev-card-facts) > .dev-badge > :not(.dev-badge-label):not(.dev-badge-name)',
    '.dev-ws-row-band > .dev-badge > :not(.dev-badge-label):not(.dev-badge-name)',
  ]) {
    assert.match(rule(sel), /flex-shrink: 0/, `${sel} keeps the dot and avatar`);
  }
});

test('the Workshop line row\'s category chip shrinks before the mask, not into it', () => {
  const r = rule('.dev-ws-lrow .dev-ws-wrow-status > .attr-chip');
  assert.match(r, /flex: 0 1 auto/, 'the category chip is the one thing that gives way');
  assert.match(r, /min-width: 0/);
  assert.match(r, /overflow: hidden/);
  // The line masks its last 20px; it keeps 20px of right padding so a chip
  // that FITS is never faded. That is a second rule of its own, so find it
  // rather than the line's main one.
  assert.ok(
    CSS.includes('\n.dev-ws-lrow .dev-ws-wrow-status { padding-right: 20px; }'),
    'a chip that fits ends before the 20px mask');
});

// ── The light/dark treatment the collapse introduced is untouched ───────

test('the chip tint still comes from utilities, not a hard-coded background', () => {
  const chip = rule('.attr-chip');
  assert.match(chip, /background: none/,
    'the per-value bg-…/10 utility supplies the tint in both themes');
  const badge = rule('.dev-badge');
  assert.doesNotMatch(badge, /background:/,
    'geometry only — a literal background here would break dark mode');
});
