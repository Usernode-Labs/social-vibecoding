/**
 * The Improve panel's controller: the seam between the classic scripts and the
 * React island, and the owner of the panel's presentation.
 *
 * ── What replaced what ─────────────────────────────────────────────────
 *
 * The header used to carry an App/Dev segmented switch, a feedback button and a
 * work cog. All three are gone. An app now renders as an app, and the second
 * mode — everything you do *to* the app rather than *with* it — is this panel.
 * That means this file absorbed responsibilities from three retired places:
 *
 *   * `App.DrawerStatus.setAppOpen()`'s show/hide of `#app-mode-switch`
 *     becomes `Improve.setTarget()`, which publishes what the panel is about
 *     (and therefore whether the header button exists at all);
 *   * the drawer's `#drawer-row-github` / `#drawer-row-share` / version rows
 *     become fields on the store, rendered inside the panel;
 *   * `WorkDrawer`'s cross-app session list becomes the panel's two session
 *     sections — this app's, and everything else in an overflow area.
 *
 * ── Presentation: bottom sheet on touch, slide-over on desktop ─────────
 *
 * The two idioms are the product requirement, not an implementation detail, and
 * they fall out of one `adoptKitSurface` call. On touch the kit presents the
 * panel element as a bottom `sheet` with its own drag-to-dismiss; on desktop
 * `gate: 'touch'` refuses and we fall through to the CSS slide-over the panel's
 * own class string draws from the right edge. This is the INVERSE of the
 * hamburger, which is a kit side `panel` on touch — deliberately: the hamburger
 * is navigation (an edge drawer at both widths reads as navigation) and this is
 * an action surface over the thing you are looking at.
 *
 * `hidden` stays ours on both paths, exactly as it does for the work drawer:
 * the kit knows nothing about it, and it is what the desktop slide-over means
 * by closed.
 *
 * ── Why the store and not the DOM ──────────────────────────────────────
 *
 * Everything below writes `improveStore` and never a node inside the panel.
 * The panel's whole subtree is React-owned, so a `getElementById` write in here
 * would be exactly the two-owners conflict the migration exists to prevent. The
 * one node this file does touch by id is `#improve-panel` itself — its `hidden`
 * class and its adoption — which is the same sanctioned pair every other
 * kit-adopted root uses.
 */

import { adoptKitSurface } from '../../lib/kit-surface';
import { improveStore } from './improve-store.js';

/** Sessions whose state means "an AI turn is in flight right now". */
const BUSY_STATES = new Set(['running', 'starting', 'queued']);

function isBusy(session) {
  if (!session) return false;
  if (session.busy === true) return true;
  return BUSY_STATES.has(String(session.status || '').toLowerCase());
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
  if (state === 'awaiting_input' || state === 'needs_input') return 'Needs you';
  return null;
}

/** ms since epoch, or 0 for anything unparseable — never NaN into a sort. */
function timeOf(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : 0;
}

function toRow(session, appNameFallback) {
  return {
    key: `s${session.id}`,
    kind: 'session',
    id: session.id,
    appSlug: session.app_slug || null,
    appName: session.app_name || appNameFallback || session.app_slug || '',
    // THE SAME PRECEDENCE THE RETIRED WORK DRAWER USED (#971): the human
    // title a session was given, then the PR it opened, then the branch it
    // works on — a dev name is the last thing worth showing, and `id` is the
    // floor. `session.title` alone was wrong: GET /api/me/active-sessions
    // sends `session_title` / `pr_title` / `branch_name` and no `title` at
    // all, so every row in the panel read "Untitled session".
    title: session.session_title || session.pr_title || session.branch_name
      || `Session #${session.id}`,
    href: `#app/${session.app_slug}/dev/sessions/${session.id}`,
    status: statusLabel(session),
    busy: isBusy(session),
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
    title: task.title || `Work order #${task.id}`,
    href: task.issue_number
      ? `#app/${task.app_slug}/dev/issues/${task.issue_number}`
      : `#app/${task.app_slug}/dev`,
    status: agentLabel(task.agent),
    busy: false,
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
  // Called from App.DrawerStatus.setAppOpen() for an open app, and from
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
      if (improveStore.get().open) Improve.close();
      improveStore.set({
        target: null,
        slug: null,
        name: '',
        selfHosted: false,
        repoUrl: null,
        version: null,
        deploying: false,
        readOnly: false,
        showTerminal: false,
        canShare: false,
        // Back to App.currentTab's own initial value, so the next target does
        // not inherit the last one's half.
        tab: 'app',
      });
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
      version: target.version || null,
      deploying: !!target.deploying,
      readOnly: !!target.readOnly,
      canShare: !!target.canShare,
      // The terminal is only meaningful while an iframe is on screen, and
      // DevConsole owns that fact — a target change alone never turns it on.
      showTerminal: slugChanged ? false : prev.showTerminal,
    });
    if (slugChanged) Improve._rebucket();
  },

  /**
   * Publish which half of the app is on screen — the App tab or the Dev area.
   *
   * Called from `App.switchTab()`, the single place `App.currentTab` is
   * assigned. Only meaningful while there IS a target, so a switch with none
   * published is dropped rather than stored against nothing.
   */
  setTab(tab) {
    if (!improveStore.get().slug) return;
    // #1406: 'other' is a platform screen that is neither half of an app. It
    // is passed explicitly by App._enterScreenChrome and never inferred, so
    // anything unrecognised still collapses to 'app' exactly as before.
    const next = tab === 'dev' ? 'dev' : (tab === 'other' ? 'other' : 'app');
    improveStore.set({ tab: next });
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
    for (const key of ['name', 'repoUrl', 'version', 'deploying', 'readOnly', 'canShare', 'selfHosted']) {
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

  toggle() {
    if (improveStore.get().open) Improve.close();
    else Improve.open();
  },

  open() {
    const state = improveStore.get();
    if (!state.slug) return;
    const panel = document.getElementById('improve-panel');
    if (!panel) return;
    // One surface at a time: opening this closes the hamburger, the same
    // courtesy the cog and bell drawers paid each other.
    if (window.HeaderMenu?.isPresenting?.()) window.HeaderMenu.close?.();

    if (!Improve._sheet) {
      // Publish `open` BEFORE presenting: the kit sheet measures the content's
      // height once at present time to seed its slide-up spring, so the panel
      // has to be rendered at full height by then. The store write is flushed
      // synchronously (lib/plain-store.js's injected flushSync), so React has
      // painted the rows by the time adoptKitSurface reads the element.
      improveStore.set({ open: true });
      const sheet = adoptKitSurface({
        kind: 'sheet',
        contentEl: panel,
        home: 'body',
        gate: 'touch',
        onDismiss: () => {
          Improve._sheet = null;
          improveStore.set({ open: false });
          // The kit's exit spring has run: anything chained on close() (the
          // Share dialog) may present now.
          Improve._resolveDismissWaiters();
        },
      });
      if (sheet) {
        Improve._sheet = sheet;
        Improve.loadSessions();
        return;
      }
      // The kit refused (desktop, or no kit): adoptKitSurface has already
      // rolled its own bookkeeping back and the slide-over below is the
      // presentation. `open` is already published, so nothing more to do
      // than fall through.
    }
    improveStore.set({ open: true });
    Improve.loadSessions();
  },

  // The panel's own slide-out, matching #improve-panel's transition in
  // app.css. A close that resolves BEFORE the panel is gone is the whole
  // defect this pairs against — see close().
  LEGACY_CLOSE_MS: 200,

  // A hard cap on the completion promise, so a kit teardown that never fires
  // cannot hang a chained presentation forever.
  DISMISS_SAFETY_MS: 500,

  _dismissWaiters: [],

  /**
   * Returns a promise that resolves once the panel is actually GONE — the kit
   * teardown on the touch path, the CSS slide's end on the desktop one,
   * immediately when nothing was open.
   *
   * This is HeaderMenu.close()'s contract (#977), and it is here for the same
   * reason: the "Share app" row presents a DIALOG of its own, and a dialog
   * that fades in while its host surface is still sliding out reads as two
   * things moving at once. The row was the hamburger's until THE UI OVERHAUL
   * moved the drawer's reference footer into this panel, so the rule had to
   * travel with it — every other caller can keep ignoring the return value.
   */
  close() {
    if (Improve._sheet) {
      // The kit runs its exit spring and calls onDismiss, which is what
      // publishes `open: false` — publishing it here as well would empty the
      // sheet a frame before it started animating out.
      const done = Improve._afterDismiss();
      Improve._sheet.dismiss();
      return done;
    }
    if (!improveStore.get().open) return Promise.resolve();
    improveStore.set({ open: false });
    const done = Improve._afterDismiss();
    setTimeout(() => Improve._resolveDismissWaiters(), Improve.LEGACY_CLOSE_MS);
    return done;
  },

  _afterDismiss() {
    return new Promise((resolve) => {
      Improve._dismissWaiters.push(resolve);
      setTimeout(resolve, Improve.DISMISS_SAFETY_MS);
    });
  },

  _resolveDismissWaiters() {
    const waiters = Improve._dismissWaiters;
    Improve._dismissWaiters = [];
    for (const resolve of waiters) resolve();
  },

  /**
   * Close before a row navigates.
   *
   * Same contract as `WorkDrawer._dismissSheetForNav`: on touch the panel is
   * modal over the destination screen, so a row that navigates has to take it
   * down first. On desktop the slide-over closes too — unlike the anchored
   * dropdowns it covers the surface you are navigating to.
   */
  dismissForNav() {
    if (improveStore.get().open) Improve.close();
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

  _rebucket() {
    const { slug, name } = improveStore.get();
    const mine = [];
    const others = [];
    const place = (row, rowSlug) => {
      if (slug && rowSlug === slug) mine.push(row);
      else others.push(row);
    };
    for (const session of Improve._all) {
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
        // session that finishes while the panel is open updates in place
        // instead of going stale until the next open.
        if (window.SessionState) {
          window.SessionState.seed(sessions, data.issuedAt);
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
   * Two jobs, and the second is the one that matters with the panel SHUT: an
   * open panel reloads its list, and the button's glyph tracks whether
   * anything is running at all. `SessionState` is synced from app.js's boot
   * path and re-ticks on its own (faster while something is in flight), so
   * this is live without the panel ever being opened — which is the whole
   * point of putting the cue on the button.
   */
  onSessionStateChanged() {
    Improve.refreshWorking();
    if (improveStore.get().open) Improve.loadSessions();
  },

  /** `SessionState.anyActive()`, as store state. Safe before it exists. */
  refreshWorking() {
    const working = !!window.SessionState?.anyActive?.();
    if (improveStore.get().working !== working) improveStore.set({ working });
  },

  /**
   * The green session count, from Notifications._renderBadge.
   *
   * That module is loaded as a classic SCRIPT by two test files, so it cannot
   * import this store and reaches it by name instead — the same constraint
   * dev-chat.js documents. It used to write `textContent` and toggle `hidden`
   * on a span inside the hamburger; the span is inside a React-owned button
   * now, so it publishes the two numbers and the component renders them.
   */
  setSessionBadge(unread, done) {
    const sessionUnread = Number(unread) || 0;
    const sessionDone = Number(done) || 0;
    const cur = improveStore.get();
    if (cur.sessionUnread === sessionUnread && cur.sessionDone === sessionDone) return;
    improveStore.set({ sessionUnread, sessionDone });
  },

  /**
   * The platform version dot's state, from DrawerStatus.refreshDeployDot().
   *
   * 'deploying' | 'stale' | 'idle' — read off the version rows this panel's
   * own footer renders, which is why the dot moved here from the hamburger.
   */
  setVersionState(versionState) {
    const next = versionState === 'deploying' || versionState === 'stale'
      ? versionState : 'idle';
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
    if (window.App.currentApp === slug) {
      await window.App.switchTab('dev', null, subTab);
    } else {
      await window.App.navigateToApp(slug, 'dev', null, subTab);
    }
    // The viewer can navigate away while the fetch above is in flight; the
    // router guards its own tail on exactly this condition, so this does too.
    if (window.App.currentApp !== slug) return;
    if (then) then();
  },

  /**
   * Open the feedback dialog.
   *
   * `fromDev: true` is the mode the Dev "+" menu's "New issue" row used: it
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

  /** "Start a new session" — the Dev "+" menu's "Propose a change" row. */
  startSession() {
    Improve.close();
    Improve._withApp(() => window.AppView?.createProposal?.());
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
  openTerminal() {
    Improve.close();
    window.DevConsole?.show?.();
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
