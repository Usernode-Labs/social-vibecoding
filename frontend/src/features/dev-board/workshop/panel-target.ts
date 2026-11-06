/**
 * The item the column's ⋯ menu carries into the Workshop (#6380).
 *
 * "Open in workshop" is pressed beside the Homeroom bot's list, where the
 * request, change or decision is open in the column. The Workshop it opens is
 * a different screen: its tab takes a row's `TopicRef` and shows that page in
 * the panel beside its list (`./workshop.tsx` sideItem, `./side-panel.tsx`).
 * So the press leaves the item here, and the Workshop tab takes it as it
 * mounts (or shows), exactly as a door leaves its place in a room
 * (AppView._stashDiscussionTarget, public/js/app-view.js).
 *
 * One item at a time, for one project, and only for the TTL below: a page
 * opened much later is not moved by a door it never saw.
 *
 * A change addressed by its pull request's number (`dev/changes/<N>`) is
 * resolved to the session id the Workshop's pages are keyed by, the same read
 * AppView._sessionIdForChange makes, against the project named in the route.
 */

import type { TopicRef } from './work-row';

/**
 * #4457: where a Workshop row opens its page in a panel beside the list
 * rather than as the page: room for the list and a 560px panel beside it.
 * (Moved here from `./workshop.tsx` so the column can ask the same question
 * before it navigates.)
 */
export const WORKSHOP_SIDE_QUERY = '(min-width: 1180px)';

/** How long a stashed item waits for the Workshop it was left for. */
export const WORKSHOP_PANEL_TTL_MS = 30_000;

interface Stash {
  slug: string;
  ref: TopicRef | null;
  pr: number | null;
  at: number;
}

let stash: Stash | null = null;

const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
};

/** Leave an item for `slug`'s Workshop, and tell one already open. */
export function stashWorkshopPanelItem(
  slug: string | null | undefined,
  target: { ref?: TopicRef | null; pr?: number | null } = {},
): void {
  if (!slug) return;
  stash = { slug, ref: target.ref || null, pr: positive(target.pr), at: Date.now() };
  try {
    window.dispatchEvent(new CustomEvent('usernode:workshop-panel-target', { detail: { slug } }));
  } catch { /* no window (a prerender): the item is left all the same */ }
}

/** The item `slug`'s Workshop is waiting for, left where it is. */
export function peekWorkshopPanelItem(slug: string | null | undefined) {
  if (!stash || !slug || stash.slug !== slug) return null;
  if (Date.now() - stash.at > WORKSHOP_PANEL_TTL_MS) {
    stash = null;
    return null;
  }
  return stash;
}

/**
 * The same, taken: the Workshop opens it once. `null` for a stash that is
 * not this project's, is stale, or names a change this project cannot resolve.
 */
export async function takeWorkshopPanelItem(slug: string | null | undefined): Promise<TopicRef | null> {
  const s = peekWorkshopPanelItem(slug);
  if (s) stash = null;
  if (!s) return null;
  if (s.ref) return { kind: s.ref.kind, id: s.ref.id };
  if (!s.pr) return null;
  const id = await sessionIdForChange(s.slug, s.pr);
  return id ? { kind: 'proposal', id } : null;
}

/** #4367: the session a change's pull request number names on this app. */
async function sessionIdForChange(slug: string, pr: number): Promise<number | null> {
  try {
    const A = (window as unknown as { AppView?: { _demoQS?: () => string } }).AppView;
    const demo = typeof A?._demoQS === 'function' ? A._demoQS() : '';
    const res = await fetch(`/api/apps/${encodeURIComponent(slug)}/changes/${Number(pr)}${demo || ''}`);
    if (!res.ok) return null;
    const data = await res.json();
    return positive(data && data.sessionId);
  } catch {
    return null;
  }
}

/** For tests: forget the waiting item. */
export function _resetWorkshopPanelTarget(): void {
  stash = null;
}
