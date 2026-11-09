/**
 * THE PHONE'S COMMUNITY HEADER: WHEN IT APPLIES (Evan's design, 18 Oct
 * 2026; the drawer under it removed 3 Nov 2026).
 *
 * Under the Communities tab, under 768px, a community's page draws the
 * platform header as its own (./header-drawer.tsx): on the Hub the grid
 * that opens all your communities, elsewhere the arrow up to the Hub, the
 * community's name over its place's, and the community's colour. This
 * settles whether it applies and which community and place it names
 * (./drawer-store.ts).
 *
 * It used to be the deepest of three levels side by side on one strip (your
 * communities at 85%, the community's places at 80%, then the page), slid
 * between by the arrow, the lit tab and a finger. That drawer is gone: a
 * community opens on its Hub, the Hub's rows lead to its places (Needs you,
 * the Workshop, #general and each topic), and All communities is a page of
 * its own (#communities). A wide window nests the places under the
 * community's row in the sidebar (../nav/rail-communities.tsx), and nothing
 * here draws there.
 *
 * Nothing in the prerender: it settles only once the phone's width and the
 * route are known, from state that changes after the first paint.
 */

import { useEffect, useState, type ReactNode } from 'react';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { isPlaceKey } from '../dev-board/workshop/places';
import { cachedTopics, itemReturnPlace, livePlace, placeStore } from '../dev-board/workshop/place-store';
import { useDevViewMode } from '../dev-board/view-mode-store';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';
import { keepPlace } from './drawer-math';
import { setOn, setShown } from './drawer-store';

const PHONE_QUERY = '(max-width: 767.98px)';

/** Phone-narrow, settled in an effect so the first render is the prerender's (place-bar.tsx usePhoneHeader). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(PHONE_QUERY);
    const apply = () => setPhone(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return phone;
}

/**
 * Whether the phone's community header applies. A phone, the app view on
 * show, and on it a community's own page (its Dev half, in the Workshop
 * layout: not the running app, a change's session, or the Kanban board).
 * Pure.
 *
 * AN ITEM'S PAGE TOO (polish board #23, 19 Oct 2026): a request, a change's
 * page or a vote opened from the community's pages is a page of the
 * community's, so it keeps the drawer's header (the arrow, the community
 * over its place) and its swipe back. With the drawer off there, opening a
 * request from the Workshop swapped the header to the community switcher,
 * and a swipe back did nothing. One opened from a Messages conversation
 * (`topicOrigin` there) belongs to that conversation and keeps the drawer
 * off, as does any item under the Kanban board, and one opened from the
 * Homeroom bot tab's page, which goes back there (29 Oct 2026).
 */
export function drawerApplies(at: {
  phone: boolean; screen: string | null; slug: string | null; tab: string | null; subTab: string | null;
  viewMode: string; topicOrigin?: string | null;
}): boolean {
  if (!at.phone || at.screen !== 'app-view') return false;
  if (!at.slug || at.tab !== 'dev' || at.viewMode !== 'workshop') return false;
  if (at.subTab === 'forum') return true;
  const origin = String(at.topicOrigin || '');
  return at.subTab === 'topic' && !origin.startsWith('#messages') && !/^#homeroom-bot(\/|$)/.test(origin);
}

export function NavDrawer(): ReactNode {
  const phone = usePhone();
  const { screen } = useStoreState(navStore) as { screen: string | null };
  const improve = useStoreState(improveStore) as {
    slug: string | null; tab: string | null; subTab: string | null; name: string | null; selfHosted: boolean;
    topicOrigin: string | null;
  };
  const viewMode = useDevViewMode();
  const placed = useStoreState(placeStore);
  const on = drawerApplies({
    phone, screen, slug: improve.slug, tab: improve.tab, subTab: improve.subTab, viewMode,
    topicOrigin: improve.topicOrigin,
  });

  // Before paint, so the header draws its arrow and titles in the same
  // frame the route lands in.
  useIsomorphicLayoutEffect(() => { setOn(on); }, [on]);
  useIsomorphicLayoutEffect(() => {
    if (!on || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    root.setAttribute('data-nav-drawer', '');
    return () => root.removeAttribute('data-nav-drawer');
  }, [on]);

  const slug = improve.slug;
  const pageUp = !!slug && placed.slug === slug;
  // #5683: the page's own place is checked against the community it is in,
  // so a channel left over from another one gives way to its Hub; the page
  // not up yet opens on the place remembered only where this community has
  // it. A request's or a change's page names the place its chip goes back
  // to (itemReturnPlace, audit N05).
  const place = pageUp && slug
    ? livePlace(slug, placed.place)
    : (slug && improve.subTab === 'topic'
      ? itemReturnPlace(slug)
      : keepPlace(rememberedPlace(), slug ? cachedTopics(slug) : null));
  const name = improve.name || slug || '';
  const selfHosted = !!improve.selfHosted;
  useIsomorphicLayoutEffect(() => {
    setShown({ slug: slug || null, name, selfHosted, place });
  }, [slug, name, selfHosted, place]);
  return null;
}

/** The place the page opens on before it has said (AppView._workshopTab), else the Hub. */
function rememberedPlace(): string {
  try {
    const tab = (window as unknown as { AppView?: { _workshopTab?: () => unknown } }).AppView?._workshopTab?.();
    return isPlaceKey(tab) ? tab : 'status';
  } catch {
    return 'status';
  }
}
