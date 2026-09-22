// The panels the bar opens COVER the bar, and the bar is inside their dim.
//
// ── What this file used to pin, and why it inverted ────────────────────
//
// For one round the Improve rail, the notifications rail and all four
// backdrops started at the bar's underside, so the header stayed lit and
// clickable with a panel open. That bought one real thing: pressing the bell
// while another panel was up moved straight between them, instead of the
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
// ── The one thing that did NOT revert, and where it ended up ───────────
//
// Every sheet built on lib/sheet-controller.js closed the Improve panel when
// it opened; the panel closed none of them back, because the line that did it
// retired with the hamburger and left only its comment. The live header is
// what made that gap reachable, and it was a real gap either way, so
// `Improve.open()` was made to dismiss the registered sheets through the same
// helper `_closeSiblings` uses.
//
// THE PANEL THEN RETIRED (#2718 review) and the fix outlived it in the best
// possible way: `Improve.open()` forwards to the app-context sheet, which is
// IN the registry, so one sweep with `except` sparing the opener covers
// every surface. `_closeSiblings` no longer names any sheet by hand — which
// is what the two assertions below check, one for the sweep and one for the
// forward.
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
 *
 * `#improve-overlay` was the fourth and is NOT here for the opposite reason:
 * its panel retired (#2718 review) and its rules went out of app.css with it,
 * so the rule does not list it either. That is the discrepancy closing, not
 * the test knowing better.
 */
const BACKDROPS = ['#apps-switcher-overlay',
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

// The Improve rail was the other one, and the first assertion this file
// made. It retired with its panel (#2718 review) and every rule that drew it
// left app.css, so what is left to pin is the rail that is still there — and
// the ABSENCE below, which is what actually guards against the offset coming
// back for any of them.
test('the notifications rail covers the bar', () => {
  const rail = rule('#notifications-sheet,\n#messages-sheet');
  assert.match(rail, /top:\s*0/,
    'the rail starts at the top of the viewport, over the header');
  assert.ok(!rail.includes(UNDER_HEADER),
    'and carries no leftover of the offset it used to hang from');
  assert.match(rail, /bottom:\s*0/,
    'and still reaches the floor — only where it STARTS moved');
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
  // #improve-panel was read here too, and retired (#2718 review). The app
  // menu is the one that now states its own phone geometry rather than
  // inheriting the desktop rule.
  const menu = small.filter((b) => b.includes('#apps-switcher-sheet {'));
  assert.equal(menu.length, 1, 'the bottom sheet still states its own geometry');
  assert.match(menu[0], /top:\s*auto/,
    'which resets the desktop rule rather than inheriting it');

  assert.equal(small.filter((b) => BACKDROPS.some((id) => b.includes(id))).length, 0,
    'and no phone rule touches any backdrop: they still cover the viewport');
});

// ── The behaviour ──────────────────────────────────────────────────────

test('one implementation of "close the other sheets", and one sweep', () => {
  assert.match(CONTROLLER, /export function dismissRegisteredSheets\(except\)/,
    'the registry sweep is exported');
  assert.match(CONTROLLER, /_closeSiblings\(\)[\s\S]{0,900}?dismissRegisteredSheets\(controller\)/,
    'the sheets go through it, sparing themselves');
  // It used to call `window.Improve?.dismissForNav?.()` first, by name,
  // because the panel predated the registry. Now that Improve forwards to a
  // sheet that IS in the registry, that named call would either do nothing
  // or — when the app-context sheet is the one opening — tell it to close
  // itself. `except` spares the opener; nothing needs naming.
  assert.ok(!/_closeSiblings\(\)[\s\S]{0,900}?window\.Improve\?\.dismissForNav\?\.\(\);/.test(CONTROLLER),
    'and no sheet is closed by name on top of the sweep');
});

test('Improve closes the other sheets when it opens, through the surface it forwards to', () => {
  // The half that was missing. Without it, a live header means two panels can
  // be on screen at once.
  //
  // It is not Improve's own line any more and it does not need to be: the
  // panel retired (#2718 review), `Improve.open()` forwards to the
  // app-context sheet, and that sheet's `open()` runs `_closeSiblings()`
  // before it presents — which is where the sweep belongs, once, for every
  // surface built on the chassis.
  assert.match(IMPROVE, /_surface\(\) \{[\s\S]{0,200}window\.AppContext/,
    'the forward names the controller that owns the surface');
  assert.match(IMPROVE, /open\(\) \{\n\s+return Improve\._surface\(\)\?\.open\(\);/,
    'and open() is that forward, holding no presentation of its own');
  const improveCode = IMPROVE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/improveStore\.get\(\)\.open/.test(improveCode),
    'nor a second copy of `open` — a flag nobody writes would answer toggle '
    + 'and dismissForNav wrongly, so the field left the store too');
  const STORE = fs.readFileSync(
    path.join(__dirname, '..', 'frontend/src/features/improve/improve-store.js'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bopen:\s*false/.test(STORE) && !/\badopted:\s*false/.test(STORE),
    'and the store declares neither');

  // And the sweep still happens before the present, not after: two backdrops
  // fading past each other is the artefact of closing them late.
  const open = CONTROLLER.slice(CONTROLLER.indexOf('\n    open() {'));
  const body = open.slice(0, open.indexOf('\n    },'));
  assert.ok(body.indexOf('_closeSiblings()') < body.indexOf("store.set({ open: true })"),
    'the siblings go down before this surface publishes open');
});
