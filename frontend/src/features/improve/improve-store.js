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
 * lifecycle from `App.ImproveStatus.setAppOpen()`, `public/js/app-view.js`
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
 * One row in the panel's list. TWO KINDS share this shape (#1417):
 *
 *   'session'  a chat_sessions row — a real dev session with a container, a
 *              transcript and a worker. Opens its session page.
 *   'task'     an OPEN connector work order: work handed to a coding agent
 *              running on the user's own machine. It has no container, no
 *              transcript and no worker, so there is no session page to open
 *              — it points at the request it was prepared from instead.
 *
 * They are one shape because they answer one question ("what of mine is in
 * flight?"), and one list because splitting them would ask the reader to
 * know which mechanism produced their work before they can find it. `href`
 * is what keeps them honest: each kind names its own destination rather than
 * the panel inferring one from an id that means different things.
 *
 * @typedef {object} ImproveSession
 * @property {string} key         Unique across both kinds; ids are not.
 * @property {'session'|'task'} kind
 * @property {number} id
 * @property {string} appSlug
 * @property {string} appName
 * @property {string} title
 * @property {string} href        Where the row goes when clicked.
 * @property {string|null} status Display label ("Working…", "Paused"), or null.
 * @property {boolean} busy       An AI turn is in flight right now.
 * @property {number} sortAt      Recency, ms since epoch. Mixed-kind ordering.
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
 * @property {'app'|'dev'|'other'} tab
 * @property {ImproveSession[]} sessions
 * @property {ImproveSession[]} otherSessions
 * @property {boolean} loadingSessions
 * @property {boolean} sessionsLoaded
 * @property {boolean} working
 * @property {number} sessionUnread
 * @property {number} sessionDone
 * @property {'idle'|'deploying'|'stale'} versionState
 * @property {'forum'|'chat'|'sessions'|'topic'|null} subTab
 * @property {number|null} previewSessionId
 * @property {string|null} previewUrl
 * @property {boolean} previewActive
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
   * while home is on screen (#1367, published by Home.publishImproveTarget).
   */
  slug: null,
  /**
   * Which half of the open app is on screen: its App tab or its Dev area.
   *
   * Republished from `App.switchTab()` — the one place `App.currentTab` is
   * assigned — because the App/Feed/Kanban toggle (#1367) has to render which
   * one is active, and a control that reflects state needs that state to be
   * reactive. THE UI OVERHAUL deleted the `.app-mode-seg` repaint that used to
   * sit in switchTab for exactly this reason, noting "there is no control in
   * the header reflecting which tab is active any more"; there is again, so
   * the fact is published as store state rather than repainted by hand.
   *
   * #1406 added a third value, 'other': a platform screen that is neither half
   * of an app — settings, profile, messages. Those screens now keep the improve
   * button and the view selector, and none of the selector's three segments is
   * where you are, so the control has to be able to say "none of these" rather
   * than claiming the one it would otherwise default to.
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

  // ── The indicators the store carries with the panel shut ─────────────
  //
  // All of these used to be painted onto other controls by classic modules
  // that resolved a span by id and wrote `classList` / `textContent` into it.
  // Their nodes are React-owned now (<MenuIndicators/> on the hamburger —
  // see ../header/platform-header.tsx), so they are state here and the
  // component renders them — the same reason #feedback-queue-dot goes
  // through the visibility store rather than being toggled by id.
  //
  // None of them is derived from `sessions` below, deliberately: that array is
  // only loaded while the panel is OPEN, and every one of these has to be true
  // when it is shut. They come from sources that run at boot instead —
  // SessionState's live entries and the notification stream.

  /**
   * A dev session the viewer can see is mid-turn. Drives the emerald badge's
   * pulse, so "something is running" is legible without opening anything.
   * From `SessionState.anyActive()`.
   */
  working: false,
  /**
   * Unread session-related notifications — the green count on the hamburger.
   * Split out of the bell's red count by Notifications._renderBadge so the
   * two never double-count; this is that same split, published rather than
   * written into a span.
   */
  sessionUnread: 0,
  /**
   * How many of those are specifically "your session finished". Rendered as
   * `data-session-done`, which a declared check selects on to prove the badge
   * is showing for a real reason rather than merely present.
   */
  sessionDone: 0,
  /**
   * The platform version row's state, mirrored onto the hamburger's dot:
   * amber while a deploy is in flight, violet once the platform has rolled
   * past the SHA this tab loaded against.
   */
  versionState: 'idle',
  /**
   * Which dev sub-view is on screen ('forum' | 'chat' | 'sessions' | 'topic'),
   * or null off the Dev half. Republished with `tab` from App.switchTab —
   * the header's eye needs to know whether it is looking at a SESSION.
   */
  subTab: null,
  /**
   * The open session's staging PREVIEW, or null when there is none.
   *
   * The header's eye is the preview affordance on a session screen — the
   * same eye glyph the cards use (AppView.PREVIEW_EYE_SVG, gated on
   * `staging_url`) — so it only renders when there is something to preview.
   * Published by DevChat._publishPreview() at every point the open session
   * or its staging_url changes.
   */
  previewSessionId: null,
  previewUrl: null,
  /**
   * True while a staging preview is actually ON SCREEN — the "seeing" half
   * of the board's doing↔seeing loop. Set by AppView.ensureStaging (the one
   * funnel every preview open goes through, #439) and cleared by
   * AppView.closeStagingOverlay. Distinct from previewUrl, which says a
   * preview EXISTS; this says the viewer is looking at it — it drives the
   * eye/pencil pair's active state and the session strip's Preview chip.
   */
  previewActive: false,
};

export const improveStore = createStore(INITIAL);
