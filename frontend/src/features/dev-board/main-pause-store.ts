/**
 * The Dev board's "merges are paused" banner, as a view model.
 *
 * services/main-watch.js runs the repo's unit suite on every merge commit;
 * a red one pauses the app's merges until a fix lands or an admin resumes
 * them. That is the APP's state, and for one afternoon it lived only inside
 * each card's collapsed requirements ledger while the cards' pills kept
 * reading "Passed, merging shortly" — nothing on the board said why nothing
 * was merging, and the admin who could have resumed them found the button
 * by accident. The banner is the fix: one sentence at the top of the card
 * list, for everyone, naming the test and — for an admin — carrying the
 * verb.
 *
 * Published by `AppView._renderMainPauseNotice` from the promoted list's
 * `mainCheck` block (routes/votes.js), the same load that feeds the locked
 * banner beside it.
 */

import { createStore } from '../../lib/plain-store.js';

export interface MainPauseState {
  /** The app's merges are paused by a red main. */
  paused: boolean;
  /** The red is a first failure being re-run once before it counts. */
  confirming: boolean;
  /** The red merge commit, abbreviated. */
  sha: string | null;
  /** The first failing test's name, when the run named one. */
  failingTest: string | null;
  /** The viewer may resume merges (full admin, not read-only). */
  canResume: boolean;
  /** The app the banner is about, for the resume call. */
  slug: string | null;
}

export const mainPauseStore = createStore<MainPauseState>({
  paused: false, confirming: false, sha: null, failingTest: null, canResume: false, slug: null,
});

/** The banner's sentence — one spelling, for the frame and its tests. */
export function mainPauseText(s: Pick<MainPauseState, 'confirming' | 'sha' | 'failingTest'>): string {
  const since = s.sha ? ` since ${s.sha}` : '';
  const test = s.failingTest ? `: ${s.failingTest}` : '';
  if (s.confirming) {
    return `Main’s unit suite failed once${since}${test}. Re-running to confirm. Merges are paused meanwhile, `
      + 'except for proposals already level with main whose own checks passed.';
  }
  return `Merges are paused: main’s unit suite is failing${since}${test}. They resume when a fix lands `
    + 'or an admin resumes them; a proposal already level with main whose own checks passed still merges.';
}
