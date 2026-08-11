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
  for (const sel of ['.attr-chip', '.dev-badge-name', '.attr-avatar']) {
    const r = rule(sel);
    if (sel === '.attr-avatar') {
      // The avatar is a nested circle with its own deliberate 0.6rem glyph.
      assert.match(r, /font-size: 0\.6rem/);
      continue;
    }
    assert.doesNotMatch(r, /font-size:/, `${sel} must not fight .dev-badge`);
  }
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
