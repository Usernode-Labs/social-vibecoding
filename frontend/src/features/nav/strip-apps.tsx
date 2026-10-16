/**
 * #platform-strip-apps — your pinned apps, then the recent ones, on the
 * desktop strip (#4417, #4935).
 *
 * ── It replaces Recents ──────────────────────────────────────────────
 *
 * The desktop rail was 224px of sections, then Recents (#2802): the apps you
 * left and the conversations you were in, on one clock, with the running
 * apps above them under Active (#3074). The rail is a 76px strip now, the
 * four sections as an icon over a label, and the column beside it holds what
 * the section on screen needs (./section-column.tsx): a project's places in
 * Communities, the conversation list in Messages. So the conversations went
 * home to Messages' own list, where every one of them already was, and what
 * is left here is the apps: the five you used last, newest first, each its
 * own tile over its name.
 *
 * ── The pinned part (#5323) ──────────────────────────────────────────
 *
 * The strip no longer copies My apps. Its top part holds the apps YOU pinned
 * there, by dragging a My apps tile onto it while the "Pin here" slot is up
 * (./pinned-apps-store.js keeps the list; Home's drag recognizer names the
 * drop through the nav bridge). It starts empty for everyone, so a strip
 * with nothing pinned shows only recents. A pinned app is never listed a
 * second time: the one on screen stays in its pinned slot and stays lit.
 * Unpin by dragging the pinned tile back out of the rail, or by Unpin in its
 * right-click menu — the same small menu a My apps tile opens.
 *
 * ── Still open ───────────────────────────────────────────────────────
 *
 * The last few apps opened stay running in hidden frames
 * (../app-frame/app-frame-store.js `kept`, up to keepAliveLimit()), so going
 * back to one is instant and shows it as it was left. Those carry the green
 * dot (../app-frame/live-apps.tsx), and their name says "still open" to a
 * screen reader. The app on screen is the one lit (`aria-current`).
 *
 * ── Where an app goes when it closes ─────────────────────────────────
 *
 * Its tile here is where a closed app shrinks to and where a resumed one
 * grows out of on the desktop (./resume-motion.ts resumeHandleFor): pressing
 * it notes it as the zoom's origin, as Recents' Resume pill did (#3618).
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The root ships EMPTY and `hidden`; the apps arrive from localStorage after
 * hydration, one commit after mount, so the prerendered document and the
 * first client render agree. `hidden` goes through useHiddenClass.
 *
 * ── The scroll cue (#4738) ───────────────────────────────────────────
 *
 * On a short window the list scrolls under the settings cog with no sign of
 * it (the scrollbar is hidden on purpose), so a bottom fade is drawn instead
 * — `data-more`, set post-mount only when more apps sit below the fold and
 * cleared once the list is scrolled to its end. It never ships in the
 * prerender: the attribute is absent from the first render, so the
 * prerendered document and the first client render still agree.
 */

import { useEffect, useRef, useState,
  type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useMessages } from '../../lib/i18n/react';
import { listText } from '../../lib/i18n/runtime';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { liveAppLabel, LiveAppDot, useCurrentAppSlug, useLiveAppSlugs } from '../app-frame/live-apps';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from './nav-store.js';
import { pinDropStore, pinnedAppsStore, readPinnedApps, unpinApp } from './pinned-apps-store.js';
import { readRecentApps, recentAppsStore } from './recent-apps-store.js';
import { noteResumeOrigin } from './resume-motion';

/** How many apps the strip shows. */
export const STRIP_APPS = 5;

/** An app you used, as ./recent-apps-store.js keeps it. */
export interface StripApp {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  at?: string;
  /** In the strip's pinned part: an app the viewer pinned there (#5323). */
  pinned?: boolean;
}

/**
 * The strip's apps, at most STRIP_APPS, each once: the pinned apps first
 * (#4935, `pinned` — never more than limit - 1 of them, so the rest of the
 * strip keeps at least one slot), then the app you are in, even before it
 * has ever been left (its header record names it, `current`); then the apps
 * still running behind it (`live`, the frame store's order, named from the
 * stored list where it has them, else by slug); then the rest of the stored
 * list, the most recently used first. A pinned slug is never repeated by a
 * later part. Pure.
 */
export function stripApps(
  apps: StripApp[],
  current: StripApp | null = null,
  live: string[] = [],
  limit: number = STRIP_APPS,
  pinned: StripApp[] = [],
): StripApp[] {
  const out: StripApp[] = [];
  const push = (app: StripApp | null | undefined, pinnedSlot = false) => {
    if (!app || !app.slug || out.some((a) => a.slug === app.slug)) return;
    out.push({ ...app, name: app.name || app.slug, ...(pinnedSlot ? { pinned: true } : null) });
  };
  for (const app of pinned.slice(0, Math.max(0, limit - 1))) push(app, true);
  push(current);
  for (const slug of live) {
    push(apps.find((a) => a.slug === slug) || { slug, name: slug, iconUrl: null, iconEmoji: null });
  }
  const dated = apps.slice().sort((a, b) => {
    const diff = Date.parse(b.at || '') - Date.parse(a.at || '');
    return Number.isNaN(diff) ? 0 : diff;
  });
  for (const app of dated) push(app);
  return out.slice(0, Math.max(0, limit));
}

/**
 * The app ON SCREEN, which is the only app lit (#3096), or null.
 *
 * NOT the mounted frame on its own: the frame store's `slug` stays set while
 * the frame is mounted, which outlasts every way of leaving but Home (a tab,
 * the app's own Workshop, its discussion). The router's answer decides: the
 * app is on screen only while its screen is `#app-view` AND no tab is lit
 * (`#app-view` with a tab lit is the app's Workshop, where the lit tab is
 * the strip's one "you are here").
 */
export function currentAppOnScreen(input: {
  /** The mounted frame's slug, '' or null when none is. */
  frameSlug: string | null;
  /** navStore's `screen`: the root the router last revealed. */
  screen: string | null;
  /** navStore's `tab`: the tab that screen lights, or null. */
  tab: string | null;
}): string | null {
  if (input.screen !== 'app-view' || input.tab) return null;
  return input.frameSlug || null;
}

function onAppClick(event: MouseEvent<HTMLAnchorElement>, slug: string, live: boolean): void {
  const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
  if (nav?.isNativeClick?.(event)) return;
  event.preventDefault();
  // #3618: a running app grows back out of the tile that was pressed.
  if (live) noteResumeOrigin(slug, event.currentTarget.querySelector('.platform-strip-tile') || event.currentTarget);
  // The router's "this app, this tab" entry point: it switches to an app
  // that is still open and navigates to any other.
  (window as unknown as { App?: { openAppTab?: (slug: string, tab: string) => void } }).App?.openAppTab?.(slug, 'app');
}

export function StripApps() {
  const t = useMessages('core');
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [more, setMore] = useState(false);
  const { apps } = useStoreState(recentAppsStore);
  const { apps: pinned } = useStoreState(pinnedAppsStore);
  // The "Pin here" slot's state while a My apps tile is in the air (#5323),
  // named by Home's drag recognizer through the bridge. null the rest of the
  // time — which is also the hydration state: nothing sets it but a drag.
  const { drop } = useStoreState(pinDropStore);
  const live = useLiveAppSlugs();
  const frameSlug = useCurrentAppSlug();
  const improve = useStoreState(improveStore);
  const { viewer, screen, tab } = useStoreState(navStore);
  const on = currentAppOnScreen({ frameSlug, screen, tab });

  // ── Dragging a pinned app back OUT (#5323) ─────────────────────────
  // Mouse-only: touch lifts open the card menu instead. Past 6px the row
  // captures the pointer and a ghost follows it; while the ghost is outside
  // #platform-tabs it carries the "Unpin" caption, and letting go there
  // unpins. Letting go inside the rail does nothing, Escape and a cancelled
  // pointer abort, and the click the release would otherwise turn into is
  // swallowed. React state only — the ghost is null on first render, so the
  // prerender is untouched.
  const [ghost, setGhost] = useState<{
    app: StripApp; x: number; y: number; unpin: boolean;
  } | null>(null);
  const dragRef = useRef<{ app: StripApp; startX: number; startY: number; active: boolean } | null>(null);
  const swallowClickRef = useRef(false);

  useEffect(() => {
    if (!ghost) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      dragRef.current = null;
      setGhost(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ghost]);

  const insideTabs = (x: number, y: number): boolean => {
    const tabs = document.getElementById('platform-tabs');
    if (!tabs || typeof tabs.getBoundingClientRect !== 'function') return false;
    const r = tabs.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  const endDrag = () => {
    dragRef.current = null;
    setGhost(null);
  };
  const pinnedPointerDown = (event: PointerEvent<HTMLAnchorElement>, app: StripApp) => {
    if (event.button !== 0 || event.pointerType !== 'mouse') return;
    dragRef.current = { app, startX: event.clientX, startY: event.clientY, active: false };
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a drag needs no capture to try */ }
  };
  const pinnedPointerMove = (event: PointerEvent<HTMLAnchorElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.active
      && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 6) return;
    drag.active = true;
    setGhost({
      app: drag.app,
      x: event.clientX,
      y: event.clientY,
      unpin: !insideTabs(event.clientX, event.clientY),
    });
  };
  const pinnedPointerUp = (event: PointerEvent<HTMLAnchorElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.active) {
      // The release must not ALSO open the app the row links to.
      swallowClickRef.current = true;
      if (!insideTabs(event.clientX, event.clientY)) {
        unpinApp(drag.app.slug, navStore.get().viewer);
      }
    }
    endDrag();
  };

  // POST-MOUNT, for hydration. The stored apps are read by ./mount.ts when
  // the router names the viewer, since the list is theirs; this covers a
  // viewer named before the island hydrated. The pinned part (#4935) is read
  // the same way, from Home's published list.
  useEffect(() => {
    setMounted(true);
    const who = navStore.get().viewer;
    if (who && !recentAppsStore.get().apps.length) {
      const stored = readRecentApps(who);
      if (stored.length) recentAppsStore.set({ apps: stored });
    }
    if (who && !pinnedAppsStore.get().apps.length) {
      const stored = readPinnedApps(who);
      if (stored.length) pinnedAppsStore.set({ apps: stored });
    }
  }, []);

  // The open app's header record names it before it has ever been left.
  const current: StripApp | null = on
    ? (apps.find((a: StripApp) => a.slug === on)
      || (improve.slug === on ? { slug: on, name: improve.name || on, iconUrl: improve.iconUrl || null, iconEmoji: improve.iconEmoji || null } : { slug: on, name: on, iconUrl: null, iconEmoji: null }))
    : null;
  const items = mounted && viewer
    ? stripApps(apps as StripApp[], current, live, STRIP_APPS, pinned as StripApp[])
    : [];
  // The slot must be there to drop ON, so the strip stays visible while a
  // tile is in the air even when the list itself is empty; an empty settle
  // hides it again.
  useHiddenClass(ref, items.length === 0 && !drop);

  // THE SCROLL CUE (#4738): the fade shows only while apps sit below the
  // fold. Keyed on the rendered slugs so a change of list re-checks; the
  // ResizeObserver covers a window resize and a row growing to two lines.
  // The root is `display: none` when the strip is hidden, so the check reads
  // zero sizes there and clears the fade. Absent from the prerender.
  const slugKey = items.map((a) => a.slug).join();
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, [slugKey]);

  // THE "PIN HERE" SLOT (#5323). One row while a My apps tile is in the air,
  // drawn after the pinned rows and before the rest — it IS the pinned
  // part's edge then, and app.css draws the hairline on it. The refused
  // states say what a drop would do instead of doing it.
  const dropLabel = drop === 'already' ? t('core:stripApps.drop.already')
    : drop === 'full' ? t('core:stripApps.drop.full')
      : t('core:stripApps.drop.pin');
  const dropRow = drop ? (
    <div
      key="strip-drop"
      className="platform-strip-drop"
      data-strip-drop=""
      data-drop-state={drop}
    >
      <span className="platform-strip-drop-tile" aria-hidden="true" />
      <span className="platform-strip-drop-label">{dropLabel}</span>
    </div>
  ) : null;

  const renderRow = (app: StripApp) => {
    const running = live.includes(app.slug);
    const lit = app.slug === on;
    const record = { icon_url: app.iconUrl, icon_emoji: app.iconEmoji, name: app.name };
    return (
      <a
        key={app.slug}
        className="platform-strip-app"
        href={`/app/${encodeURIComponent(app.slug)}`}
        data-strip-app={app.slug}
        // The pinned part's edge is where the hairline between the two
        // groups is drawn (app.css): the last pinned row before a non-pinned
        // one, or before the "Pin here" slot while it is up.
        {...(app.pinned ? { 'data-strip-pinned': 'true' } : null)}
        title={app.name}
        // A kept-alive app says so aloud after its name: two facts, joined
        // the way the language joins them.
        aria-label={running ? listText([app.name, liveAppLabel()]) : undefined}
        aria-current={lit ? 'page' : undefined}
        {...(running ? { 'data-live': 'true' } : null)}
        onClick={(event) => {
          // A drag-out ends with a click on the row it started from; that
          // click must not open the app (a plain click never sets it).
          if (app.pinned && swallowClickRef.current) {
            swallowClickRef.current = false;
            event.preventDefault();
            return;
          }
          onAppClick(event, app.slug, running && !lit);
        }}
        // Unpin is in the same small menu a My apps tile opens (#5323).
        {...(app.pinned ? {
          onContextMenu: (event: MouseEvent<HTMLAnchorElement>) => {
            event.preventDefault();
            const ui = (window as unknown as {
              PlatformUI?: { menu?: (opts: unknown) => unknown };
            }).PlatformUI;
            ui?.menu?.({
              anchorEl: event.currentTarget,
              title: app.name,
              items: [{
                label: t('core:stripApps.menu.unpin'),
                handler: () => { unpinApp(app.slug, navStore.get().viewer); },
              }],
            });
          },
          onPointerDown: (event: PointerEvent<HTMLAnchorElement>) => pinnedPointerDown(event, app),
          onPointerMove: pinnedPointerMove,
          onPointerUp: pinnedPointerUp,
          onPointerCancel: endDrag,
        } : null)}
      >
        <span className="platform-strip-mark">
          <span className="app-icon-tile platform-strip-tile" data-icon={appIconKind(record)} aria-hidden="true">
            <AppIconContent app={record} />
          </span>
          {running ? <LiveAppDot className="platform-strip-live" /> : null}
        </span>
        <span className="platform-strip-label">{app.name}</span>
      </a>
    );
  };

  // Pinned rows first, the slot after them (it leads when nothing is pinned
  // and is the whole strip when the list is empty), then the rest.
  const rows: ReactNode[] = [];
  let dropPlaced = false;
  for (const app of items) {
    if (dropRow && !app.pinned && !dropPlaced) {
      rows.push(dropRow);
      dropPlaced = true;
    }
    rows.push(renderRow(app));
  }
  if (dropRow && !dropPlaced) rows.push(dropRow);

  return (
    <>
      <div
        ref={ref}
        id="platform-strip-apps"
        className="platform-strip-apps hidden"
        role="group"
        aria-label={t('core:stripApps.label')}
        data-more={more ? 'true' : undefined}
      >
        {rows}
      </div>
      {/* THE DRAGGED PINNED TILE (#5323). Portaled to the body, because the
          rail clips what it holds and a ghost must cross it. The "Unpin"
          caption rides along only while the ghost is outside the rail —
          that is the state whose release takes the app off. */}
      {ghost ? createPortal(
        <span
          className="platform-strip-ghost"
          style={{ left: ghost.x, top: ghost.y }}
          data-unpin={ghost.unpin ? 'true' : undefined}
          aria-hidden="true"
        >
          <span className="app-icon-tile platform-strip-tile" data-icon={appIconKind({
            icon_url: ghost.app.iconUrl, icon_emoji: ghost.app.iconEmoji, name: ghost.app.name,
          })}>
            <AppIconContent app={{
              icon_url: ghost.app.iconUrl, icon_emoji: ghost.app.iconEmoji, name: ghost.app.name,
            }} />
          </span>
          {ghost.unpin ? (
            <span className="platform-strip-ghost-caption">{t('core:stripApps.ghost.unpin')}</span>
          ) : null}
        </span>,
        document.body,
      ) : null}
    </>
  );
}
