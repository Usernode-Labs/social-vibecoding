// #1406 / #1408 — two small UI tweaks.
//
//   #1406  The improve button and the view selector stay on the other platform
//          screens (settings, profile, messages) instead of vanishing the
//          moment you leave home.
//   #1408  Text boxes grow with their content up to a ceiling.
//
// #1407 was here too — centring the title in the space the side groups LEAVE
// rather than on the viewport, which is a different place because the groups
// are lopsided. It was implemented, reviewed on the staging preview and backed
// out: the anchor moving with the right group's width read as the title
// wandering rather than as it being centred. use-header-layout.ts keeps the
// viewport-centred rule it always had — absolute at left:50% when the title's
// natural width clears the wider group on both sides, flex flow otherwise —
// and nothing in this file asserts on it.
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
const GROW_TS = read('frontend/src/lib/use-auto-grow.ts');
const COMPOSER = read('frontend/src/features/messages/composer.tsx');
const ROW = read('frontend/src/features/messages/message-row.tsx');
const CSS = read('public/css/app.css');

// One method of the App object literal, from its opening line to the `},`
// that closes it at the same indent. Used instead of a character count so a
// comment added inside a method cannot silently push an assertion's subject
// out of the window it is matched against.
const fnBody = (name) => {
  const start = APP_JS.indexOf(`  ${name}() {`);
  assert.ok(start !== -1, `${name} exists in app.js`);
  const end = APP_JS.indexOf('\n  },', start);
  assert.ok(end !== -1, `${name} is closed`);
  return APP_JS.slice(start, end);
};

// ── #1406: the controls survive onto the other platform screens ────────

test('one shared entry point republishes the platform target', () => {
  // _enterScreenChrome is the single function every non-home platform screen
  // passes through — leaderboard, profile, admin, settings, browse, messages.
  // Doing this there rather than in six navigate* functions is what keeps the
  // next screen from having to remember.
  const enter = fnBody('_enterScreenChrome');

  // The clear STILL runs first: it is what drops an open app's target, and
  // these screens are reached from inside an app as often as from home.
  const clearAt = enter.indexOf('setAppOpen(false)');
  const publishAt = enter.indexOf('_publishPlatformChrome()');
  assert.ok(clearAt !== -1, 'the app target is still cleared');
  assert.ok(publishAt !== -1, 'and the platform chrome published after it');
  assert.ok(clearAt < publishAt, 'in that order — a swap, exactly as on home');

  // The publish half is its own function because it must be able to run
  // AGAIN (see the cold-load test below) while the clear must not: re-running
  // setAppOpen(false) after an app has opened would drop that app's target.
  const publish = fnBody('_publishPlatformChrome');
  assert.doesNotMatch(publish, /setAppOpen/,
    'the destructive half must not be inside the repeatable one');
  assert.match(publish, /Home\.publishImproveTarget\(\)/);
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
  const publish = fnBody('_publishPlatformChrome');
  assert.match(publish, /setTab\?\.\('other'\)/, 'the screen says so explicitly');
  // Published AFTER the target, because setTab no-ops while there is no slug.
  assert.ok(publish.indexOf('publishImproveTarget')
    < publish.indexOf("setTab?.('other')"));

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

test('a direct load of one of these screens fetches the app list first', () => {
  // The catch the declared checks made: only Home.load() and Browse._load()
  // ever fetch /api/apps, and both are gated on their own screen being on
  // show. So arriving at /#settings by NAVIGATION worked (home had already
  // filled the list) while a refresh on that URL published nothing at all —
  // no improve button, no selector. The fix is to ask for the payload from
  // the screen that needs it, not to guess the platform's slug: the row the
  // viewer was actually served is what decides whether the button exists.
  const publish = fnBody('_publishPlatformChrome');
  assert.match(publish, /Home\.ensureAppsLoaded\?\.\(\)/);
  assert.match(publish, /loading\.then\(/, 'and republishes when it lands');

  const ensure = HOME_JS.slice(
    HOME_JS.indexOf('  ensureAppsLoaded() {'),
    HOME_JS.indexOf('\n  },', HOME_JS.indexOf('  ensureAppsLoaded() {'))
  );
  assert.ok(ensure.length > 0, 'Home.ensureAppsLoaded exists');
  assert.match(ensure, /fetch\(`\/api\/apps\$\{demoQS\}`\)/,
    'the same endpoint and the same ?demo=1 pass-through as load()');
  assert.match(ensure, /Home\._apps = apps/);
  assert.match(ensure, /Home\._appsLoaded = true/);
  // NOT a render: home is not the screen on show, and navigateHome runs the
  // real load() before it ever is.
  assert.doesNotMatch(ensure, /Home\.render\(\)/);
});

test('the re-publish terminates, whether the fetch works or not', () => {
  // _publishPlatformChrome re-enters itself from the promise, so the exit
  // condition is entirely in ensureAppsLoaded's first two lines: it must
  // answer null on the second ask. Guarding on _appsLoaded alone would loop
  // forever on a failed fetch, which is the offline case.
  const ensure = HOME_JS.slice(
    HOME_JS.indexOf('  ensureAppsLoaded() {'),
    HOME_JS.indexOf('\n  },', HOME_JS.indexOf('  ensureAppsLoaded() {'))
  );
  assert.match(ensure,
    /if \(Home\._appsLoaded \|\| Home\._appsFetchAttempted\) return null;/);
  // Set BEFORE the fetch, not in its success branch — that ordering is the
  // whole guarantee.
  const flagAt = ensure.indexOf('Home._appsFetchAttempted = true');
  const fetchAt = ensure.indexOf('await fetch(');
  assert.ok(flagAt !== -1 && fetchAt !== -1 && flagAt < fetchAt,
    'the attempt is recorded before it can fail');
  assert.match(HOME_JS, /_appsFetchAttempted: false,/, 'and it starts false');
});

test('a late payload never overwrites a header its screen no longer owns', () => {
  // The fetch can land after the viewer has opened an app or gone home. Both
  // publish their own target, so re-running this then would describe the
  // wrong thing — the same mistake publishImproveTarget's own gates avoid.
  const publish = fnBody('_publishPlatformChrome');
  const cb = publish.slice(publish.indexOf('loading.then('));
  assert.match(cb, /if \(App\.currentApp\) return;/);
  assert.match(cb, /if \(App\._isScreenVisible\('home-screen'\)\) return;/);
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
