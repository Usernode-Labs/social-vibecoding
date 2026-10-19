'use strict';

// One thing going on at a time on the screen after Make it
// (frontend/src/features/first-session/made.tsx).
//
// Newcomer run six (14 October 2026, iPhone 17 Safari, Club Votes): while
// Homeroom bot planned, the screen said three things were under way at once,
// "Homeroom bot is planning it" under the project, the setup's card
// ("Setting up its storage… 1/4") and "Checking whether Homeroom bot needs to
// ask you anything first." With the questions up, the planning line stayed
// though the plan was written, and "Preparing it to run… 3/4" sat over them.
// After Submit, a "Starting the build" line and the setup's card again. Now:
//
//   checking   the project, then one spinner over the checking line;
//   questions  the project, then the questions and Submit;
//   invite     the project, then one card with the first look and how far it
//              has got (the setup, then the stage), then the invite ask.
//
// Run seven (14 Oct 2026): while it checks or asks the project stands at
// the top, so the spinner sits just under it and the questions come in the
// same place without the card moving.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const DIR = 'frontend/src/features/first-session';
const SRC = read(`${DIR}/made.tsx`);
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const made = loadTsx(`${DIR}/made.tsx`);

const CLUB = { slug: 'club-votes', name: 'Club Votes', emoji: '🗳️', description: null, example: null, conversationId: 12 };
const draw = (props) => renderToHtml(createElement(made.MadeScreen, { made: CLUB, me: 'evan', onContinue() {}, onOpenChat() {}, ...props }));
const card = (props) => renderToHtml(createElement(made.FirstLookCard, { src: null, name: 'Club Votes', ...props }));
const SETUP = (step, over = {}) => ({ setup: true, step, slow: false, waitedOut: false, ...over });
const LOOK = '/api/apps/club-votes/first-version/screens/first_look/0?v=17';

test('the three states, and what stands under the project in each', () => {
  const { screenOf, madeParts, firstLookHereFor } = made;
  assert.equal(screenOf({ checking: true, asking: false, stalled: false }), 'checking');
  assert.equal(screenOf({ checking: false, asking: true, stalled: false }), 'questions');
  assert.equal(screenOf({ checking: false, asking: false, stalled: false }), 'invite');
  assert.equal(screenOf({ checking: true, asking: true, stalled: true }), 'stalled', 'a setup that stopped says so, whatever else');
  // A project the bot builds from its description, on the first session:
  // nothing beside the checking line or the questions, then the first look
  // card alone, carrying the setup's progress.
  assert.deepEqual(madeParts('checking', true), { ownLine: false, setupCard: false, firstLook: false });
  assert.deepEqual(madeParts('questions', true), { ownLine: false, setupCard: false, firstLook: false });
  assert.deepEqual(madeParts('invite', true), { ownLine: false, setupCard: false, firstLook: true });
  assert.deepEqual(madeParts('stalled', true), { ownLine: true, setupCard: false, firstLook: false }, 'its stopped card and the line that says so');
  // Anything else past the questions is as it was: its line, and its setup's card where it has one.
  assert.deepEqual(madeParts('invite', false), { ownLine: true, setupCard: true, firstLook: false });
  assert.deepEqual(madeParts('questions', false), { ownLine: false, setupCard: false, firstLook: false }, 'from Create, while it asks');
  const at = { botBuilds: true, imported: false, readyMade: false, entry: 'first-session' };
  assert.equal(firstLookHereFor(at), true);
  assert.equal(firstLookHereFor({ ...at, entry: 'create' }), false, 'Create hands on to the hub, which shows the setup');
  assert.equal(firstLookHereFor({ ...at, botBuilds: false }), false, 'nothing for the bot to draw');
  assert.equal(firstLookHereFor({ ...at, imported: true }), false);
  assert.equal(firstLookHereFor({ ...at, readyMade: true }), false);
  // Wired: the screen draws from the parts.
  assert.match(CODE, /const screen = screenOf\(\{ checking, asking: !!asked && !stalled, stalled: !!stalled \}\);\s+const \{ ownLine, setupCard, firstLook \} = madeParts\(screen, firstLookHere\);/);
  assert.match(CODE, /const firstLookHere = firstLookHereFor\(\{ botBuilds, imported, readyMade, entry \}\);/);
  assert.match(CODE, /<SketchCard made=\{made\} sketch=\{sketch\} line=\{ownLine \? line : null\}/);
  assert.match(CODE, /\{settingUp && setupCard \? <SetupProgress /);
  assert.match(CODE, /\{ranInPlace && setupCard \? <SetupProgress /);
});

test('checking: the project, then one spinner over the checking line, and nothing else under way', () => {
  const html = draw();
  const { CheckingLine, CHECKING_LINE } = made;
  assert.equal(message(CHECKING_LINE), 'Checking whether Homeroom bot needs to ask you anything first.');
  // One spinner on the screen, the checking line's.
  assert.equal((html.match(/animate-spin/g) || []).length, 1, 'one spinner');
  assert.doesNotMatch(html, /data-progress-ring-spinning/, 'no setup ring');
  assert.doesNotMatch(html, /data-build-line=|Homeroom bot is planning it/, 'no planning line');
  assert.doesNotMatch(html, /data-made-setup|Setting up its storage|Usually about a minute\./, 'no setup card');
  assert.doesNotMatch(html, /data-made-first-look/, 'no first look card yet');
  assert.doesNotMatch(html, /Share invite|Invite people later/);
  // Under the project, in the buttons' place.
  assert.ok(html.indexOf('data-featured-card=') < html.indexOf('data-first-session-checking=""'));
  const line = renderToHtml(createElement(CheckingLine));
  assert.match(line, /^<div role="status" data-first-session-checking="" class="flex flex-col items-center gap-2\.5 text-center text-\[15px\] leading-5 text-zinc-500 dark:text-zinc-400"><svg[^>]*class="h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none"[^>]*aria-hidden="true"/);
  assert.match(line, /<p>Checking whether Homeroom bot needs to ask you anything first\.<\/p><\/div>$/);
  // Setup goes on underneath: read as before, its card simply not drawn.
  assert.match(CODE, /const settingUp = holdsContinue\(waits, appStatus, false\);/);
});

test('run seven: while it checks or asks, the project stands at the top, the spinner and then the questions just under it', () => {
  // Newcomer run seven (14 Oct 2026, iPhone Safari, Club Votes): the body
  // grew and centred the card, so the spinner sat about 150px under it, by
  // the toolbar, and the card jumped when the questions came. Now the body
  // takes its own height at the top while it checks or asks; the invite ask
  // and a stopped setup are centred as before.
  const { madeBodyClass, MADE_BODY, MADE_BODY_TOP } = made;
  assert.equal(MADE_BODY, 'flex grow flex-col justify-center gap-4 py-4');
  assert.equal(MADE_BODY_TOP, 'flex flex-col gap-4 py-4');
  assert.equal(madeBodyClass('checking'), MADE_BODY_TOP);
  assert.equal(madeBodyClass('questions'), MADE_BODY_TOP, 'the same place, so the card does not move');
  assert.equal(madeBodyClass('invite'), MADE_BODY);
  assert.equal(madeBodyClass('stalled'), MADE_BODY);
  for (const cls of MADE_BODY_TOP.split(' ')) assert.ok(!['grow', 'justify-center', 'mt-auto'].includes(cls), cls);
  // Wired from the state, with its data attribute kept.
  assert.match(CODE, /<div data-first-session-made-body="" className=\{madeBodyClass\(screen\)\}>/);
  // Checking, drawn: the body at the top, then the checking line straight
  // after it (16px, the body's own bottom padding), nothing between.
  const html = draw();
  const body = html.indexOf('<div data-first-session-made-body="" class="flex flex-col gap-4 py-4">');
  assert.ok(body >= 0, 'at the top while it checks');
  assert.ok(body < html.indexOf('data-featured-card='));
  assert.ok(html.indexOf('data-featured-card=') < html.indexOf('data-first-session-checking=""'));
  // The questions take the checking line's place, after the same body.
  const footer = CODE.slice(CODE.indexOf('data-first-session-made-body'));
  assert.ok(footer.indexOf('<QuickQuestions ') < footer.indexOf('<CheckingLine />'), 'one slot, the questions or the line');
});

test('questions: the project, then the questions and Submit, with no planning line and no setup card', () => {
  // The questions take the footer; nothing under the project says it is under way.
  const { madeParts } = made;
  assert.deepEqual(madeParts('questions', true), { ownLine: false, setupCard: false, firstLook: false });
  assert.match(CODE, /\{asked && !stalled \? \(\s+<QuickQuestions /);
  // The plain card's row goes too (a project with no sketch).
  assert.match(CODE, /const rowHidden = settingUp \|\| ranInPlace \|\| !ownLine;/);
  assert.match(CODE, /\{rowHidden \? null : \(\s+<div data-first-session-build-row=""/);
  // The first look card is the invite ask's, never over the questions.
  // #5618: tapping it opens the maker's chat with Homeroom bot.
  assert.match(CODE, /\{firstLook \? <FirstLookCard src=\{lookShown\} name=\{made\.name\} progress=\{lookProgress\} onBroken=\{setBrokenLook\} phone=\{!lookInCard\} onOpen=\{\(\) => onOpenChat\(made\.conversationId\)\} \/> : null\}/);
});

test('after Submit: one card carries the first look and the setup, under the project card, which stays as it is', () => {
  const { FIRST_LOOK_KICKER, FIRST_LOOK_TITLE, FIRST_LOOK_ROW, firstLookEstimate } = made;
  assert.equal(message(FIRST_LOOK_KICKER), 'First look');
  assert.equal(message(FIRST_LOOK_TITLE), 'Here\'s what Homeroom bot is making');
  assert.equal(firstLookEstimate(false, false), 'Usually about a minute');
  assert.equal(firstLookEstimate(true, false), 'Should be ready shortly…');
  assert.equal(firstLookEstimate(true, true), 'Ready shortly. You can go on.');
  for (const words of [message(FIRST_LOOK_KICKER), message(FIRST_LOOK_TITLE), firstLookEstimate(false, false), firstLookEstimate(true, false), firstLookEstimate(true, true)]) {
    assert.doesNotMatch(words, /!|—/, words);
  }

  // No picture yet: a calm phone outline with a band of light, then the
  // small caps kicker, the title, and the setup's ring, step and estimate.
  const drawing = card({ progress: SETUP(3) });
  // #5618: the card is positioned, so the empty overlay button can cover it.
  assert.match(drawing, /^<section data-made-first-look="drawing" aria-labelledby="made-first-look-title" class="relative">/);
  assert.match(drawing, /data-made-first-look-phone="drawing"/);
  assert.match(drawing, /motion-safe:animate-card-sweep/);
  assert.doesNotMatch(drawing, /<img/);
  assert.match(drawing, /<p class="text-\[12px\] font-bold uppercase leading-4 tracking-\[0\.06em\] text-zinc-500 dark:text-zinc-400">First look<\/p>/);
  assert.match(drawing, /<h2 id="made-first-look-title" class="mt-0\.5 line-clamp-2 text-\[15px\] font-\[650\] leading-5">Here&#x27;s what Homeroom bot is making<\/h2>/);
  assert.match(drawing, /data-made-first-look-status="build"/);
  assert.match(drawing, /aria-label="Step 3 of 4"[^>]*data-progress-ring-spinning=""/);
  assert.match(drawing, />3\/4<\/text>/);
  assert.match(drawing, />Preparing it to run…<\/p><p class="truncate text-\[13px\] leading-\[18px\] text-zinc-500 dark:text-zinc-400">Usually about a minute<\/p>/);
  // Before any step is read: the ring turning with no number.
  const started = card({ progress: SETUP(0) });
  assert.match(started, /data-made-first-look-status="started"/);
  assert.match(started, />Getting it ready…<\/p>/);
  assert.doesNotMatch(started, /<text/);

  // The picture, once there is one: the tour's and the App tab's, faded in
  // over the outline when it has loaded.
  const ready = card({ src: LOOK, progress: SETUP(4) });
  assert.match(ready, /data-made-first-look="ready"/);
  assert.match(ready, new RegExp(`<img src="${LOOK.replace(/[?.]/g, '\\$&')}" alt="The first look at Club Votes&#x27;s main screen" draggable="false" class="absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-300 ease-out motion-reduce:transition-none opacity-0"/>`));

  // Set up: the stage in the build line's own words, the ring full and quiet.
  const stage = card({ src: LOOK, progress: { setup: false, words: 'Starting the build', note: 'It’s set up.', busy: true, asks: false } });
  assert.match(stage, /data-made-first-look-status="stage"/);
  assert.match(stage, />Starting the build<\/p><p class="truncate text-\[13px\][^"]*">It’s set up\.<\/p>/);
  assert.match(stage, /aria-label="Starting the build"[^>]*data-progress-ring-spinning=""/);
  assert.match(stage, /stroke-zinc-400/);
  assert.doesNotMatch(stage, /<text/);
  const asks = card({ progress: { setup: false, words: 'Your plan is ready to review', note: 'It’s set up.', busy: false, asks: true } });
  assert.match(asks, /text-\[color:var\(--accent\)\]">Your plan is ready to review<\/p>/);
  assert.doesNotMatch(asks, /data-progress-ring-spinning/);

  // One height whatever it shows, so nothing under it moves: the same row,
  // the same phone, the same status row.
  assert.match(FIRST_LOOK_ROW, /(^| )h-\[132px\]( |$)/);
  const rows = [drawing, started, ready, stage, asks].map((html) => {
    assert.match(html, /<div data-made-first-look-phone="(drawing|ready)" class="relative h-\[108px\] w-\[50px\] shrink-0 overflow-hidden rounded-\[11px\] /);
    assert.match(html, /<div role="status" data-made-first-look-status="[^"]+" class="mt-2 flex h-10 items-center gap-2\.5">/);
    return html.match(/<section [^>]*><div class="([^"]*)">/)[1];
  });
  assert.deepEqual([...new Set(rows)], [FIRST_LOOK_ROW]);
  // The plane's card, 20px, one hairline.
  assert.match(FIRST_LOOK_ROW, /rounded-\[20px\] bg-white [^"]*shadow-\[inset_0_0_0_1px_var\(--app-sheet-line\)\] dark:bg-zinc-900/);

  // On the screen: under the project card, never in it, and the stage line
  // that stood under the project is gone (ownLine). The invite line and its
  // buttons follow, Invite people later off until the app runs.
  const body = CODE.slice(CODE.indexOf('data-first-session-made-body'), CODE.indexOf('data-first-session-hint='));
  assert.ok(body.indexOf('<SketchCard made=') < body.indexOf('<FirstLookCard '), 'under the project');
  assert.ok(body.indexOf('<FirstLookCard ') < body.indexOf('<QuickQuestions '), 'before the footer');
  assert.match(CODE, /data-first-session-continue="" onClick=\{\(\) => onContinue\(true, stage\)\} disabled=\{holds\}/);
});

test('the progress: the setup\'s step until it runs, then the stage in the words every screen uses', () => {
  assert.match(CODE, /const lookProgress: FirstLookProgress = settingUp\s+\? \{ setup: true, step: setupStep, slow, waitedOut \}/);
  // The phase's own words (N4, ./build-line.tsx phaseLine), else the build
  // line's (BUILD_LINE_WORDS), as BuildLine says them.
  assert.match(CODE, /words: named\.words \|\| \(line && line !== 'working' \? t\(BUILD_LINE_WORDS\[line\]\) : t\(SETUP_SET_UP\)\),/);
  assert.match(CODE, /note: named\.note \|\| t\(SETUP_SET_UP\),/);
  // A build that stopped (14 Oct 2026) turns nothing either.
  assert.match(CODE, /busy: !!line && !buildLineAsks\(line\) && !buildLineDone\(line\) && !buildLineStopped\(line\),/);
  assert.match(CODE, /const phase = fv\?\.phase \|\| \(answered && line === 'building' \? \{ key: 'starting' \} : null\);\s+const named = phaseLine\(line, phase, now, null, left\);/);
  assert.equal(message('onboarding:buildLine.phase.starting'), 'Starting the build');
  assert.doesNotMatch(CODE, /'onboarding:firstSession\.made\.firstLook\.(stage|building|drawing)/, 'no stage words of its own');
});

test('the first look is the picture tour step 9 and the App tab show, and it is picked up when it comes', () => {
  assert.match(CODE, /import \{ FIRST_LOOK_POLL_MS, firstLookSrc \} from '\.\/first-look';/);
  // From the screen's own read of the project, past the service worker's cache.
  assert.match(CODE, /const found = firstLookSrc\(body, made\.slug\);\s+if \(found\) setLook\(found\);/);
  // One that will not load counts as none until another comes.
  assert.match(CODE, /const lookShown = look && look !== brokenLook \? look : null;/);
  // Asked for as often as tour step 9 asks while there is none, or only its
  // drawn screen (15 Oct 2026, tests/first-look-drawn.test.js).
  assert.match(CODE, /const lookWaits = firstLookHere && \(!lookShown \|\| isDrawnLook\(lookShown\)\);/);
  assert.match(CODE, /const t = window\.setInterval\(read, settingUp \|\| planComing \? READY_POLL_MS : lookWaits \? FIRST_LOOK_POLL_MS : 10000\);/);
  assert.equal(loadTsx(`${DIR}/first-look.tsx`).FIRST_LOOK_POLL_MS, 5000);
});

test('the moments are told as they were', () => {
  assert.match(CODE, /noteMoment\(made\.slug, 'made_shown', \{ entry: fromCreate \? 'create' : 'first_session' \}, \{ once: true \}\);/);
  assert.match(CODE, /const planningShown = line === 'planning';\s+useEffect\(\(\) => \{\s+if \(planningShown\) noteMoment\(made\.slug, 'planning_shown', \{\}, \{ once: true \}\);/);
  assert.match(CODE, /noteMoment\(made\.slug, 'questions_shown', \{ count: questionsShown \}, \{ once: true \}\);/);
  assert.match(CODE, /noteMoment\(made\.slug, 'submit_tapped', \{ count: answers\.length \}\);/);
  assert.match(CODE, /if \(inviteShown\) noteMoment\(made\.slug, 'invite_shown', askedHere \? \{ how: 'after_questions' \} : \{\}, \{ once: true \}\);/);
});
