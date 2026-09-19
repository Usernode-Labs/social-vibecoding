// The welcome tour (#2255), which replaces the one-line #home-welcome banner
// (#1561).
//
// The banner stated the two things the launcher never says and then went away
// for good. What it could not do is POINT: "send feedback from the Improve
// button" names a control on another screen, and a new account has no way to
// tell which of the things in front of it that sentence is about. The tour
// dims the page, cuts a hole around the thing each step is about, and puts
// the sentence beside it.
//
// What is pinned here, and why each one is worth a test:
//
//   - THE STEP TABLE. Eight steps in the product owner's order, with the
//     copy they settled on, and the interaction flags that make the Improve
//     arc real rather than illustrated. The order is the whole design, so a
//     reshuffle should be a deliberate edit to this file too.
//   - THE WALK. Next, Back, Finish and their clamps, over the pure helpers
//     in tour-steps.ts, so the arithmetic is covered without a browser.
//   - THE GEOMETRY. placeCard is the part that can silently put the card off
//     screen; it is pure numbers, so it is EXECUTED here rather than grepped.
//   - PERSISTENCE. Per user id, wrapped, failing toward showing the tour --
//     the three decisions the banner's own test pinned, carried over to the
//     new key. Executed against a localStorage stub, not grepped.
//   - THE FIRST RENDER. The island rule: the built document and the first
//     client pass have to agree, so the overlay renders hidden with no
//     measured geometry in it at all.
//   - THE REPLAY. Settings clears the flag, asks, and navigates home.
//
// Run with: node --test tests/home-tour.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderComponent, loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const TOUR_DIR = 'frontend/src/features/home/tour';
const OVERLAY_SRC = read(`${TOUR_DIR}/index.tsx`);
const STEPS_SRC = read(`${TOUR_DIR}/tour-steps.ts`);
const STORAGE_SRC = read(`${TOUR_DIR}/tour-storage.ts`);
const SETTINGS_SECTION_SRC = read('frontend/src/features/settings/sections/tour.tsx');
const SETTINGS_JS = read('frontend/src/features/settings/settings.js');
const TERMS_SRC = read('frontend/src/features/settings/terms-first-run.js');
const HOME_SRC = read('frontend/src/features/home/index.tsx');
const SHELL_SRC = read('frontend/src/Shell.tsx');
const INDEX = read('public/index.html');

// ── the step model and the geometry, executed ──────────────────────────

const steps = loadTsx(`${TOUR_DIR}/tour-steps.ts`);
const spotlight = loadTsx(`${TOUR_DIR}/spotlight.ts`);

test('the eight steps are the ones the design settled on, in order', () => {
  assert.equal(steps.TOUR_LENGTH, 8);
  assert.deepEqual(steps.TOUR_STEPS.map((s) => s.id), [
    'welcome', 'create', 'improve', 'feedback', 'new-change', 'workshop',
    'challenges', 'settings',
  ]);
});

test('each step carries copy, and none of it is an em dash', () => {
  for (const step of steps.TOUR_STEPS) {
    assert.ok(step.title.length > 0, `${step.id} has a title`);
    assert.ok(step.body.length > 12, `${step.id} has body copy`);
    // tests/no-em-dash-in-copy.test.js bans it across frontend/src; this
    // table is all copy, so it is worth saying twice.
    assert.doesNotMatch(`${step.title} ${step.body}`, /—/, `${step.id} is em-dash free`);
  }
});

test('every step points at a REAL control, and nothing is illustrated', () => {
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  // Step 1 has nothing to point at: it says what the place is.
  assert.deepEqual([...byId.welcome.targets], []);
  assert.deepEqual([...byId.create.targets], ['#home-create-section']);
  assert.deepEqual([...byId.challenges.targets], ['#home-challenges-section']);
  // The way into Settings from Home is the header chip, whose menu carries
  // #switcher-row-settings.
  assert.deepEqual([...byId.settings.targets], ['#app-switcher-btn']);
  // The Improve arc: the header control on Home, then the rows of the panel
  // the viewer opens with it. No mock anywhere in the feature.
  assert.deepEqual([...byId.improve.targets], ['#improve-btn']);
  assert.deepEqual([...byId.feedback.targets], ['#improve-row-feedback']);
  assert.deepEqual([...byId['new-change'].targets], ['#improve-row-new-session']);
  assert.deepEqual([...byId.workshop.targets], ['#app-context-row-workshop']);
  for (const src of [STEPS_SRC, OVERLAY_SRC]) {
    assert.doesNotMatch(src, /\bmock\b/i, 'the inline still life is gone, not hidden');
  }
});

test('the Improve step waits for the viewer, and has no Next to skip it with', () => {
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  assert.equal(byId.improve.advanceOn, 'improve-open');
  assert.equal(steps.hasNext(steps.IMPROVE_STEP_INDEX), false);
  assert.equal(steps.IMPROVE_STEP_INDEX, 2);
  // Every other step is driven by Next.
  for (const [i, step] of steps.TOUR_STEPS.entries()) {
    if (step.advanceOn) continue;
    assert.equal(steps.hasNext(i), true, `${step.id} has a Next`);
  }
  // The click is watched, never intercepted: the overlay subscribes to the
  // store and advances on the EDGE into open.
  assert.match(OVERLAY_SRC, /improveStore\.subscribe\(/);
  assert.match(OVERLAY_SRC, /if \(now && stepAt\(indexRef\.current\)\.advanceOn === 'improve-open'\)/);
  assert.doesNotMatch(OVERLAY_SRC, /addEventListener\('click'/);
});

test('the cut-out passes the press through only where pressing is the point', () => {
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  for (const id of ['improve', 'feedback', 'new-change', 'workshop']) {
    assert.equal(byId[id].interactive, true, `${id} lets the real control be pressed`);
  }
  for (const id of ['welcome', 'create', 'challenges', 'settings']) {
    assert.equal(byId[id].interactive, undefined, `${id} only describes its target`);
  }
  // The root blocks nothing; the four shades block everything around the
  // hole. A box-shadow could not, which is why there are four of them.
  assert.match(OVERLAY_SRC, /const ROOT = 'hidden fixed inset-0 z-\[9993\] overflow-hidden pointer-events-none'/);
  assert.match(OVERLAY_SRC, /const SHADE = 'absolute bg-zinc-950\/60 dark:bg-zinc-950\/75 pointer-events-auto/);
  assert.match(OVERLAY_SRC, /useClassToggle\(spotRef, 'pointer-events-auto', !step\.interactive\)/);
});

test('the three panel steps know they need the panel, and step 7 shuts it', () => {
  const byId = Object.fromEntries(steps.TOUR_STEPS.map((s) => [s.id, s]));
  for (const id of ['feedback', 'new-change', 'workshop']) {
    assert.equal(byId[id].needsPanel, true);
  }
  assert.equal(byId.improve.needsPanel, undefined, 'the Improve step stands on its own');
  assert.equal(byId.challenges.closesPanel, true);
  // Closed through the controller's own path, never by writing to the
  // panel's DOM, which React owns.
  assert.match(OVERLAY_SRC, /if \(!stepAt\(index\)\.closesPanel\) return;\s*\n\s*if \(!panelOpenNow\(\)\) return;\s*\n\s*void Improve\.close\(\);/);
  assert.doesNotMatch(OVERLAY_SRC, /getElementById\('improve-panel'\)\.(?:classList|innerHTML|style)/);
});

test('the tour pauses for anything else on screen, and resumes where the rule says', () => {
  // Paused is derived from the two things that mean "not on Home, alone":
  // Home is not the visible screen, or the kit has presented something that
  // is not the Improve panel.
  assert.match(OVERLAY_SRC, /const paused = !homeVisible \|\| otherSurface;/);
  assert.match(OVERLAY_SRC, /const live = open && !paused;/);
  assert.match(OVERLAY_SRC, /useHiddenClass\(rootRef, !live\)/);
  assert.match(OVERLAY_SRC, /const KIT_SURFACES = '\.un-modal, \.un-sheet, \.un-alert'/);
  assert.match(OVERLAY_SRC, /new MutationObserver\(read\)/);
  // A panel step with no panel resumes at the Improve step, and only once
  // the flow that took the viewer away has finished (`live`, not `open`).
  const fallback = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('if (!stepAt(index).needsPanel) return;'));
  const body = fallback.slice(0, fallback.indexOf('}, ['));
  assert.match(body, /if \(panelOpen\) return;/);
  assert.match(body, /setIndex\(IMPROVE_STEP_INDEX\);/);
  assert.match(OVERLAY_SRC, /\}, \[live, index, panelOpen\]\);/);
});

test('Back onto the Improve step shuts the panel, so the step always reads the same', () => {
  // Arriving with the panel already up would be a dead end: the step ends on
  // the panel OPENING and there is no edge left to wait for.
  const guard = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf("if (stepAt(index).advanceOn !== 'improve-open') return;"));
  const body = guard.slice(0, guard.indexOf('}, ['));
  assert.match(body, /if \(!panelOpenNow\(\)\) return;/);
  assert.match(body, /void Improve\.close\(\);/);
  // Back itself is a plain step move; the effect above is what handles the
  // panel, so it covers every way of landing there.
  assert.match(OVERLAY_SRC, /const goBack = useCallback\(\(\) => setIndex\(clampIndex\(indexRef\.current - 1\)\), \[\]\);/);
});

test('Next, Back and Finish cannot walk off either end', () => {
  assert.equal(steps.clampIndex(-3), 0);
  assert.equal(steps.clampIndex(99), 7);
  assert.equal(steps.clampIndex(Number.NaN), 0);
  assert.equal(steps.stepAt(0).id, 'welcome');
  assert.equal(steps.stepAt(7).id, 'settings');
  assert.ok(!steps.isLastStep(6));
  assert.ok(steps.isLastStep(7));
  assert.equal(steps.stepCounter(0), '1 of 8');
  assert.equal(steps.stepCounter(7), '8 of 8');
});

test('the card goes below the hole when it fits, above it when it does not', () => {
  const viewport = { width: 1280, height: 800 };
  const card = { width: 340, height: 200 };

  const below = spotlight.placeCard(viewport, card, {
    top: 100, left: 600, width: 80, height: 40,
  });
  assert.equal(below.top, 152, 'below the hole, one gap down');
  assert.equal(below.left, 470, 'centred on the hole');

  const above = spotlight.placeCard(viewport, card, {
    top: 700, left: 600, width: 80, height: 40,
  });
  assert.equal(above.top, 488, 'no room below, so above');
});

test('the card is always inside the viewport, hole or no hole', () => {
  const viewport = { width: 390, height: 844 };
  const card = { width: spotlight.cardWidth(390), height: 260 };
  assert.equal(card.width, 340, 'a phone still fits the full card');

  // A target hard against the right edge must not push the card off it.
  const clamped = spotlight.placeCard(viewport, card, {
    top: 60, left: 360, width: 26, height: 26,
  });
  assert.ok(clamped.left >= 12 && clamped.left + card.width <= 390 - 12 + 0.5,
    `left ${clamped.left} keeps the card on screen`);

  // No hole: centred.
  const centred = spotlight.placeCard(viewport, card, null);
  assert.equal(centred.left, 25);
  assert.equal(centred.top, 292);
});

test('a narrow viewport shrinks the card rather than overflowing', () => {
  assert.equal(spotlight.cardWidth(320), 296);
  assert.equal(spotlight.cardWidth(1280), 340);
});

test('the four shades tile the viewport minus the hole', () => {
  const viewport = { width: 1000, height: 800 };
  const [top, right, bottom, left] = spotlight.shadeBoxes(viewport, {
    top: 200, left: 300, width: 100, height: 50,
  });
  assert.deepEqual(top, { top: 0, left: 0, width: 1000, height: 200 });
  assert.deepEqual(right, { top: 200, left: 400, width: 600, height: 50 });
  assert.deepEqual(bottom, { top: 250, left: 0, width: 1000, height: 550 });
  assert.deepEqual(left, { top: 200, left: 0, width: 300, height: 50 });
  // Together they cover everything except the hole, which is what makes the
  // cut-out clickable: the shades are the elements that take pointer events.
  const covered = top.width * top.height + bottom.width * bottom.height
    + right.width * right.height + left.width * left.height;
  assert.equal(covered, 1000 * 800 - 100 * 50);
});

test('with nothing to point at, one shade covers the screen', () => {
  const [top, right, bottom, left] = spotlight.shadeBoxes({ width: 640, height: 480 }, null);
  assert.deepEqual(top, { top: 0, left: 0, width: 640, height: 480 });
  for (const box of [right, bottom, left]) {
    assert.equal(box.width * box.height, 0);
  }
});

test('a target scrolled half off screen still produces sane shades', () => {
  const viewport = { width: 500, height: 400 };
  for (const hole of [
    { top: -40, left: -30, width: 100, height: 60 },
    { top: 380, left: 470, width: 100, height: 60 },
  ]) {
    for (const box of spotlight.shadeBoxes(viewport, hole)) {
      assert.ok(box.width >= 0 && box.height >= 0, `no negative box for ${JSON.stringify(hole)}`);
      assert.ok(box.top >= 0 && box.left >= 0);
    }
  }
});

test('the hole is the target plus breathing room', () => {
  assert.deepEqual(
    spotlight.padRect({ top: 100, left: 50, width: 200, height: 40 }),
    { top: 92, left: 42, width: 216, height: 56 },
  );
});

// ── persistence, executed ──────────────────────────────────────────────

/**
 * tour-storage.ts, bundled and run against a storage of our own.
 *
 * Executed rather than grepped because the interesting cases are the ones a
 * grep cannot see: a second account on the same device, a clear that must
 * touch only one key, and a storage that throws on every access (Safari in
 * private mode, which is the failure the wrapping exists for).
 */
const storageApi = loadTsx(`${TOUR_DIR}/tour-storage.ts`);

function withStorage({ throwing = false } = {}) {
  const backing = new Map();
  const deny = () => { throw new Error('denied'); };
  globalThis.localStorage = throwing ? {
    getItem: deny, setItem: deny, removeItem: deny,
  } : {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  return backing;
}

test('the answer is per account, and never a bare global key', () => {
  const backing = withStorage();
  assert.equal(storageApi.keyFor(null), null);
  assert.equal(storageApi.keyFor(7), 'usernode:home-tour-done:7');
  // No viewer, no tour: there is nobody to welcome and no key to write under.
  assert.equal(storageApi.readDone(null), true);

  assert.equal(storageApi.readDone(7), false);
  storageApi.writeDone(7);
  assert.equal(storageApi.readDone(7), true);
  // A second account on the same device gets its own answer.
  assert.equal(storageApi.readDone(8), false);
  assert.deepEqual([...backing.keys()], ['usernode:home-tour-done:7']);
});

test('Replay clears exactly that account\'s answer', () => {
  withStorage();
  storageApi.writeDone(7);
  storageApi.writeDone(8);
  storageApi.clearDone(7);
  assert.equal(storageApi.readDone(7), false, 'the tour runs again for 7');
  assert.equal(storageApi.readDone(8), true, 'and is still finished for 8');
});

test('storage denied shows the tour rather than silently retiring it', () => {
  withStorage({ throwing: true });
  assert.equal(storageApi.readDone(7), false);
  // Neither write throws out of the module, so a denied storage costs the
  // viewer a repeated tour and nothing else.
  assert.doesNotThrow(() => storageApi.writeDone(7));
  assert.doesNotThrow(() => storageApi.clearDone(7));
});

test('the viewer is read off App.user, which only exists on the client', () => {
  const before = globalThis.window;
  globalThis.window = { App: { user: { id: 42 } } };
  try {
    assert.equal(storageApi.currentUserId(), 42);
    globalThis.window = { App: { user: null } };
    assert.equal(storageApi.currentUserId(), null);
    globalThis.window = {};
    assert.equal(storageApi.currentUserId(), null);
  } finally {
    globalThis.window = before;
  }
});

test('the key is new, so a dismissed banner is not a finished tour', () => {
  assert.match(STORAGE_SRC, /const KEY_PREFIX = 'usernode:home-tour-done:'/);
  assert.doesNotMatch(STORAGE_SRC, /home-welcome-dismissed/);
});

// ── the first render ───────────────────────────────────────────────────

test('the first render is the hidden overlay, with nothing measured', () => {
  const html = renderComponent(`${TOUR_DIR}/index.tsx`, 'OnboardingTour');
  assert.match(html, /id="home-tour"/);
  assert.match(html, /class="hidden fixed inset-0/, 'hidden until an effect says otherwise');
  assert.match(html, /id="home-tour-card"/);
  assert.match(html, /id="home-tour-next"/);
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.match(html, new RegExp(`id="home-tour-shade-${side}"`));
  }
  // The Skip question ships in the document and starts hidden, like the card
  // itself: nothing is mounted on demand, so React never has to reorder
  // children of a node the kit may have written to.
  assert.match(html, /id="home-tour-confirm" class="hidden"/);
  assert.match(html, /Are you sure\? You can reopen this from Settings\./);
  // Step 1 is what a step-less render shows, on both sides of hydration.
  assert.match(html, /1 of 8/);
  assert.match(html, /Welcome to Homeroom/);
  // No geometry in the markup: the hole and the card position are style
  // writes through refs, and a measured pixel in the prerender would be a
  // hydration mismatch waiting for the first viewport that differs.
  assert.doesNotMatch(html, /style="/);
});

test('the overlay is in the built document, hidden, and the banner is gone', () => {
  assert.ok(INDEX.includes('id="home-tour"'), 'prerendered, like the install strip');
  assert.ok(!INDEX.includes('id="home-welcome"'), 'the banner it replaces is retired');
  assert.ok(!fs.existsSync(path.join(ROOT, 'frontend/src/features/home/welcome-banner.tsx')));
  assert.doesNotMatch(HOME_SRC, /WelcomeBanner/);
  assert.match(SHELL_SRC, /<Island name="OnboardingTour"><OnboardingTour \/><\/Island>/);
});

test('visibility rides refs, never a rendered className', () => {
  // The same contract every island in the shell signs: constant class
  // strings, toggled through lib/legacy-dom.ts.
  for (const call of [
    'useHiddenClass(rootRef, !live)',
    'useHiddenClass(bodyRef, confirming)',
    'useHiddenClass(confirmRef, !confirming)',
    'useHiddenClass(nextRef, !showsNext)',
  ]) {
    assert.ok(OVERLAY_SRC.includes(call), `${call} is how that node hides`);
  }
  assert.ok(
    OVERLAY_SRC.includes("const ROOT = 'hidden fixed inset-0"),
    'the root class string is a constant with hidden where the prerender has it',
  );
});

// ── when it opens ──────────────────────────────────────────────────────

test('nothing opens the tour on a deterministic capture route', () => {
  const guard = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('function isDeterministicRoute'));
  const body = guard.slice(0, guard.indexOf('\n}'));
  for (const param of ['shot', 'demo', 'token']) {
    assert.match(body, new RegExp(`params\\.get\\('${param}'\\)`),
      `?${param}= is refused, so the declared checks never meet the overlay`);
  }
  assert.match(OVERLAY_SRC, /if \(isDeterministicRoute\(\)\) return;/);
});

test('the auto-start waits for the viewer, the terms gate and Home', () => {
  const start = OVERLAY_SRC.slice(OVERLAY_SRC.indexOf('if (started.current || userId == null) return;'));
  const body = start.slice(0, start.indexOf('}, [userId, start]);'));
  assert.ok(body.indexOf('await whenTermsSettled()') < body.indexOf('await whenHomeVisible()'),
    'terms first, then Home');
  assert.match(body, /if \(readDone\(userId\)\) return;/);
  // Once per document: neither path may stack a second tour on the first.
  assert.match(body, /started\.current = true;/);
});

test('the terms gate publishes the settled() the tour waits on', () => {
  assert.match(TERMS_SRC, /settled\(\) \{/);
  assert.match(TERMS_SRC, /_resolve\(\) \{/);
  // Every exit from the gate resolves it, or the tour would wait forever on
  // an account with no published terms to answer.
  const check = TERMS_SRC.slice(TERMS_SRC.indexOf('async _check()'));
  assert.ok((check.match(/TermsFirstRun\._resolve\(\);/g) || []).length >= 5,
    'each early return out of the check resolves the promise');
  assert.match(TERMS_SRC, /onClosed: \(\) => \{\s*TermsFirstRun\._presented = false;\s*TermsFirstRun\._resolve\(\);/);
});

test('Escape behaves like Skip, and focus stays in the card', () => {
  assert.match(OVERLAY_SRC, /if \(event\.key === 'Escape'\)/);
  assert.match(OVERLAY_SRC, /setConfirming\(\(was\) => !was\);/);
  assert.match(OVERLAY_SRC, /if \(event\.key !== 'Tab'\) return;/);
  assert.match(OVERLAY_SRC, /const surface = confirmingRef\.current \? confirmRef\.current : bodyRef\.current;/);
});

test('the overlay re-measures on resize and on scroll', () => {
  assert.match(OVERLAY_SRC, /window\.addEventListener\('resize', onChange\);/);
  // Capture, because #home-screen is the scroller and scroll does not bubble.
  assert.match(OVERLAY_SRC, /window\.addEventListener\('scroll', onChange, true\);/);
  assert.match(OVERLAY_SRC, /prefers-reduced-motion: reduce/);
  assert.match(OVERLAY_SRC, /motion-safe:transition/);
});

// ── the way back in ────────────────────────────────────────────────────

test('Settings offers Replay the tour, and it is a registered section', () => {
  const html = renderComponent('frontend/src/features/settings/sections/tour.tsx', 'TourSection');
  assert.match(html, /data-settings-section="tour"/);
  assert.match(html, /class="hidden"/, 'the pane ships hidden, like its fifteen siblings');
  assert.match(html, /id="settings-tour-replay"/);
  assert.match(html, /Replay the tour/);
  // Registered in the menu, in Preferences.
  assert.match(SETTINGS_JS, /\{ key: 'tour', label: 'Welcome tour', group: 'Preferences' \}/);
});

test('Replay clears the flag, asks for the tour, then goes to Home', () => {
  const fn = SETTINGS_SECTION_SRC.slice(SETTINGS_SECTION_SRC.indexOf('function replay'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(body.indexOf('clearDone(currentUserId())') < body.indexOf('requestTour()'));
  assert.ok(body.indexOf('requestTour()') < body.indexOf('navigateHome'));
});

test('the replay request survives the chunk boundary between Settings and Home', () => {
  // The settings panes are a lazy chunk and the overlay rides the shell, so
  // the counter lives on window rather than in a module, the same way
  // lib/visibility-store.ts reasons about load order.
  const REQUEST_SRC = read(`${TOUR_DIR}/tour-request.ts`);
  assert.match(REQUEST_SRC, /export const TOUR_REQUEST_KEY = '__usernodeTourRequest'/);
  assert.match(REQUEST_SRC, /store\.count \+= 1;/);
  assert.match(REQUEST_SRC, /useSyncExternalStore\(subscribe, readTourRequest, \(\) => 0\)/);
});

test('the tour never reads or writes the challenge-based onboarding gate', () => {
  for (const src of [STEPS_SRC, STORAGE_SRC, SETTINGS_SECTION_SRC]) {
    assert.doesNotMatch(src, /setupFinished/);
    assert.doesNotMatch(src, /HomePanels/);
  }
  // Step 7 points at the Challenges section and says what finishing it does,
  // which is the whole of the relationship between the two.
  const challenges = steps.TOUR_STEPS.find((s) => s.id === 'challenges');
  assert.match(challenges.body, /Complete challenges to finish onboarding/);
});
