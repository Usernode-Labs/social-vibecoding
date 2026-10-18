/**
 * BACK REMEMBERS THE TAB YOU WERE ON.
 *
 * A project's page has four tabs (Hub, Discussion, Needs you, Workshop) and a
 * page under one of them (All items) — none of which had an address of its
 * own. Changing tab was React state, so it wrote no history entry: a Back
 * press skipped the tab and left the project, sometimes all the way to Home.
 * The Communities screen's Needs you page was the same.
 *
 * Screens that already have an address (Messages, Settings, the admin
 * console, Discover, a project's proposal or issue page) need nothing here:
 * Back walks their hash routes as it always did. This is for the page changes
 * that are a reading position rather than a place.
 *
 * ── A same-address record ──────────────────────────────────────────────
 *
 * Every tab change pushes a record at the SAME address — the model
 * `back-stack.ts` uses for a dialog, for the same reason: the URL, the hash
 * router and `App._currentRoute` do not change, and a tab is not a place a
 * shared link should name (the `?ws=` deep links already do that). The tab is
 * carried in the entry's STATE under `__unPageTab`, so a traversal can land on
 * an entry and read which tab it was:
 *
 *   { scope: 'project', slug: 'garden', tab: 'workshop', from: 'status' }
 *
 * `scope` is `project` or `communities`; `from` is the tab the record was
 * pushed FROM, which is what a page's own back disc reads (All items to the
 * Workshop, Needs you to the hub) — `backWithinTabs` walks the history only
 * when the entry below is that parent, so the disc is a Back step rather than
 * a new one and Back afterwards does not bounce between the two pages.
 *
 * The record is merged with whatever state the entry already holds, minus the
 * back-stack's own keys: a dialog's record and a tab record must not be
 * mistaken for one another.
 *
 * A page that MOUNTS on an entry with no marker stamps one with
 * `replaceState`, so the entry the page opened on is a tab Back can return
 * to. A marker for another page (another project's, or the Communities
 * screen's) is ignored, and `stampPageTab` replaces that rather than losing
 * the entry's own position.
 *
 * No-ops without a window: the SSG prerender pass evaluates this module's
 * graph in Node.
 */

export const PAGE_TAB_KEY = '__unPageTab';

export type PageTabScope = 'project' | 'communities';

export interface PageTabRecord {
  scope: PageTabScope;
  /** The project whose page this is. Null for the Communities screen. */
  slug?: string | null;
  tab: string;
  /** The tab this record was pushed from. Null where none is known. */
  from?: string | null;
}

type HistoryLike = {
  state?: unknown;
  pushState?: (state: unknown, title: string, url?: string | null) => void;
  replaceState?: (state: unknown, title: string, url?: string | null) => void;
  back?: () => void;
};

/** The back-stack's own keys, which never travel with a tab record. */
const BACK_STACK_KEYS = ['__unDismissDepth', '__unDismissId'];

function browserHistory(): HistoryLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return (window.history as HistoryLike) || null;
  } catch {
    return null;
  }
}

function normalize(record: PageTabRecord): PageTabRecord {
  return {
    scope: record.scope,
    slug: record.scope === 'project' && typeof record.slug === 'string' ? record.slug : null,
    tab: record.tab,
    from: typeof record.from === 'string' ? record.from : null,
  };
}

/** The record carried by an entry's state, or null where it carries none. */
export function readPageTab(state: unknown): PageTabRecord | null {
  if (!state || typeof state !== 'object') return null;
  const mark = (state as Record<string, unknown>)[PAGE_TAB_KEY];
  if (!mark || typeof mark !== 'object') return null;
  const { scope, slug, tab, from } = mark as Record<string, unknown>;
  if (scope !== 'project' && scope !== 'communities') return null;
  if (typeof tab !== 'string' || !tab) return null;
  if (slug != null && typeof slug !== 'string') return null;
  if (from != null && typeof from !== 'string') return null;
  return {
    scope,
    slug: typeof slug === 'string' ? slug : null,
    tab,
    from: typeof from === 'string' ? from : null,
  };
}

/** The status of the entry the page is standing on now. */
export function currentPageTab(): PageTabRecord | null {
  const history = browserHistory();
  if (!history) return null;
  try {
    return readPageTab(history.state);
  } catch {
    return null;
  }
}

/** Does this record describe `scope`'s page, for `slug` on a project? */
export function pageTabMatches(
  record: PageTabRecord | null,
  scope: PageTabScope,
  slug?: string | null,
): boolean {
  if (!record || record.scope !== scope) return false;
  if (scope === 'project') return !!slug && record.slug === slug;
  return true;
}

function write(record: PageTabRecord, method: 'pushState' | 'replaceState'): void {
  const history = browserHistory();
  if (!history || typeof history[method] !== 'function') return;
  try {
    const previous = history.state && typeof history.state === 'object'
      ? { ...(history.state as Record<string, unknown>) }
      : {};
    for (const key of BACK_STACK_KEYS) delete previous[key];
    previous[PAGE_TAB_KEY] = normalize(record);
    history[method]!(previous, '');
  } catch {
    /* A history a sandbox will not let us write is not worth throwing over. */
  }
}

/** Record a tab change as a step Back can take. */
export function pushPageTab(record: PageTabRecord): void {
  write(record, 'pushState');
}

/** Replace the current entry's tab, without adding a step of its own. */
export function replacePageTab(record: PageTabRecord): void {
  write(record, 'replaceState');
}

/**
 * Give the entry the page just mounted on a marker, so Back can return to the
 * tab it opened on. An entry that already carries this page's marker keeps it:
 * a traversal landed on it, and its own position is the answer.
 */
export function stampPageTab(record: PageTabRecord): void {
  const existing = currentPageTab();
  if (pageTabMatches(existing, record.scope, record.slug)) return;
  write(record, 'replaceState');
}

/**
 * A page's own back disc, as a Back step: walk the history when the entry
 * below is the tab this page was opened from. False where it is not, and the
 * caller opens the parent itself instead.
 */
export function backWithinTabs(
  scope: PageTabScope,
  slug: string | null | undefined,
  parent: string,
): boolean {
  const record = currentPageTab();
  if (!pageTabMatches(record, scope, slug) || !record || record.from !== parent) return false;
  const history = browserHistory();
  if (!history || typeof history.back !== 'function') return false;
  try {
    history.back();
    return true;
  } catch {
    return false;
  }
}
