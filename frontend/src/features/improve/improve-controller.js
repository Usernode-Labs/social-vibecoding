/**
 * The Improve feature's controller: the seam between the classic scripts and
 * the React islands that draw what Improve offers.
 *
 * ── What replaced what ─────────────────────────────────────────────────
 *
 * The header used to carry an App/Dev segmented switch, a feedback button and
 * a work cog. All three are gone. An app renders as an app, and the second
 * mode — everything you do *to* the app rather than *with* it — became a
 * panel this file presented, which is why it absorbed three retired places:
 *
 *   * `App.ImproveStatus.setAppOpen()`'s show/hide of `#app-mode-switch`
 *     becomes `Improve.setTarget()`, which publishes what Improve is ABOUT
 *     (and therefore whether its controls have a subject at all);
 *   * the drawer's `#drawer-row-github` / `#drawer-row-share` / version rows
 *     become fields on the store;
 *   * `WorkDrawer`'s cross-app session list becomes the two session sections,
 *     this app's and everything else.
 *
 * ── And then the panel itself went (#2718 review) ──────────────────────
 *
 * Each of those three found a surface of its own, which is what left the
 * panel holding two buttons: the sessions are the Workshop's and the
 * notifications sheet's Agents tab, the reference rows are the app menu's
 * About pane, and the two actions plus the build notice are rows of that same
 * menu (../app-context/, ./actions.tsx). A drawer you open to press a button
 * is a tap to reach a tap, so it retired and this file stopped owning a
 * presentation: `open`, `close`, `toggle` and `dismissForNav` are names every
 * caller already says, forwarded to the controller that owns the surface.
 *
 * ── Why the store and not the DOM ──────────────────────────────────────
 *
 * Everything below writes `improveStore` and never a node in anyone's markup.
 * Those subtrees are React-owned, so a `getElementById` write in here would be
 * exactly the two-owners conflict the migration exists to prevent — and with
 * the panel gone there is no root left for this file to adopt either, which is
 * why the kit-surface call its header used to describe is no longer here.
 */

import { iconViewFor } from '../apps/app-card.js';
// Presentation state for the ONE surface that still lists these sessions —
// the notifications sheet's Agents tab. A leaf module holding a single
// boolean, so reading it here adds no cycle; ../notifications/ already
// imports improveStore the other way for the rows themselves.
import { notificationsSheetStore } from '../notifications/notifications-sheet-store.js';
import { boardHref, improveStore } from './improve-store.js';
import { saveShellSnapshot } from '../../lib/shell-snapshot';

/** Sessions whose state means "an AI turn is in flight right now". */
const BUSY_STATES = new Set(['running', 'starting', 'queued']);

function isBusy(session) {
  if (!session) return false;
  if (session.busy === true) return true;
  return BUSY_STATES.has(String(session.status || '').toLowerCase());
}

/**
 * Whether an AI turn is in flight for this session RIGHT NOW (#1958).
 *
 * `isBusy` above reads the flag the server wrote into the last
 * /api/me/active-sessions answer, which is true for exactly as long as that
 * answer is. `SessionState` (public/js/session-state.js) is what the server
 * has said SINCE: it pushes a `session_state` event on every real turn
 * boundary, so a turn that ended after the payload was issued is already
 * idle there — and every other surface that draws this fact (the dev
 * screen's session list, the board's cards) reads it through the store.
 * This row was the one that did not, so its pill went Working → Ready one
 * refetch round trip after the turn ended, and a panel opened later painted
 * the flag a fetch during the turn had left behind until the open-time
 * refetch landed. A live entry wins; the payload's flag is the fallback for
 * a session the store has never heard of.
 */
function liveBusy(session) {
  const fallback = isBusy(session);
  const live = typeof window !== 'undefined' ? window.SessionState : null;
  if (!live || typeof live.isBusy !== 'function') return fallback;
  return !!live.isBusy(session.id, fallback);
}

/**
 * Whether the session is WAITING ON THE USER (#1959) — the one fact behind
 * both the caption's "Needs you" and the pill's "Ready for your input", so
 * the two cannot say different things.
 *
 * `awaiting_input` is the verdict GET /api/me/active-sessions reaches from
 * the transcript (sessionAwaitsInput in routes/sessions.js): the last
 * conversational row is the assistant's, and it either asked with answer
 * chips or closed a spec whose Questions section is still open. A finished
 * spec with nothing to answer, or a finished build, is plain Ready — the
 * pill says "for your input" only when something in the session is asking.
 *
 * The two status values are the seam #1417 left for a connector agent's
 * notify_awaiting_input. Nothing publishes them into this payload yet; they
 * stay so a row that does arrive in that state reads right.
 *
 * A turn in flight is never waiting on anyone. The live store wins here for
 * the same reason it wins for `busy` (#1958): the payload is a snapshot, and
 * a push that starts a turn must take "Needs you" down in the same frame it
 * puts the spinner up.
 */
function awaitsInput(session) {
  if (!session || liveBusy(session)) return false;
  if (session.awaiting_input === true) return true;
  const state = String(session.status || '').toLowerCase();
  return state === 'awaiting_input' || state === 'needs_input';
}

/**
 * A PARKED session (owner review).
 *
 * "Changes in progress" and "Changes in other apps" are lists of what is
 * MOVING. A paused session is not in progress — it is set down — and listing
 * it under that heading both overstates the list and pushes the rows that are
 * actually running further from the thumb. Paused work stays reachable where
 * parked work belongs: the Board, and the session's own screen.
 */
function isParked(session) {
  return String((session && session.status) || '').toLowerCase() === 'paused';
}

/**
 * A session row's display status.
 *
 * Deliberately the same three words the cog drawer used, so a viewer who knew
 * that surface reads this one without relearning it.
 */
function statusLabel(session) {
  if (isBusy(session)) return 'Working…';
  const state = String(session.status || '').toLowerCase();
  if (state === 'paused') return 'Paused';
  if (awaitsInput(session)) return 'Needs you';
  return null;
}

/** ms since epoch, or 0 for anything unparseable — never NaN into a sort. */
function timeOf(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * The app's artwork for a row's leading tile, in the shape AppCard already
 * publishes (image / emoji / letter). Built HERE rather than in the component
 * so the row renders facts: the two `app_icon_*` columns both list endpoints
 * now carry are a detail of the payload, and a letter derived from the app's
 * name is the fallback whichever of them is missing.
 */
function iconOf(row, appNameFallback) {
  return iconViewFor({
    icon_url: row.app_icon_url || null,
    icon_emoji: row.app_icon_emoji || null,
    name: row.app_name || appNameFallback || row.app_slug || '',
  });
}

function toRow(session, appNameFallback) {
  return {
    key: `s${session.id}`,
    kind: 'session',
    id: session.id,
    appSlug: session.app_slug || null,
    appName: session.app_name || appNameFallback || session.app_slug || '',
    icon: iconOf(session, appNameFallback),
    // THE SAME PRECEDENCE THE RETIRED WORK DRAWER USED (#971): the human
    // title a session was given, then the PR it opened, then the branch it
    // works on — a dev name is the last thing worth showing, and `id` is the
    // floor. `session.title` alone was wrong: GET /api/me/active-sessions
    // sends `session_title` / `pr_title` / `branch_name` and no `title` at
    // all, so every row in the panel read "Untitled session".
    title: session.session_title || session.pr_title || session.branch_name
      || `Session #${session.id}`,
    // A row represents the change, not just its chat. The lifecycle-aware
    // page keeps the context around the workspace and still embeds it.
    href: `#app/${session.app_slug}/dev/proposals/${session.id}`,
    status: statusLabel(session),
    busy: liveBusy(session),
    awaitingInput: awaitsInput(session),
    sortAt: timeOf(session.last_activity_at) || timeOf(session.created_at),
    // Streamlined Concept: the app-context sheet's change rows show a
    // relative time, the way the Figma board draws them.
    lastActivityAt: session.last_activity_at || session.created_at || null,
  };
}

/**
 * A row for an OPEN connector work order (#1417) — work handed to a coding
 * agent on the user's own machine, which has no chat_sessions row of its own
 * until it is shared or submitted.
 *
 * `busy` is FALSE, always, and that is a statement rather than a default: the
 * agent is running somewhere the platform cannot see, so a pulsing dot here
 * would be an invention. The status carries which agent holds it instead,
 * which is the honest thing this row does know.
 *
 * The destination is the REQUEST, not a session page. There is no transcript
 * to open, and a row that navigates to a dead end is worse than one that
 * admits what it is. A task with no request behind it (prepare_work accepts a
 * bare brief) falls back to the app's Dev board.
 */
function taskToRow(task, appNameFallback) {
  return {
    key: `t${task.id}`,
    kind: 'task',
    id: task.id,
    appSlug: task.app_slug || null,
    appName: task.app_name || appNameFallback || task.app_slug || '',
    icon: iconOf(task, appNameFallback),
    title: task.title || `Work order #${task.id}`,
    href: task.issue_number
      ? `#app/${task.app_slug}/dev/issues/${task.issue_number}`
      : `#app/${task.app_slug}/dev`,
    status: agentLabel(task.agent),
    busy: false,
    // Same reasoning as `busy`: whether the agent on the user's machine is
    // waiting on them is not something this side can see per work order.
    awaitingInput: false,
    sortAt: timeOf(task.created_at),
  };
}

/**
 * How the row names the agent holding the work. Deliberately the product
 * names a person would recognise, mapped from the three values the server
 * normalizes to — never whatever string a connector client claimed.
 */
function agentLabel(agent) {
  if (agent === 'claude-code') return 'Claude Code';
  if (agent === 'codex') return 'Codex';
  return 'Handed off';
}

const Improve = {
  /** The live kit adoption on touch, or null on desktop / before presenting. */
  _sheet: null,
  /** Guards against two overlapping session loads racing their writes. */
  _loadToken: 0,

  // ── What the panel is about ──────────────────────────────────────
  //
  // Called from App.ImproveStatus.setAppOpen() for an open app, and from
  // Home.publishImproveTarget() for the platform's own self-hosted row while
  // home is on screen (#1367). Passing null clears the target, which hides the
  // header button — every OTHER screen does that.
  //
  // Home's publisher lives in Home.render() rather than on the navigation
  // paths, and that is load-bearing: the reverted first attempt published only
  // when returning from an app, so the button appeared after backing out and
  // vanished on refresh. Both callers land here identically; only the moment
  // they fire differs.
  setTarget(target) {
    if (!target || !target.slug) {
      // Was `if (improveStore.get().open) Improve.close()`, on a flag the
      // retired panel wrote. dismissForNav asks the surface's own owner,
      // which is the only one that knows.
      Improve.dismissForNav();
      improveStore.set({
        target: null,
        slug: null,
        name: '',
        selfHosted: false,
        repoUrl: null,
        iconUrl: null,
        iconEmoji: null,
        version: null,
        deploying: false,
        appUpdateReady: false,
        readOnly: false,
        showTerminal: false,
        canShare: false,
        // Back to App.currentTab's own initial value, so the next target does
        // not inherit the last one's half.
        tab: 'app',
      });
      // Remembered for the next cold paint, so the button is drawn (or not)
      // at hydration rather than a network round trip later — see
      // lib/shell-snapshot.ts.
      saveShellSnapshot({ improveTarget: '' });
      return;
    }
    const prev = improveStore.get();
    // Changing which app the panel is about invalidates the session split, so
    // the rows are re-bucketed from whatever the last load returned rather
    // than left describing the previous app.
    const slugChanged = prev.slug !== target.slug;
    improveStore.set({
      target: target.kind === 'platform' ? 'platform' : 'app',
      slug: target.slug,
      name: target.name || '',
      selfHosted: !!target.selfHosted,
      repoUrl: target.repoUrl || null,
      iconUrl: target.iconUrl || null,
      iconEmoji: target.iconEmoji || null,
      version: target.version || null,
      deploying: !!target.deploying,
      // A build that landed for the PREVIOUS app is not this one's news.
      appUpdateReady: slugChanged ? false : !!prev.appUpdateReady,
      readOnly: !!target.readOnly,
      canShare: !!target.canShare,
      // The terminal is only meaningful while an iframe is on screen, and
      // DevConsole owns that fact — a target change alone never turns it on.
      showTerminal: slugChanged ? false : prev.showTerminal,
    });
    saveShellSnapshot({ improveTarget: target.kind === 'platform' ? 'platform' : 'app' });
    if (slugChanged) Improve._rebucket();
    Improve.prefetchSessions();
  },

  /**
   * Fill the session lists BEFORE the surface that shows them is opened.
   *
   * That surface was the Improve panel and is the notifications sheet's
   * Agents tab now (#2718 review); the reasoning is the same either way.
   * `loadSessions()` used to run only from `open()`, so the panel presented
   * with `sessionsLoaded` false — its placeholder — and the real rows arrived
   * a round trip later, on top of a sheet that had already finished animating
   * in. The list visibly snapped in under the viewer's thumb.
   *
   * The request does not depend on the surface at all: GET
   * /api/me/active-sessions is per-USER, not per-app, and `_rebucket()` is
   * what splits its answer into "this app" and "everything else". So it can
   * be made as soon as there is a target, and the sheet then opens on a list
   * that is already there instead of drawing one.
   *
   * ONCE, not per target change. A viewer moving between apps re-buckets the
   * same payload (setTarget does that above), and re-fetching per hop would
   * turn a navigation into a request for a surface nobody has opened. Later
   * freshness is `onSessionStateChanged`'s, which already reloads while that
   * sheet is open and is driven by SessionState's own tick.
   *
   * Fire-and-forget, and silent: `loadSessions` swallows its own failures and
   * only raises `loadingSessions` when nothing has ever loaded, so a preload
   * that fails leaves the list exactly as it was before this existed.
   */
  prefetchSessions() {
    if (Improve._prefetched) return;
    const state = improveStore.get();
    if (!state.slug || state.sessionsLoaded || state.loadingSessions) return;
    Improve._prefetched = true;
    try {
      Promise.resolve(Improve.loadSessions()).catch(() => {});
    } catch (err) { /* never let a preload break a target publish */ }
  },

  /** Whether the preload above has already been started this page visit. */
  _prefetched: false,

  /**
   * Publish which half of the app is on screen — the App tab or the Dev area.
   *
   * Called from `App.switchTab()`, the single place `App.currentTab` is
   * assigned. Only meaningful while there IS a target, so a switch with none
   * published is dropped rather than stored against nothing.
   */
  setTab(tab, subTab) {
    const prev = improveStore.get();
    if (!prev.slug) return;
    // #1406's 'other' value survives in the store's type but has no publisher
    // since the Streamlined Concept took platform screens back to a plain
    // title; anything unrecognised still collapses to 'app' exactly as before.
    const next = tab === 'dev' ? 'dev' : (tab === 'other' ? 'other' : 'app');
    const nextSubTab = next === 'dev' ? (subTab || 'forum') : null;
    improveStore.set({
      tab: next,
      // Which dev sub-view: the header's eye is a PREVIEW control on a
      // session and a back-to-the-app control everywhere else.
      subTab: nextSubTab,
      // And which LAYOUT the Dev screen is in, for the header's back arrow on
      // the sub-views that are reached from it. Captured on every route change
      // rather than subscribed to, because the only reader is a route that has
      // already left the board: by the time a topic publishes, the layout can
      // no longer change under it.
      boardView: Improve._boardView(),
      sessionOrigin: Improve._sessionOriginFor(prev, next, nextSubTab),
    });
  },

  /**
   * Which layout the Dev screen is in — 'kanban' or 'workshop'.
   *
   * Read through `window.AppView` rather than from the view-mode store in
   * ../dev-board/view-mode-store.ts, and the difference is a COLD DEEP LINK:
   * that store is seeded when the board frame mounts, and a link straight to
   * an issue never mounts one, so it would answer with its own default
   * instead of with this viewer's preference. `_getViewMode()` resolves the
   * `?view=` override and then the stored preference, and needs no board.
   *
   * Settled by the time this runs on a layout hop too: `restoreFromHash`
   * calls `AppView._setViewMode(boardView)` BEFORE `App.navigateToApp`, which
   * is what reaches `App.switchTab` and therefore `setTab` above.
   */
  _boardView() {
    return window.AppView?._getViewMode?.() === 'kanban' ? 'kanban' : 'workshop';
  },

  /**
   * Where a session's back arrow should point, given the route being left.
   *
   * THIS IS THE ONE PLACE WITH BOTH HALVES IN HAND. `setTab` runs before the
   * store has been updated, so `prev` is the route being left and the
   * arguments are the route being entered — and the answer is only ever
   * computed on the transition INTO a session, never re-derived afterwards.
   * Anywhere later the outgoing route is already gone.
   *
   * Three cases, in order:
   *
   *   entering a session from elsewhere  →  serialise the route being left
   *   already on a session (a hop inside it, a re-publish, a preview open)
   *                                      →  keep what we captured
   *   anywhere else                      →  null, so a stale origin cannot
   *                                         outlive the session it belonged to
   *
   * A cold deep link straight to a session yields null twice over: `setTab`
   * returns early before the slug is published, and there is no previous app
   * route to serialise. The header falls back to the Board, which is where
   * the session's own card lives.
   */
  /**
   * The captured origin, for the click path that mirrors the header's arrow.
   *
   * DevChat reads it through `window.Improve` rather than importing the
   * store: a dozen test files run dev-chat.js as a script in a `vm` context,
   * where a top-level import is a syntax error.
   */
  sessionOrigin() {
    return improveStore.get().sessionOrigin;
  },

  _sessionOriginFor(prev, next, nextSubTab) {
    const entering = next === 'dev' && nextSubTab === 'sessions';
    const first = !Improve._routed;
    Improve._routed = true;
    if (!entering) return null;
    // A DOOR THAT NAMED ITS OWN ORIGIN (#2770). A change is an agent
    // conversation, and Messages is where those live: New change and the
    // inbox's own session rows say so before they navigate, because the
    // store's `prev` cannot — it describes the last APP route, and Messages
    // is not one. Taken once, on the way in, so it cannot outlive the entry
    // it was set for.
    const named = Improve._nextSessionOrigin;
    Improve._nextSessionOrigin = null;
    if (named) return named;
    const wasSession = prev.tab === 'dev' && prev.subTab === 'sessions';
    if (wasSession) return prev.sessionOrigin;
    // A COLD DEEP LINK HAS NO PREVIOUS SCREEN, and the store cannot say so by
    // itself: its INITIAL is `tab: 'app'`, which is indistinguishable from
    // having actually been on the app tab. Reading it as one sent a shared
    // session link's back arrow to `#app/<slug>/app` — a screen this tab had
    // never shown, and on the platform's own self-hosted app one that does
    // not exist. "The last screen you were on" requires there to have been
    // one, so the first routing pass of a page load captures nothing.
    if (first) return null;
    return Improve._routeHref(prev);
  },

  /** Whether setTab has run at all in this page load. See above. */
  _routed: false,

  /**
   * The origin the NEXT session entry should record, set by a door that
   * knows it (see `_sessionOriginFor`). Null when the door said nothing.
   */
  _nextSessionOrigin: null,

  /** Called by a session row in Messages just before its anchor navigates. */
  enterSessionFrom(href) {
    Improve._nextSessionOrigin = typeof href === 'string' && href.startsWith('#') ? href : null;
  },

  /**
   * An app route as an href, or null when it does not name one.
   *
   * Deliberately NOT App._appUrl: that serialises PATHS (`/app/<slug>/board`)
   * for the address bar, and this feeds an anchor in the header, where every
   * other destination is a hash. Both forms route — `_deepLinkTarget` reads
   * either — but mixing them inside one control means a copied link differs
   * by which screen you copied it from.
   */
  _routeHref(route) {
    const slug = route.slug;
    if (!slug) return null;
    // The platform's own app has no App tab — App.switchTab coerces a request
    // for one back to the dev forum — so it can never be an origin.
    if (route.tab !== 'dev') return route.selfHosted ? null : `#app/${slug}/app`;
    if (route.subTab === 'forum' || route.subTab === 'topic') {
      // Workshop and Board are one screen in two layouts, and the layout IS
      // the route (see the alias block in app.js's restoreFromHash), so the
      // origin has to name the one that was on screen.
      return boardHref(slug, Improve._boardView());
    }
    if (route.subTab === 'chat') return `#app/${slug}/dev/chat`;
    return null;
  },

  /**
   * The open session's staging preview, or null.
   *
   * Called by DevChat._publishPreview() whenever the open session or its
   * `staging_url` changes. Gated the header's eye, back when the header had
   * a contextual slot; ../dev-chat/session-header.tsx carries that loop now.
   */
  setSessionPreview(preview) {
    improveStore.set({
      previewSessionId: (preview && preview.sessionId) || null,
      previewUrl: (preview && preview.url) || null,
      previewBuildable: !!(preview && preview.buildable),
    });
  },

  /**
   * Whether a staging preview is on screen right now — the "seeing" half of
   * the doing↔seeing loop. AppView.ensureStaging publishes true (every
   * preview open funnels through it, #439); AppView.closeStagingOverlay
   * publishes false. Drives the eye/pencil pair and the Preview chip.
   */
  setPreviewActive(on) {
    if (improveStore.get().previewActive !== !!on) {
      improveStore.set({ previewActive: !!on });
    }
  },

  /**
   * The App/Feed/Kanban toggle's first segment: back to the app itself.
   *
   * The counterpart of openDev below. It does NOT go through _withApp, which
   * always lands on Dev — this is the one destination that is the other tab.
   *
   * ── The self-hosted row goes HOME (#1386) ──────────────────────────
   *
   * The platform's own row has no per-slug iframe URL, so `switchTab('app')`
   * coerces the request to the Dev forum — which is why the segment used not to
   * be rendered for it at all. That reasoning held for the TAB and not for the
   * destination: "the app itself" is not missing for the platform, it merely is
   * not an iframe. The platform's product surface IS the home screen, and home
   * is the very screen `Home.publishImproveTarget()` publishes this target
   * from. So the segment renders there too and lands home, which closes the
   * one-way trip the toggle exists to fix.
   *
   * ── #1406 widened where this can be reached from ──────────────────
   *
   * That used to be true of exactly two states — home, and an open app —
   * because every other screen cleared the target outright and unrendered the
   * control. #1406 republishes the platform's row on settings, profile,
   * messages and the rest, so the segment is now reachable from a screen that
   * is NEITHER home nor an app.
   *
   * So "no app open" no longer means "already home", and the guard is the home
   * screen itself rather than the absence of a slug. Left as it was, this
   * would have silently done nothing from Settings — a segment rendering as
   * inactive, clicked, and no navigation.
   */
  openApp() {
    Improve.close();
    const { slug, selfHosted } = improveStore.get();
    if (!slug || !window.App) return;
    if (selfHosted) {
      // Home is where this goes, from wherever it is clicked. The only state
      // with nothing to do is being on home ALREADY, which is the state the
      // segment renders as active — and `_isScreenVisible` is what answers
      // that now, since an open app is no longer the only other possibility.
      const onHome = typeof window.App._isScreenVisible === 'function'
        ? window.App._isScreenVisible('home-screen')
        : !window.App.currentApp;
      if (!onHome) window.App.navigateHome();
      return;
    }
    if (window.App.currentApp === slug) window.App.switchTab('app');
    else window.App.navigateToApp(slug, 'app');
  },

  /** Patch fields on the CURRENT target — app-view.js calls this as data lands. */
  update(patch) {
    if (!patch || !improveStore.get().slug) return;
    const allowed = {};
    for (const key of ['name', 'repoUrl', 'iconUrl', 'iconEmoji', 'version', 'deploying', 'appUpdateReady', 'readOnly', 'canShare', 'selfHosted']) {
      if (key in patch) allowed[key] = patch[key];
    }
    improveStore.set(allowed);
  },

  /**
   * Whether the developer-terminal row is worth showing.
   *
   * Published by features/dev-console/store.ts's setButtonVisible(), which is
   * the same call that used to show and hide the header's `#dev-console-btn`.
   * The button is gone; the row it became reads the identical signal.
   */
  setTerminalAvailable(available) {
    improveStore.set({ showTerminal: !!available });
  },

  // ── Presentation ─────────────────────────────────────────────────
  //
  // THERE IS NO IMPROVE PANEL ANY MORE (#2718 review). It was a drawer you
  // opened from a row in the mark's menu to reach two buttons, a session list
  // the Workshop took earlier in this issue, and a build notice — one tap to
  // open, one to press. All three are in the menu now (../app-context/), so
  // "open Improve" and "open the menu" name the same act.
  //
  // THESE FOUR ARE NAMES, NOT STATE. Four call sites in public/js/app.js say
  // `window.Improve?.open()`, the tour drives open and close, and every row
  // that navigates dismisses its host through `dismissForNav` — so the names
  // stay and each forwards to the controller that actually owns the surface,
  // its registry entry and its dismissal promise.
  //
  // WHAT WENT WITH THE PANEL IS THE SECOND COPY OF `open`. `toggle` and
  // `dismissForNav` used to read `improveStore.open`, which nothing writes
  // any more: toggle would only ever have opened, and dismissForNav would
  // never have fired. A controller that tracks a surface it no longer
  // presents answers from a field nobody sets, which is worse than not
  // answering — so it asks the owner instead. `LEGACY_CLOSE_MS` and
  // `DISMISS_SAFETY_MS` went the same way: the transition they were timed
  // against was #improve-panel's, and that rule is gone from app.css.

  /** @returns {object|undefined} the app-context controller, where mounted. */
  _surface() {
    return (typeof window !== 'undefined' && window.AppContext) || undefined;
  },

  /**
   * Whether Improve has a subject yet.
   *
   * THE SURFACE NO LONGER ANSWERS THIS. The Improve panel refused to open
   * without a target, so "did it open" was also "is there something to act
   * on" — which is what `?shot=app-update-ready` and the rest waited on. The
   * menu opens on every route (it is the app menu, and Home needs it too), so
   * the two questions came apart and the second one needs asking directly.
   * Without it those shots fired into a surface whose rows had no app, and
   * `update()` — which no-ops without a slug — did nothing at all.
   */
  hasTarget() {
    return !!improveStore.get().slug;
  },

  toggle() {
    Improve._surface()?.toggle();
  },

  open() {
    return Improve._surface()?.open();
  },

  /**
   * Resolves once the surface is actually GONE — the kit teardown on the
   * touch path, the CSS slide's end on the desktop one, immediately when
   * nothing was open.
   *
   * That contract is why this returns a promise at all: "Share app" presents
   * a DIALOG of its own, and a dialog that fades in while its host surface is
   * still sliding out reads as two things moving at once. Every other caller
   * can keep ignoring the return value.
   */
  close() {
    return Improve._surface()?.close() ?? Promise.resolve();
  },

  /**
   * Close before a row navigates.
   *
   * On touch the surface is modal over the destination screen, so a row that
   * navigates has to take it down first. On desktop the dropdown closes too.
   */
  dismissForNav() {
    return Improve._surface()?.dismissForNav() ?? Promise.resolve();
  },

  // ── Sessions ─────────────────────────────────────────────────────

  /**
   * Split the last-loaded session list into "this app" and "everything else".
   *
   * Kept separate from the fetch so a target change re-buckets without another
   * round trip — opening Improve on app A and then on app B is one request.
   */
  _all: [],

  /**
   * The same, for OPEN connector work orders (#1417) — kept beside `_all`
   * rather than merged into it so a reload replaces each list from the field
   * that produced it, and a server that has not shipped `externalTasks` yet
   * simply contributes none.
   */
  _tasks: [],

  /**
   * Publish a session that was just created in this tab.
   *
   * DevChat owns session creation, but the Improve panel owns a separate
   * cross-app cache. Waiting for its next /active-sessions response leaves a
   * successful new session looking absent, and a preload issued before the
   * POST can arrive afterwards and erase a naive optimistic row. Invalidate
   * that older request and publish the server-created row immediately; the
   * normal load on panel open remains the authoritative follow-up.
   */
  onSessionCreated(session, appSlug) {
    if (!session || session.id == null) return;
    const existing = Improve._all.find((candidate) => (
      String(candidate.id) === String(session.id)
    ));
    const row = {
      ...(existing || {}),
      ...session,
      app_slug: session.app_slug || existing?.app_slug || appSlug || null,
    };
    if (!row.app_slug) return;

    // Any request already in flight describes the world before this POST.
    Improve._loadToken += 1;
    Improve._all = [
      row,
      ...Improve._all.filter((existing) => String(existing.id) !== String(row.id)),
    ];
    improveStore.set({ loadingSessions: false, sessionsLoaded: true });
    Improve._rebucket();
  },

  _rebucket() {
    const { slug, name } = improveStore.get();
    const mine = [];
    const others = [];
    const place = (row, rowSlug) => {
      if (slug && rowSlug === slug) mine.push(row);
      else others.push(row);
    };
    for (const session of Improve._all) {
      // Active only — see isParked. (statusLabel keeps its 'Paused' branch:
      // it is the shared vocabulary, and a caller that does not filter still
      // gets the right word.)
      if (isParked(session)) continue;
      place(toRow(session, session.app_slug === slug ? name : null), session.app_slug);
    }
    // #1417: open connector work orders go in the SAME two buckets, by the
    // same app rule. A row is a row — the panel's question is "what of mine
    // is in flight on this app", and where the agent happens to be running
    // is not a reason to make the reader look in a second place for it.
    for (const task of Improve._tasks) {
      place(taskToRow(task, task.app_slug === slug ? name : null), task.app_slug);
    }
    // Busy first, then most recently touched — the two things a viewer scanning
    // for "what is running right now" is actually looking for.
    //
    // Recency is a TIMESTAMP rather than the descending id it used to be.
    // That proxy only held while every row came from one table: a work order
    // and a session have unrelated id sequences, so comparing them would sort
    // by which table the row came from and call it time. `sortAt` is the
    // server's own last_activity_at, which is already what it orders by.
    const order = (a, b) => Number(b.busy) - Number(a.busy) || b.sortAt - a.sortAt;
    improveStore.set({
      sessions: mine.sort(order),
      otherSessions: others.sort(order),
    });
  },

  async loadSessions() {
    const token = ++Improve._loadToken;
    // #1958: stamped BEFORE the request goes out — see SessionState.seed.
    // This used to hand the seed `data.issuedAt`, a field the endpoint has
    // never sent, so every payload was stamped at ARRIVAL and an answer that
    // was in flight while a turn ended put the spinner straight back — the
    // inversion the store's own comment warns about. DevChat.loadActiveSessions
    // stamps the same call the same way.
    const issuedAt = Date.now();
    if (!improveStore.get().sessionsLoaded) improveStore.set({ loadingSessions: true });
    let sessions = [];
    let tasks = [];
    try {
      const res = await fetch(`/api/me/active-sessions${Improve._demoQS()}`);
      if (res.ok) {
        const data = await res.json();
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
        tasks = Array.isArray(data.externalTasks) ? data.externalTasks : [];
        // Seed the shared live-state store exactly as the cog drawer did, so a
        // session that finishes while the sheet is open updates in place
        // instead of going stale until the next open.
        if (window.SessionState) {
          window.SessionState.seed(sessions, issuedAt);
        }
      }
    } catch {
      // Offline or a transient failure: keep whatever the last load produced
      // rather than blanking a list the viewer is looking at.
    }
    // A newer load started while this one was in flight — its answer wins.
    if (token !== Improve._loadToken) return;
    Improve._all = sessions;
    Improve._tasks = tasks;
    improveStore.set({ loadingSessions: false, sessionsLoaded: true });
    Improve._rebucket();
  },

  /**
   * `?demo=1` passthrough for the staging fixture, matching WorkDrawer._demoQS.
   *
   * Staging starts from a copy of production with the private session tables
   * empty, so without this a reviewer opening the preview sees an empty panel
   * and cannot tell the layout from a bug.
   */
  _demoQS() {
    try {
      return new URLSearchParams(window.location.search).get('demo') === '1'
        ? '?demo=1'
        : '';
    } catch {
      return '';
    }
  },

  /**
   * Session state changed underneath us.
   *
   * Three jobs. The rows re-derive from the last payload, so their pills
   * follow the push (#1958); an open panel then reloads its list; and the
   * button's glyph tracks whether anything is running at all — the one that
   * matters with the panel SHUT. `SessionState` is synced from app.js's boot
   * path and re-ticks on its own (faster while something is in flight), so
   * this is live without the panel ever being opened — which is the whole
   * point of putting the cue on the button.
   */
  onSessionStateChanged() {
    Improve.refreshWorking();
    // #1958: the rows are re-derived from the last payload FIRST, so the
    // Working → Ready flip IS the push — one frame, no round trip — and it
    // happens with the sheet shut too, so opening it after a turn ended
    // paints Ready rather than the flag a fetch during the turn left behind.
    // The reload below (while it is open only) still refreshes what the store
    // cannot know: a title that landed at turn end, the status line, the
    // activity stamp.
    if (improveStore.get().sessionsLoaded) Improve._rebucket();
    // Only while a surface is showing them. That used to be the Improve
    // panel's own flag; the panel retired (#2718 review) and the list it held
    // is the notifications sheet's Agents tab, so this asks that sheet.
    // Without the change the gate read a field nobody writes, and the
    // reload below simply stopped happening.
    //
    // …AND WHILE MESSAGES IS (#2770). A change is an agent conversation now,
    // and Messages → Agents lists these same rows; without this their titles
    // and status lines would freeze at whatever the last load said for as
    // long as the inbox stayed open. Asked through the island's window seam
    // rather than an import, so this module keeps its three dependencies.
    if (notificationsSheetStore.get().open || Improve._messagesOnScreen()) {
      Improve.loadSessions();
    }
  },

  /** Whether the Messages screen is the one on screen. Safe before it exists. */
  _messagesOnScreen() {
    try {
      return !!window.UsernodeReact?.messages?.isOpen?.();
    } catch {
      return false;
    }
  },

  /** `SessionState.anyActive()`, as store state. Safe before it exists. */
  refreshWorking() {
    const working = !!window.SessionState?.anyActive?.();
    if (improveStore.get().working !== working) improveStore.set({ working });
  },

  // setSessionBadge is GONE (#1610). Notifications._renderBadge used to
  // publish the unread session count here so this button could render it;
  // that count is part of the bell's number now, because the bell's list is
  // the only place a session notification can be marked read. `working`
  // above is the one indicator this button still carries.

  /**
   * Where the PLATFORM's build has got to, from
   * ImproveStatus.refreshDeployDot(), which takes it from
   * App.renderPlatformVersionPill rather than from any rendered markup.
   *
   *   'deploying'   — a new build is rolling out
   *   'downloading' — it rolled out, and this tab is pulling it down
   *   'ready'       — it is cached; a reload lands on it
   *   'failed'      — it could not be pre-downloaded; a reload may need two
   *                   tries, but withholding the offer entirely is worse
   *   'idle'        — this tab is on the current build
   *
   * 'stale' was the single value that used to cover downloading, ready and
   * failed together. It is still accepted, as ready: nothing in the tree
   * publishes it any more, but it was the vocabulary of a global the shell
   * exposes, and mapping it beats a silent fall to 'idle' that would hide a
   * real update from anyone still sending it.
   */
  setVersionState(versionState) {
    const KNOWN = ['deploying', 'downloading', 'ready', 'failed'];
    const next = versionState === 'stale'
      ? 'ready'
      : (KNOWN.includes(versionState) ? versionState : 'idle');
    if (improveStore.get().versionState !== next) improveStore.set({ versionState: next });
  },

  // ── Actions ──────────────────────────────────────────────────────
  //
  // Every row closes the panel first. On touch it is a modal sheet over the
  // destination; on desktop the slide-over covers the right edge of the screen
  // the row is navigating to. Neither is somewhere to leave a surface open.

  /**
   * Put the panel's TARGET on screen, then run `then` against it.
   *
   * Improve can be opened for an app whose `/api/apps/<slug>` payload is not
   * the one `AppView` currently describes (a target published before the
   * app's own fetch settles). So the actions that need `AppView.appData`
   * navigate first and await the same promise the router awaits, rather than
   * firing at an `AppView` that is still describing the previous app (or
   * none).
   */
  async _withApp(then, opts) {
    const { slug } = improveStore.get();
    if (!slug || !window.App) return;
    const subTab = opts?.subTab || 'forum';
    const ref = opts?.ref ?? null;
    if (window.App.currentApp === slug) {
      await window.App.switchTab('dev', ref, subTab);
    } else {
      await window.App.navigateToApp(slug, 'dev', ref, subTab);
    }
    // The viewer can navigate away while the fetch above is in flight; the
    // router guards its own tail on exactly this condition, so this does too.
    if (window.App.currentApp !== slug) return;
    if (then) then();
  },

  /**
   * Open the feedback dialog.
   *
   * `fromDev: true` is the mode the Dev "+" menu's "File an issue" row uses: it
   * preselects the open app as the target (falling back to Platform for the
   * self-hosted row, or while the repo does not exist yet). That is the right
   * default here for the same reason — the panel is unambiguously about one
   * app, so the dialog should not open asking which one.
   */
  giveFeedback() {
    const { slug } = improveStore.get();
    Improve.close();
    if (!window.App?.openFeedbackModal) return;
    // Already looking at this app: the dialog can resolve its own target.
    if (window.App.currentApp === slug) {
      window.App.openFeedbackModal({ fromDev: true });
      return;
    }
    // Otherwise there is no open app for "This app" to mean, so the dialog
    // opens on its Platform default.
    window.App.openFeedbackModal();
  },

  /**
   * New change: the entry point for starting a session on desktop and touch.
   *
   * ── A NEW CHANGE IS AN AGENT CONVERSATION (#2770, #2772) ──────────────
   *
   * It went through the app's Workshop — `_withApp` opened the board, then
   * `AppView.createProposal()` hopped to the unsent-change screen — so the
   * first thing a phone showed after New change was the Workshop tab, and
   * back from the change led to the board. A change is a conversation with
   * the agent that builds, and Messages is where those are listed now, so:
   *
   *   - it goes STRAIGHT to /dev/sessions/new, the screen createProposal's
   *     plain path always ended on, with no board painted on the way;
   *   - that screen lights the Messages tab (App._syncPlatformTabs), and
   *   - its back arrow goes up to Messages, recorded here as the origin.
   *
   * Nothing is created by the click (#2241): the row appears on the first
   * send, when DevChat.createSession publishes it through
   * `onSessionCreated` — which is what puts it in Messages → Agents at once.
   * The one-shot hint is the one createProposal set on the same path.
   */
  startSession() {
    Improve.close();
    const ref = window.DevChat?.NEW_SESSION_REF || 'new';
    // THE SIDE PANEL (desktop): New change on a running app opens the unsent
    // change in a panel BESIDE the app, which keeps running
    // (frontend/src/features/side-panel/). The one-shot hint rides along to
    // the panel's own document, where the screen is drawn. Declined whenever
    // that is not the moment, and the change opens here as before.
    const { slug } = improveStore.get();
    const panel = window.UsernodeReact?.sidePanel;
    if (slug && panel?.take?.(`app/${encodeURIComponent(slug)}/dev/sessions/${ref}`,
      { proposalHint: true })) return;
    Improve._nextSessionOrigin = '#messages';
    if (window.AppView) window.AppView._proposalHint = true;
    Improve._withApp(null, { subTab: 'sessions', ref });
  },

  /**
   * New change on a NAMED app (#2778): Messages' "+" → Agent chat, once the
   * viewer has picked which app. The same destination startSession reaches —
   * `/dev/sessions/new`, lighting the Messages tab, back arrow up to
   * Messages — for an app that need not be the one Improve is pointed at.
   * Nothing is created until the first send, exactly as there.
   *
   * A later change will point this at a platform-wide agent session instead;
   * the caller does not need to know which.
   */
  async startSessionFor(slug) {
    if (!slug || !window.App) return;
    Improve.close();
    Improve._nextSessionOrigin = '#messages';
    if (window.AppView) window.AppView._proposalHint = true;
    const ref = window.DevChat?.NEW_SESSION_REF || 'new';
    if (window.App.currentApp === slug) {
      await window.App.switchTab('dev', ref, 'sessions');
    } else {
      await window.App.navigateToApp(slug, 'dev', ref, 'sessions');
    }
  },

  /**
   * Open the Dev screen on one of its two tabs.
   *
   * `mode` is a dev view mode ('feed' | 'kanban'), which is what the two
   * board tabs are. Setting it before the repaint means the board paints the
   * requested tab on its first frame rather than flashing the stored one.
   */
  openDev(mode) {
    Improve.close();
    Improve._withApp(() => {
      if (mode && window.AppView?.openDevView) window.AppView.openDevView(mode);
    });
  },

  /** The retired `#dev-console-btn`, as a row. */
  // Waits for the panel to be GONE before presenting, for the same reason
  // `share()` below does: on touch the console rides in a kit bottom sheet of
  // its own, and presenting it across this panel's exit spring puts two kit
  // surfaces on screen at once — the second one adopting its node while the
  // first is still tearing its own down. Desktop resolves immediately after
  // the slide, so the row costs nothing there. (#1967)
  openTerminal() {
    Promise.resolve(Improve.close()).then(() => {
      window.DevConsole?.show?.();
    });
  },

  /**
   * Load the build that just landed. The panel's reload row and the button's
   * arrow glyph both mean this. The offer is withdrawn as it is taken up, so
   * a reload that is slow to show the new build does not re-offer itself
   * midway: a second tap is a second reload, not a repeat of the first.
   *
   * The frame, not the tab: what is stale is the app's document, and
   * AppView.reloadAppFrame knows the two loads it takes to get past an app's
   * own shell cache.
   */
  reloadApp() {
    improveStore.set({ appUpdateReady: false });
    Promise.resolve(Improve.close())
      .then(() => Improve._showAppTab())
      .then(() => { window.AppView?.reloadAppFrame?.(); });
  },

  /**
   * Put the app itself on screen, if it is not already.
   *
   * The offer is made from every screen the panel opens over, the Dev ones
   * included — the Workshop, the board, a topic. On those the app's frame is
   * behind another surface or not mounted at all, so a reload there reloads
   * nothing the viewer can see: the panel closed, the offer was withdrawn,
   * and as far as the screen was concerned the click did nothing. Taking the
   * offer means "show me the new version", so go to the app first.
   *
   * Answers switchTab's promise so the reload waits for the destination to
   * render — renderAppTab mounts the frame and sets its src synchronously,
   * so by then reloadAppFrame has a frame to work on. A render that mounted
   * the frame fresh has already started one load and the reload adds its
   * usual two; a third load of a document the app's own cache is serving is
   * cheap, and cutting it would mean this function knowing which branch
   * renderAppTab took.
   *
   * On the app tab already: nothing, rather than a re-render.
   */
  _showAppTab() {
    const app = window.App;
    if (!app || app.currentTab === 'app' || typeof app.switchTab !== 'function') return null;
    return app.switchTab('app');
  },

  /** The retired `#drawer-row-share`, as a row. */
  // Share — a dialog of its own, so it waits for the panel to be GONE rather
  // than fading in across its exit (#977, carried over from the hamburger row
  // this replaced).
  share() {
    Promise.resolve(Improve.close()).then(() => {
      window.AppView?.openShareModal?.();
    });
  },
};

if (typeof window !== 'undefined') {
  window.Improve = Improve;
}

export { Improve };
