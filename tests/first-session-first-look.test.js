'use strict';

// The maker's tour while Homeroom bot builds their first version
// (frontend/src/features/first-session/tour-steps.ts, first-look.tsx).
//
// Newcomer run four (12-13 October 2026, Club Votes): the tour's last card
// asked them to "Tap Open app" on the hub, and the hub shows no Open app
// before the first version is live (community-card.tsx hides it while a
// first version is on its way), so the card waited on a control that was not
// there and only Back worked. Its second card said "Club Votes opens here"
// over a screen that only said it was being built.
//
// N1: for a first version that is not live yet the tour ends on its first
// look: "Here's what Homeroom bot is making", the picture of its main screen,
// "Drawing your screens…" until that is there, and Done. N8: the app's card
// says it will open there.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';

test('N1: a first version on its way ends the maker\'s tour on its first look, never on Open app', () => {
  const { makerSteps, OPEN_APP, firstLookStep } = loadTsx(`${DIR}/tour-steps.ts`);
  const project = { slug: 'club-votes', name: 'Club Votes', conversationId: 4 };
  const today = makerSteps(project);
  for (const firstVersion of ['building', 'ready']) {
    const steps = makerSteps({ ...project, firstVersion });
    assert.equal(steps.length, today.length + 1, firstVersion);
    // No card asks for a press on Open app, or on anything not there.
    assert.ok(steps.every((s) => s.press !== OPEN_APP && s.target !== OPEN_APP), 'Open app is never pressed');
    const hub = steps[steps.length - 2];
    assert.equal(hub.target, '#app-content');
    assert.equal(hub.tap, undefined, 'the hub is a card with Next');
    assert.equal(hub.last, undefined);
    assert.equal(hub.text, 'The discussion and the app\'s changes are here.');
    const last = steps[steps.length - 1];
    assert.deepEqual(last, firstLookStep());
    assert.equal(last.title, 'Here\'s what Homeroom bot is making');
    assert.equal(last.text, 'Drawn from your answers. The working app follows, and we\'ll message you when it\'s live.');
    assert.deepEqual([last.screen, last.firstLook, last.last, last.tap, last.press], ['hub', true, true, undefined, undefined]);
  }
  // A project with no first version on its way (a ready-made app, or one the
  // bot does not build) ends as it did, on Open app.
  assert.equal(today[today.length - 1].press, OPEN_APP);
  assert.deepEqual(makerSteps({ ...project, firstVersion: null }), today);
});

test('N8: the app\'s card says it will open there while Homeroom bot builds it', () => {
  const { makerSteps, invitedSteps } = loadTsx(`${DIR}/tour-steps.ts`);
  const project = { slug: 'club-votes', name: 'Club Votes' };
  for (const steps of [makerSteps({ ...project, firstVersion: 'building' }), invitedSteps({ ...project, firstVersion: 'building' })]) {
    const app = steps[1];
    assert.equal(app.target, '#app-view');
    assert.equal(app.title, 'Club Votes will open here');
    assert.equal(app.text, 'Homeroom bot is building it now. When it\'s ready, this is where you\'ll use it.');
    assert.equal(app.saysWhereItOpens, true);
  }
  // Built and waiting to be tried, or live: it opens there.
  for (const firstVersion of ['ready', null]) {
    assert.equal(makerSteps({ ...project, firstVersion })[1].title, 'Club Votes opens here', String(firstVersion));
  }
  for (const id of ['onboarding:firstSession.tour.opensBuilding.title', 'onboarding:firstSession.tour.opensBuilding.text',
    'onboarding:firstSession.tour.firstLook.title', 'onboarding:firstSession.tour.firstLook.text', 'onboarding:firstSession.tour.firstLook.drawing']) {
    assert.doesNotMatch(message(id, { app: 'X' }), /—/, id);
  }
});

test('the made screen hands the tour where its first version stands', () => {
  const { madeStage } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(madeStage(null, true), 'building', 'the bot builds it, nothing read yet');
  assert.equal(madeStage({ step: 4, line: 'building' }, true), 'building');
  assert.equal(madeStage({ ready: true }, true), 'ready');
  assert.equal(madeStage(null, false), null, 'Homeroom bot builds nothing: Open app ends the tour');
  assert.equal(madeStage({ step: 4 }, true, true), null, 'live already');
  const made = read(`${DIR}/made.tsx`);
  assert.match(made, /const stage = madeStage\(fv, botBuilds && !imported && !readyMade, !making\);/);
  assert.match(made, /onClick=\{\(\) => onContinue\(false, stage\)\}/);
  assert.match(made, /onClick=\{\(\) => onContinue\(true, stage\)\}/);
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /onContinue=\{\(_skipped, firstVersion\) => \{\s+const info = \{ slug: made\.slug, name: made\.name, iconEmoji: made\.emoji, conversationId: made\.conversationId, firstVersion \};/);
  assert.match(index, /const project = \{ slug: mode\.info\.slug, name: mode\.info\.name, firstVersion: mode\.info\.firstVersion \?\? null \};/);
});

test('the first look card: the picture once it is there, "Drawing your screens…" until then, and Done', () => {
  const { firstLookSrc, TourFirstLook } = loadTsx(`${DIR}/first-look.tsx`);
  const body = (screens) => ({ app: { first_version: { line: 'building', screens } } });
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1, v: '17' }), 'club votes'),
    '/api/apps/club%20votes/first-version/screens/first_look/0?v=17');
  assert.equal(firstLookSrc(body({ kind: 'real', count: 3, v: '9' }), 'club-votes'),
    '/api/apps/club-votes/first-version/screens/real/0?v=9', 'its real screens, once there are some');
  assert.equal(firstLookSrc(body(undefined), 'club-votes'), null);
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 0 }), 'club-votes'), null);
  assert.equal(firstLookSrc({ app: {} }, 'club-votes'), null);
  assert.equal(firstLookSrc(null, 'club-votes'), null);
  // Before it is read: the words, with a spinner, where the picture goes.
  const html = renderToHtml(createElement(TourFirstLook, { slug: 'club-votes', name: 'Club Votes' }));
  assert.match(html, /data-first-session-first-look="drawing"/);
  assert.match(html, /<p role="status"[^>]*>Drawing your screens…<\/p>/);
  // Drawn in the card, under its words; Done ends the tour (no Skip on a
  // last card, and Back still works).
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /\{step\.firstLook \? <TourFirstLook slug=\{info\.slug\} name=\{info\.name\} \/> : null\}/);
  assert.match(index, /\{step\.firstLook \? t\('core:common\.done'\) : step\.last \? t\('onboarding:firstSession\.tour\.gotIt'\) : t\('onboarding:firstSession\.tour\.next'\)\}/);
  assert.equal(message('core:common.done'), 'Done');
  // Asked again while there is none, and stops once it is pictured (15 Oct
  // 2026: a drawn screen alone is asked past, tests/first-look-drawn.test.js).
  const look = read(`${DIR}/first-look.tsx`);
  assert.match(look, /if \(src && src !== broken && !isDrawnLook\(src\)\) return undefined;/);
  assert.match(look, /const timer = window\.setInterval\(read, FIRST_LOOK_POLL_MS\);/);
});
