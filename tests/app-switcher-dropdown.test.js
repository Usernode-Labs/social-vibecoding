// The app chip's menu is a DROPDOWN on desktop, not a right-edge rail.
//
// #apps-switcher-sheet is one always-mounted element with three
// presentations, all of them decided in app.css: a kit bottom sheet on touch,
// a CSS bottom sheet below `sm`, and at `sm`+ for a mouse a panel hanging
// under the chip that opened it. That last one used to be the same
// full-height right-edge slide-over as #improve-panel and the notifications
// sheet, which is right for a list with no natural end and wrong for a menu:
// the trigger sits in the middle of the top bar, and on a wide display the
// answer arrived a foot away from the question.
//
// Nothing about the markup changed, which is the point — these pin the CSS
// contract that replaced it, and the three traps in it:
//
//   1. A dropdown cannot hide by sliding off an edge (its edge is the header,
//      and it paints above it), so the closed state is opacity + visibility.
//      `.platform-sheet-adopted` flattens transform, position, border and
//      shadow but NOT those two — so a touch device wider than 639px, which
//      matches the desktop rule and the kit adoption at once, would present
//      an invisible sheet without an explicit reset.
//   2. The chip is only viewport-centred while it fits
//      (features/header/use-header-layout.ts toggles `.is-centered`), so the
//      panel follows the class rather than assuming the middle.
//   3. The backdrop stays — it is what catches the dismissing click — but
//      stops dimming, because a scrim behind a header menu says "modal".
//
// And the offset is the header's own height, restated once as
// --platform-header-h, which is only worth having if it cannot drift from the
// markup it describes. The first test is what makes that true.
//
// Run with: node --test tests/app-switcher-dropdown.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');
const HEADER = read('frontend/src/features/header/platform-header.tsx');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');

/** A rule's body, by exact selector text. */
function rule(selector) {
  const i = CSS.indexOf(`\n${selector} {`);
  assert.ok(i >= 0, `expected a \`${selector}\` rule in app.css`);
  return CSS.slice(i, CSS.indexOf('\n}', i));
}

/**
 * Every `@media (<condition>)` block in the file. There are many of each —
 * `sm` is the shell's one phone/desktop line, so both conditions recur — which
 * is why nothing here takes the first one it finds.
 *
 * Blocks are two levels deep at most, so the first bare `}` at column 0 closes
 * the media query.
 */
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
  assert.ok(out.length > 0, `expected at least one \`@media (${condition})\` block`);
  return out;
}

/** The single block at `condition` that carries `needle`. */
function blockWith(condition, needle) {
  const hit = mediaBlocks(condition).filter((b) => b.includes(needle));
  assert.equal(hit.length, 1,
    `exactly one \`@media (${condition})\` block should own \`${needle}\``);
  return hit[0];
}

/** The one desktop block that positions the switcher sheet. */
function switcherDesktopBlock() {
  return blockWith('min-width: 640px', '#apps-switcher-sheet {');
}

// ── The offset is the header's own height ──────────────────────────────

test('--platform-header-h is the height the header markup actually builds', () => {
  // Declared once, in the first `:root` block — there are four of them in
  // this file, so the declaration is what is searched for, not a block.
  const declared = CSS.match(/^\s*--platform-header-h:\s*([\d.]+)rem;$/m);
  assert.ok(declared, ':root declares --platform-header-h in rem');

  // The bar is a flex row: `py-N` top and bottom around a 28px content row.
  // Read the padding out of the markup rather than restating it, so changing
  // it fails HERE rather than as a panel that has quietly drifted off the bar
  // it hangs from. No hairline — the reskin took the border off both top bars,
  // and one coming back would add a pixel to the border box.
  const bar = HEADER.slice(HEADER.indexOf('id="platform-header"'));
  const className = bar.slice(0, bar.indexOf('>'));
  const py = className.match(/\bpy-(\d+)\b/);
  assert.ok(py, '#platform-header states its vertical padding as py-N');
  assert.ok(!/\bborder-b\b/.test(className),
    'no hairline under the bar — if one comes back this arithmetic gains a pixel');

  // The content row is 28px = `h-7`, held open from both directions by the
  // rules tests/header-height-parity.test.js owns (a floor that survives every
  // child being hidden, and a ceiling no direct child may exceed). All this
  // needs from that file is that the row is still stated in h-7 terms.
  assert.match(HEADER, /\bh-7\b/,
    'the header still states its content row as h-7 — see '
    + 'tests/header-height-parity.test.js for the floor and the ceiling');

  // Tailwind's scale is 0.25rem per step; h-7 is 1.75rem.
  const expected = (Number(py[1]) * 0.25 * 2) + 1.75;
  assert.equal(Number(declared[1]), expected,
    `--platform-header-h must equal py-${py[1]} * 2 + h-7 = ${expected}rem`);
});

// ── The dropdown ───────────────────────────────────────────────────────

test('the desktop presentation hangs off the header, not the right edge', () => {
  const block = switcherDesktopBlock();
  const closed = block.slice(block.indexOf('#apps-switcher-sheet {'),
    block.indexOf('#apps-switcher-sheet[data-open]'));

  assert.match(closed, /top:\s*calc\(var\(--platform-header-h\)\s*\+\s*var\(--platform-safe-top\)/,
    'it is offset by the bar it hangs from, including the status-bar inset');
  assert.match(closed, /left:\s*50%/, 'centred on the viewport, under the centred chip');
  assert.match(closed, /right:\s*auto/, 'the right edge no longer pins it…');
  assert.match(closed, /bottom:\s*auto/, '…and neither does the floor: it is content-height');
  assert.match(closed, /max-height:\s*calc\(100dvh/,
    'capped against the fold, with #switcher-nav taking the overflow');
  assert.match(closed, /border-radius:/, 'a floating panel has corners on all four sides');
  assert.doesNotMatch(closed, /border-left-width/,
    'a rail borders one edge; a dropdown borders all of them');
});

test('closed is opacity + visibility, because there is no edge to hide behind', () => {
  const block = switcherDesktopBlock();
  const closed = block.slice(block.indexOf('#apps-switcher-sheet {'),
    block.indexOf('#apps-switcher-sheet[data-open]'));
  const open = block.slice(block.indexOf('#apps-switcher-sheet[data-open] {'));

  assert.match(closed, /opacity:\s*0/);
  assert.match(closed, /visibility:\s*hidden/,
    'opacity alone leaves a 320px click-eater over the page');
  assert.match(open, /opacity:\s*1/);
  assert.match(open, /visibility:\s*visible/);

  // Visibility is not interpolable, so it is stepped: after the fade on the
  // way out, before it on the way in.
  assert.match(closed, /visibility 0s linear 1\d\dms/,
    'the closed rule delays visibility until the fade has finished');
  assert.match(open, /visibility 0s linear 0s/,
    'the open rule applies it immediately, or the fade-in is invisible');
});

test('a kit-adopted sheet is never left invisible by the dropdown state', () => {
  // THE TABLET TRAP. `.platform-sheet-adopted` resets position, inset,
  // transform, transition, border, radius, shadow and background — every
  // property the old rail hid behind — but not opacity or visibility.
  const adopted = rule('.platform-sheet-adopted#apps-switcher-sheet');
  assert.match(adopted, /opacity:\s*1\s*!important/);
  assert.match(adopted, /visibility:\s*visible\s*!important/);

  const generic = rule('.platform-sheet-adopted');
  assert.doesNotMatch(generic, /opacity/,
    'if the generic block ever covers it, this reset can go — until then it '
    + 'is the only thing standing between a touch tablet and an empty sheet');
});

test('the panel follows the chip when the title is not centred', () => {
  const block = switcherDesktopBlock();
  const closed = 'body:has(#header-title:not(.is-centered)) #apps-switcher-sheet {';
  const open = 'body:has(#header-title:not(.is-centered)) #apps-switcher-sheet[data-open] {';
  assert.ok(block.includes(closed), 'flow mode has its own resting position');
  assert.ok(block.includes(open), 'and its own open position');

  const flow = block.slice(block.indexOf(closed), block.indexOf(open));
  assert.match(flow, /left:\s*1rem/,
    "1rem is the header's own px-4 — the panel opens on the bar's content edge");
  assert.match(flow, /transform:\s*translate\(0,/,
    'no -50% here: the panel is anchored by its left edge, not its centre');

  // The open variant carries the same :has() prefix, so it outranks the flow
  // rule above it. Without the prefix the more specific closed rule would win
  // and the menu would never finish opening in flow mode.
  assert.ok(block.indexOf(open) > block.indexOf(closed),
    'and it comes after, so the two read in the order they apply');
});

// ── The backdrop ───────────────────────────────────────────────────────

test('the desktop backdrop stops dimming but keeps catching the click', () => {
  const overlay = blockWith('min-width: 640px', '#apps-switcher-overlay {');
  assert.match(overlay, /background-color:\s*transparent/,
    'a menu hanging off a header control is not a modal');

  // It is still there and still armed: dismissing by clicking away is what
  // the element exists for, at every width.
  assert.match(rule('#apps-switcher-overlay[data-open]'), /pointer-events:\s*auto/);
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?onClick=\{close\}/,
    'and clicking it still closes the sheet');
});

// ── The other two presentations are untouched ──────────────────────────

test('below sm it is still a bottom sheet, dim and all', () => {
  const block = blockWith('max-width: 639px', '#apps-switcher-sheet {');
  const sheet = block.slice(block.indexOf('#apps-switcher-sheet {'));
  assert.match(sheet, /bottom:\s*0/);
  assert.match(sheet, /transform:\s*translateY\(100%\)/, 'it still comes up from the floor');
  assert.match(block, /#apps-switcher-sheet\[data-open\] \{\s*\n\s*transform:\s*translateY\(0\)/);
  assert.match(sheet, /border-top-left-radius:\s*1rem/, 'and keeps its two top corners');

  // The dim is the default and only desktop opts out of it.
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?bg-black\/40/);
});

test('the sheet markup is one panel — the presentation is entirely CSS', () => {
  // The whole point of doing this in a media query: no branch, no second
  // element, nothing measured in JS, so the three presentations cannot grow
  // three sets of behaviour.
  assert.doesNotMatch(SHEET, /matchMedia/,
    'the panel does not ask how wide the window is');
  assert.match(SHEET, /id="apps-switcher-sheet"[\s\S]{0,600}?className="fixed z-50/,
    'one root, one constant class string');
});
