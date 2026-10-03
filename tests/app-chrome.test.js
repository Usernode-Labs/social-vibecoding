// The running app's chrome carries the group's two doors (#3702).
//
// Until this change both ways into the loop sat one tap into the Homeroom
// menu: "N to vote" was the trailing figure on its "Go to community hub" row
// (app-context-sheet.tsx) and "Ask for a change" its filled button
// (improve/actions.tsx). The request asks for both on the in-app chrome
// beside the mark, without opening any menu, with the same counts the menu
// row shows (needs-seen.ts's #3526 adjustment) and the same dialog the
// menu's button opens, scoped to the app on screen.
//
// What is pinned here:
//
//   1. The two controls exist in the header's right group — inside the
//      measured group, so the title-clearance layout keeps counting them.
//   2. They are REAL app-scoped controls: the pill reuses
//      app-context-sheet.tsx's exact count path (same endpoint, same
//      unseenNeeds adjustment, same demo flag), and Suggest opens the dialog
//      with target: 'app', the payload Getting started's Suggest passes and
//      the dialog's controller takes as a choice already made (#2707).
//   3. Nothing renders on the platform's own screens, at a zero count, or in
//      chromeless mode (the bar is hidden there; the controls ride it down
//      rather than floating over the app).
//   4. Pressing the pill is the door Getting started's Look step uses:
//      AppView._landOnTab(slug, 'needs') then App.openAppTab(slug, 'dev') —
//      the app stays parked and the page opens on Needs you.
//   5. The pill lands at the FIRST UNSEEN card: the Communities pane relays
//      a door event and the feed snaps to row 0, the same instant-scroll
//      arrangement the ?shot=needs-end route uses. A Back/Forward traversal
//      lands nothing.
//   6. The menu keeps both of its entries untouched.
//
// Run with: node --test tests/app-chrome.test.js
//
// The run above builds the shell, so this file stands alone: `npm run
// test:changed -- --files frontend/src/features/header/app-chrome.tsx` runs
// it against the same build the other suites read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const HEADER = read('frontend/src/features/header/platform-header.tsx');
const CHROME = read('frontend/src/features/header/app-chrome.tsx');
const SHEET = read('frontend/src/features/app-context/app-context-sheet.tsx');
const ACTIONS = read('frontend/src/features/improve/actions.tsx');
const WORKSHOP = read('frontend/src/features/workshop/index.tsx');
const FEED = read('frontend/src/features/dev-board/workshop/workshop.tsx');

// ── The two controls live in the header ──────────────────────────────

test('the in-app controls render in the header right group, inside the measured group', () => {
  const group = HEADER.slice(HEADER.indexOf('ref={rightGroupRef}'));
  const at = group.indexOf('<AppChromeControls />');
  assert.ok(at >= 0, 'the header renders the two controls');
  const bell = group.indexOf('id="notifications-btn"');
  assert.ok(bell > at >= 0, 'they sit to the LEFT of the bell (the mark stays the corner control)');
  // The measured group is what use-header-layout.ts counts for the title's
  // clearance — the retired #improve-btn note says whatever goes here next
  // must stay inside it.
  assert.ok(HEADER.includes('ref={rightGroupRef}'),
    'the group ref the layout hook measures is present');
});

test('both controls are app-scoped, never platform-scoped', () => {
  // The platform's own screens name no app: the pill would say "0" of
  // nothing and Suggest would open the dialog about the platform, which the
  // menu still offers.
  assert.match(CHROME, /if \(!slug \|\| selfHosted \|\| !headerVisible\) return null/,
    'they render nothing without an app target, on the self-hosted row, or in chromeless mode');
  assert.match(CHROME, /selfHosted/, 'the self-hosted target is named');
});

test('the vote pill reuses the menu row\u2019s exact count path', () => {
  // The same endpoint, the same demo flag, the same #3526 adjustment — one
  // source, two readers, so the pill and the row cannot disagree.
  assert.match(CHROME, /fetch\(`\/api\/workshop\/counts\$\{demo\}`\)/, 'the counts endpoint');
  const sheetFetch = SHEET.match(/const res = await fetch\(`\/api\/workshop\/counts\$\{demo\}`\);/);
  assert.ok(sheetFetch, 'app-context-sheet.tsx still fetches the same endpoint');
  assert.match(CHROME, /unseenNeeds\(slug, c\.needs, Array\.isArray\(c\.owed\) \? c\.owed : null\)/,
    'the #3526 swipe-past adjustment');
  assert.match(CHROME, /hydrateNeedsSeen\(\)/, 'the seen record is read outside React');
  // Zero shows nothing, not "0 to vote".
  assert.match(CHROME, /n > 0\) setOwed\(n\)/, 'zero is dropped, not drawn');
  assert.match(CHROME, /owed \? \(/, 'the pill renders only when a count arrived');
});

test('the vote pill opens the community\u2019s Needs you, the door the app stays parked through', () => {
  // Getting started's Look step is the pair: the remembered-tab door, then
  // the router. openAppTab clears chromeless itself and keeps the running
  // app parked (parked-store.js), so the return trip is the parked strip.
  assert.match(CHROME, /_landOnTab\?\.\(slug, 'needs'\)/, 'the door writes the Needs you tab');
  assert.match(CHROME, /openAppTab\?\.\(slug, 'dev'\)/, 'and the router takes the page there');
});

test('Suggest opens the existing dialog, already scoped to this app', () => {
  // target: 'app' is what the dialog's controller takes as a choice already
  // made (#2707) — the same payload Getting started's Suggest passes.
  assert.match(CHROME, /openFeedbackModal\?\.\(\{ target: 'app' \}\)/, 'the payload');
  // The dialog's own rows are untouched: the menu's button still calls
  // Improve.giveFeedback, which opens the same modal.
  assert.match(ACTIONS, /Improve\.giveFeedback\(\)/,
    'the menu\u2019s "Ask for a change" button is unchanged');
  assert.match(SHEET, /id="app-menu-workshop-owed"/, 'the menu\u2019s vote count is unchanged');
});

// ── The landing: first unseen card, not the top of a half-read feed ──

test('the pill lands on the first unseen card, and a traversal lands nothing', () => {
  // The Communities pane relays the door event, traversal-typed so Back and
  // Forward are not doors.
  assert.match(WORKSHOP, /usernode:needs-land-first/, 'the relay event');
  assert.match(WORKSHOP, /detail\.traversal/, 'traversals are filtered at the relay');
  // The feed snaps to row 0 — the first unseen card — with the same instant
  // arrangement wantsEnd uses, and catches a door that arrived before the
  // scroller had a height.
  assert.match(FEED, /NEEDS_FIRST_EVENT = 'usernode:needs-land-first'/, 'the listener\u2019s event');
  assert.match(FEED, /el\.scrollTop = 0/, 'the snap to the first card');
  assert.match(FEED, /firstLandRef/, 'the door that arrived before layout is owed');
});

// ── Chromeless mode ──────────────────────────────────────────────────

test('chromeless mode hides the whole bar, controls included', () => {
  // App.setChromeless publishes 'platform-header' false; these controls
  // render INSIDE that bar, so it is the same flag that hides both — no
  // second floating layer to place against the safe areas, and nothing that
  // could cover app content on a 390×844 phone.
  const publishes = read('public/js/app.js');
  assert.match(publishes, /App\.Visibility\.publish\('platform-header', !enable\)/,
    'the existing chromeless publish');
  assert.match(CHROME, /useVisibility\('platform-header', true\)/,
    'the controls read the same flag the bar does');
});
