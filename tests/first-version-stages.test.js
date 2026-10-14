'use strict';

// N4 (newcomer run four, 12-13 October 2026): every stage of a first
// version's build named, with how long it has run.
//
// In run four the made screen, the App tab and the hub said "Building it"
// from Build it to the proposal: through the spec turn (5.5 minutes, shown
// as waiting its turn), the build, and two review rounds, during which the
// build agent's last phrase, "Adding the ballot bar", stayed up for 36
// minutes. Now the server names the stage (homeroom-bot-progress.js
// firstVersionPhase: Drawing the screens, Writing the plan, Building it,
// Built. Checking the screens…, Checking the screens · round n of m, Testing
// it) with when it began, the line says it with the time so far ("7 min so
// far"), and the App tab lists every step with its time
// (firstVersionSteps, frontend/src/features/app-frame/first-version-steps.tsx).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTsx, renderToHtml, createElement } = require('./lib/render-tsx');
const { message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const progress = require('../src/services/homeroom-bot-progress');

const T = (min) => new Date(Date.parse('2026-10-13T10:00:00Z') + min * 60000).toISOString();

test('each stage of the build by its own name, from when it began', () => {
  const phase = (stage, row = {}, extra = {}) => progress.firstVersionPhase({ stage, since: T(1) }, row, extra);
  // Waiting its turn, and its workspace starting: no spec turn yet, so
  // nothing is drawn (run five, 13 Oct 2026: "Drawing the screens" showed
  // before the build was picked up). Then the spec draws the screens first.
  assert.deepEqual(phase('build_queued', { build_waiting_at: T(1) }), { key: 'starting', since: T(1) });
  assert.deepEqual(phase('starting', { run_at: T(1) }), { key: 'starting', since: T(1) });
  assert.deepEqual(phase('planning', { build_started_at: T(2) }), { key: 'drawing', since: T(2) }, 'never "queued"');
  // Once the first look is drawn, the spec writes the rest of the plan.
  assert.deepEqual(phase('planning', { build_started_at: T(2) }, { firstLookAt: T(4) }), { key: 'writing', since: T(4) });
  assert.deepEqual(phase('building'), { key: 'building', since: T(1) });
  // The build landed: its screens are captured, then each review round.
  assert.deepEqual(phase('reviewing', { review_started_at: T(20), review_round: 0, review_max_rounds: 2 }), { key: 'built', since: T(20) });
  assert.deepEqual(phase('reviewing', { review_started_at: T(20), review_round: 2, review_max_rounds: 2 }),
    { key: 'checking', since: T(20), round: 2, rounds: 2 });
  for (const stage of ['proposing', 'checks', 'checks_failed', 'fixing']) {
    assert.equal(phase(stage, { proposal_at: T(30) }).key, 'testing', stage);
  }
  // Before the build and once it is ready, nothing to name here.
  for (const stage of ['setting_up', 'queued', 'reading', 'plan', 'question', 'vote']) assert.equal(phase(stage), null, stage);
  assert.deepEqual(progress.FIRST_VERSION_PHASES, ['starting', 'drawing', 'writing', 'building', 'built', 'checking', 'testing']);
});

test('the App tab\'s steps: done with the minutes they took, the one under way from when it began, the rest to come', () => {
  const times = { made: T(0), decided: T(1), firstLook: T(3), spec: T(6), review: T(20), proposal: T(36) };
  const shape = (steps) => steps.map((s) => [s.key, s.state, s.minutes ?? s.since ?? null]);
  assert.deepEqual(shape(progress.firstVersionSteps(null, { made: T(0) })), [
    ['plan', 'now', T(0)], ['screens', 'next', null], ['build', 'next', null], ['check', 'next', null], ['test', 'next', null], ['live', 'next', null],
  ], 'the plan, while it is written and answered');
  assert.deepEqual(shape(progress.firstVersionSteps({ key: 'drawing', since: T(2) }, { made: T(0), decided: T(1) })), [
    ['plan', 'done', 1], ['screens', 'now', T(1)], ['build', 'next', null], ['check', 'next', null], ['test', 'next', null], ['live', 'next', null],
  ]);
  assert.deepEqual(shape(progress.firstVersionSteps({ key: 'writing', since: T(3) }, { made: T(0), decided: T(1), firstLook: T(3) })), [
    ['plan', 'done', 1], ['screens', 'done', 2], ['build', 'now', T(3)], ['check', 'next', null], ['test', 'next', null], ['live', 'next', null],
  ], 'the rest of the plan is the build\'s, to its maker');
  assert.deepEqual(shape(progress.firstVersionSteps({ key: 'checking', since: T(20), round: 1, rounds: 2 }, times)).slice(0, 4), [
    ['plan', 'done', 1], ['screens', 'done', 2], ['build', 'done', 17], ['check', 'now', T(20)],
  ]);
  assert.deepEqual(shape(progress.firstVersionSteps({ key: 'testing', since: T(36) }, times)).slice(3, 5), [['check', 'done', 16], ['test', 'now', T(36)]]);
  // No review ran: its row is left out, not said to be done.
  const noReview = progress.firstVersionSteps({ key: 'testing', since: T(30) }, { ...times, review: null, proposal: T(30) });
  assert.deepEqual(noReview.find((s) => s.key === 'check'), { key: 'check', state: 'skipped' });
  assert.equal(noReview.find((s) => s.key === 'build').minutes, 27, 'the build ran until the proposal');
  // Without the first look, the screens were drawn with the spec.
  assert.equal(progress.firstVersionSteps({ key: 'building', since: T(6) }, { ...times, firstLook: null }).find((s) => s.key === 'screens').minutes, 5);
  assert.deepEqual(progress.FIRST_VERSION_STEP_KEYS, ['plan', 'screens', 'build', 'check', 'test', 'live']);
});

test('the line says the stage and the time so far; zero says nothing', () => {
  const { phaseLine, soFarNote, phaseWords } = loadTsx('frontend/src/features/first-session/build-line.tsx');
  const now = Date.parse(T(9));
  // Run seven (14 Oct 2026): the plan and the first look are made at Make
  // it, so the spec's two stages say what it does, never "Drawing the
  // screens" beside a drawn screen or "Writing the plan" under "Plan written".
  assert.deepEqual(phaseLine('building', { key: 'drawing', since: T(2) }, now), { words: 'Working out the details', note: '7 min so far' });
  assert.deepEqual(phaseLine('building', { key: 'writing', since: T(8) }, now), { words: 'Working out the details', note: '1 min so far' });
  assert.deepEqual(phaseLine('building', { key: 'building', since: T(9) }, now, 'Adding the ballot bar'), { words: 'Building it', note: 'Adding the ballot bar' });
  assert.deepEqual(phaseLine('building', { key: 'building', since: T(2) }, now, 'Adding the ballot bar'),
    { words: 'Building it', note: 'Adding the ballot bar · 7 min so far' });
  // The build's phrase goes once the build has landed (it stood for 36 minutes).
  assert.deepEqual(phaseLine('building', { key: 'built', since: T(8) }, now, 'Adding the ballot bar'), { words: 'Built. Checking the screens…', note: '1 min so far' });
  assert.deepEqual(phaseLine('building', { key: 'checking', since: T(5), round: 1, rounds: 2 }, now),
    { words: 'Checking the screens · round 1 of 2', note: '4 min so far' });
  assert.deepEqual(phaseLine('building', { key: 'testing', since: T(5) }, now), { words: 'Testing it', note: '4 min so far' });
  // Only while the line says it is being built; an unknown stage says the line's own words.
  assert.deepEqual(phaseLine('ready', { key: 'testing', since: T(5) }, now), { words: null, note: null });
  assert.deepEqual(phaseLine('building', { key: 'queued', since: T(5) }, now), { words: null, note: null });
  assert.deepEqual(phaseLine('building', null, now), { words: null, note: null });
  // Run five: the build waiting its turn, before the spec turn draws anything.
  assert.deepEqual(phaseLine('building', { key: 'starting', since: T(5) }, now), { words: 'Starting the build', note: '4 min so far' });
  assert.equal(soFarNote(T(9), now), null, 'under a minute: nothing');
  assert.equal(soFarNote(null, now), null);
  assert.equal(phaseWords(null), null);
  for (const id of ['onboarding:buildLine.phase.starting', 'onboarding:buildLine.phase.details', 'onboarding:buildLine.phase.built']) {
    assert.doesNotMatch(message(id), /queued|—/i, id);
  }
  const { PHASE_WORDS } = loadTsx('frontend/src/features/first-session/build-line.tsx');
  assert.equal(PHASE_WORDS.drawing, 'onboarding:buildLine.phase.details');
  assert.equal(PHASE_WORDS.writing, 'onboarding:buildLine.phase.details', 'one thing said for the spec');
  const catalog = JSON.parse(read('frontend/locales/en/onboarding.json'));
  assert.ok(catalog['buildLine.phase.details'].description.length > 60, 'a translator\'s description');
  for (const gone of ['buildLine.phase.drawing', 'buildLine.phase.writing', 'buildLine.tile.phase.drawing', 'buildLine.tile.phase.writing']) {
    assert.equal(catalog[gone], undefined, gone);
  }
  // BuildLine says the stage's words in place of its own.
  const { BuildLine } = loadTsx('frontend/src/features/first-session/build-line.tsx');
  const html = renderToHtml(createElement(BuildLine, { state: 'building', words: 'Drawing the screens', note: '2 min so far' }));
  assert.match(html, /data-build-line="building"/);
  assert.match(html, /<span class="truncate">Drawing the screens · 2 min so far<\/span>/);
});

test('the App tab lists the steps in the house style: small caps over the plane\'s card, rows 15 over 13, no fill on a done step', () => {
  const { FirstVersionSteps, stepNote } = loadTsx('frontend/src/features/app-frame/first-version-steps.tsx');
  const now = Date.parse(T(25));
  const steps = progress.firstVersionSteps({ key: 'checking', since: T(20), round: 1, rounds: 2 },
    { made: T(0), decided: T(0.5), firstLook: T(3), spec: T(6), review: T(20) });
  const html = renderToHtml(createElement(FirstVersionSteps, { steps, phase: { key: 'checking', since: T(20), round: 1, rounds: 2 }, caption: 'Adding the ballot bar' }));
  assert.match(html, /data-app-first-version-steps=""/);
  assert.match(html, /<h2 class="[^"]*text-xs font-bold uppercase tracking-\[0\.06em\][^"]*">How it&#x27;s going<\/h2>/);
  assert.match(html, /rounded-\[20px\][^"]*bg-\[color:var\(--dc-sheet-solid\)\]/);
  const rows = [...html.matchAll(/data-step="(\w+)" data-step-state="(\w+)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(rows, [['plan', 'done'], ['screens', 'done'], ['build', 'done'], ['check', 'now'], ['test', 'next'], ['live', 'next']]);
  for (const words of ['Plan written', 'Screens drawn', 'Building', 'Checking the screens', 'Testing', 'Live']) assert.match(html, new RegExp(`>${words}<`));
  assert.match(html, /text-\[0\.9375rem\] font-\[650\]/, '15px titles');
  assert.match(html, /text-\[0\.8125rem\]/, '13px lines');
  assert.match(html, /aria-current="step"/);
  assert.doesNotMatch(html, /--accent|violet-/, 'no accent: nothing here asks for anything');
  // What each row says under it.
  assert.equal(stepNote({ key: 'plan', state: 'done', minutes: 0 }, now), null, 'under a minute: nothing');
  assert.equal(stepNote({ key: 'screens', state: 'done', minutes: 2 }, now), '2 min');
  assert.equal(stepNote({ key: 'check', state: 'now', since: T(20) }, now, { phase: { key: 'checking', round: 1, rounds: 2 } }), 'Round 1 of 2 · 5 min so far');
  assert.equal(stepNote({ key: 'build', state: 'now', since: T(20) }, now, { phase: { key: 'building' }, caption: 'Adding the ballot bar' }), 'Adding the ballot bar · 5 min so far');
  assert.equal(stepNote({ key: 'build', state: 'now', since: T(20) }, now, { phase: { key: 'writing' } }), 'Working out the details · 5 min so far');
  assert.equal(stepNote({ key: 'test', state: 'next' }, now), null);
  assert.equal(renderToHtml(createElement(FirstVersionSteps, { steps: [] })), '');
});

test('the server answers the stage and the steps, and the screens say them', () => {
  const route = read('src/routes/apps.js');
  assert.match(route, /\.\.\.\(state\.phase \? \{ phase: state\.phase \} : \{\}\),\s+\.\.\.\(Array\.isArray\(state\.steps\) \? \{ steps: state\.steps \} : \{\}\),/);
  const view = read('public/js/app-view.js');
  assert.match(view, /\.\.\.\(phase \? \{ phase \} : \{\}\),\s+\.\.\.\(steps \? \{ steps \} : \{\}\),/);
  const status = read('frontend/src/features/app-frame/app-status.tsx');
  assert.match(status, /const named = phaseLine\(line, phase, now, listed \? null : caption, left\);/);
  assert.match(status, /const caption = line === 'building' \? view\.buildNote \|\| null : null;/);
  assert.match(status, /\{steps \? <FirstVersionSteps steps=\{steps\} phase=\{view\.phase \|\| null\} caption=\{caption\} estimate=\{estimate\} \/> : null\}/);
  assert.match(status, /if \(waiting \|\| steps\) \{/, 'the screen scrolls with the steps under the card');
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.match(made, /const phase = fv\?\.phase \|\| \(answered && line === 'building' \? \{ key: 'starting' \} : null\);\s+const named = phaseLine\(line, phase, now, null, left\);/);
  // The stage's words come from one table (build-line-words.js), shared.
  const words = read('frontend/src/features/first-session/build-line-words.js');
  assert.match(words, /export const PHASE_WORDS = Object\.freeze\(\{/);
  assert.match(words, /export const STEP_WORDS = Object\.freeze\(\{/);
  // The line itself is unchanged: Live and the first look key on `building`.
  // 14 Oct 2026: `stopped` is said apart, never for a stage (firstVersionStopped).
  assert.deepEqual(progress.BUILD_LINE_STATES, ['planning', 'plan', 'plan-member', 'question', 'building', 'testing', 'ready', 'live', 'stopped']);
  for (const stage of ['planning', 'reviewing', 'build_queued']) assert.equal(progress.buildLineOf(stage), 'building', stage);
});

test('run five, 5: the Home tile, the hub card and the App tab name the same stage, and say "Starting the build" until the spec turn', () => {
  // Waiting its turn and starting its workspace: the screens are the step
  // under way on the App tab's list, but nothing is drawn yet.
  assert.deepEqual(progress.firstVersionSteps({ key: 'starting', since: T(1) }, { made: T(0), decided: T(1) }).map((s) => [s.key, s.state]).slice(0, 3),
    [['plan', 'done'], ['screens', 'now'], ['build', 'next']]);
  const { PHASE_TILE_WORDS, PHASE_WORDS, buildLineTileWordsOf, phaseKeyOf } = loadTsx('frontend/src/features/first-session/build-line.tsx');
  assert.deepEqual(Object.keys(PHASE_TILE_WORDS), Object.keys(PHASE_WORDS), 'a short word for every stage');
  assert.deepEqual(Object.keys(PHASE_WORDS), [...progress.FIRST_VERSION_PHASES], 'every stage the server names has its words');
  // The tile, in its short word.
  const tile = (line, phase) => message(buildLineTileWordsOf(line, phase));
  assert.equal(tile('building', null), 'Building', 'no stage named: the line\'s own short word');
  assert.equal(tile('building', { key: 'starting', since: T(1) }), 'Starting');
  // Run seven: the spec's two stages are "Planning", as the tile says while the plan is made.
  assert.equal(tile('building', { key: 'drawing', since: T(1) }), 'Planning');
  assert.equal(tile('building', { key: 'writing', since: T(1) }), 'Planning');
  assert.equal(tile('building', { key: 'building', since: T(1) }), 'Building');
  assert.equal(tile('building', { key: 'checking', since: T(1), round: 1, rounds: 2 }), 'Checking');
  assert.equal(tile('testing', null), 'Testing');
  assert.equal(tile('plan', { key: 'drawing' }), 'Plan ready', 'only while it is built');
  assert.equal(phaseKeyOf('ready', { key: 'testing' }), null);
  for (const key of Object.keys(PHASE_TILE_WORDS)) assert.ok(message(PHASE_TILE_WORDS[key]).length <= 12, key);
  assert.equal(message('onboarding:buildLine.phase.starting'), 'Starting the build');
  // Wired: the list answers each tile's stage, the tile says it, the hub card too.
  const route = read('src/routes/apps.js');
  assert.match(route, /first_version_phase: firstVersionPhases\.get\(Number\(a\.id\)\) \|\| null,/);
  assert.match(route, /if \(line && phases && state\.phase\) phases\.set\(Number\(appId\), state\.phase\);/);
  assert.match(route, /phase: state\.phase \|\| null,/);
  const home = read('frontend/src/features/home/home.js');
  assert.equal((home.match(/buildLineTileWordsOf\(buildLine, buildPhase\)/g) || []).length, 2, 'both tiles');
  // The stage is the list's, as the made screen says it (run six, tileStageOf).
  assert.match(home, /return tileStageOf\(app\.slug, buildLineTileOf\(app\.first_version_line\), app\.first_version_phase\);/);
  const hub = read('frontend/src/features/dev-board/workshop/hub-cards.tsx');
  assert.match(hub, /const named = phaseLine\(line, fv\.phase, now, null, left\);/);
  assert.match(hub, /lineWords=\{named\.words\}/);
  const { hubFirstVersion } = require('../src/routes/apps');
  assert.deepEqual(hubFirstVersion({ userId: 7, line: 'building', phase: { key: 'starting', since: T(1) } }, 7).phase, { key: 'starting', since: T(1) });
});
