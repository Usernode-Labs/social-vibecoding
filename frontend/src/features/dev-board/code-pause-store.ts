/**
 * The project page's "code changes are paused" banner, as a view model.
 *
 * Since GitHub suspended the account that held Homeroom's app repositories
 * (25 Oct 2026), app code lives on Homeroom's own git host. One repository
 * stays on GitHub, the platform's own, and while GitHub is paused
 * (services/github-pause.js) nothing reaches it: a change to that project's
 * code cannot be proposed, pushed or merged from Homeroom, and the worker's
 * push and the merge each refuse with their own message. That is the
 * PROJECT's state, so the page says it once above the cards, beside the
 * merges-paused and release-stalled banners, rather than letting each change
 * fail on its own. Requests and discussions are Homeroom's own rows and carry
 * on, and the sentence says so.
 *
 * Published by `AppView._renderCodePauseNotice` from the app record
 * (GET /api/apps/:slug `codeChangesPaused`), which is true only for a
 * project on GitHub while GitHub is paused, so every other project draws
 * nothing.
 */

import { createStore } from '../../lib/plain-store.js';

export interface CodePauseState {
  /** Changes to this project's code are held while Homeroom moves off GitHub. */
  paused: boolean;
  /** The project the banner is about. */
  slug: string | null;
}

export const codePauseStore = createStore<CodePauseState>({ paused: false, slug: null });
