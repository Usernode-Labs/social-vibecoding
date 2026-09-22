/**
 * The top-level Workshop screen's state.
 *
 * A plain store rather than component state for the same reason Browse and
 * Messages have one: the screen is entered by the legacy router
 * (`App.navigateToWorkshop`, public/js/app.js), which is a classic script and
 * cannot import from this bundle. It reaches the controller in ./index.tsx by
 * name through `window.UsernodeReact.workshop`, and that controller writes
 * here.
 *
 * ── The initial value IS the prerender ─────────────────────────────────
 *
 * `open: false` with `rows: null` renders the screen exactly as the shipped
 * document has it: `hidden`, with an empty list and no rows. Nothing is
 * fetched during render — the load runs from the controller's `open()` — so
 * the SSG pass and the first client render agree and hydration is silent. A
 * console error on any route fails proposal checks, which is what makes that
 * a rule rather than a preference.
 *
 * `rows: null` and `rows: []` are different states and both are drawn:
 * null is "the list has not answered yet" (skeletons), `[]` is "you have no
 * apps" (the empty card). An empty list and an unloaded one looking identical
 * is the bug the Board's own `loading` flag exists to prevent.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} WorkshopRow
 * @property {string} slug
 * @property {string} [name]
 * @property {string|null} [icon_url]
 * @property {string|null} [icon_emoji]
 * @property {number} working  Items in that app's "What you are working on".
 * @property {number} needs    Votes owed in that app's "Needs you" queue.
 */

/**
 * @typedef {'status'|'needs'|'all'} WorkshopTab
 *
 * THE SAME THREE WORDS THE APP'S OWN WORKSHOP USES, one level up (#2718).
 * features/dev-board/workshop/workshop.tsx opens on "Current status" with
 * "Needs you" and "All items" beside it, and those three answer the question
 * for ONE app; this screen answers them across every app you have. Reusing
 * the words rather than inventing a second set is the whole of why the two
 * screens read as one place at two scopes: you pick a tab here, pick an app,
 * and land on the same tab there.
 */

/**
 * @typedef {object} WorkshopState
 * @property {boolean} open   The router has this screen on show.
 * @property {WorkshopRow[]|null} rows  Null until the first load answers.
 * @property {boolean} error The load failed; the screen offers a retry.
 * @property {WorkshopTab} tab  Which of the three is showing.
 * @property {null|'scope'|'change'|'issue'} picker  Which in-screen panel is
 *   expanded, or null for none. It is one field rather than three booleans
 *   because exactly one can be open: the scope chip's app list, and the two
 *   the plus offers, all occupy the same place on the screen and opening one
 *   has to close the others.
 */

/** @type {WorkshopState} */
const INITIAL = {
  open: false,
  rows: null,
  error: false,
  // 'status' is where the app's own Workshop opens, so this does too: the
  // question people arrive with is "what is in flight", and "all items" is
  // what you widen to once you have answered it.
  tab: 'status',
  picker: null,
};

export const workshopStore = createStore(INITIAL);
