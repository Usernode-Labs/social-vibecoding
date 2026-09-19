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
 * "Discover" is capitalised because it names the section directly below the
 * launcher, which is where the sentence is pointing.
 */
export const NO_APPS_YET = 'No apps yet. Discover finds the ones you can join.';
