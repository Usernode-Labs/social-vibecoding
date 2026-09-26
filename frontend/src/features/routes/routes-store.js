/**
 * The Routes screen's state (#routes).
 *
 * A plain store rather than component state, for the same reason the
 * Workshop and Messages screens have one: the screen is entered by the
 * legacy router (`App.navigateToRoutes`, public/js/app.js), which is a
 * classic script and cannot import from this bundle. It reaches the
 * controller in ./index.tsx by name through `window.UsernodeReact.routes`,
 * and that controller writes here.
 *
 * ── The initial value IS the prerender ─────────────────────────────────
 *
 * `open: false` with `runs: null` renders the screen exactly as the shipped
 * document has it: `hidden`, with an empty list and no rows. Nothing is
 * fetched during render — the load runs from the controller's `open()` — so
 * the prerender pass and the first client render agree and hydration is
 * silent. A console error on any route fails proposal checks, which is what
 * makes that a rule rather than a preference.
 *
 * `runs: null` and `runs: []` are different states and both are drawn: null
 * is "the list has not answered yet" (skeletons), `[]` is "you have no
 * runs" (the empty card).
 *
 * ── The recorder is state too ──────────────────────────────────────────
 *
 * A run in progress is `recording: true` plus the two live numbers the
 * screen ticks: `elapsed` seconds and `liveMeters`. They are written by the
 * controller's one-second tick and by each location fix, never by a render.
 * `locationState` is the honest degradation: 'unknown' before we have
 * asked, 'on' once a fix has arrived, 'off' once the browser or the shell
 * has told us we will not get one. 'off' is a state the screen DRAWS (a
 * note under the button), never one it hides the recorder behind.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} RunRow
 * @property {number} id
 * @property {string} started_at
 * @property {string|null} finished_at
 * @property {number|null} duration_seconds
 * @property {number|null} distance_meters
 * @property {number} point_count
 * @property {boolean} has_location
 * @property {string} [label]  A ?demo=1 fixture's name; real rows have none.
 */

/**
 * @typedef {object} RoutePoint
 * @property {number} seq
 * @property {number} lat
 * @property {number} lng
 * @property {string} recorded_at
 * @property {number|null} accuracy_m
 */

/**
 * @typedef {'unknown'|'on'|'off'} LocationState
 */

/**
 * @typedef {object} RoutesState
 * @property {boolean} open        The router has this screen on show.
 * @property {RunRow[]|null} runs  Null until the first load answers.
 * @property {boolean} error       The load failed; the screen offers a retry.
 * @property {boolean} demo        The rows came from the ?demo=1 fixtures.
 * @property {boolean} recording   A run is in progress.
 * @property {number|null} runId   The open run's id while recording.
 * @property {number} elapsed      Seconds since Start run, ticked by the controller.
 * @property {number} liveMeters   The client's own running total, for the ticker.
 * @property {LocationState} locationState  See the header.
 * @property {boolean} saving      Finish run is in flight.
 * @property {string|null} notice   A line to show under the button, or null.
 * @property {number|null} detailId  The run whose page is open, or null for the list.
 * @property {RunRow|null} detail   That run, once it has answered.
 * @property {RoutePoint[]|null} detailPoints  Its trace; null until it answers.
 * @property {boolean} detailError  That read failed.
 * @property {boolean} detailLoading  That read is in flight.
 */

/**
 * @type {RoutesState}
 */
const INITIAL = {
  open: false,
  runs: null,
  error: false,
  demo: false,
  recording: false,
  runId: null,
  elapsed: 0,
  liveMeters: 0,
  locationState: 'unknown',
  saving: false,
  notice: null,
  detailId: null,
  detail: null,
  detailPoints: null,
  detailError: false,
  detailLoading: false,
};

export const routesStore = createStore(INITIAL);
