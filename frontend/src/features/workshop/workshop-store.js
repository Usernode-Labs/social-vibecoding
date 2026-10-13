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
 * @property {'status'|'needs'} tab  The list, or the Needs you page its top
 *   row opens (#3051 made these two tabs; they are one page and its door now).
 * @property {Array<object>|null} feed  GET /api/workshop/needs-feed: every
 *   decision owed by the viewer across their projects, newest first, which
 *   the Needs you tab draws as one feed (#3270). Null until it answers.
 * @property {boolean} feedError  That read failed; the tab says so.
 * @property {boolean} feedCapped  The read stopped at its bound.
 */

/**
 * `tab: 'status'` is the prerender too: the list showing, the Needs you page
 * `hidden`. The All chip opens "Your communities" (./community-switcher.tsx),
 * whose open flag is ./community-scope.ts's.
 *
 * @type {WorkshopState}
 */
const INITIAL = {
  open: false,
  rows: null,
  error: false,
  tab: 'status',
  feed: null,
  feedError: false,
  feedCapped: false,
};

export const workshopStore = createStore(INITIAL);
