// A maker whose first version Homeroom bot is still building
// (frontend/src/features/first-session/made.tsx madeStage, index.tsx,
// first-look.tsx).
//
// Newcomer run four (12-13 October 2026, Club Votes): the tour's last card
// asked them to "Tap Open app" on the hub, and the hub shows no Open app
// before the first version is live, so the card waited on a control that
// was not there. N1 ended that tour on the first look instead.
//
// 15 Oct 2026 (Evan, "A tip in the app, then 1, 2, 3 on Home"): that tour is
// gone. A first version on its way has no app to open, so the made screen's
// way on goes to Home, the maker's first visit to Homeroom, and the walk runs
// there; the tip waits for the app to be live
// (tests/first-session-app-tip.test.js). The first look itself is drawn by
// the made screen's card and the hub's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx } = require('./lib/render-tsx');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';

test('N1, now: a first version on its way sends the maker to Home and the walk, and no card is a first look', () => {
  const tour = loadTsx(`${DIR}/tour-steps.ts`);
  for (const gone of ['makerSteps', 'invitedSteps', 'privateSteps', 'firstLookStep', 'OPEN_APP']) assert.equal(tour[gone], undefined, gone);
  assert.ok(tour.homeWalkSteps({ slug: 'club-votes' }).every((s) => !s.firstLook && !s.press), 'no first look, nothing to press');
  assert.equal(loadTsx(`${DIR}/first-look.tsx`).TourFirstLook, undefined);
  assert.doesNotMatch(read(`${DIR}/index.tsx`), /TourFirstLook|step\.firstLook/);
  const catalog = JSON.parse(read('frontend/locales/en/onboarding.json'));
  for (const key of ['title', 'text', 'drawing', 'alt']) assert.equal(catalog[`firstSession.tour.firstLook.${key}`], undefined, key);
  // The walk runs now, on Home, once: the maker's, told to the server.
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /if \(firstVersion !== null\) \{[\s\S]*?enterScreen\('home', slug\);\s+if \(uid != null && !claimWalk\(uid\)\) \{ setMode\(\{ kind: 'none' \}\); return; \}\s+setMode\(\{ kind: 'tour', info: \{ slug, name \}, path: 'walk', moments: true \}\);/);
});

test('the made screen hands on where its first version stands: null opens the app, anything else goes Home', () => {
  const { madeStage } = loadTsx(`${DIR}/made.tsx`);
  assert.equal(madeStage(null, true), 'building', 'the bot builds it, nothing read yet');
  assert.equal(madeStage({ step: 4, line: 'building' }, true), 'building');
  assert.equal(madeStage({ ready: true }, true), 'ready', 'built, up for approval: still not live');
  assert.equal(madeStage(null, false), null, 'Homeroom bot builds nothing: the app is what there is');
  assert.equal(madeStage({ step: 4 }, true, true), null, 'live already');
  const made = read(`${DIR}/made.tsx`);
  assert.match(made, /const stage = madeStage\(fv, botBuilds && !imported && !readyMade, !making\);/);
  assert.match(made, /onClick=\{\(\) => onContinue\(false, stage\)\}/);
  assert.match(made, /onClick=\{\(\) => onContinue\(true, stage\)\}/);
  const index = read(`${DIR}/index.tsx`);
  assert.match(index, /onContinue=\{\(skipped, firstVersion\) => \{/);
  assert.match(index, /if \(firstVersion !== null\) \{/);
  assert.match(index, /setMode\(\{ kind: 'none' \}\);\s+enterScreen\('app', slug\);/);
});

test('the first look\'s picture: its own URL once it is there, none until then', () => {
  const { firstLookSrc, FIRST_LOOK_POLL_MS } = loadTsx(`${DIR}/first-look.tsx`);
  const body = (screens) => ({ app: { first_version: { line: 'building', screens } } });
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 1, v: '17' }), 'club votes'),
    '/api/apps/club%20votes/first-version/screens/first_look/0?v=17');
  assert.equal(firstLookSrc(body({ kind: 'real', count: 3, v: '9' }), 'club-votes'),
    '/api/apps/club-votes/first-version/screens/real/0?v=9', 'its real screens, once there are some');
  assert.equal(firstLookSrc(body(undefined), 'club-votes'), null);
  assert.equal(firstLookSrc(body({ kind: 'first_look', count: 0 }), 'club-votes'), null);
  assert.equal(firstLookSrc({ app: {} }, 'club-votes'), null);
  assert.equal(firstLookSrc(null, 'club-votes'), null);
  // The made screen asks again as often while there is none (./made.tsx).
  assert.equal(FIRST_LOOK_POLL_MS, 5000);
  assert.match(read(`${DIR}/made.tsx`), /import \{ FIRST_LOOK_POLL_MS, firstLookSrc \} from '\.\/first-look';/);
});
