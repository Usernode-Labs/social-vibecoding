// Semantic colour tokens for the dev board (public/css/app.css).
//
// The board's status vocabulary used to hard-code hexes per badge helper,
// which produced two concrete bugs:
//
//   • "✓ Checks passing" borrowed .gc-merged-badge and so rendered in the
//     VIOLET "Merged" colour, even though green is what the rest of the board
//     means by passing (and "Passed — merging shortly" IS green);
//   • the vote tally pill and the "You voted X" box hard-coded
//     background:#fff / color:#1f2937 with NO .dark counterpart anywhere in
//     the file, so they sat as white slabs on an otherwise dark card.
//
// Every status tone now routes through a --state-* token declared for both
// light and dark. This is a CSS-text assertion in the style of
// tailwind-build.test.js — cheap insurance against a hex creeping back in.
//
// Run with: node --test tests/dev-color-tokens.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');

// The :root block and the FIRST .dark block (the palette override).
function blockAfter(marker) {
  const i = CSS.indexOf(marker);
  assert.ok(i >= 0, `expected a ${marker} block`);
  const open = CSS.indexOf('{', i);
  const close = CSS.indexOf('\n}', open);
  return CSS.slice(open, close);
}
const ROOT = blockAfter(':root {');
const DARK = blockAfter('.dark {');

function tokensIn(block) {
  return (block.match(/--state-[a-z-]+(?=\s*:)/g) || []).sort();
}

// ── The token set ───────────────────────────────────────────────────────

test('the five semantic tones are all declared', () => {
  const names = tokensIn(ROOT);
  for (const tone of ['neutral', 'progress', 'attention', 'blocked', 'ok', 'admin']) {
    assert.ok(names.includes(`--state-${tone}`), `--state-${tone} declared`);
  }
});

test('EVERY --state-* token has a dark counterpart', () => {
  // A token added to :root without a dark value renders an unreadable badge
  // in dark mode; this is what makes that a test failure rather than a bug
  // report.
  const light = tokensIn(ROOT);
  const dark = tokensIn(DARK);
  assert.ok(light.length >= 12, 'the tokens are actually in :root');
  assert.equal(light.join(','), dark.join(','),
    'the light and dark --state-* lists must match exactly');
});

// ── The two bugs the pass fixed ─────────────────────────────────────────

test('"Checks passing" no longer inherits the violet Merged colour', () => {
  // Its own class, so a future tone change to one can't silently move the
  // other, and both resolve to the OK token rather than a hex.
  assert.match(CSS, /\.gc-checks-passing-badge \{[^}]*color: var\(--state-ok\)/);
  assert.match(CSS, /\.gc-merged-badge \{[^}]*color: var\(--state-ok\)/);
  const FE = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(FE, /gc-checks-passing-badge[^>]*>✓ Checks passing/,
    'the passing badge uses its own class');
});

test('the tally pill and the voted box follow the theme', () => {
  const pill = CSS.slice(CSS.indexOf('.gc-vote-count {'), CSS.indexOf('.gc-vote-count-pending'));
  assert.doesNotMatch(pill, /#fff/, 'no hard-coded white');
  assert.match(pill, /background: var\(--bg-primary\)/);
  assert.match(CSS, /\.gc-vote-count-label \{[^}]*color: var\(--text-primary\)/);
  const voted = CSS.slice(CSS.indexOf('.gc-vote-voted-box {'), CSS.indexOf('.gc-vote-voted-box-yes'));
  assert.doesNotMatch(voted, /#fff/);
  assert.match(voted, /background: var\(--bg-primary\)/);
});

// ── One meaning per hue ─────────────────────────────────────────────────

test('checks FAILING reads blocked, not the advisory amber', () => {
  // It gates the merge, so it must not share .gc-warning-badge's amber with
  // the genuinely-advisory console warning.
  assert.match(CSS, /\.gc-blocked-badge \{[^}]*color: var\(--state-blocked\)/);
  assert.match(CSS, /\.gc-warning-badge \{[^}]*color: var\(--state-attention\)/);
  const FE = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  assert.match(FE, /gc-blocked-badge[^>]*>⚠ \$\{escapeHtml\(label\)\}/,
    'checksBadgeHtml renders the failing state as blocked');
});

test('the in-flight merge stages read PROGRESS, freeing amber for warnings', () => {
  assert.match(CSS, /\.gc-merging-badge \{[^}]*color: var\(--state-progress\)/);
  assert.match(CSS, /\.gc-conflict-badge \{[^}]*color: var\(--state-blocked\)/);
  assert.match(CSS, /\.gc-checks-running-badge \{[^}]*color: var\(--state-neutral\)/);
  // The composite pill derives 'behind main' and 'resolving' itself, so
  // .gc-behind-badge / .gc-resolving-badge (and their renderers) are gone —
  // dead CSS for a badge nothing paints is the same debt as a dead helper.
  assert.doesNotMatch(CSS, /\.gc-behind-badge/);
  assert.doesNotMatch(CSS, /\.gc-resolving-badge/);
  const FE = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'js', 'app-view.js'), 'utf8');
  for (const dead of ['resolvingBadgeHtml()', 'behindBadgeHtml(pr)', 'conflictFailedBadgeHtml()']) {
    assert.ok(!FE.includes(dead), `${dead} has no renderer left`);
  }
  // The two that other surfaces still call must survive.
  assert.match(FE, /mergingBadgeHtml\(\) \{/, 'group-chat.js still renders this one');
  assert.match(FE, /mergedBadgeHtml\(\) \{/);
});

test('an admin bypass is distinguished by SHAPE as well as hue', () => {
  // Amber alone would compete with the advisory warnings, so the force-merge
  // control carries a dashed outline too.
  const admin = CSS.slice(CSS.indexOf('.gc-vote-btn-admin {'), CSS.indexOf('.gc-vote-btn-admin:hover'));
  assert.match(admin, /color: var\(--state-admin\)/);
  assert.match(admin, /border-style: dashed/);
});

test('the canonical MergeStatus tones route through the tokens', () => {
  for (const [cls, tone] of [
    ['ms-badge-neutral', 'neutral'], ['ms-badge-violet', 'progress'],
    ['ms-badge-amber', 'attention'], ['ms-badge-green', 'ok'], ['ms-badge-red', 'blocked'],
  ]) {
    assert.match(CSS, new RegExp(`\\.${cls} *\\{[^}]*var\\(--state-${tone}\\)`), cls);
  }
  for (const [cls, tone] of [
    ['ms-pill-neutral', 'neutral'], ['ms-pill-violet', 'progress'],
    ['ms-pill-amber', 'attention'], ['ms-pill-green', 'ok'], ['ms-pill-red', 'blocked'],
  ]) {
    assert.match(CSS, new RegExp(`\\.${cls} *\\{[^}]*var\\(--state-${tone}\\)`), cls);
  }
});

test('the composite pill has a class for every tone it can emit', () => {
  for (const tone of ['neutral', 'progress', 'attention', 'blocked', 'ok', 'pending', 'yes', 'no']) {
    assert.match(CSS, new RegExp(`\\.gc-vote-count-${tone} \\{`), `gc-vote-count-${tone}`);
  }
});

test('the proportional fills are token-derived, not literal rgba', () => {
  assert.match(CSS, /\.gc-vote-fill-yes \{[^}]*var\(--state-ok-fill\)/);
  assert.match(CSS, /\.gc-vote-fill-no \{[^}]*var\(--state-blocked-fill\)/);
  assert.match(CSS, /\.gc-vote-fill-full-yes \{[^}]*var\(--state-ok-fill\)/);
  assert.match(CSS, /\.gc-vote-fill-full-no \{[^}]*var\(--state-blocked-fill\)/);
});

// ── The new board chrome is themed too ──────────────────────────────────

test('the ⋯ menu, dividers and muted cards use theme variables', () => {
  const menu = CSS.slice(CSS.indexOf('.dev-card-menu {'), CSS.indexOf('.dev-card-menu-item {'));
  assert.match(menu, /background: var\(--bg-primary\)/);
  assert.match(menu, /border: 1px solid var\(--border\)/);
  assert.match(menu, /position: fixed/, 'body-mounted so a column cannot clip it');
  assert.match(CSS, /\.dev-card-menu-item-danger \{[^}]*var\(--state-blocked\)/);
  assert.match(CSS, /\.dev-col-divider-label \{[^}]*color: var\(--text-faint\)/);
  // The private-session card says "draft" with a dashed ring. The widget
  // language's card has no hairline to switch, so the ring is an OUTLINE now —
  // drawn outside the box, taking no layout space, so a muted card still lines
  // up with its neighbours. Still a theme variable, which is what this test is
  // actually about.
  assert.match(CSS, /\.dev-card-muted \{[^}]*outline: 1px dashed var\(--border\)/);
});

test('the detail-view reason list tints by severity', () => {
  assert.match(CSS, /\.dev-detail-reason-hard \.dev-detail-reason-label \{[^}]*var\(--state-blocked\)/);
  assert.match(CSS, /\.dev-detail-reason-soft \.dev-detail-reason-label \{[^}]*var\(--state-attention\)/);
});
