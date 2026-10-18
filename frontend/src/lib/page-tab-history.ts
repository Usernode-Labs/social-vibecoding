/**
 * The project page's tabs, as steps the back button can walk.
 *
 * A project page's four tabs (Hub, Discussion, Needs you, Workshop, with All
 * items under the Workshop) were invisible to back: a press jumped straight
 * out of the project to whatever screen was open before it, usually Home,
 * while the page's own back disc on All items went to the Workshop — the
 * back button and the disc disagreed. Every tab press now leaves a step:
 * back from the Workshop returns to the Hub, back at the tab the page was
 * opened on leaves the project exactly as it always did, and Forward walks
 * the steps the other way.
 *
 * ── A same-address record, like the back stack's ────────────────────────
 *
 * A tab is not a place: its identity is not in the URL, and putting it there
 * would put every tab in every shared link. So a tab press writes history at
 * the address the page already stands at, in two moves:
 *
 *   1. `replaceState` over the entry being left, spreading its previous
 *      state plus the tab it showed — so the arrival entry remembers the
 *      tab the page opened on, and each later entry remembers the tab it
 *      is showing.
 *   2. `pushState` of a record whose state carries ONLY the new tab — never
 *      a spread of whatever a dismiss record left behind, so a dialog's
 *      ownership check (back-stack.ts reads its own markers) stays honest.
 *
 * The address never moves, so no `hashchange` fires, the router's
 * duplicate-run guard is untouched, and `updateHash`'s canonicaliser —
 * which would `replaceState(null)` over the entry — leaves the entry alone,
 * because the page's canonical address already equals it. `App._historyPushes`
 * counts only `updateHash` pushes, so `_pinAppReturn`'s arithmetic is
 * unaffected.
 *
 * ── Consuming a step ────────────────────────────────────────────────────
 *
 * A traversal that lands on an entry whose state carries the marker, did not
 * move the address, and finds the project page on view, is a tab step: the
 * tab is applied through `AppView._landOnTab` — which already writes the
 * remembered tab, forgets the saved scroll and publishes
 * `usernode:workshop-tab`, which the open page applies with a scroll to its
 * head — and the popstate is stopped, so the router never rebuilds the page
 * (a rebuild would reopen it on the remembered tab, the wrong one — the
 * #3583 class of bug). back-stack.ts's capture listener consults
 * `consumePopstate` AFTER its own dismissible check, which fixes listener
 * order by construction: a dialog over the page still eats the press first.
 *
 * A traversal that DID move the address (back from a topic, or from another
 * screen) is passed to the router, which reopens the page from the landing
 * entry's marker — restoreFromHash's app route publishes it through
 * `AppView._overrideWorkshopTab`. A landing on an entry without the marker
 * is an arrival or a door, and clears that override, so the page opens on
 * the tab a door named or the one last remembered.
 *
 * Records no page owns are steps to pass through, exactly as the back
 * stack's are: a dialog closed by its own button leaves its record below a
 * tab record, and one back press spends it — doing nothing visible — before
 * the next applies the tab.
 */

import { isEmbeddedPanel } from './side-panel-mode';

/** The marker in a history entry's state, beside the back stack's `__unDismissDepth`. */
export const PAGE_TAB_STATE_KEY = '__unPageTab';

type HistoryLike = {
  state?: unknown;
  pushState(state: unknown, title: string): void;
  replaceState(state: unknown, title: string): void;
};
/** The slice of the Navigation API used to tell an in-place traversal. */
type NavigationLike = {
  currentEntry?: { index: number; key?: string } | null;
  addEventListener?(
    type: 'currententrychange',
    listener: (event: { navigationType?: string; from?: { index: number; url?: string | null } | null }) => void,
  ): void;
};
export type PageTabWindowLike = {
  history: HistoryLike;
  location?: { href: string };
  navigation?: NavigationLike | null;
};

/** The two answers the legacy world owes this module: is the page open, and apply a tab. */
export type PageTabHost = {
  /** True when the project page is the screen on view. */
  isPageOnView: () => boolean;
  /** Apply a recorded tab to the open page (AppView._landOnTab). */
  landOnTab: (tab: string) => void;
};

type PopstateLike = { state?: unknown };

export interface PageTabHistory {
  /** Record one tab change, at the address the page already stands at. */
  push(from: string, to: string): void;
  /** Run one popstate. True when it was a tab step and was consumed. */
  consumePopstate(event?: PopstateLike): boolean;
}

export function createPageTabHistory(win: PageTabWindowLike, host: PageTabHost): PageTabHistory {
  // The address the latest record was pushed at — the in-place answer where
  // the host has no Navigation API to say which way a traversal went. Null
  // when there is no address to report (a test double), in which case no
  // step is ever consumed.
  let pushedHref: string | null = null;
  // Where the traversal that is landing now came from, from the Navigation
  // API — its `currententrychange` fires before popstate.
  let traversedFrom: { url: string | null } | null = null;
  try {
    win.navigation?.addEventListener?.('currententrychange', (event) => {
      traversedFrom = event.navigationType === 'traverse' && event.from
        ? { url: event.from.url ?? null }
        : null;
    });
  } catch {
    /* No Navigation API: the push-time address answers. */
  }

  const href = (): string | null => {
    try {
      return win.location?.href ?? null;
    } catch {
      return null;
    }
  };

  const landedState = (event?: PopstateLike): Record<string, unknown> | null => {
    const raw = event && 'state' in event ? event.state : win.history.state;
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  };

  function push(from: string, to: string): void {
    if (from === to) return;
    try {
      const prev = (win.history.state ?? null) as Record<string, unknown> | null;
      // The entry being left remembers the tab it showed.
      win.history.replaceState({ ...(prev || {}), [PAGE_TAB_STATE_KEY]: from }, '');
      // The record pushed carries only the tab it shows.
      win.history.pushState({ [PAGE_TAB_STATE_KEY]: to }, '');
      pushedHref = href();
      traversedFrom = null;
    } catch {
      /* A history a sandbox will not let us write is not worth throwing over. */
    }
  }

  function consumePopstate(event?: PopstateLike): boolean {
    const state = landedState(event);
    const tab = state ? state[PAGE_TAB_STATE_KEY] : null;
    if (typeof tab !== 'string') return false;
    if (!host.isPageOnView()) return false;
    // A tab record sits at the page's own address, so an in-place traversal
    // is a tab step and one that moved the address is a navigation the
    // router must rebuild from (back from a topic, a landing from another
    // screen — the app route reads the landing entry's marker for those).
    const from = traversedFrom;
    traversedFrom = null;
    const at = href();
    if (from ? from.url !== at : at === null || at !== pushedHref) return false;
    host.landOnTab(tab);
    return true;
  }

  return { push, consumePopstate };
}

// ── The shell's one instance ────────────────────────────────────────────
//
// Created here rather than per page, and consulted from back-stack.ts's
// capture listener, so the order a popstate is read in stays answerable:
// a dismissible first, then a tab step, then the router.

let shared: PageTabHistory | null = null;

/** The shell's page-tab history. Null in the prerender and the side panel. */
export function pageTabHistory(): PageTabHistory | null {
  return shared;
}

/**
 * Record a project page's tab change (`openTab` is the one caller).
 *
 * A no-op where there is no window (the SSG prerender pass evaluates this
 * module's graph in Node) or in the side panel's document (`?panel=1`,
 * framed beside a running app): a frame's history entries are the top
 * window's, and the panel has no device back button to walk them — the same
 * rule back-stack.ts states for the records a frame must not write.
 */
export function pushPageTab(from: string, to: string): void {
  shared?.push(from, to);
}

/** Run one popstate as a possible tab step. True when it was one, consumed. */
export function consumePopstate(event?: PopstateLike): boolean {
  return shared ? shared.consumePopstate(event) : false;
}

// NOT IN THE SIDE PANEL'S DOCUMENT — see pushPageTab.
if (typeof window !== 'undefined' && !isEmbeddedPanel()) {
  const w = window as unknown as {
    App?: { currentApp?: string | null; currentTab?: string; chromeless?: boolean };
    AppView?: { _landOnTab?: (slug: string, tab: string) => void };
  };
  shared = createPageTabHistory(window, {
    // The project page is the screen on view: an app is open, on its project
    // (Dev) tab, not chromeless. A traversal that arrived here from another
    // screen is not this module's step — the app route reads the landing
    // entry's marker instead.
    isPageOnView: () => !!w.App?.currentApp && w.App.currentTab === 'dev' && !w.App.chromeless,
    // AppView._landOnTab writes the remembered tab, forgets the saved scroll
    // and publishes `usernode:workshop-tab`, which the open page applies
    // with a scroll to its head.
    landOnTab: (tab) => {
      const slug = w.App?.currentApp;
      if (slug && w.AppView?._landOnTab) w.AppView._landOnTab(slug, tab);
    },
  });
}
