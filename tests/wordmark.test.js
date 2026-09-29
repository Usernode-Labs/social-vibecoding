// The wordmark primitive: frontend/@/components/ui/wordmark.tsx.
//
// ── Why this test exists at all ─────────────────────────────────────────
//
// The component is added one proposal AHEAD of the three screens that draw it
// (the landing header, the sign-in card, the home header's app chip), so for
// the length of that proposal nothing imports it: Vite tree-shakes it out of
// the bundle, it appears on no route, and a staging screenshot of any screen
// is byte-identical to the one before. There is no browser evidence to be had.
// Rendering it here IS the evidence — and it is also what makes the change
// visible to `npm run test:changed`, which maps a changed file to the suites
// that name it (scripts/test-changed.js).
//
// ── What is worth pinning about a logotype ──────────────────────────────
//
// Not its shape: eight `d` strings cannot be eyeballed in a diff, and
// tests/shell-icon-set.test.js already proves the shipped document's paths are
// this module's, character for character. What is worth pinning is everything
// AROUND the shape, because each of these is a decision that a later edit
// could quietly undo:
//
//   - `fill="currentColor"` and no colour class, which is the whole reason the
//     mark needs no dark variant and can sit in a chip's ink at 20px.
//   - `className` passed STRAIGHT THROUGH, not through cn(). twMerge reorders
//     and collapses, and the prerendered public/index.html is compared
//     attribute by attribute.
//   - both accessible paths — named figure and decoration — because the three
//     call sites need one each, and a missing one gets hand-rolled.
//   - eight paths. A half-pasted logotype still draws something.
//
// Run with: node --test tests/wordmark.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderComponent } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ENTRY = 'frontend/@/components/ui/wordmark.tsx';
const SRC = read(ENTRY);

/** The Figma logotype node exports eight paths; see the module's header. */
const PATH_COUNT = 8;

const render = (props) => renderComponent(ENTRY, 'Wordmark', props);

/** Every single-quoted path literal in the module — the same read tests/shell-icon-set.test.js makes. */
const quotedPaths = () => (SRC.match(/'M[^'\\\n]*'/g) || []).map((s) => s.slice(1, -1));

/** The module's code, with the header comment that names these very spellings removed. */
const code = () => SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

test('the mark is one <svg> of eight paths, filled with the current ink', () => {
  const html = render({ title: 'Homeroom' });
  assert.equal((html.match(/<svg\b/g) || []).length, 1, 'one drawing, not a group of them');
  assert.equal((html.match(/\sd="/g) || []).length, PATH_COUNT,
    `the logotype is ${PATH_COUNT} paths — a shorter render is a half-pasted export, `
    + 'which still draws something and so looks like a styling problem');
  assert.match(html, /fill="currentColor"/,
    'currentColor is what lets one drawing serve both themes and three sizes');
  assert.doesNotMatch(html, /stroke/,
    'a logotype is filled; a stroke on it is a different drawing');
  assert.match(html, /viewBox="0 0 1236\.9 319\.2"/,
    'the node\'s own box — changing it rescales the mark against its call sites');
});

test('a title names the figure; without one the mark is decoration', () => {
  const named = render({ title: 'Homeroom' });
  assert.match(named, /role="img"/);
  assert.match(named, /aria-label="Homeroom"/,
    'the landing header and the app chip are the mark AS the name');
  assert.doesNotMatch(named, /aria-hidden/,
    'a figure with an accessible name must not also be hidden');

  const bare = render({});
  assert.match(bare, /aria-hidden="true"/,
    'above an <h1> the word is already read once; the mark must not repeat it');
  assert.doesNotMatch(bare, /role="img"/);
  assert.doesNotMatch(bare, /aria-label/);
});

test('className lands verbatim — no merge, no reorder', () => {
  // Two heights in one string: cn()'s twMerge would collapse these to the
  // last one, which is the observable difference between a straight-through
  // className and a merged one.
  const html = render({ id: 'landing-header-title', className: 'h-5 h-7 w-auto shrink-0' });
  assert.match(html, /class="h-5 h-7 w-auto shrink-0"/,
    'the caller\'s class string is shipped as written — see the module header');
  // Attribute order is load-bearing for the same reason icons.tsx says it is.
  assert.match(html, /<svg id="landing-header-title" class="h-5 h-7 w-auto shrink-0" fill="currentColor" viewBox=/,
    'id, then className, then fill, then viewBox — the prerendered document is '
    + 'compared attribute by attribute');
  // The header explains this very decision by name, so only the CODE counts —
  // the same split tests/shell-icon-set.test.js makes for its lucide rule.
  assert.doesNotMatch(code(), /\bcn\(/, 'cn() runs twMerge, which reorders');
});

test('the path data is quoted literals, so the icon-set test can read it', () => {
  const quoted = quotedPaths();
  assert.equal(quoted.length, PATH_COUNT,
    'each path is a single-quoted literal on its own line, as FoldMarkIcon\'s are');
  const html = render({ title: 'Homeroom' });
  for (const d of quoted) {
    assert.ok(html.includes(`d="${d}"`), `a literal that never renders: ${d.slice(0, 32)}…`);
  }
  // The coupling this file exists beside: tests/shell-icon-set.test.js asserts
  // that every path in the prerendered document is one a module exports, and
  // this primitive is the second and last source it reads. Dropping that read
  // would fail the moment a screen draws the mark, which is a later proposal —
  // so it is pinned here, where the decision was taken.
  const iconSet = read('tests/shell-icon-set.test.js');
  assert.match(iconSet, /frontend\/@\/components\/ui\/wordmark\.tsx/,
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
    'no colour class: currentColor is the whole design, and a default ink would '
    + 'need a dark: twin at every call site instead');
  assert.doesNotMatch(body, /\bdark:/, 'nothing to theme — see above');
  assert.doesNotMatch(body, /\bcva\(/,
    'size travels in className at the call site (28px, 24px, 20px), so there is '
    + 'no variant table to keep as complete literals');
});
