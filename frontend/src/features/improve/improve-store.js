/**
 * The Improve panel's rendered state.
 *
 * The panel replaced the header's App/Dev segmented switch: an app is now just
 * an app, and everything you can do *to* it — file feedback, open a session,
 * reach the board, read the activity feed, get at the repo — lives behind one
 * button. That makes this store the single description of "what can I do to the
 * thing currently on screen", and the panel a pure function of it.
 *
 * ── Why a plain store and not React state ──────────────────────────────
 *
 * Every writer is a classic script. `public/js/app.js` publishes the app
 * lifecycle from `App.DrawerStatus.setAppOpen()`, `public/js/app-view.js`
 * publishes the repo/version/read-only facts once `/api/apps/:slug` resolves,
 * and `frontend/src/features/dev-console/store.ts` publishes whether the
 * terminal row is worth showing. None of them can import from this bundle, so
 * they go through `window.Improve` (./improve-controller.js) and land here.
 *
 * The PANEL itself is fully React-owned — nothing in `public/js/**` writes a
 * node inside it — which is what lets it hold state at all (AGENTS.md's
 * stateful-island rule). This store is that state.
 *
 * ── The initial value is the prerender ─────────────────────────────────
 *
 * `frontend/scripts/build-shell.mjs` renders the island in Node from exactly
 * these values, so they have to describe the CLOSED, EMPTY panel: no target, no
 * sessions, nothing loaded. Anything that fetches does so from an effect or a
 * controller call, never from render — a first render that disagrees with the
 * prerendered document is a hydration mismatch, and a console error on any
 * route fails proposal checks.
 */

import { createStore } from '../../lib/plain-store.js';

/**
 * @typedef {object} ImproveSession
 * @property {number} id
 * @property {string} appSlug
 * @property {string} appName
 * @property {string} title
 * @property {string|null} status  Display label ("Working…", "Paused"), or null.
 * @property {boolean} busy        An AI turn is in flight right now.
 */

/**
 * @typedef {object} ImproveState
 * @property {boolean} open
 * @property {'app'|'platform'|null} target
 * @property {string|null} slug
 * @property {string} name
 * @property {boolean} selfHosted
 * @property {string|null} repoUrl
 * @property {string|null} version
 * @property {boolean} deploying
 * @property {boolean} readOnly
 * @property {boolean} showTerminal
 * @property {boolean} canShare
 * @property {'app'|'dev'} tab
 * @property {ImproveSession[]} sessions
 * @property {ImproveSession[]} otherSessions
 * @property {boolean} loadingSessions
 * @property {boolean} sessionsLoaded
 */

/** @type {ImproveState} */
const INITIAL = {
  /** Whether the panel is presented. `hidden` on the root is derived from it. */
  open: false,
  /**
   * What the panel is ABOUT.
   *
   * `null` means there is nothing improvable on screen and the header button is
   * hidden; the panel can never be opened in that state.
   */
  target: null,
  /**
   * The target's slug — the open app's, or the platform's own self-hosted row
   * while home is on screen (#1363, published by Home.publishImproveTarget).
   */
  slug: null,
  /**
   * Which half of the open app is on screen: its App tab or its Dev area.
   *
   * Republished from `App.switchTab()` — the one place `App.currentTab` is
   * assigned — because the App/Feed/Kanban toggle (#1363) has to render which
   * one is active, and a control that reflects state needs that state to be
   * reactive. THE UI OVERHAUL deleted the `.app-mode-seg` repaint that used to
   * sit in switchTab for exactly this reason, noting "there is no control in
   * the header reflecting which tab is active any more"; there is again, so
   * the fact is published as store state rather than repainted by hand.
   *
   * 'app' in the initial value because that is `App.currentTab`'s own initial
   * value, so the prerender and the first client render agree.
   */
  tab: 'app',
  /** Display name for the header line. */
  name: '',
  /** True when the target is the platform's own self-hosted row. */
  selfHosted: false,
  /** `appData.repo_url`, or null — gates the "View on GitHub" row. */
  repoUrl: null,
  /** Short commit sha for the version row, or null while unknown. */
  version: null,
  /** Whether a deploy is in flight for the target — renders as a pill. */
  deploying: false,
  /** `AppView.readOnly` — hides the two write actions for a non-collaborator. */
  readOnly: false,
  /** Whether the developer terminal is meaningful right now (an iframe is up). */
  showTerminal: false,
  /** Whether the target is running and has a URL, i.e. whether Share works. */
  canShare: false,
  /** Active sessions belonging to `slug`. */
  sessions: [],
  /** Active sessions on every OTHER app — the overflow area. */
  otherSessions: [],
  /** True while /api/me/active-sessions is in flight for the first time. */
  loadingSessions: false,
  /** True once a session load has resolved at least once. */
  sessionsLoaded: false,
};

export const improveStore = createStore(INITIAL);
