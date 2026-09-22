// The app chip's menu is a DROPDOWN on desktop, not a right-edge rail.
//
// #apps-switcher-sheet is one always-mounted element with three
// presentations, all of them decided in app.css: a kit bottom sheet on touch,
// a CSS bottom sheet below `sm`, and at `sm`+ for a mouse a panel hanging
// under the chip that opened it. That last one used to be the same
// full-height right-edge slide-over as the retired #improve-panel and the notifications
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
//   3. The backdrop stays — it is what catches the dismissing click — and
//      paints nothing. That WAS an argument about modality (a scrim behind a
//      header menu says "modal"), and it lost on review: this menu and the
//      Improve rail are opened the same way, so one dimming and the other not
//      made them read as two kinds of surface. The dim came back and is here
//      now; what changed is that the PANEL casts it, as a 100vmax box-shadow
//      on `.dc-lift-panel[data-open]`. A dim painted behind the panel lands
//      inside the panel's own backdrop-filter and turns its glass grey — see
//      tests/overlay-panes-lift.test.js for the measurements.
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
const TABS = read('frontend/src/features/improve/view-tabs.tsx');
const TW = read('tailwind.config.js');

/** A Tailwind spacing step in px — the scale is 0.25rem per unit. */
const step = (n) => n * 4;

/** A radius from the config's OVERRIDDEN scale, in px. Never the stock one. */
function radius(name) {
  const scale = TW.match(/borderRadius:\s*\{([^}]*)\}/);
  assert.ok(scale, 'tailwind.config.js declares a borderRadius scale');
  const hit = scale[1].match(new RegExp(`'?${name}'?:\\s*'([\\d.]+)rem'`));
  assert.ok(hit, `the scale declares ${name}`);
  return Number(hit[1]) * 16;
}

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
  //
  // THE TWO PADDINGS ARE READ SEPARATELY. The bar was `py-3`; it is
  // `pt-2 pb-4` now (#2305), because `-mb-2` spends 8px of the bottom padding
  // cutting the notch below it and the controls were left with four pixels
  // of clearance above an app's raised sheet. A single `py-N` read would
  // have gone on matching nothing and silently reported the old height.
  const bar = HEADER.slice(HEADER.indexOf('id="platform-header"'));
  const className = bar.slice(0, bar.indexOf('>'));
  const pt = className.match(/\bpt-(\d+)\b/);
  const pb = className.match(/\bpb-(\d+)\b/);
  assert.ok(pt && pb, '#platform-header states its vertical padding as pt-N / pb-N');
  assert.ok(!/\bpy-\d/.test(className),
    'and states it in ONE vocabulary — a py-N beside them is a second source '
    + 'of truth this arithmetic cannot see');
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
  const expected = ((Number(pt[1]) + Number(pb[1])) * 0.25) + 1.75;
  assert.equal(Number(declared[1]), expected,
    `--platform-header-h must equal pt-${pt[1]} + pb-${pb[1]} + h-7 = ${expected}rem`);
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

test('the backdrop dims at every width, and catches the dismissing click', () => {
  // This guarded SAMENESS with the Improve panel's backdrop, because the two
  // opened from the same bar and dismissed the same way — one dimming the
  // page and the other not made them read as two different KINDS of surface.
  // The panel is retired (#2718 review), so there is no second backdrop to be
  // the same as, and what is left is the rule that mattered: the dim is not a
  // width choice.
  // Narrowed from "no desktop rule may touch the backdrop at all". That was
  // the right guard when the only reason to reach for one was to turn the dim
  // off, and too broad the moment a desktop rule moved where the dim STARTS
  // (it now begins under the header, so the bar stays lit and clickable — see
  // tests/header-stays-live.test.js). What must not come back is the
  // transparency, so that is what this forbids: the geometry is free to move,
  // the paint is not.
  for (const block of mediaBlocks('min-width: 640px')) {
    if (!block.includes('#apps-switcher-overlay')) continue;
    assert.doesNotMatch(block, /#apps-switcher-overlay[^}]*background/,
      'no desktop rule may repaint the backdrop — it dims at every width');
    assert.doesNotMatch(block, /#apps-switcher-overlay[^}]*opacity/,
      'nor fade it out: opacity is the open/closed switch, not a width choice');
  }

  // It covers the page and nothing else decides that.
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,300}?className="fixed inset-0/);

  // And it is still the thing that catches the dismissing click.
  assert.match(rule('#apps-switcher-overlay[data-open]'), /pointer-events:\s*auto/);
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?onClick=\{close\}/,
    'clicking it closes the sheet');
});

// ── The other two presentations are untouched ──────────────────────────

test('below sm it is still a bottom sheet, dim and all', () => {
  const block = blockWith('max-width: 639px', '#apps-switcher-sheet {');
  const sheet = block.slice(block.indexOf('#apps-switcher-sheet {'));
  assert.match(sheet, /bottom:\s*0/);
  assert.match(sheet, /transform:\s*translateY\(100%\)/, 'it still comes up from the floor');
  assert.match(block, /#apps-switcher-sheet\[data-open\] \{\s*\n\s*transform:\s*translateY\(0\)/);
  // Two top corners, and they are the pane radius now rather than 1rem: below
  // sm this menu is a bottom sheet like the Improve rail and the bell's, and
  // all three read the same 1.75rem off `.dc-lift`. What is pinned here is
  // that it still HAS two rounded top corners — the dropdown above keeps its
  // own 0.75rem menu radius, which is the shape this must not inherit.
  assert.match(sheet, /border-top-left-radius:\s*1\.75rem/, 'and keeps its two top corners');
  assert.match(sheet, /border-top-right-radius:\s*1\.75rem/);

  // The dim is still the default at every width — but the panel CASTS it now
  // (`.dc-lift-panel[data-open]`'s 100vmax box-shadow) rather than the backdrop
  // painting it, because a dim painted behind the panel lands inside the
  // panel's own backdrop-filter and turns its glass grey. The backdrop element
  // stays for pointer-events and dismiss-on-click, and paints nothing.
  assert.match(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?className="fixed inset-0 z-40"/);
  assert.doesNotMatch(SHEET, /id="apps-switcher-overlay"[\s\S]{0,400}?bg-black/);
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

// ── The panel's contents ───────────────────────────────────────────────

test('the panel is deliberately wider than the rails, and still fits', () => {
  const block = switcherDesktopBlock();
  const closed = block.slice(block.indexOf('#apps-switcher-sheet {'),
    block.indexOf('#apps-switcher-sheet[data-open]'));
  const mine = closed.match(/\n\s*width:\s*([\d.]+)rem/);
  assert.ok(mine, 'the dropdown states a width');

  // It matched #notifications-sheet / #messages-sheet for one round. It does
  // not any more, and that is a decision rather than drift: the app strip is
  // the only part of this menu that uses width, and those two hold rows only.
  // Pinned as an INEQUALITY so the departure is deliberate in both directions
  // — restoring parity should fail here and be argued for, not slip in.
  const sheets = rule('#notifications-sheet,\n#messages-sheet');
  const theirs = sheets.match(/\n\s*width:\s*([\d.]+)rem/);
  assert.ok(theirs, 'the notifications/messages rail states a width');
  assert.ok(Number(mine[1]) > Number(theirs[1]),
    'the menu is the wider of the two on purpose — see the comment for the '
    + 'measurements that bought it and what they cost');

  // At this size the guard is load-bearing: the panel has to stay inside the
  // narrowest viewport the desktop rule applies to, with air on both sides.
  const guard = closed.match(/max-width:\s*calc\(100vw\s*-\s*([\d.]+)rem\)/);
  assert.ok(guard, 'and it caps itself against the viewport');
  const SM = 640;
  const px = Number(mine[1]) * 16;
  assert.ok(px <= SM - (Number(guard[1]) * 16),
    `${px}px must fit inside ${SM}px less the ${Number(guard[1]) * 16}px guard, `
    + 'or the panel touches both edges the moment the desktop rule engages');
});

test('the panel meets the header rather than floating under it', () => {
  const block = switcherDesktopBlock();
  const closed = block.slice(block.indexOf('#apps-switcher-sheet {'),
    block.indexOf('#apps-switcher-sheet[data-open]'));
  const top = closed.match(/top:\s*calc\(([^;]*)\);/);
  assert.ok(top, 'the dropdown states its top');
  assert.doesNotMatch(top[1], /\+\s*[\d.]+rem/,
    'the header height and the safe-area inset, and nothing added to them: '
    + 'the chip is IN the bar, so a gap is a seam through one object');
  // The bar has no surface on the wallpaper routes, so what ties the menu to
  // the chip is the hairline they share, not a slab they both sit on.
  assert.match(closed, /border-color:\s*var\(--brand-line\)/,
    'the hairline is the brand one the chip itself wears');
});

test('the label row is a label, not a heading', () => {
  // The row it sits in cannot use SECTION — it holds the close button too —
  // so the type half is shared as a constant and the row states SECTION's own
  // padding. Both halves have to hold for it to read as a label.
  //
  // IT SAYS THE APP'S NAME NOW. "Apps" was right while a strip of every app
  // sat under it; with the strip retired (#2718 review) this row names what
  // the sheet is about, and the duplicate label that used to open the list
  // below went with it.
  assert.match(SHEET, /const SECTION_TYPE = 'text-\[0\.7rem\] font-semibold uppercase tracking-wide '/,
    'the type half is a constant of its own');
  assert.match(SHEET, /const SECTION = 'px-5 pt-4 pb-1 ' \+ SECTION_TYPE;/,
    'and SECTION is that constant plus the row it owns');
  assert.match(SHEET, /className=\{'flex-1 min-w-0 block truncate ' \+ SECTION_TYPE\}/,
    'the label reads as a label…');
  assert.match(SHEET, /className="flex items-center gap-3 px-5 pt-4 pb-1 shrink-0"/,
    '…in a row carrying SECTION\'s own padding');
  assert.doesNotMatch(SHEET, /text-lg font-semibold text-zinc-900/,
    'the heading it used to be is gone');
});

test('every group in the menu announces itself', () => {
  // ONE GROUP NOW. "Platform" and "You" were the platform's destinations and
  // the viewer's, and both left with #2718 — the tab bar carries the first
  // and the Profile screen the second. The apps strip was the third and left
  // on the owner's review, so what remains is named after the APP, which is
  // what every row in it is about.
  //
  // "In this app" is not in this list either, and its absence is older: the
  // App | Board | Activity strip it captioned left when the menu was still
  // picking WHICH APP, because a control about the app you are already inside
  // sat between you and the list you opened it for.
  assert.match(SHEET, /\{appLabel\}\n\s+<\/span>/,
    "the one group is labelled with the app's name");
  const nav = SHEET.slice(SHEET.indexOf('id="switcher-nav"'));
  assert.ok(!nav.includes('{appLabel}</div>'),
    'and not a second time inside the list — the header row is the label now');
  assert.doesNotMatch(nav, /id="switcher-row-/,
    'and no platform destination is left in this menu at all — they are tabs '
    + 'and Profile rows now (#2718)');
});

test('the view strip is single-homed — in the menu, and nowhere twice', () => {
  // THE RULE IS THE SAME; THE HOME MOVED (#2718 review). The strip is one
  // module rendered from a caller-supplied id map, so a second surface is one
  // import away and a duplicated navigation control is the kind of thing that
  // reads as harmless in a diff. It used to live in the Improve panel and the
  // menu was forbidden it; the panel is retired, so the menu is where it
  // lives and the duplicate to guard against is the `Open in Workshop` ROW
  // that named the same destination one row below it.
  assert.match(SHEET, /<AppViewTabs/, 'the strip is here now');
  assert.ok(!/id="app-menu-row-workshop"/.test(SHEET),
    'and the row that named the same destination is gone');
  // The row was the only one of the two carrying the vote count, so the count
  // came with it rather than going away.
  assert.match(TABS, /id="app-menu-workshop-owed"/);
  assert.match(SHEET, /owed=\{owed\}/);
  assert.ok(!/In this app/.test(SHEET.replace(/\{\/\*[\s\S]*?\*\/\}/g, '')),
    'and no caption left behind — comments explaining a move are fine, '
    + 'rendered text is not');
});

// ── The segmented control's pill ───────────────────────────────────────

test('the tab pill is concentric with the track it sits in', () => {
  // THE BUG THIS PINS: a rounded box nested in a rounded box has exactly one
  // correct radius — the outer one less the gap. The pill was `0.625rem`,
  // which is `xl - 2px` in STOCK Tailwind, where xl is 12px. This config
  // overrides the whole radius scale, so the track is 16px and the pill was
  // 4px too tight, leaving a crescent of track at each end of the strip.
  const track = TABS.match(/const TRACK =\s*\n?\s*'([^']*)'/);
  assert.ok(track, 'the track states its classes');
  const tr = track[1].match(/\brounded-(\w+)\b/);
  const pad = track[1].match(/\bp-(\d+(?:\.\d+)?)\b/);
  assert.ok(tr && pad, 'the track states a radius and a padding');

  const seg = TABS.match(/const SEG =\s*\n?\s*'([^']*)'/);
  assert.ok(seg, 'the pill states its classes');
  const sr = seg[1].match(/rounded-\[([\d.]+)rem\]/);
  assert.ok(sr, 'the pill states an explicit radius');

  const inner = radius(tr[1]) - (Number(pad[1]) * 4);
  assert.equal(Number(sr[1]) * 16, inner,
    `the track is ${radius(tr[1])}px with ${Number(pad[1]) * 4}px of padding, `
    + `so the pill must be ${inner}px — read the radius off tailwind.config.js, `
    + 'never off what Tailwind ships by default');
});
