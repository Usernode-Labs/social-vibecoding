/**
 * THE PHONE'S NAVIGATION DRAWER (Evan's design, 18 Oct 2026).
 *
 * Under the Communities tab, under 768px, a community's page is the deepest
 * of three levels side by side on one strip:
 *
 *   0  your communities (./outer-level.tsx), 85% wide, the places peeking
 *   1  the community's places (../dev-board/workshop/project-places.tsx,
 *      the list the tray held), 80% wide, the page peeking
 *   2  the place's page: #app-view, the page as it always was
 *
 * The header's back arrow goes up a level, the lit Communities tab goes up
 * one at a time, and a press on whatever peeks in from the right goes to it.
 * The strip follows a finger: a sideways drag anywhere on levels 0 and 1, and
 * on the page one that starts at the left edge (EDGE_PX, as the tray had),
 * except in Safari on an iPhone, where that edge is the browser's own Back.
 * Let go past a quarter of the way into a level and it lands there. It
 * replaced the places tray on the phone; a wide window keeps the section
 * column beside the strip, and nothing here draws there.
 *
 * A GESTURE SURFACE, NOT A PAGE SLIDE. The phone swaps pages in place
 * (tests/phone-no-page-slides.test.js, PlatformUI.transition); this moves
 * no route. Levels 0 and 1 are not addresses: they hold a Back record
 * instead (./drawer-store.ts). A press on a place or on another community
 * navigates as it always did, and the drawer slides home over it.
 *
 * HOW IT MOVES, ON iOS. Transform and opacity only, on a strip fixed between
 * the header's foot and the tab bar, and on #app-view itself while the page
 * is off its rest. At rest on the page #app-view carries no transform at all
 * (not even `none`'s translate(0)): a transformed ancestor re-anchors every
 * fixed descendant to it. A switch of community starts the slide first and
 * the route a frame or two later (`afterSlideStarts`), so the swap's main-
 * thread work cannot hold the slide's first frames.
 *
 * Nothing in the prerendered shell: the island draws only once the phone's
 * width and the route are known, into `document.body`, from state that
 * changes after the first paint.
 */

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { pushDismissible } from '../../lib/back-stack';
import { useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { audienceLine, cachedCommunity, useCachedCommunity } from '../dev-board/workshop/community-card';
import { isPlaceKey, liveTopics, type PlaceKey } from '../dev-board/workshop/places';
import { openPlace, placeStore } from '../dev-board/workshop/place-store';
import { pageTakesEdge } from '../dev-board/workshop/places-tray';
import { ProjectPlaces } from '../dev-board/workshop/project-places';
import { useDevViewMode } from '../dev-board/view-mode-store';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';
import type { WorkshopRow } from '../workshop/index';
import {
  depthAt, EDGE_PX, isPan, keepPlace, landing, LEVEL_AT, PAN_SLOP_PX, SLIDE_EASE, SLIDE_MS, type Level,
} from './drawer-math';
import {
  drawerStore, go, holdBack, letGoBack, registerSurface, setBackRecords, setDepth, setMoving, setOn, setPending,
  setSearching, setShown,
} from './drawer-store';
import { pageLabel } from './header-drawer';
import { OuterLevel } from './outer-level';

const PHONE_QUERY = '(max-width: 767.98px)';

// Levels 0 and 1 hold a Back record, as a sheet does (./drawer-store.ts).
setBackRecords((close) => pushDismissible(close));

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
 * Whether the drawer applies. A phone, the app view on show, and on it a
 * community's own page (its Dev half, in the Workshop layout: not the
 * running app, a card or a change under it, or the Kanban board) — or a
 * community picked on level 0 whose page is still on its way, while the
 * header's record of the app is cleared for the load. Pure.
 */
export function drawerApplies(at: {
  phone: boolean; screen: string | null; slug: string | null; tab: string | null; subTab: string | null;
  viewMode: string; pending: boolean;
}): boolean {
  if (!at.phone || at.screen !== 'app-view') return false;
  if (at.pending) return true;
  return !!at.slug && at.tab === 'dev' && at.subTab === 'forum' && at.viewMode === 'workshop';
}

/** Two frames, so the slide is on the compositor before heavy work runs; never later than `capMs`. */
export function afterSlideStarts(run: () => void, capMs = 120): void {
  if (typeof requestAnimationFrame !== 'function') {
    run();
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    run();
  };
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, capMs);
}

export function NavDrawer(): ReactNode {
  const phone = usePhone();
  const { screen } = useStoreState(navStore) as { screen: string | null };
  const improve = useStoreState(improveStore) as {
    slug: string | null; tab: string | null; subTab: string | null; name: string | null; selfHosted: boolean;
  };
  const viewMode = useDevViewMode();
  const drawer = useStoreState(drawerStore);
  const placed = useStoreState(placeStore);
  const pending = drawer.pending;
  const on = drawerApplies({
    phone, screen, slug: improve.slug, tab: improve.tab, subTab: improve.subTab, viewMode, pending: !!pending,
  });

  // Before paint, so the header draws the drawer's arrow and titles in the
  // same frame the route lands in.
  useIsomorphicLayoutEffect(() => { setOn(on); }, [on]);
  useIsomorphicLayoutEffect(() => {
    if (!on || typeof document === 'undefined') return undefined;
    const root = document.documentElement;
    root.setAttribute('data-nav-drawer', '');
    return () => root.removeAttribute('data-nav-drawer');
  }, [on]);

  // The community the drawer shows: one picked on level 0 until its page is
  // up, else the page's own.
  const slug = pending ? pending.slug : improve.slug;
  const pageUp = !!slug && placed.slug === slug;
  const place = pending ? pending.place : (pageUp ? placed.place : rememberedPlace());
  const name = pending ? pending.name : (improve.name || slug || '');
  const selfHosted = pending ? pending.selfHosted : !!improve.selfHosted;
  useIsomorphicLayoutEffect(() => {
    setShown({ slug: slug || null, name, selfHosted, place });
  }, [slug, name, selfHosted, place]);

  // A picked community is the page's once the page is up for it (or the
  // app view has gone, or it never came).
  useEffect(() => {
    if (!pending) return undefined;
    if (screen !== 'app-view') {
      setPending(null);
      return undefined;
    }
    const tabUp = improve.slug === pending.slug && improve.tab === 'dev' && placed.slug === pending.slug;
    if (tabUp) {
      setPending(null);
      return undefined;
    }
    const timer = window.setTimeout(() => setPending(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [pending, screen, improve.slug, improve.tab, placed.slug]);

  if (!on || !slug || typeof document === 'undefined') return null;
  return createPortal(
    <DrawerSurface slug={slug} name={name} place={place} owed={pageUp ? placed.owed : 0} />,
    document.body,
  );
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

function appView(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.getElementById('app-view');
}

function screenWidth(): number {
  return Math.max(1, document.documentElement.clientWidth || window.innerWidth || 1);
}

function DrawerSurface({ slug, name, place, owed }: { slug: string; name: string; place: string; owed: number }): ReactNode {
  const t = useMessages('communities');
  const { level, searching, moving } = useStoreState(drawerStore);
  const community = useCachedCommunity(slug);
  const rootRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const coverRef = useRef<HTMLButtonElement>(null);
  const outerListRef = useRef<HTMLDivElement>(null);
  const settle = useRef(0);
  // Level 0's list is drawn the first time it is wanted, then kept.
  const [warm, setWarm] = useState(false);
  useEffect(() => { if (level < 2 || moving) setWarm(true); }, [level, moving]);
  // The arrow has no level 0 to show on: focus that pressed it moves onto
  // the community you are on in the list (never the search, which would
  // raise a keyboard).
  useEffect(() => {
    if (level !== 0) return;
    const active = document.activeElement as HTMLElement | null;
    if (!active || !active.matches?.('[data-nav-drawer-back]')) return;
    const here = rootRef.current?.querySelector<HTMLElement>('.nav-drawer-outer [aria-current="true"]')
      || outerListRef.current;
    here?.focus({ preventScroll: true });
  }, [level, warm]);

  // ── Putting the strip and the page somewhere ──
  const put = (offset: number, transition: string, pageToo = true) => {
    const w = screenWidth();
    const strip = stripRef.current;
    const cover = coverRef.current;
    const x = -offset * w;
    const pageX = (LEVEL_AT[2] - offset) * w;
    if (strip) {
      strip.style.transition = transition;
      strip.style.transform = `translate3d(${x}px, 0, 0)`;
    }
    if (cover) {
      cover.style.transition = transition;
      cover.style.transform = `translate3d(${pageX}px, 0, 0)`;
    }
    const page = appView();
    if (page && pageToo) {
      page.style.transition = transition;
      page.style.transform = `translate3d(${pageX}px, 0, 0)`;
    }
  };
  const restPage = () => {
    window.clearTimeout(settle.current);
    settle.current = 0;
    const page = appView();
    if (page) {
      page.style.transition = '';
      page.style.transform = '';
    }
  };
  const placeAt = (to: Level, cut: boolean) => {
    window.clearTimeout(settle.current);
    settle.current = 0;
    const transition = cut ? 'none' : `transform ${SLIDE_MS}ms ${SLIDE_EASE}`;
    put(LEVEL_AT[to], transition, !(to === 2 && cut));
    if (to !== 2) return;
    if (cut) {
      restPage();
      setMoving(false);
      return;
    }
    // Home: the page loses its transform once the slide has run.
    settle.current = window.setTimeout(() => {
      settle.current = 0;
      restPage();
      setMoving(false);
    }, SLIDE_MS + 40);
  };
  const placeRef = useRef(placeAt);
  placeRef.current = placeAt;

  useIsomorphicLayoutEffect(() => {
    // Where it starts: on the page, at rest, nothing on #app-view.
    put(LEVEL_AT[drawerStore.get().level], 'none', drawerStore.get().level !== 2);
    const undo = registerSurface({
      place: (to, cut) => placeRef.current(to, cut),
      outerList: () => outerListRef.current,
    });
    const onResize = () => {
      const s = drawerStore.get();
      put(LEVEL_AT[s.level], 'none', s.level !== 2);
    };
    window.addEventListener('resize', onResize);
    return () => {
      undo();
      window.removeEventListener('resize', onResize);
      restPage();
    };
  }, []);

  // ── A finger on levels 0 and 1 ──
  const pan = useRef<null | { id: number; x0: number; y0: number; from: Level; w: number; on: boolean; dx: number }>(null);
  const swallowClick = useRef(false);
  const follow = (offset: number) => {
    put(offset, 'none');
    setDepth(depthAt(offset));
  };
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = drawerStore.get();
    if (!e.isPrimary || e.button !== 0 || s.searching || s.level === 2) return;
    pan.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from: s.level, w: screenWidth(), on: false, dx: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || e.pointerId !== p.id) return;
    const dx = e.clientX - p.x0;
    const dy = e.clientY - p.y0;
    if (!p.on) {
      if (!isPan(dx, dy)) {
        if (Math.abs(dy) > PAN_SLOP_PX * 2) pan.current = null;
        return;
      }
      p.on = true;
      try { rootRef.current?.setPointerCapture(e.pointerId); } catch { /* not every pointer can be captured */ }
      // A mouse dragging the strip would select the lists' words as it went.
      if (rootRef.current) rootRef.current.style.userSelect = 'none';
      setMoving(true);
    }
    p.dx = dx;
    follow(Math.max(0, Math.min(LEVEL_AT[2], LEVEL_AT[p.from] - dx / p.w)));
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    pan.current = null;
    if (!p || e.pointerId !== p.id || !p.on) return;
    if (rootRef.current) rootRef.current.style.userSelect = '';
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, 0);
    const offset = Math.max(0, Math.min(LEVEL_AT[2], LEVEL_AT[p.from] - p.dx / p.w));
    go(landing(p.from, offset, p.dx));
  };

  // ── A finger at the page's left edge ──
  useEffect(() => {
    if (!pageTakesEdge()) return undefined;
    let p: null | { x0: number; y0: number; w: number; on: boolean; dx: number } = null;
    const move = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!p || !touch) return;
      const dx = touch.clientX - p.x0;
      const dy = touch.clientY - p.y0;
      if (!p.on) {
        if (isPan(dx, dy) && dx > 0) {
          p.on = true;
          setMoving(true);
        } else if (Math.abs(dy) > PAN_SLOP_PX || dx < -PAN_SLOP_PX) {
          stop();
          return;
        } else {
          return;
        }
      }
      if (e.cancelable) e.preventDefault();
      p.dx = dx;
      follow(Math.max(0, Math.min(LEVEL_AT[2], LEVEL_AT[2] - dx / p.w)));
    };
    const stop = () => {
      p = null;
      document.removeEventListener('touchmove', move);
    };
    const down = (e: TouchEvent) => {
      const touch = e.touches[0];
      const s = drawerStore.get();
      stop();
      if (!s.on || s.level !== 2 || s.moving || e.touches.length !== 1 || !touch || touch.clientX > EDGE_PX) return;
      const target = e.target as Element | null;
      if (!target || !target.closest?.('#app-view')) return;
      p = { x0: touch.clientX, y0: touch.clientY, w: screenWidth(), on: false, dx: 0 };
      document.addEventListener('touchmove', move, { passive: false });
    };
    const up = () => {
      const was = p;
      stop();
      if (!was || !was.on) return;
      const offset = Math.max(0, Math.min(LEVEL_AT[2], LEVEL_AT[2] - was.dx / was.w));
      go(landing(2, offset, was.dx));
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    document.addEventListener('touchcancel', up, { passive: true });
    return () => {
      stop();
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
      document.removeEventListener('touchcancel', up);
    };
  }, []);

  // ── Presses ──
  const choosePlace = (key: PlaceKey) => {
    // The press pushes an entry of its own (the page's place, #3620), so the
    // Back record is left under it rather than spent.
    letGoBack(true);
    openPlace(slug, key);
    go(2, { navigating: true });
  };
  const pick = (row: WorkshopRow) => {
    const s = drawerStore.get();
    if (s.searching) setSearching(false);
    if (row.slug === slug) {
      go(1);
      return;
    }
    // The place you were on, if this community has it (its record, when it
    // has been read; a topic it is not known to have is its Hub).
    const topics = cachedTopics(row.slug);
    const keep = keepPlace(drawerStore.get().shown.place, topics);
    setPending({ slug: row.slug, name: row.name || row.slug, selfHosted: !!row.self_hosted, place: keep });
    go(1);
    afterSlideStarts(() => {
      const w = window as unknown as {
        AppView?: { _landOnTab?: (slug: string, tab: string) => void };
        App?: { navigateToApp?: (slug: string, tab: string) => unknown };
      };
      letGoBack(true);
      try { w.AppView?._landOnTab?.(row.slug, keep); } catch { /* the page opens on its hub */ }
      void w.App?.navigateToApp?.(row.slug, 'dev');
      // Still off the page: Back returns to it, the new one now.
      if (drawerStore.get().level < 2) holdBack();
    });
  };

  const cls = ['nav-drawer'];
  if (level === 2 && !moving) cls.push('is-resting');
  if (searching) cls.push('is-searching');
  const placesPeek = level === 0 && !searching;
  const pageName = pageLabel(place);
  return (
    <div
      ref={rootRef}
      className={cls.join(' ')}
      data-nav-drawer-level={level}
      aria-hidden={level === 2 && !moving ? true : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div ref={stripRef} className="nav-drawer-strip">
        <section
          className="nav-drawer-outer"
          data-nav-drawer-outer=""
          aria-label={t('communities:drawer.outer.name')}
          inert={level !== 0}
        >
          {warm ? (
            <OuterLevel current={slug} searching={searching} wanted={level < 2 || moving} onPick={pick} listRef={outerListRef} />
          ) : null}
        </section>
        <section
          className={placesPeek ? 'nav-drawer-places is-peek' : 'nav-drawer-places'}
          data-nav-drawer-places=""
          aria-label={t('communities:drawer.places.name', { community: name })}
          inert={level === 2 && !moving}
          onClick={placesPeek ? () => go(1) : undefined}
        >
          <div className="nav-drawer-places-scroll" inert={level !== 1}>
            <div className="nav-drawer-who">
              <b className="nav-drawer-who-name">{name}</b>
              {community ? <span className="nav-drawer-who-line">{audienceLine(community)}</span> : null}
            </div>
            <ProjectPlaces
              slug={slug}
              name={name}
              place={place as PlaceKey}
              owed={owed}
              places={community?.places}
              onPlace={choosePlace}
            />
          </div>
        </section>
      </div>
      <button
        ref={coverRef}
        type="button"
        className="nav-drawer-cover"
        data-nav-drawer-cover=""
        tabIndex={level === 1 ? 0 : -1}
        aria-label={t('communities:drawer.peek.page', { page: pageName })}
        onClick={() => go(2)}
      />
    </div>
  );
}

/** The live topics' handles in a community's record, or null when it has not been read. */
function cachedTopics(slug: string): string[] | null {
  const record = cachedCommunity(slug);
  return record ? liveTopics(record.places).map((c) => String(c.handle || '')) : null;
}
