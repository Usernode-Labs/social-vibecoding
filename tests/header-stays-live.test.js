// The header is not covered by the panels it opens.
//
// ── What this changed ──────────────────────────────────────────────────
//
// Two things, and the second is the one with teeth.
//
// The Improve rail was `top: 0`, so it slid up OVER the bar: the button you
// had just pressed vanished under the thing it opened. It starts at the bar's
// underside now, which is where the app chip's menu already started.
//
// And both backdrops were `inset-0` at `z-40` over a `z-10` header, so they
// dimmed the bar AND swallowed every click on it. With a panel open, pressing
// the bell hit the backdrop: the panel closed and nothing else happened, so
// moving between the two panels in that bar took two clicks and the first
// appeared to do nothing. The dim starts below the bar now, which fixes both
// at once and does it with GEOMETRY rather than z-order — the backdrop no
// longer reaches the header, so a click there lands on the control it looks
// like it lands on.
//
// ── The gap that opened as a result ────────────────────────────────────
//
// Every sheet built on lib/sheet-controller.js closes the Improve panel when
// it opens; the Improve panel closed none of them back, because the line that
// did it retired with the hamburger and left only its comment. That was
// unreachable while the backdrop covered the header — with one panel up there
// was no way to press another control — and is one click wide now. So
// `Improve.open()` dismisses the registered sheets, through the same helper
// `_closeSiblings` uses, and these pin both halves of that pairing.
//
// Run with: node --test tests/header-stays-live.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');
const CONTROLLER = read('frontend/src/lib/sheet-controller.js');
const IMPROVE = read('frontend/src/features/improve/improve-controller.js');

/** The offset both panels and both backdrops start at. */
const UNDER_HEADER = 'calc(var(--platform-header-h) + var(--platform-safe-top))';

function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector.replace(/\n/g, ' ')}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

function mediaBlocks(condition) {
  const needle = `@media (${condition}) {`;
  const out = [];
  let at = 0;
  for (;;) {
    at = CSS.indexOf(needle, at);
    if (at < 0) break;
    const end = CSS.indexOf('\n}\n', at);
    assert.ok(end > at, `an \`@media (${condition})\` block is unclosed`);
    out.push(CSS.slice(at, end));
    at = end;
  }
  return out;
}

// ── The geometry ───────────────────────────────────────────────────────

test('the Improve rail starts where the app menu does, under the bar', () => {
  const panel = rule('#improve-panel');
  assert.ok(panel.includes(`top: ${UNDER_HEADER}`),
    'the rail hangs from the header rather than covering it');
  assert.match(panel, /bottom:\s*0/,
    'and still reaches the floor — only where it STARTS moved');

  // The same expression the app chip's menu uses, so "they begin on the same
  // line" is true by construction rather than by two numbers that agree today.
  // Found through the media block, NOT by indexOf on the selector: the first
  // `#apps-switcher-sheet {` in the file is inside
  // `.platform-sheet-adopted#apps-switcher-sheet`, which is a different rule
  // and has no top at all.
  const menu = mediaBlocks('min-width: 640px')
    .filter((b) => b.includes('\n  #apps-switcher-sheet {'));
  assert.equal(menu.length, 1, 'one desktop rule positions the app menu');
  assert.ok(menu[0].includes(`top: ${UNDER_HEADER}`),
    'and it is the same offset, not a second copy of the arithmetic');
});

test('both backdrops stop at the bar, in one rule so they cannot drift', () => {
  const hit = mediaBlocks('min-width: 640px')
    .filter((b) => b.includes('#improve-overlay') && b.includes('#apps-switcher-overlay'));
  assert.equal(hit.length, 1,
    'one desktop rule covers both backdrops — a rule each is how they diverge');
  assert.ok(hit[0].includes(`top: ${UNDER_HEADER}`),
    'and it is the header offset, matching the panels above it');

  // The dim itself is untouched: this moves where it starts, not what it is.
  for (const id of ['#improve-overlay', '#apps-switcher-overlay']) {
    assert.match(rule(`${id}[data-open]`), /pointer-events:\s*auto/,
      `${id} still catches the dismissing click below the bar`);
  }
});

test('the phone is untouched — it is a sheet over the page there', () => {
  // Below `sm` these are bottom sheets and the kit draws its own backdrop over
  // everything on touch. A half-lit phone header would be a different
  // decision; this change does not make it.
  const small = mediaBlocks('max-width: 639px');
  const improve = small.filter((b) => b.includes('#improve-panel {'));
  assert.equal(improve.length, 1, 'the bottom sheet still states its own geometry');
  assert.match(improve[0], /top:\s*auto/,
    'which resets the desktop offset rather than inheriting it');

  assert.equal(small.filter((b) => b.includes('-overlay')).length, 0,
    'and no phone rule touches either backdrop: they still cover the viewport');
});

// ── The behaviour ──────────────────────────────────────────────────────

test('one implementation of "close the other sheets", used from both ends', () => {
  assert.match(CONTROLLER, /export function dismissRegisteredSheets\(except\)/,
    'the registry sweep is exported, because the Improve panel is not built here');
  assert.match(CONTROLLER, /_closeSiblings\(\) \{[\s\S]{0,240}?dismissRegisteredSheets\(controller\)/,
    'the sheets go through it, sparing themselves');
  assert.match(CONTROLLER, /_closeSiblings\(\) \{[\s\S]{0,240}?window\.Improve\?\.dismissForNav/,
    'and still close the Improve panel by name');
});

test('Improve closes the other sheets when it opens', () => {
  // The half that was missing. Without it, a live header means the app menu
  // and the Improve panel can both be on screen at once.
  assert.match(IMPROVE, /import \{ dismissRegisteredSheets \} from '\.\.\/\.\.\/lib\/sheet-controller\.js';/,
    'it imports the one implementation rather than walking a registry it cannot see');
  const open = IMPROVE.slice(IMPROVE.indexOf('\n  open() {'));
  const body = open.slice(0, open.indexOf('\n  },'));
  assert.match(body, /dismissRegisteredSheets\(\)/,
    'open() dismisses them, with no argument — this panel is not in the registry');

  // And it happens before the panel presents, not after: two backdrops fading
  // past each other is the artefact of closing them late.
  assert.ok(body.indexOf('dismissRegisteredSheets()') < body.indexOf('improveStore.set({ open: true })'),
    'and does it before this panel publishes open');
});
