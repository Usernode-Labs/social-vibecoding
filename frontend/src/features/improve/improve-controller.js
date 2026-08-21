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

function toRow(session, appNameFallback) {
  return {
    id: session.id,
    appSlug: session.app_slug || null,
    appName: session.app_name || appNameFallback || session.app_slug || '',
    title: session.title || 'Untitled session',
    status: statusLabel(session),
    busy: isBusy(session),
  };
}

const Improve = {
  /** The live kit adoption on touch, or null on desktop / before presenting. */
  _sheet: null,
  /** Guards against two overlapping session loads racing their writes. */
  _loadToken: 0,

  // ── What the panel is about ──────────────────────────────────────
  //
  // Called from App.DrawerStatus.setAppOpen() for an open app, and from
  // App.navigateHome() with the platform's own self-hosted row so that
  // "Improve" on the home screen means "improve Social Vibecoding itself".
  // Passing null clears the target, which hides the header button — that is
  // what every other platform screen (settings, admin, profile…) does.
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

  close() {
    if (Improve._sheet) {
      // The kit runs its exit spring and calls onDismiss, which is what
      // publishes `open: false` — publishing it here as well would empty the
      // sheet a frame before it started animating out.
      Improve._sheet.dismiss();
      return;
    }
    improveStore.set({ open: false });
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

  _rebucket() {
    const { slug, name } = improveStore.get();
    const mine = [];
    const others = [];
    for (const session of Improve._all) {
      const row = toRow(session, session.app_slug === slug ? name : null);
      if (slug && session.app_slug === slug) mine.push(row);
      else others.push(row);
    }
    // Busy first, then most recently touched — the two things a viewer scanning
    // for "what is running right now" is actually looking for.
    const order = (a, b) => Number(b.busy) - Number(a.busy) || b.id - a.id;
    improveStore.set({
      sessions: mine.sort(order),
      otherSessions: others.sort(order),
    });
  },

  async loadSessions() {
    const token = ++Improve._loadToken;
    if (!improveStore.get().sessionsLoaded) improveStore.set({ loadingSessions: true });
    let sessions = [];
    try {
      const res = await fetch(`/api/me/active-sessions${Improve._demoQS()}`);
      if (res.ok) {
        const data = await res.json();
        sessions = Array.isArray(data.sessions) ? data.sessions : [];
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

  /** Refresh an open panel when session state changes underneath it. */
  onSessionStateChanged() {
    if (improveStore.get().open) Improve.loadSessions();
  },

  // ── Actions ──────────────────────────────────────────────────────
  //
  // Every row closes the panel first. On touch it is a modal sheet over the
  // destination; on desktop the slide-over covers the right edge of the screen
  // the row is navigating to. Neither is somewhere to leave a surface open.

  /**
   * Put the panel's TARGET on screen, then run `then` against it.
   *
   * Improve can be opened for an app that is not the one currently rendered —
   * on the home screen it is about the platform's own row, and nothing has
   * loaded `/api/apps/<platform>` at that point. So the actions that need
   * `AppView.appData` navigate first and await the same promise the router
   * awaits, rather than firing at an `AppView` that is still describing the
   * previous app (or none).
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
    // opens on its Platform default — which is correct on the home screen,
    // where the target IS the platform.
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
  share() {
    Improve.close();
    window.AppView?.openShareModal?.();
  },
};

if (typeof window !== 'undefined') {
  window.Improve = Improve;
}

export { Improve };
