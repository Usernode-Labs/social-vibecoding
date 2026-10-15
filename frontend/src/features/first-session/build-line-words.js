// The build line's words (#4053, ./build-line.tsx), once, for every screen
// that says them: the thumbnail, the hub card and, shorter, the Home tile.
// Plain JavaScript with no import, so home.js reads it as it reads its other
// stores, and the tests that run home.js as a classic script
// (tests/helpers/home-modules.js) run it too.
//
// The table holds message ids (frontend/locales/en/onboarding.json), read
// when a line is drawn so the words follow the language on screen:
// `PlatformI18n.t(BUILD_LINE_WORDS[state])` in a classic script, the
// component's `t` in React. In English they read (a Home tile says the
// short set, BUILD_LINE_TILE_WORDS below):
//
//   planning     Homeroom bot is planning it          steps 1 to 3, everyone
//   plan         Your plan is ready to review         its plan waits, for the person who started it
//   plan-member  Planning it                          the same, for everyone else
//   question     Homeroom bot has a question for you  it asked the person who started it
//   building     Building it                          step 4
//   testing      Testing it                           step 5
//   ready        Ready to try                         step 6
//   live         Live                                 step 7

export const BUILD_LINE_WORDS = Object.freeze({
  planning: 'onboarding:buildLine.planning',
  plan: 'onboarding:buildLine.plan',
  'plan-member': 'onboarding:buildLine.planMember',
  question: 'onboarding:buildLine.question',
  building: 'onboarding:buildLine.building',
  testing: 'onboarding:buildLine.testing',
  ready: 'onboarding:buildLine.ready',
  live: 'onboarding:buildLine.live',
});

/** The line in an answer (`first_version_line`), or null for none or one this shell does not know. */
export function buildLineTileOf(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUILD_LINE_WORDS, value)
    ? value : null;
}

/**
 * A Home tile's caption for the line, short enough for its one 11px line
 * (`.app-card-status`): Planning, Plan ready, Question, Building, Testing,
 * Ready to try, Live. Run four (13 Oct 2026): the build line's own words
 * ran to two lines and were cut off on a phone ("Homeroom bot is...",
 * "Your plan is ready to..."), so the tile says a short set, and the screens
 * with room (the thumbnail, the hub card) keep the whole phrases above.
 * Message ids, as BUILD_LINE_WORDS holds; one per state, in its order.
 */
export const BUILD_LINE_TILE_WORDS = Object.freeze({
  planning: 'onboarding:buildLine.tile.planning',
  plan: 'onboarding:buildLine.tile.plan',
  'plan-member': 'onboarding:buildLine.tile.planMember',
  question: 'onboarding:buildLine.tile.question',
  building: 'onboarding:buildLine.tile.building',
  testing: 'onboarding:buildLine.tile.testing',
  ready: 'onboarding:buildLine.tile.ready',
  live: 'onboarding:buildLine.tile.live',
});

/**
 * The caption's class (in place of the red "Spinning up..."): blue when the
 * line waits on the reader (its plan, or a question), else quiet grey, every
 * stage under way included (run six: blue is for something to act on, and a
 * build going on by itself asks nothing). One line, so the project's name
 * keeps its two (app.css, the --home-cell-h derivation: a two-line name and
 * one caption line fill the tile's 38px), and a longer translation ends in
 * an ellipsis rather than painting over the tile below.
 */
export function buildLineTileClass(state) {
  return state === 'plan' || state === 'question'
    ? 'app-card-status line-clamp-1 font-semibold text-[color:var(--accent)]'
    : 'app-card-status line-clamp-1 text-zinc-500 dark:text-zinc-400';
}

/*
 * N4 (newcomer run four, 12-13 Oct 2026): every stage of a first version's
 * build named for what is happening (`first_version.phase`,
 * services/homeroom-bot-progress.js firstVersionPhase), said in place of
 * "Building it" while the line is `building`, with how long that stage has
 * run ("Building it · 2 min so far"). In English:
 *
 *   starting   Starting the build
 *   drawing    Working out the details
 *   writing    Working out the details
 *   building   Building it
 *   built      Built. Checking the screens…
 *   checking   Checking the screens · round 1 of 2
 *   testing    Testing it
 *
 * Run seven (14 Oct 2026, iPhone Safari, Club Votes): the plan and the
 * first look are both made at Make it now, so while the spec ran the line
 * said "Drawing the screens" beside a screen already drawn, then "Writing
 * the plan" under a "Plan written" step already ticked. The spec's two
 * phases say one thing, "Working out the details", which is what it is
 * doing, and the Home tile says "Planning" for both.
 */
export const PHASE_WORDS = Object.freeze({
  starting: 'onboarding:buildLine.phase.starting',
  drawing: 'onboarding:buildLine.phase.details',
  writing: 'onboarding:buildLine.phase.details',
  building: 'onboarding:buildLine.building',
  built: 'onboarding:buildLine.phase.built',
  checking: 'onboarding:buildLine.phase.checking',
  testing: 'onboarding:buildLine.testing',
});

/**
 * Run five (13 Oct 2026): the Home tile says the phase too, in its short
 * word, so the tile, the hub card and the App tab name the same moment
 * (the tile said "Building" while the App tab said "Drawing the screens").
 * Message ids, one per PHASE_WORDS key. Run seven: the spec's two phases
 * are "Planning", the word the tile says while the plan is made.
 */
export const PHASE_TILE_WORDS = Object.freeze({
  starting: 'onboarding:buildLine.tile.phase.starting',
  drawing: 'onboarding:buildLine.tile.planning',
  writing: 'onboarding:buildLine.tile.planning',
  building: 'onboarding:buildLine.tile.building',
  built: 'onboarding:buildLine.tile.phase.checking',
  checking: 'onboarding:buildLine.tile.phase.checking',
  testing: 'onboarding:buildLine.tile.testing',
});

/** The phase a line is in, by key, or null: the answer's own, while the line says it is being built. */
export function phaseKeyOf(line, value) {
  const phase = line === 'building' ? phaseOf(value) : null;
  return phase ? phase.key : null;
}

/** A Home tile's caption for a line and its phase: a message id (BUILD_LINE_TILE_WORDS, or PHASE_TILE_WORDS while it is built). */
export function buildLineTileWordsOf(line, phase) {
  const key = phaseKeyOf(line, phase);
  return key ? PHASE_TILE_WORDS[key] : BUILD_LINE_TILE_WORDS[line];
}

/*
 * STARTED HERE (newcomer run six, 14 Oct 2026, iPhone 17 Safari). The made
 * screen's Submit starts the build, and that screen says so at once
 * ("Starting the build", ./made.tsx: answered, the line is `building`).
 * The tour's first card then stood over the project's Home tile, which said
 * "Plan ready", in blue, as if the plan still waited on them: its words came
 * from the list Home had read before Submit (GET /api/apps
 * `first_version_line`), until Home read it again a minute later and it
 * said "Drawing".
 *
 * So a Submit that went through is noted here, on this page
 * (noteBuildStarted), and the tile says what the made screen says from that
 * moment: a line still read as `plan` or `planning` is the build starting,
 * its first stage, quiet grey. The note lasts until the list names a later
 * line (the server has caught up), and at most STARTED_HOLD_MS. Kept on
 * `globalThis`, as ./tour-running.ts is, so a chunk that bundles its own
 * copy of this module reads the same notes.
 */
export const STARTED_HOLD_MS = 10 * 60 * 1000;

/** Its first stage, as the server names it before the build is picked up. */
export const STARTING_PHASE = Object.freeze({ key: 'starting', since: null, round: null, rounds: null });

const STARTED_KEY = '__usernodeFirstVersionStartedHere';

function startedNotes() {
  const g = globalThis;
  if (!(g[STARTED_KEY] instanceof Map)) g[STARTED_KEY] = new Map();
  return g[STARTED_KEY];
}

/** The made screen's Submit went through for `slug`: its build starts now. */
export function noteBuildStarted(slug, now = Date.now()) {
  if (typeof slug === 'string' && slug) startedNotes().set(slug, now);
}

/**
 * A Home tile's first version as the made screen would say it: { line,
 * phase }, the list's own, or, for a project whose Submit went through on
 * this page while the list still reads a plan, `building` from its first
 * stage. A line past the plan ends the note. Pure but for that.
 */
export function tileStageOf(slug, line, phase, now = Date.now()) {
  const notes = startedNotes();
  const at = notes.get(slug);
  if (at === undefined) return { line, phase };
  if ((line !== 'plan' && line !== 'planning') || !(now - at <= STARTED_HOLD_MS)) {
    notes.delete(slug);
    return { line, phase };
  }
  return { line: 'building', phase: STARTING_PHASE };
}

/**
 * The phase in an answer (`first_version.phase`): { key, since, round,
 * rounds } with a key this shell knows, or null.
 */
export function phaseOf(value) {
  if (!value || typeof value !== 'object') return null;
  const key = value.key;
  if (typeof key !== 'string' || !Object.prototype.hasOwnProperty.call(PHASE_WORDS, key)) return null;
  const since = typeof value.since === 'string' && !Number.isNaN(Date.parse(value.since)) ? value.since : null;
  const round = Number.isInteger(value.round) && value.round > 0 ? value.round : null;
  const rounds = Number.isInteger(value.rounds) && value.rounds > 0 ? value.rounds : null;
  return { key, since, round, rounds };
}

/** Whole minutes since `since` (an ISO time) at `now` (ms), or null for none. */
export function minutesSince(since, now) {
  const at = typeof since === 'string' ? Date.parse(since) : NaN;
  if (!Number.isFinite(at) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.floor((now - at) / 60000));
}

/*
 * The App tab's step list (N4, `first_version.steps`), its rows by key. In
 * English: Plan written, Screens drawn, Building, Checking the screens,
 * Testing, Live.
 */
export const STEP_WORDS = Object.freeze({
  plan: 'onboarding:buildLine.step.plan',
  screens: 'onboarding:buildLine.step.screens',
  build: 'onboarding:buildLine.step.build',
  check: 'onboarding:buildLine.step.check',
  test: 'onboarding:buildLine.step.test',
  live: 'onboarding:buildLine.step.live',
});

/** The steps in an answer, cleaned: [{ key, state, minutes?, since? }], skipped ones left out. */
export function stepsOf(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const s of value) {
    if (!s || typeof s !== 'object' || !Object.prototype.hasOwnProperty.call(STEP_WORDS, s.key)) continue;
    if (s.state !== 'done' && s.state !== 'now' && s.state !== 'next') continue;
    out.push({
      key: s.key,
      state: s.state,
      ...(Number.isInteger(s.minutes) && s.minutes >= 0 ? { minutes: s.minutes } : {}),
      ...(typeof s.since === 'string' && !Number.isNaN(Date.parse(s.since)) ? { since: s.since } : {}),
    });
  }
  return out;
}
