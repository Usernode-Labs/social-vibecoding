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
 * @typedef {object} WorkshopState
 * @property {boolean} open   The router has this screen on show.
 * @property {WorkshopRow[]|null} rows  Null until the first load answers.
 * @property {boolean} error The load failed; the screen offers a retry.
 * @property {null|'scope'} picker  Whether the scope chip's app list is
 *   expanded. It was one field with three values rather than three booleans,
 *   because the chip's list and the two panels the plus offered all occupied
 *   the same place and opening one had to close the others; the plus is
 *   retired from this screen (#2718 review), so one value is left and the
 *   field is now a two-state thing that kept its shape.
 */

/** @type {WorkshopState} */
const INITIAL = {
  open: false,
  rows: null,
  error: false,
  picker: null,
};

export const workshopStore = createStore(INITIAL);
