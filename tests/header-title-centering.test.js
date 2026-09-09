// Where the header title sits, and the arithmetic that decides.
//
// The rule the user sees: centred when there is genuinely room for it,
// left-aligned beside the back/home icon and truncating from the right when
// there is not. Never an in-between — a centred title has no flex cell to
// truncate against (`position: absolute; flex: none` in app.css), so if the
// maths says "fits" and it does not, it simply runs over the right group.
//
// It did. `headerW - 2 * (max(leftW, rightW) + GAP)` assumes each side group
// is flush against the header's border box, and neither is: the header is
// `px-4`, so every group's inner edge is 16px further in than its width says.
// The formula over-reported the room by 32px, and at 390px "Settings" was
// centred and overlapped the Improve button by 3px — measured in a browser,
// which is where this was found.
//
// Run with: node --test tests/header-title-centering.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadTsx } = require('./lib/render-tsx');

const root = path.join(__dirname, '..');
const SRC = fs.readFileSync(
  path.join(root, 'frontend/src/features/header/use-header-layout.ts'), 'utf8');

let fn = null;
const canCenter = (args) => {
  fn = fn || loadTsx('frontend/src/features/header/use-header-layout.ts').canCenterTitle;
  return fn(args);
};

// Real numbers, read off the running header at 390px on the Settings screen —
// the case that overlapped.
const PHONE_SETTINGS = {
  headerLeft: 0, headerWidth: 390, leftInner: 36, rightInner: 235, titleNaturalW: 85,
};

test('a phone never centres, however short the title', () => {
  assert.equal(canCenter(PHONE_SETTINGS), false,
    '"Settings" at 390px is what overlapped the Improve button');
  // Not a knife-edge about this particular title: nothing centres down here.
  assert.equal(canCenter({ ...PHONE_SETTINGS, titleNaturalW: 8 }), false);
  assert.equal(canCenter({ ...PHONE_SETTINGS, headerWidth: 639, rightInner: 484 }), false,
    'just below the sm breakpoint');
});

test('the old formula is what this replaces — it said yes to that case', () => {
  // Kept as an executable record of the bug. leftW 36, rightW 139 (374 - 235),
  // GAP 4: `390 - 2 * (139 + 4)` = 104, and 85 <= 104, so it centred. The 32px
  // it is missing is the header's own `px-4`, twice.
  const leftW = 36;
  const rightW = 374 - PHONE_SETTINGS.rightInner;
  const oldAvailable = PHONE_SETTINGS.headerWidth - 2 * (Math.max(leftW, rightW) + 4);
  assert.ok(PHONE_SETTINGS.titleNaturalW <= oldAvailable,
    'the retired formula did say this fits');
  assert.equal(canCenter(PHONE_SETTINGS), false, 'and the current one does not');
});

test('above the breakpoint it centres when it truly fits', () => {
  // 900px, Settings: right group's inner edge at 505, centre at 450.
  const wide = {
    headerLeft: 0, headerWidth: 900, leftInner: 36, rightInner: 505, titleNaturalW: 85,
  };
  assert.equal(canCenter(wide), true);
  // …and stops the moment half the title would reach the gap.
  assert.equal(canCenter({ ...wide, titleNaturalW: 2 * (505 - 450 - 4) }), false,
    'a title exactly filling the clearance leaves no room for the jitter slack');
  assert.equal(canCenter({ ...wide, titleNaturalW: 2 * (505 - 450 - 4) - 4 }), true);
});

test('the tighter side decides, and a group past the centre means no room', () => {
  const base = {
    headerLeft: 0, headerWidth: 900, leftInner: 36, rightInner: 505, titleNaturalW: 85,
  };
  // A left group that reaches further in than the right one now governs.
  assert.equal(canCenter({ ...base, leftInner: 420 }), false);
  // The real 700px Settings header: the right group is 379px wide, so its
  // inner edge (305) is already left of the centre line (350). Negative room.
  assert.equal(canCenter({
    headerLeft: 0, headerWidth: 700, leftInner: 36, rightInner: 305, titleNaturalW: 85,
  }), false);
});

test('a header with no width yet is not a centring decision', () => {
  assert.equal(canCenter({ ...PHONE_SETTINGS, headerWidth: 0 }), false);
});

test('the offsetWidth formula is gone from the source, not just unused', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('offsetWidth'),
    'widths cannot see the header padding — the measurement is rects now');
  assert.match(SRC, /const CENTER_MIN_WIDTH_PX = 640;/,
    'the phone gate is the shell\'s own sm breakpoint');
  // The hook must not re-implement the rule beside the exported one.
  assert.match(code, /const canCenter = canCenterTitle\(\{/,
    'recompute defers to the pure function the tests above drive');
});
