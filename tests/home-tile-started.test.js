// The Home tile from the moment the made screen's Submit goes through
// (frontend/src/features/first-session/build-line-words.js tileStageOf,
// frontend/src/features/home/home.js tileBuildStage).
//
// Newcomer run six (14 Oct 2026, iPhone 17 Safari, Club Votes): right after
// Submit the made screen said "Starting the build". The tour's first card
// then landed on Home, where the new project's tile read "Plan ready", in
// blue, as if something waited for them: its words were the list Home had
// read before Submit. A minute later Home read the list again and the tile
// said "Drawing". Now the tile says the made screen's stage from Submit on,
// in the tile's quiet grey, and blue is kept for what asks for them.
//
// Run with: node --test tests/home-tile-started.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { installAppCard } = require('./helpers/app-card');
const { installGridStore, installPanelsStore } = require('./helpers/home-grid-store');
const { HOME_SRC, PANELS_SRC, LAYOUT_SRC } = require('./helpers/home-modules');
const { loadTsx } = require('./lib/render-tsx');
const { englishPlatformI18n, message } = require('./lib/platform-i18n');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const WORDS = 'frontend/src/features/first-session/build-line-words.js';

function fakeElement() {
  let text = '';
  return {
    style: {},
    set textContent(v) { text = String(v); },
    get textContent() { return text; },
    get innerHTML() {
      return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
  };
}

/** home.js in a sandbox of its own, with the shipped build-line words inlined (./helpers/home-modules). */
function makeHome() {
  const sandbox = {
    console,
    App: { user: null },
    document: {
      createElement: fakeElement,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      body: { appendChild: () => {} },
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    location: { search: '', origin: 'https://sv.test' },
    URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval,
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sandbox.window = sandbox;
  sandbox.PlatformI18n = englishPlatformI18n();
  vm.createContext(sandbox);
  installAppCard(sandbox);
  installGridStore(sandbox);
  installPanelsStore(sandbox);
  vm.runInContext(`${LAYOUT_SRC}\n${HOME_SRC}\n${PANELS_SRC}\n;globalThis.__Home = Home;`, sandbox);
  return { Home: sandbox.__Home, sandbox };
}

const clubVotes = (over = {}) => ({
  slug: 'club-votes',
  name: 'Club Votes',
  status: 'running',
  locked: false,
  icon_emoji: '🗳️',
  icon_url: null,
  first_version_line: 'plan',
  first_version_phase: null,
  ...over,
});

const GREY = 'app-card-status line-clamp-1 text-zinc-500 dark:text-zinc-400';
const BLUE = 'app-card-status line-clamp-1 font-semibold text-[color:var(--accent)]';

test('run six: from Submit on, the tile says the build is starting, in grey, on both grids', () => {
  const { Home, sandbox } = makeHome();
  const app = clubVotes();
  // Before Submit the list says the plan waits for them: blue, theirs to act on.
  assert.equal(message('onboarding:buildLine.tile.plan'), 'Plan ready');
  assert.ok(Home.renderAppCard(app).includes(`<p class="${BLUE}" data-build-line="plan">Plan ready</p>`));
  assert.deepEqual([Home.appView(app).buildLine, Home.appView(app).statusLabel], ['plan', 'Plan ready']);

  // Submit went through on the made screen. Home still holds that list.
  sandbox.noteBuildStarted('club-votes');
  assert.ok(Home.renderAppCard(app).includes(`<p class="${GREY}" data-build-line="building">Starting</p>`),
    'the string tile says the made screen\'s stage, quiet');
  const view = Home.appView(app);
  assert.deepEqual([view.buildLine, view.statusLabel], ['building', 'Starting'], 'and so does the React grid\'s view');
  assert.equal(sandbox.buildLineTileClass(view.buildLine), GREY);
  // The same moment the made screen names (./made.tsx: "Starting the build").
  assert.equal(message('onboarding:buildLine.phase.starting'), 'Starting the build');
  // A list read again, still behind: the same.
  assert.equal(Home.appView(clubVotes({ first_version_line: 'planning' })).statusLabel, 'Starting');

  // The list catches up: its own stage from then on, and the note is spent.
  const drawing = clubVotes({ first_version_line: 'building', first_version_phase: { key: 'drawing', since: '2026-10-14T18:02:00Z' } });
  assert.deepEqual([Home.appView(drawing).buildLine, Home.appView(drawing).statusLabel], ['building', 'Planning']);
  // A plan that waits on them again after that (one they asked to change,
  // in the chat) is theirs to review again: blue.
  assert.deepEqual([Home.appView(app).buildLine, Home.appView(app).statusLabel], ['plan', 'Plan ready']);
});

test('only that project, only a plan, and not for long', () => {
  const { tileStageOf, noteBuildStarted, STARTED_HOLD_MS, STARTING_PHASE, buildLineTileWordsOf, buildLineTileClass } = loadTsx(WORDS);
  const at = Date.parse('2026-10-14T18:00:00Z');
  noteBuildStarted('run-six-a', at);
  // Another project's tile is its list's.
  assert.deepEqual(tileStageOf('run-six-b', 'plan', null, at), { line: 'plan', phase: null });
  // A question it asks after Submit asks for them, and stays blue.
  assert.deepEqual(tileStageOf('run-six-a', 'question', null, at + 1000), { line: 'question', phase: null });
  assert.equal(buildLineTileClass('question'), 'app-card-status line-clamp-1 font-semibold text-[color:var(--accent)]');
  // ...and it ended the note: the list said something past the plan.
  assert.deepEqual(tileStageOf('run-six-a', 'plan', null, at + 2000), { line: 'plan', phase: null });

  noteBuildStarted('run-six-c', at);
  const started = tileStageOf('run-six-c', 'planning', null, at + 5000);
  assert.deepEqual(started, { line: 'building', phase: STARTING_PHASE });
  assert.equal(message(buildLineTileWordsOf(started.line, started.phase)), 'Starting');
  assert.equal(buildLineTileClass(started.line), 'app-card-status line-clamp-1 text-zinc-500 dark:text-zinc-400');
  // A list that never catches up stops being overruled after STARTED_HOLD_MS.
  assert.equal(STARTED_HOLD_MS, 10 * 60 * 1000);
  assert.deepEqual(tileStageOf('run-six-c', 'plan', null, at + STARTED_HOLD_MS + 1), { line: 'plan', phase: null });
  assert.deepEqual(tileStageOf('run-six-c', 'plan', null, at + 1), { line: 'plan', phase: null }, 'spent');
  // Nothing noted for an empty slug.
  noteBuildStarted('', at);
  noteBuildStarted(null, at);
  assert.deepEqual(tileStageOf('', 'plan', null, at), { line: 'plan', phase: null });
});

test('the made screen notes it the moment its Submit goes through, and both tiles read it', () => {
  const made = read('frontend/src/features/first-session/made.tsx');
  assert.match(made, /import \{ noteBuildStarted \} from '\.\/build-line-words\.js';/);
  assert.match(made, /if \(!res\.ok\) throw new Error\(String\(res\.status\)\);\s+setAnswered\(true\);[\s\S]{0,200}?noteBuildStarted\(made\.slug\);/,
    'after the answers are kept, never before');
  const home = read('frontend/src/features/home/home.js');
  assert.equal((home.match(/const \{ line: buildLine, phase: buildPhase \} = Home\.tileBuildStage\(app\);/g) || []).length, 2,
    'the React grid\'s view and the string tile');
  // One copy of the notes for every chunk, as the tour's flag is kept.
  assert.match(read(WORDS), /const STARTED_KEY = '__usernodeFirstVersionStartedHere';/);
});
