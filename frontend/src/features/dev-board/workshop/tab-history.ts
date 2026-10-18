/**
 * A PROJECT'S TABS ARE PLACES, SO BACK STEPS THROUGH THEM.
 *
 * The Hub, Discussion, Needs you, Workshop and All items were local React
 * state (`workshop.tsx`'s `tab`) plus a remembered choice in localStorage
 * (`AppView._setWorkshopTab`). Neither writes a history entry, so the only
 * entry a project page had was the one its route pushed: press Workshop and
 * then Back and the device left the project instead of returning to the Hub.
 *
 * A tab press now pushes a record at the SAME address, carrying the tab in
 * `history.state`. The address deliberately does not change: the shell keeps
 * query parameters across screens (`App._rootUrl`, `App._routeSearch`), so a
 * `?ws=` written by a tab press would ride into Home, Settings and the next
 * project, where `AppView._workshopTabParam` reads it first. A tab record is
 * also how `../lib/back-stack.ts` works for dialogs — same address, state
 * that says what the record is — so the two can share history without
 * consuming each other's steps: a tab record carries no dismiss id, and a
 * dialog record copies the tab tag when it spreads the state.
 *
 * The record is written in three places, and this module is all three:
 *
 *  1. ON ARRIVAL (`tagTabEntry`), a layout effect replaces the entry's state
 *     with the tab the page opened on — a door, a deep link, a reload, a
 *     switch between projects.
 *  2. ON A REAL TAB CHANGE (`pushTabEntry`), `openTab` and the door listener
 *     push a record only when the tab actually changed and this project's
 *     page is the one on screen. Pressing the lit tab adds no step.
 *  3. ON A TRAVERSAL (`readTabEntry`), the page's `popstate` listener sets
 *     the tab the landed entry names, in either direction.
 *
 * Every helper takes the window-like object rather than reading the global,
 * so it can be tested without a browser, in the style of `lib/back-stack.ts`.
 */

import { isEmbeddedPanel } from '../../../lib/side-panel-mode';

/** Tab keys the project page knows, in the band's order plus All items. */
export const WORKSHOP_TAB_KEYS = ['status', 'discussion', 'needs', 'workshop', 'all'] as const;

export type WorkshopTabKey = (typeof WORKSHOP_TAB_KEYS)[number];

/** The key in a history entry's state that names the tab it showed. */
export const WORKSHOP_TAB_STATE_KEY = '__unWorkshopTab';

type HistoryLike = {
  state?: unknown;
  pushState(state: unknown, title: string, url?: string | null): void;
  replaceState(state: unknown, title: string, url?: string | null): void;
};

export type TabWindow = {
  history: HistoryLike;
  location: { href: string; pathname?: string; hash?: string };
};

/**
 * The page's window, or null where there is none (a test, a server render)
 * and in the side panel's document (`?panel=1`, `lib/side-panel-mode`).
 *
 * The panel is the same shell in a same-origin frame beside a running app, so
 * its history entries are the TOP window's: a tab record pushed there would be
 * a Back press the top window inherits, and one this document could never
 * restore. `lib/back-stack.ts` stands down there for the same reason; the
 * panel's tabs keep switching locally, as they did before.
 */
export function tabWindow(): TabWindow | null {
  if (typeof window === 'undefined') return null;
  if (isEmbeddedPanel()) return null;
  return window as unknown as TabWindow;
}

export function isTabKey(value: unknown): value is WorkshopTabKey {
  return typeof value === 'string'
    && (WORKSHOP_TAB_KEYS as readonly string[]).includes(value);
}

/** The tab the entry the page is standing on showed, if it names one. */
export function readTabEntry(win: TabWindow | null): WorkshopTabKey | null {
  if (!win) return null;
  try {
    const state = win.history?.state;
    if (!state || typeof state !== 'object') return null;
    const tab = (state as Record<string, unknown>)[WORKSHOP_TAB_STATE_KEY];
    return isTabKey(tab) ? tab : null;
  } catch {
    return null;
  }
}

/**
 * A step back can undo: a record at the same address naming `tab`.
 *
 * The address is passed explicitly so the record lands where the page
 * already is. An unknown key writes nothing — a tab press is state, not a
 * reason to duplicate the current entry for a tab that does not exist.
 */
export function pushTabEntry(win: TabWindow | null, tab: unknown): void {
  if (!win || !isTabKey(tab)) return;
  try {
    const href = win.location?.href;
    if (!href) return;
    const prev = (win.history.state ?? null) as Record<string, unknown> | null;
    win.history.pushState({ ...(prev || {}), [WORKSHOP_TAB_STATE_KEY]: tab }, '', href);
  } catch {
    /* A history a sandbox will not let us write is not worth throwing over. */
  }
}

/**
 * Name the tab on the entry the page is standing on, without adding a step.
 * This is what a page arriving from a door, a deep link or a reload writes.
 */
export function tagTabEntry(win: TabWindow | null, tab: unknown): void {
  if (!win || !isTabKey(tab)) return;
  try {
    const href = win.location?.href;
    if (!href) return;
    const prev = (win.history.state ?? null) as Record<string, unknown> | null;
    win.history.replaceState({ ...(prev || {}), [WORKSHOP_TAB_STATE_KEY]: tab }, '', href);
  } catch {
    /* Same: the tab still switches locally. */
  }
}

/**
 * The project whose own page the address is — `/app/<slug>/workshop` or the
 * `/board` alias, and their legacy `#app/...` hash spellings — or null for
 * any other address.
 *
 * Both spellings, because a legacy hash address is canonicalised by
 * `restoreFromHash` with a `replaceState`, which can land after the page has
 * mounted.
 */
export function projectPageSlug(win: TabWindow | null): string | null {
  if (!win) return null;
  const decode = (part: string): string => {
    try { return decodeURIComponent(part); } catch { return part; }
  };
  const route = (value: string): string | null => {
    const m = /^\/?app\/([^/?#]+)\/(?:workshop|board)(?:[/?#]|$)/.exec(value);
    return m ? decode(m[1]) : null;
  };
  try {
    const pathname = String(win.location?.pathname || '');
    const fromPath = route(pathname.startsWith('/') ? pathname : `/${pathname}`);
    if (fromPath !== null) return fromPath;
    const hash = String(win.location?.hash || '').replace(/^#/, '');
    return route(hash);
  } catch {
    return null;
  }
}

/**
 * Is the address THIS project's own page?
 *
 * Anything else (`/app/<slug>`, `/app/<slug>/dev/...`, another project,
 * another screen) is not, so a door delivered to a hidden page or while
 * another screen is up cannot write to the wrong entry.
 */
export function isProjectPageUrl(win: TabWindow | null, slug: string | null | undefined): boolean {
  if (!slug) return false;
  return projectPageSlug(win) === String(slug);
}
