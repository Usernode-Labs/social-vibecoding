/**
 * The one sentence an empty app list says (#2564).
 *
 * Two places show a viewer the set of apps they have: the app-context sheet's
 * switcher strip (../app-context/app-context-sheet.tsx) and Home's launcher
 * grid (../home/app-grid.tsx). The strip already answered an empty set in
 * words; the launcher answered it with nothing at all, so a first sign-in read
 * as a screen that had failed rather than one with nothing in it yet.
 *
 * It is a constant rather than the same string typed twice because the two
 * copies have to stay the same sentence: the point of the line is that a
 * viewer who meets it in one place recognises it in the other, and a wording
 * change that reaches only one of them quietly ends that.
 *
 * It names the two ways to have one, in the order the screen draws them:
 * the "New project" tile, which follows the note in an empty launcher
 * (../home/create-tile.tsx CREATE_TILE_LABEL, present for every account),
 * then the Discover section below the launcher. It said only "Find apps to
 * add in the Discover section." until the first-session run-through of 5
 * October 2026, where a brand-new account read it with the tile right after
 * it, and was sent past the one thing on the screen that makes an app.
 * "New project" and "Discover" are capitalised because they name what is on
 * the screen.
 */
export const NO_APPS_YET = 'No apps added yet. Make one with New project, or find one in the Discover section.';
