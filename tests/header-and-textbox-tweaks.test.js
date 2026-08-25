// #1406 / #1407 / #1408 — three small UI tweaks, two of which are one change.
//
// They ship together because #1406 and #1407 touch the same measurement:
// putting the view selector and the improve button on more screens changes the
// right group's width on exactly those screens, and the right group's width is
// the input the title-centring decision reads. Landing them apart would mean
// tuning a centring rule against a header about to change under it.
//
// What each is:
//
//   #1406  The improve button and the view selector stay on the other platform
//          screens (settings, profile, messages) instead of vanishing the
//          moment you leave home.
//   #1407  The title centres in the space the side groups LEAVE, not on the
//          viewport — the groups are lopsided, so those are different places.
//   #1408  Text boxes grow with their content up to a ceiling.
//
// Run with: node --test tests/header-and-textbox-tweaks.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const APP_JS = read('public/js/app.js');
const HOME_JS = read('frontend/src/features/home/home.js');
const IMPROVE_JS = read('frontend/src/features/improve/improve-controller.js');
const TOGGLE_TSX = read('frontend/src/features/improve/view-toggle.tsx');
const LAYOUT_TS = read('frontend/src/features/header/use-header-layout.ts');
const GROW_TS = read('frontend/src/lib/use-auto-grow.ts');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const ROW = read('frontend/src/features/messages/message-row.tsx');
const CSS = read('public/css/app.css');

// ── #1406: the controls survive onto the other platform screens ────────

test('one shared entry point republishes the platform target', () => {
  // _enterScreenChrome is the single function every non-home platform screen
  // passes through — leaderboard, profile, admin, settings, browse, messages.
  // Doing this there rather than in six navigate* functions is what keeps the
  // next screen from having to remember.
  const start = APP_JS.indexOf('  _enterScreenChrome() {');
  assert.ok(start !== -1, '_enterScreenChrome exists');
  const body = APP_JS.slice(start, APP_JS.indexOf('\n  },', start));

  // The clear STILL runs first: it is what drops an open app's target, and
  // these screens are reached from inside an app as often as from home.
  const clearAt = body.indexOf('setAppOpen(false)');
  const publishAt = body.indexOf('publishImproveTarget');
  assert.ok(clearAt !== -1, 'the app target is still cleared');
  assert.ok(publishAt !== -1, 'and the platform target published after it');
  assert.ok(clearAt < publishAt, 'in that order — a swap, exactly as on home');
});

test('the publish gate asks whether an APP is on screen, not whether home is', () => {
  const start = HOME_JS.indexOf('  publishImproveTarget() {');
  const publish = HOME_JS.slice(start, HOME_JS.indexOf('\n  },', start));
  // Still refuses over an open app — that guard is why the header button never
  // describes the wrong thing during a transition.
  assert.match(publish, /currentApp/);
  assert.match(publish, /_isScreenVisible\('app-view'\)/);
  // But no longer refuses every screen that is not home, which was the whole
  // reason the controls disappeared.
  assert.doesNotMatch(publish, /!App\._isScreenVisible\('home-screen'\)/);
});

test('the selector marks NO segment on a screen that is none of them', () => {
  // The control's job is saying where you are. On settings you are not on
  // home, not on the app tab and not in the dev area, so claiming one of the
  // three would be a false statement made by a control people navigate with.
  const enter = APP_JS.slice(
    APP_JS.indexOf('  _enterScreenChrome() {'),
    APP_JS.indexOf('\n  },', APP_JS.indexOf('  _enterScreenChrome() {'))
  );
  assert.match(enter, /setTab\?\.\('other'\)/, 'the screen says so explicitly');
  // Published AFTER the target, because setTab no-ops while there is no slug.
  assert.ok(enter.indexOf('publishImproveTarget') < enter.indexOf("setTab?.('other')"));

  // 'other' is only ever passed, never inferred — anything unrecognised still
  // collapses to 'app' exactly as before.
  const setTab = IMPROVE_JS.slice(IMPROVE_JS.indexOf('  setTab(tab) {'));
  assert.match(setTab.slice(0, 400), /tab === 'other' \? 'other' : 'app'/);

  // And the component renders that as "none selected" rather than defaulting.
  assert.match(TOGGLE_TSX, /const active: Segment \| null/);
  assert.match(TOGGLE_TSX, /tab === 'app' \? 'app' : null/);
});

test('clicking Home from another screen actually navigates', () => {
  // The bug this avoids: #1386 could no-op here because "no app open" meant
  // "already home". #1406 makes that false, so the guard is the home screen
  // itself — otherwise the segment renders inactive, is clicked, and nothing
  // happens.
  const start = IMPROVE_JS.indexOf('  openApp() {');
  const body = IMPROVE_JS.slice(start, IMPROVE_JS.indexOf('\n  },', start));
  assert.match(body, /_isScreenVisible\('home-screen'\)/);
  assert.match(body, /if \(!onHome\) window\.App\.navigateHome\(\)/);
  assert.doesNotMatch(body, /if \(window\.App\.currentApp\) window\.App\.navigateHome\(\)/,
    'the old "an app is open" guard would strand a click from Settings');
  // A deployment where the helper is missing still navigates rather than
  // silently doing nothing.
  assert.match(body, /typeof window\.App\._isScreenVisible === 'function'/);
});

// ── #1407: centred in the gap, not on the viewport ─────────────────────

test('the anchor is the midpoint between the groups', () => {
  assert.match(LAYOUT_TS, /const gapStart = leftW \+ SIDE_GAP_PX/);
  assert.match(LAYOUT_TS, /const gapEnd = headerW - rightW - SIDE_GAP_PX/);
  assert.match(LAYOUT_TS, /gapStart \+ availableForCenter \/ 2/);
  // The old rule demanded the WIDER group's width as clearance on both sides,
  // which threw away the narrow side's room and put the title off-centre
  // within the gap it actually occupies.
  assert.doesNotMatch(LAYOUT_TS, /Math\.max\(leftW, rightW\)/,
    'the symmetric-clearance rule is gone, not merely bypassed');
});

test('the fit test asks only whether the title fits the gap', () => {
  assert.match(LAYOUT_TS, /availableForCenter = gapEnd - gapStart/);
  assert.match(LAYOUT_TS, /availableForCenter > 0[\s\S]{0,120}titleNaturalW \+ JITTER_SLACK_PX <= availableForCenter/);
  // The contract is unchanged: no state where a truncated title is also
  // centred. Falling back to flex flow is still how that is guaranteed.
  assert.match(LAYOUT_TS, /classList\.toggle\('is-centered', canCenter\)/);
});

test('the offset reaches CSS as a property, and is cleared when unused', () => {
  assert.match(LAYOUT_TS, /setProperty\('--header-title-centre'/);
  assert.match(LAYOUT_TS, /removeProperty\('--header-title-centre'/,
    'a left-aligned title must not carry a stale offset from a width it lost');
  assert.match(CSS, /left: var\(--header-title-centre, 50%\)/,
    'the stylesheet keeps the positioning rule; the hook supplies one number');
});

test('the measurement still reacts to the right group changing size', () => {
  // #1406 makes the right group's width vary across screens, which is exactly
  // what this observer exists for — the two changes meet here.
  assert.match(LAYOUT_TS, /rightObserver\.observe\(rightGroup\)/);
  assert.match(LAYOUT_TS, /headerObserver\.observe\(header\)/);
});

// ── #1408: text boxes that grow ────────────────────────────────────────

test('the hook collapses before measuring, or the height only ratchets up', () => {
  // Reading scrollHeight without the reset measures against the box the
  // element already has, so a textarea that grew never shrinks again when its
  // text is deleted.
  const autoAt = GROW_TS.indexOf("el.style.height = 'auto'");
  const setAt = GROW_TS.indexOf('el.scrollHeight');
  assert.ok(autoAt !== -1 && setAt !== -1 && autoAt < setAt,
    'collapse to auto, then pin to the content height');
});

test('the ceiling lives in CSS, and the overflow stays reachable', () => {
  // One control, one ceiling. Duplicating the max as a number in JS would give
  // each box two that can disagree.
  assert.doesNotMatch(GROW_TS, /max-?[Hh]eight\s*[:=]\s*\d/,
    'the hook sets no maximum of its own');
  // Setting height past max-height is harmless — the used height is clamped —
  // but the hidden lines have to be scrollable or they are simply lost.
  const composer = CSS.slice(CSS.indexOf('.messages-composer-input {'));
  assert.match(composer.slice(0, 600), /max-height: 140px/);
  assert.match(composer.slice(0, 600), /overflow-y: auto/);
  const edit = CSS.slice(CSS.indexOf('.messages-edit textarea {'));
  assert.match(edit.slice(0, 900), /max-height: \d+px/);
  assert.match(edit.slice(0, 900), /overflow-y: auto/);
});

test('both message text boxes use it, keyed on their own value', () => {
  // The dependency is the controlled value rather than an input listener: by
  // the time the effect runs React has re-rendered, so one measurement covers
  // typing, pasting, a clear on send and a draft restored on mount.
  assert.match(COMPOSER, /useAutoGrow\(inputRef, value\)/);
  assert.match(ROW, /useAutoGrow\(editRef, editValue\)/);
  assert.match(ROW, /<textarea ref=\{editRef\}/);
});

test('a hand-dragged edit box is not undone by the next keystroke', () => {
  // The grow is a floor on convenience, not a ceiling on choice: the edit box
  // keeps `resize: vertical`, so a deliberate drag survives.
  const edit = CSS.slice(CSS.indexOf('.messages-edit textarea {'));
  assert.match(edit.slice(0, 900), /resize: vertical/);
});
