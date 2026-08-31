// The home-indicator inset is the kit's job inside an adopted surface, and
// this is the rule that says so once instead of per element.
//
// ── The bug, three times ───────────────────────────────────────────────
//
// `.platform-safe-scroll` and `.platform-safe-sheet` reserve the strip under
// the home indicator. That is right wherever nothing else does it — a desktop
// slide-over (where the inset is 0 anyway) and mobile Safari, where the kit is
// absent and the panel stays a fixed slide-over.
//
// Inside a kit sheet it is counted TWICE: `.un-sheet` sets
// `padding-bottom: var(--un-safe-inset-bottom)` and `.un-sheet-body` adds 20px
// under that. Measured on a 34px indicator, every adoptable sheet had it:
//
//   #improve-footer            .platform-safe-scroll   34 + 20 + 34 =  88px
//   #switcher-nav              .platform-safe-sheet    54 + 20 + 34 = 108px
//   the notifications scroller .platform-safe-scroll   34 + 20 + 34 =  88px
//
// Only the first was fixed, by id. The app menu's is worst because
// `.platform-safe-sheet` adds 1.25rem on top of the inset.
//
// ── Why the fix is a CLASS rule, which is what these pin ───────────────
//
// The notifications scroller has no id. An id-based rule could not reach it
// however many ids were listed — so the rule is written the way its own
// comment always stated it: inside an adopted surface, the inset is the kit's,
// wherever it appears. That is the property worth pinning, because it is what
// makes the rule true for the element nobody can name and for the next sheet
// that has not been written yet.
//
// And the gap is HEIGHT. A bottom sheet is as tall as its content, so the
// padding pushed the sheet up the screen: the app menu went from 82% of a
// 390x844 phone to 75% when it went away.
//
// Run with: node --test tests/kit-sheet-safe-inset.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const CSS = read('public/css/app.css');

/** The two classes that reserve the strip. */
const SAFE_CLASSES = ['platform-safe-scroll', 'platform-safe-sheet'];

/** The kit's two adopted-surface markers. */
const ADOPTED = ['platform-sheet-adopted', 'platform-panel-adopted'];

/**
 * Every component that hands its root to the kit — the sheets built on
 * lib/sheet-controller.js plus the Improve panel, which adopts directly.
 * Listed rather than discovered so that a NEW adoptable sheet is a
 * deliberate addition here, and its safe-area element gets looked at.
 */
const ADOPTABLE = [
  'frontend/src/features/improve/improve-panel.tsx',
  'frontend/src/features/app-context/app-context-sheet.tsx',
  'frontend/src/features/notifications/notifications-sheet.tsx',
];

/** The rule that zeroes the duplicate, as a selector list. */
function zeroingRule() {
  const at = CSS.indexOf('.platform-sheet-adopted .platform-safe-scroll');
  assert.ok(at > 0,
    'the adopted-surface override must exist and must target the CLASS — see '
    + 'the header of this file for why an id list cannot do the job');
  const open = CSS.indexOf('{', at);
  return {
    selectors: CSS.slice(at, open).split(',').map((s) => s.trim()).filter(Boolean),
    body: CSS.slice(open, CSS.indexOf('\n}', open)),
  };
}

// ── The rule ───────────────────────────────────────────────────────────

test('the override is written against classes, not a list of ids', () => {
  const { selectors, body } = zeroingRule();
  assert.match(body, /padding-bottom:\s*0\s*!important/,
    'it zeroes the duplicate, and !important because both classes use it');

  // Every combination of (adopted marker x safe class) is covered, so no
  // element can fall between the two markers.
  for (const marker of ADOPTED) {
    for (const cls of SAFE_CLASSES) {
      assert.ok(selectors.includes(`.${marker} .${cls}`),
        `\`.${marker} .${cls}\` must be in the rule — a missing pair is an `
        + 'element that keeps double-counting on one of the two kit paths');
    }
  }

  // THE REGRESSION THIS FILE EXISTS FOR: an id in here means somebody went
  // back to naming elements one at a time, and the element with no id starts
  // double-counting again in silence.
  const byId = selectors.filter((s) => s.includes('#'));
  assert.deepEqual(byId, [],
    'no id selectors: the notifications scroller has none, so an id list '
    + 'silently skips it — name the class, not the element');
});

// ── The elements it has to cover ───────────────────────────────────────

test('every adoptable sheet\'s safe-area element is reached by it', () => {
  const { selectors } = zeroingRule();
  const covered = new Set(
    selectors.map((s) => s.split(' ').pop().replace(/^\./, '')),
  );

  let found = 0;
  for (const file of ADOPTABLE) {
    const src = read(file);
    for (const cls of SAFE_CLASSES) {
      if (!src.includes(cls)) continue;
      found += 1;
      assert.ok(covered.has(cls),
        `${path.basename(file)} carries .${cls} and the rule does not cover it`);
    }
  }
  assert.ok(found >= 3,
    `expected each adoptable sheet to reserve the strip; found ${found} of `
    + `${ADOPTABLE.length}. A sheet that stopped is fine, but check it did not `
    + 'just move the class to a wrapper this test cannot see');
});

// ── And the classes still work where nothing else reserves the strip ───

test('outside an adopted surface both classes still reserve it', () => {
  // The whole point of the descendant selector: with no kit, nothing else
  // pads that strip, so zeroing these outright would put the last row flush
  // against the home indicator on mobile Safari.
  const scroll = CSS.slice(CSS.indexOf('\n.platform-safe-scroll {'));
  assert.match(scroll.slice(0, scroll.indexOf('\n}')), /var\(--platform-safe-bottom\)/,
    '.platform-safe-scroll still reserves the bare inset');

  const sheet = CSS.slice(CSS.indexOf('\n.platform-safe-sheet {'));
  assert.match(sheet.slice(0, sheet.indexOf('\n}')),
    /calc\(1\.25rem \+ var\(--platform-safe-bottom\)\)/,
    '.platform-safe-sheet still reserves its larger base gap plus the inset');
});
