// The build line's words (#4053, ./build-line.tsx), once, for every screen
// that says them: the thumbnail, the hub card and the Home tile. Plain
// JavaScript with no import, so home.js reads it as it reads its other
// stores, and the tests that run home.js as a classic script
// (tests/helpers/home-modules.js) run it too.
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
  planning: 'Homeroom bot is planning it',
  plan: 'Your plan is ready to review',
  'plan-member': 'Planning it',
  question: 'Homeroom bot has a question for you',
  building: 'Building it',
  testing: 'Testing it',
  ready: 'Ready to try',
  live: 'Live',
});

/** The line in an answer (`first_version_line`), or null for none or one this shell does not know. */
export function buildLineTileOf(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BUILD_LINE_WORDS, value)
    ? value : null;
}

/**
 * A Home tile's caption for the line (`.app-card-status`, in place of its
 * red "Spinning up..."): the same words, blue when the line waits on the
 * reader, else quiet. Owner, 7 Oct 2026: the tile says the build line's own
 * words, not a shorter set. They take two caption lines (12px each), so the
 * project's name takes one (BUILD_LINE_TILE_CARD): together they fill the
 * same 38px the two-line name and one-line caption do (app.css, the
 * --home-cell-h derivation), and the row stays its height.
 */
export function buildLineTileClass(state) {
  return state === 'plan' || state === 'question'
    ? 'app-card-status line-clamp-2 font-semibold text-[color:var(--accent)]'
    : 'app-card-status line-clamp-2 text-zinc-500 dark:text-zinc-400';
}

/** On the tile itself while it shows a build line: its name on one line. */
export const BUILD_LINE_TILE_CARD = '[&_.app-card-title]:line-clamp-1 [&_.app-card-title]:min-h-0';
