/**
 * The Communities tab pressed while it is lit: up a level, at every width
 * (#3701). Held, it does nothing more than a press (18 Oct 2026).
 *
 * ── One gesture had two meanings ───────────────────────────────────────
 *
 * Since the tab became a community (#852) the same press did two things by
 * window width: on a phone the lit tab opened the switcher, and on the
 * desktop rail the lit row went back to All communities. The phone's half
 * also broke what the tab you are already on does everywhere else, in
 * Apple's own apps and most large ones: it takes you back to the tab's first
 * page, or to the top when you are on it. Someone deep in All items or a card
 * who pressed it wanted the community back, and was shown a picker.
 *
 * ── The ladder ─────────────────────────────────────────────────────────
 *
 * So a press of the lit tab is one step up, the same at every width
 * (`rungFor`):
 *
 *   1. BELOW A COMMUNITY'S TABS (All items, a card, a reply thread beside
 *      its Discussion): back to the community, on the tab you were on, at
 *      its top. 'up'. #4417: the tabs are places now, and every place but
 *      the Hub is below it: a channel, Needs you or the Workshop goes up to
 *      the Hub, and a page under a place (All items) to that place first.
 *   2. ON ONE OF ITS TABS, SCROLLED DOWN: to the top. 'top'
 *   3. ON ONE OF ITS TABS, AT THE TOP: All communities, the tab's root. 'root'
 *   4. ON ALL COMMUNITIES: to the top, and nothing else. 'top', or 'none'
 *      when it is already there.
 *
 * ON A PHONE, A COMMUNITY'S PAGE IS THE DRAWER'S (../nav-drawer/, Evan's
 * design, 18 Oct 2026): a press goes back one level of it at a time, the
 * page to the community's places, the places to your communities, after
 * whatever is below a place (a reply thread, All items) has gone up to it.
 *
 * A STEP THAT CHANGES PAGE PUSHES AN ENTRY, as a tab press does (#3620), so
 * Back from where it landed is where it was pressed: a card goes up by the
 * hub's own address (`upToCommunity`), All items by the page's own tab entry
 * (AppView._pushWorkshopTab, in ../dev-board/workshop/workshop.tsx), and the
 * root by `#communities` (./community-scope.ts goToCommunity). Closing a reply
 * thread changes no page and no address, as opening it did not.
 *
 * ── Switching sideways ────────────────────────────────────────────────
 *
 * On a wide window the header's name and ⌄ open "Your communities"
 * (../header/header-title.tsx). On a phone the drawer's outermost level is
 * the list of your communities, and nothing on the bar opens the old
 * switcher: holding the tab used to (#3701), which put the sheet the drawer
 * replaced back over it, so the hold was removed (18 Oct 2026). A held tab
 * is an ordinary press.
 *
 * ── A blue number goes to what it counts (#5040) ──────────────────────
 *
 * The tab's blue number is the votes waiting on you (./community-scope.ts
 * `tabVotes`). Nothing said so, and pressing the tab took you to the Hub or
 * up to All communities, neither of which lists them. So while the number
 * shows and its votes are not already on screen, a press of the tab from
 * another tab opens Needs you (`goToVotes`): the community's own on a
 * community, the cross-community feed on All communities. A press of the
 * LIT tab is always the ladder above, one level up, or Needs you → Hub →
 * Needs you would loop. Phone bar only: the desktop sidebar's row is
 * unchanged. With no blue number nothing here runs.
 *
 * ── Who knows where you are ───────────────────────────────────────────
 *
 * The router knows the screen and the app (`App.currentApp`, and whether the
 * address is the project page itself, AppView._onProjectPage). Only the page
 * knows whether All items is up (../dev-board/workshop/workshop.tsx) or a
 * reply thread is open beside its Discussion
 * (../dev-board/workshop/project-discussion.tsx). Each tells this module
 * while it is mounted (`registerLevel`), and a press asks at that moment.
 * Nothing here renders.
 */

import { drawerStore, pressTab as pressDrawerTab } from '../nav-drawer/drawer-store';
import { closeSwitcher, goToCommunity } from './community-scope';
import { openPlace, placeStore } from '../dev-board/workshop/place-store';
import { workshopStore } from './workshop-store.js';

/** The pages under a place (../dev-board/workshop/places.ts): a step above them is the place. */
const PAGES_UNDER_A_PLACE = ['all', 'bot', 'plan'];

/** What one press of the lit tab does. */
export type Rung = 'up' | 'top' | 'root' | 'none';

/**
 * Where the press is made: below a community's tabs, on one of them, on All
 * communities (the tab's root), or somewhere the ladder does not know.
 */
export type Place = 'below' | 'tab' | 'root' | null;

/** The ladder. `scrolled`: the page on screen is not at its top. */
export function rungFor(at: Place, scrolled: boolean): Rung {
  if (at === 'below') return 'up';
  if (at === 'tab') return scrolled ? 'top' : 'root';
  if (at === 'root') return scrolled ? 'top' : 'none';
  return 'none';
}

/** A community's page, saying what is up on it. */
export interface Level {
  /** The community the page is. */
  slug: string;
  /** Something below the page's tabs is up: All items, a reply thread. */
  below?: () => boolean;
  /** Take it away: back to the tab it hangs off. */
  up?: () => void;
  /** The page's own element, which says where the page scrolls. */
  host?: () => HTMLElement | null;
  /**
   * #4417: how deep it is. The page says every place but the Hub is below
   * the Hub (depth 1); a reply thread open beside a channel is below the
   * channel (depth 2). A press takes the deepest step first.
   */
  depth?: number;
}

const levels = new Set<Level>();

/** A page says what it knows for as long as it is mounted. Returns the undo. */
export function registerLevel(level: Level): () => void {
  levels.add(level);
  return () => { levels.delete(level); };
}

/** Within this many pixels of its top a page is at its top: a rubber band's pixel is not a scroll. */
export const AT_TOP_PX = 2;

/**
 * The element a page's offset is read and written in. On a phone's browser
 * the DOCUMENT scrolls instead of the page's own scroller, and PlatformUI
 * says when (lib/browser-scroll.ts: "Controllers use PlatformUI.scrollElement()
 * when reading or restoring a page's position").
 */
export function scrollerOf(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  try {
    const ui = (window as unknown as { PlatformUI?: { scrollElement?: (e: HTMLElement) => HTMLElement | null } }).PlatformUI;
    return ui?.scrollElement?.(el) || el;
  } catch {
    return el;
  }
}

export function isScrolled(el: { scrollTop: number } | null): boolean {
  return !!el && el.scrollTop > AT_TOP_PX;
}

/** Up to the top of `el`, gliding there unless reduced motion is asked for. */
export function toTop(el: HTMLElement | null): void {
  if (!el) return;
  let smooth = true;
  try { smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { smooth = true; }
  try {
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      return;
    }
  } catch { /* the plain write below */ }
  el.scrollTop = 0;
}

/** The project page's places (AppView.WORKSHOP_TABS), and a topic's channel (`c:<handle>`, #4417). */
const PAGE_TABS = ['status', 'discussion', 'workshop', 'needs', 'all'];
const CHANNEL_PLACE = /^c:[a-z][a-z0-9-]{0,39}$/;

/**
 * The place a page below the community goes back to: the one last up there
 * (AppView._workshopTab), and for All items the Workshop it hangs off, which
 * is the place lit over it. Anything unreadable is the hub.
 */
export function tabToReturnTo(last: unknown): string {
  if (last === 'all') return 'workshop';
  if (typeof last !== 'string') return 'status';
  return PAGE_TABS.includes(last) || CHANNEL_PLACE.test(last) ? last : 'status';
}

type ViewApi = {
  _onProjectPage?: (slug: string) => boolean;
  _workshopTab?: () => string | null;
  _landOnTab?: (slug: string, tab: string) => void;
};
type AppApi = { currentApp?: string | null; _hubHref?: (slug: string) => string };

function view(): ViewApi | null {
  return (window as unknown as { AppView?: ViewApi }).AppView || null;
}

function app(): AppApi | null {
  return (window as unknown as { App?: AppApi }).App || null;
}

/**
 * Step 1 from a page of its own under the community (a card, a shared
 * change): the community's page, on the tab last up there, at its top, as a
 * new entry. The door every way into a page's tab takes
 * (AppView._landOnTab: the tab remembered, the page's offset forgotten), and
 * the address a card's "‹ Workshop" chip follows
 * (../dev-board/topic/topic-back.tsx), pushed rather than stepped Back to.
 */
export function upToCommunity(slug: string): void {
  const v = view();
  let last: unknown = null;
  try { last = v?._workshopTab?.(); } catch { last = null; }
  try { v?._landOnTab?.(slug, tabToReturnTo(last)); } catch { /* the page opens on the tab it remembers */ }
  let href = '';
  try { href = app()?._hubHref?.(slug) || ''; } catch { href = ''; }
  window.location.hash = href || `#app/${encodeURIComponent(slug)}/workshop`;
}

/**
 * A press of the lit Communities tab. `screen` is the nav store's: the
 * screen root the router last revealed. Returns the rung it took.
 *
 * `stopAtCommunity`: the press of the community's own row in the desktop's
 * sidebar (../nav/rail-communities.tsx, D, 18 Oct 2026), which goes up the
 * community's page the same way and stops at its Hub's top rather than
 * taking the root step to All communities: the sidebar's All row is that.
 */
export function pressLitTab(screen: string | null, { stopAtCommunity = false }: { stopAtCommunity?: boolean } = {}): Rung {
  if (screen === 'workshop-screen') {
    const el = scrollerOf(document.getElementById('workshop-screen'));
    const rung = rungFor('root', isScrolled(el));
    if (rung === 'top') toTop(el);
    return rung;
  }
  // The other screen that lights the tab: a community's own (#app-view on
  // its `dev` tab; the app itself lights none, nor do its change threads).
  if (screen !== 'app-view') return 'none';
  const slug = app()?.currentApp || null;
  if (!slug) return 'none';
  let onPage = false;
  try { onPage = !!view()?._onProjectPage?.(slug); } catch { onPage = false; }
  const mine = [...levels].filter((level) => level.slug === slug);
  // The deepest level that says something is up (#4417): a reply thread
  // beside a channel before the channel's own step up to the Hub.
  const open = onPage
    ? mine
      .filter((level) => { try { return !!level.below?.(); } catch { return false; } })
      .sort((a, b) => (b.depth || 0) - (a.depth || 0))[0]
    : undefined;
  // THE PHONE'S DRAWER: one level of it at a time, rather than up to All
  // communities. What is below a place still goes to it first: a reply
  // thread beside a channel, and a page under a place (All items, the bot's
  // slots, the plan).
  if (drawerStore.get().on) {
    const isBelow = (level: Level) => { try { return !!level.below?.(); } catch { return false; } };
    const thread = onPage ? mine.find((level) => (level.depth || 0) >= 2 && isBelow(level)) : undefined;
    if (thread?.up) {
      thread.up();
      return 'up';
    }
    const under = PAGES_UNDER_A_PLACE.includes(drawerStore.get().shown.place);
    const page = under && onPage ? mine.find((level) => (level.depth || 0) === 1 && level.up) : undefined;
    if (page?.up) {
      page.up();
      return 'up';
    }
    return pressDrawerTab();
  }
  const host = mine.map((level) => level.host?.() || null).find(Boolean) || null;
  const el = scrollerOf(host?.closest<HTMLElement>('#dev-forum-scroll') || null);
  // Off the project page's own address is a page below it: a card, a
  // shared change, the archived chat. On it, All items or a thread is.
  const at: Place = !onPage || open ? 'below' : 'tab';
  const rung = rungFor(at, isScrolled(el));
  if (rung === 'up') {
    if (open?.up) open.up();
    else upToCommunity(slug);
  } else if (rung === 'top') {
    toTop(el);
  } else if (rung === 'root') {
    if (stopAtCommunity) return 'none';
    goToCommunity(null);
  }
  return rung;
}

/**
 * #5040: the votes the tab's blue number counts are already on screen: the
 * community's Needs you place on its page, or, on All communities (no
 * slug), the Communities screen's Needs you feed.
 */
export function onVotes(screen: string | null, slug: string | null): boolean {
  if (!slug) {
    if (screen !== 'workshop-screen') return false;
    try { return (workshopStore.get() as { tab?: string }).tab === 'needs'; } catch { return false; }
  }
  if (screen !== 'app-view' || app()?.currentApp !== slug) return false;
  const shown = placeStore.get();
  return shown.slug === slug && shown.place === 'needs';
}

/**
 * Whether `slug`'s page is the one on screen: the same test `goToCommunity`'s
 * own door makes (./community-scope.ts), and the one fact the votes press
 * needs before moving a page in place.
 */
function pageOnScreen(slug: string): boolean {
  try {
    return app()?.currentApp === slug
      && !!document.querySelector?.('#app-view:not(.hidden) #dev-workshop > .dev-ws');
  } catch {
    return false;
  }
}

/**
 * #5040: a press of the tab while its blue number shows: the list it counts.
 * A community's Needs you place (openPlace moves the page in place when it
 * is up, and is a door with its own entry otherwise), or on All communities
 * the cross-community feed, the page the drawer's own "Needs you" row and a
 * vote digest open.
 *
 * #5700: the page is not always visible when its opener is registered.
 * Leaving it for Messages or Me hides `#app-view` without unmounting the
 * page, so `openPlace`'s in-place move would move a page nobody can see and
 * the press would light the tab with no route behind it. Unless the page is
 * genuinely on screen, this takes the door.
 */
export function goToVotes(slug: string | null): void {
  closeSwitcher();
  if (slug) {
    openPlace(slug, 'needs', { door: !pageOnScreen(slug) });
    return;
  }
  const w = window as unknown as { UsernodeReact?: { workshop?: { setTab?: (tab: string) => void } } };
  try { w.UsernodeReact?.workshop?.setTab?.('needs'); } catch { /* the screen opens on its list */ }
  if (window.location.hash !== '#communities') window.location.hash = '#communities';
}
