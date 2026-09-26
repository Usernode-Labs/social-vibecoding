// The mark primitive: frontend/@/components/ui/logo-mark.tsx.
//
// ── Why this test exists at all ─────────────────────────────────────────
//
// Same reason tests/wordmark.test.js exists beside that primitive: the
// component draws no browser evidence of its own — it is inline `<svg>`, not
// a screenshot-visible colour swap by itself — and rendering it here is what
// makes the change visible to `npm run test:changed`, which maps a changed
// file to the suites that name it (scripts/test-changed.js).
//
// ── What is worth pinning about a mark ───────────────────────────────────
//
// Not its shape: two `d` strings cannot be eyeballed in a diff, and
// tests/shell-icon-set.test.js already proves the shipped document's paths
// are this module's, character for character. What is worth pinning is
// everything AROUND the shape:
//
//   - `fill="currentColor"` and no colour class — the whole reason
//     ../header/platform-mark.tsx can tint it `text-violet-600` at its call
//     site instead of baking a colour into a raster.
//   - `className` passed STRAIGHT THROUGH, not through cn().
//   - both accessible paths — a named figure and a decoration.
//   - two paths: the H and the sparkle, same as the generator script.
//
// Run with: node --test tests/logo-mark.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ENTRY = 'frontend/@/components/ui/logo-mark.tsx';
const SRC = read(ENTRY);

/** The Figma frame exports two paths: the H and the sparkle. */
const PATH_COUNT = 2;

const render = (props) => renderComponent(ENTRY, 'LogoMark', props);

/** Every single-quoted path literal in the module — the same read tests/shell-icon-set.test.js makes. */
const quotedPaths = () => (SRC.match(/'M[^'\\\n]*'/g) || []).map((s) => s.slice(1, -1));

/** The module's code, with the header comment that names these very spellings removed. */
const code = () => SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

test('the mark is one <svg> of two paths, filled with the current ink', () => {
  const html = render({ title: 'Homeroom' });
  assert.equal((html.match(/<svg\b/g) || []).length, 1, 'one drawing, not a group of them');
  assert.equal((html.match(/\sd="/g) || []).length, PATH_COUNT,
    `the mark is ${PATH_COUNT} paths — a shorter render is a half-pasted export, `
    + 'which still draws something and so looks like a styling problem');
  assert.match(html, /fill="currentColor"/,
    'currentColor is what lets one drawing take whatever ink its call site sets');
  assert.doesNotMatch(html, /stroke/,
    'the mark is filled; a stroke on it is a different drawing');
  assert.match(html, /viewBox="0 0 377\.327 300"/,
    'the node\'s own box — changing it rescales the mark against its call sites');
});

test('a title names the figure; without one the mark is decoration', () => {
  const named = render({ title: 'Homeroom' });
  assert.match(named, /role="img"/);
  assert.match(named, /aria-label="Homeroom"/);
  assert.doesNotMatch(named, /aria-hidden/,
    'a figure with an accessible name must not also be hidden');

  const bare = render({});
  assert.match(bare, /aria-hidden="true"/,
    'the header button already carries the accessible name via its own aria-label; '
    + 'a named glyph here would be read twice');
  assert.doesNotMatch(bare, /role="img"/);
  assert.doesNotMatch(bare, /aria-label/);
});

test('className lands verbatim — no merge, no reorder', () => {
  // Two widths in one string: cn()'s twMerge would collapse these to the
  // last one, which is the observable difference between a straight-through
  // className and a merged one.
  const html = render({ id: 'platform-mark-svg', className: 'w-4 w-[18px] h-auto text-violet-600' });
  assert.match(html, /class="w-4 w-\[18px\] h-auto text-violet-600"/,
    'the caller\'s class string is shipped as written — see the module header');
  // Attribute order is load-bearing for the same reason icons.tsx says it is.
  assert.match(html, /<svg id="platform-mark-svg" class="w-4 w-\[18px\] h-auto text-violet-600" fill="currentColor" viewBox=/,
    'id, then className, then fill, then viewBox — the prerendered document is '
    + 'compared attribute by attribute');
  assert.doesNotMatch(code(), /\bcn\(/, 'cn() runs twMerge, which reorders');
});

test('the path data is quoted literals, so the icon-set test can read it', () => {
  const quoted = quotedPaths();
  assert.equal(quoted.length, PATH_COUNT,
    'each path is a single-quoted literal on its own line, as WORDMARK_PATHS\'s are');
  const html = render({ title: 'Homeroom' });
  for (const d of quoted) {
    assert.ok(html.includes(`d="${d}"`), `a literal that never renders: ${d.slice(0, 32)}…`);
  }
  // The coupling this file exists beside: tests/shell-icon-set.test.js asserts
  // that every path in the prerendered document is one a module exports, and
  // this primitive is the third home it reads (generate-pwa-icons.js and
  // wordmark.tsx are the other two).
  const iconSet = read('tests/shell-icon-set.test.js');
  assert.match(iconSet, /frontend\/@\/components\/ui\/logo-mark\.tsx/,
    'tests/shell-icon-set.test.js must keep reading this module as a legal home '
    + 'for prerendered path data');
});

test('the primitive is a pure function of its props, with no ink of its own', () => {
  const body = code();
  for (const banned of ['useState', 'useEffect', 'useRef', 'useLayoutEffect', 'window.', 'document.']) {
    assert.ok(!body.includes(banned),
      `${banned} in a primitive the shell PRERENDERS — a hydration mismatch is a `
      + 'console error, and a console error on any route fails the proposal checks');
  }
  assert.doesNotMatch(body, /(?:text|fill|stroke|bg)-(?:zinc|violet|white|black)/,
    'no colour class on the primitive itself: currentColor is the whole design, '
    + 'and the call site is what picks violet-600');
  assert.doesNotMatch(body, /\bdark:/, 'nothing to theme — see above');
  assert.doesNotMatch(body, /\bcva\(/,
    'size travels in className at the call site, so there is no variant table '
    + 'to keep as complete literals');
});
