// The panels the bar opens COVER the bar, and the bar is inside their dim.
//
// ── What this file used to pin, and why it inverted ────────────────────
//
// For one round the Improve rail, the notifications rail and all four
// backdrops started at the bar's underside, so the header stayed lit and
// clickable with a panel open. That bought one real thing: pressing the bell
// while Improve was up moved straight between the two panels, instead of the
// first click landing on the backdrop and only dismissing.
//
// It cost more than it bought. A dim that stops 60px short of the top of the
// screen leaves a lit band of chrome above an open panel, belonging to
// neither the panel nor the page, and a top bar that stays live while a modal
// surface is up is a claim nothing else in the product makes. The rails cover
// the bar again and every backdrop is `inset-0` again, so a click on the
// header dismisses like a click anywhere else on the scrim.
//
// TWO CLICKS TO CHANGE PANELS IS THE ACCEPTED COST, and it is written down
// here rather than left to be rediscovered: dismiss, then open the next.
//
// ── The one thing that did NOT revert ──────────────────────────────────
//
// Every sheet built on lib/sheet-controller.js closes the Improve panel when
// it opens; the Improve panel closed none of them back, because the line that
// did it retired with the hamburger and left only its comment. The live
// header is what made that gap reachable — and the gap was a real one either
// way, so `Improve.open()` still dismisses the registered sheets through the
// same helper `_closeSiblings` uses. Reverting the geometry is not a reason
// to un-fix a bug the geometry merely exposed.
//
// ── The one surface still hanging from the bar ─────────────────────────
//
// #apps-switcher-sheet, and only on desktop, because it is a DROPDOWN: it is
// anchored to the chip that opens it, and a menu drawn over its own trigger
// has nothing to point at. Its backdrop dims the bar like every other one.
// tests/app-switcher-dropdown.test.js owns that geometry; what this file
// checks is that it stayed put while the rails moved.
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

/**
 * The offset the rails and the backdrops used to start at, kept here as the
 * thing they must NOT carry any more. #apps-switcher-sheet still uses it.
 */
const UNDER_HEADER = 'calc(var(--platform-header-h) + var(--platform-safe-top))';

/**
 * Every backdrop belonging to a panel the header opens.
 *
 * `#messages-sheet-overlay` is in the rule and matches nothing: Messages went
 * back to being a screen, so the id is dead in the document and alive only in
 * app.css. It stays in the list because the RULE lists it — a test that
 * quietly knew better than the stylesheet would hide the discrepancy instead
 * of leaving it where the next reader trips over it.
 */
const BACKDROPS = ['#improve-overlay', '#apps-switcher-overlay',
  '#notifications-sheet-overlay', '#messages-sheet-overlay'];

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

test('the Improve rail covers the bar', () => {
  const panel = rule('#improve-panel');
  assert.match(panel, /top:\s*0/,
    'the rail starts at the top of the viewport, over the header');
  assert.ok(!panel.includes(UNDER_HEADER),
    'and carries no leftover of the offset it used to hang from');
  assert.match(panel, /bottom:\s*0/,
    'and still reaches the floor — only where it STARTS moved');
});

test('the notifications rail covers it too', () => {
  const rail = rule('#notifications-sheet,\n#messages-sheet');
  assert.match(rail, /top:\s*0/, 'the rail starts at the top, like Improve');
  assert.ok(!rail.includes(UNDER_HEADER), 'with no leftover offset');
  assert.match(rail, /bottom:\s*0/, 'and still reaches the floor');
});

test('no rule lifts a backdrop off the bar', () => {
  // The dim is `inset-0` in the markup. What made the header lit was a
  // desktop override that moved all four backdrops down by the bar's height,
  // and the whole of this revert is that the override is gone. Asserted as
  // an ABSENCE across every media block rather than by looking for a rule
  // that should not exist in one place: re-adding it for a single panel is
  // the half-applied version of the same mistake.
  for (const block of mediaBlocks('min-width: 640px')) {
    for (const id of BACKDROPS) {
      if (!block.includes(id)) continue;
      assert.ok(!block.includes(UNDER_HEADER),
        `a desktop rule offsets ${id} by the header height — the backdrops `
        + 'cover the bar now, see the comment at the top of this file');
    }
  }
});

test('the dim itself is untouched — it still catches the dismissing click', () => {
  for (const id of BACKDROPS) {
    const at = CSS.indexOf(`${id}[data-open]`);
    assert.ok(at > 0, `${id} has an open state`);
    const body = CSS.slice(CSS.indexOf('{', at), CSS.indexOf('\n}', at));
    assert.match(body, /pointer-events:\s*auto/,
      `${id} still catches the dismissing click — over the bar as well now`);
  }
});

test('the app menu is the ONE surface still hanging from the bar', () => {
  // A dropdown anchored to the chip cannot cover the chip. Found through the
  // media block, NOT by indexOf on the selector: the first
  // `#apps-switcher-sheet {` in the file is inside
  // `.platform-sheet-adopted#apps-switcher-sheet`, a different rule with no
  // top at all.
  const menu = mediaBlocks('min-width: 640px')
    .filter((b) => b.includes('\n  #apps-switcher-sheet {'));
  assert.equal(menu.length, 1, 'one desktop rule positions the app menu');
  assert.ok(menu[0].includes(`top: ${UNDER_HEADER}`),
    'and it still starts at the bar\'s underside, where its trigger is');
});

test('the phone is untouched — it is a sheet over the page there', () => {
  // Below `sm` these are bottom sheets and the kit draws its own backdrop
  // over everything on touch. Neither the previous change nor this one
  // touches the phone.
  const small = mediaBlocks('max-width: 639px');
  const improve = small.filter((b) => b.includes('#improve-panel {'));
  assert.equal(improve.length, 1, 'the bottom sheet still states its own geometry');
  assert.match(improve[0], /top:\s*auto/,
    'which resets the desktop rule rather than inheriting it');

  assert.equal(small.filter((b) => BACKDROPS.some((id) => b.includes(id))).length, 0,
    'and no phone rule touches any backdrop: they still cover the viewport');
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
