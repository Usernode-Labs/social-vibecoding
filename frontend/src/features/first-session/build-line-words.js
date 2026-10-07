// The build line (#4053, ./build-line.tsx) on a Home tile: its words, which
// line is which, and the caption's classes. Plain JavaScript with no import,
// so home.js reads it as it reads its other stores, and the tests that run
// home.js as a classic script (tests/helpers/home-modules.js) run it too.
//
// The tile's caption is one 11px line about 70px wide on a phone (app.css
// `.app-card-status`). The words that already fit stay as the thumbnail says
// them. The three long ones keep what they say: "Homeroom bot is" is dropped,
// the plan waiting for its creator is "Plan ready" and a question for them is
// "A question", both still blue. No glyph: the spinner, dot and check do not
// fit beside the words. Owner, 7 Oct 2026: a new project's tile says this in
// place of "Spinning up...".

export const BUILD_LINE_TILE_WORDS = Object.freeze({
  planning: 'Planning it',
  plan: 'Plan ready',
  'plan-member': 'Planning it',
  question: 'A question',
  building: 'Building it',
  testing: 'Testing it',
  ready: 'Ready to try',
  live: 'Live',
});

/** The line in an answer (`first_version_line`), or null for none or one this shell does not know. */
export function buildLineTileOf(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUILD_LINE_TILE_WORDS, value)
    ? value : null;
}

/** The caption's classes: blue when the line waits on the reader, else quiet, as on the thumbnail. */
export function buildLineTileClass(state) {
  return state === 'plan' || state === 'question'
    ? 'app-card-status truncate font-semibold text-[color:var(--accent)]'
    : 'app-card-status truncate text-zinc-500 dark:text-zinc-400';
}
