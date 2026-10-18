/**
 * #platform-rail-pinned — the communities you pinned, in the desktop's
 * sidebar of rows (18 Oct 2026; ./sidebar-rows.ts).
 *
 * ── What it is ───────────────────────────────────────────────────────
 *
 * Under a Pinned heading, above Communities: the ones you chose to keep in
 * the sidebar, each drawn as any community is (./rail-communities.tsx
 * RailCommunityRow), its App row first, its places under it while you are in
 * it. They are not among the five under Communities, which are the most
 * recent of the rest, so a pin never pushes one of those out.
 *
 * A PIN IS A COMMUNITY'S, and it used to be an app's: the sidebar listed
 * Pinned and Recent apps apart from the communities (#5323). A community and
 * its app are one to one, so the pins ./pinned-apps-store.js has kept since
 * are the same slugs and carry over as they are: an app pinned before is its
 * community's pin now. Four at most, as before.
 *
 * ── Pinning and unpinning (#5323) ────────────────────────────────────
 *
 * Pin by dragging a My apps tile onto the section while the "Pin here" slot
 * is up (Home's drag recognizer names the drop through the nav bridge, and
 * hit-tests this element). Unpin by Unpin in a pinned row's right-click menu,
 * the same small menu a My apps tile opens, or by dragging the row back out
 * of the sidebar.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * The root ships with its heading and no rows, and `hidden`; the pins arrive
 * from localStorage after hydration (./mount.ts reads them when the router
 * names the viewer, and an effect here covers a viewer named before the
 * island hydrated). `hidden` goes through useHiddenClass. app.css draws it
 * from 768px only.
 */

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';

import { useMessages } from '../../lib/i18n/react';
import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { navStore } from './nav-store.js';
import { pinDropStore, pinnedAppsStore, readPinnedApps, unpinApp } from './pinned-apps-store.js';
import { RailCommunityRow, useRailHere, type PinnedRowHandlers } from './rail-communities';

/** A pin, as ./pinned-apps-store.js keeps it: the slug, and a name and face to draw before anything loads. */
interface PinnedApp {
  slug: string;
  name: string;
  iconUrl: string | null;
  iconEmoji: string | null;
}

export function RailPinned() {
  const t = useMessages('core');
  const ref = useRef<HTMLDivElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const { apps: pins } = useStoreState(pinnedAppsStore);
  // The "Pin here" slot's state while a My apps tile is in the air (#5323),
  // named by Home's drag recognizer through the bridge. null the rest of the
  // time, which is also the hydration state: nothing sets it but a drag.
  const { drop } = useStoreState(pinDropStore);
  const { viewer } = useStoreState(navStore);
  const here = useRailHere();

  // POST-MOUNT, for hydration: a viewer named before the island hydrated.
  useEffect(() => {
    setMounted(true);
    const who = navStore.get().viewer;
    if (who && !pinnedAppsStore.get().apps.length) {
      const stored = readPinnedApps(who);
      if (stored.length) pinnedAppsStore.set({ apps: stored });
    }
  }, []);

  const items = (mounted && viewer ? pins : []) as PinnedApp[];
  // The slot must be there to drop ON, so the section shows while a tile is
  // in the air even with nothing pinned; an empty settle hides it again.
  useHiddenClass(ref, items.length === 0 && !drop);

  // ── Dragging a pinned row back OUT (#5323) ─────────────────────────
  // Mouse-only: a touch opens nothing here. Past 6px the row captures the
  // pointer and a ghost follows it; while the ghost is outside #platform-tabs
  // it carries the "Unpin" caption, and letting go there unpins. Letting go
  // inside the sidebar does nothing, Escape and a cancelled pointer abort,
  // and the click the release would otherwise turn into is swallowed. React
  // state only: the ghost is null on first render, so the prerender is
  // untouched.
  const [ghost, setGhost] = useState<{ app: PinnedApp; x: number; y: number; unpin: boolean } | null>(null);
  const dragRef = useRef<{ app: PinnedApp; startX: number; startY: number; active: boolean } | null>(null);
  const swallowClickRef = useRef(false);

  useEffect(() => {
    if (!ghost) return undefined;
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
  const handlers = (app: PinnedApp): PinnedRowHandlers => ({
    // Unpin is in the same small menu a My apps tile opens (#5323).
    onContextMenu: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      const ui = (window as unknown as { PlatformUI?: { menu?: (opts: unknown) => unknown } }).PlatformUI;
      ui?.menu?.({
        anchorEl: event.currentTarget,
        title: app.name,
        items: [{
          label: t('core:rail.pin.unpin'),
          handler: () => { unpinApp(app.slug, navStore.get().viewer); },
        }],
      });
    },
    onPointerDown: (event: PointerEvent<HTMLAnchorElement>) => {
      if (event.button !== 0 || event.pointerType !== 'mouse') return;
      dragRef.current = { app, startX: event.clientX, startY: event.clientY, active: false };
      try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a drag needs no capture to try */ }
    },
    onPointerMove: (event: PointerEvent<HTMLAnchorElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 6) return;
      drag.active = true;
      setGhost({ app: drag.app, x: event.clientX, y: event.clientY, unpin: !insideTabs(event.clientX, event.clientY) });
    },
    onPointerUp: (event: PointerEvent<HTMLAnchorElement>) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.active) {
        // The release must not ALSO open the community the row links to.
        swallowClickRef.current = true;
        if (!insideTabs(event.clientX, event.clientY)) unpinApp(drag.app.slug, navStore.get().viewer);
      }
      endDrag();
    },
    onPointerCancel: endDrag,
    swallowClick: () => {
      // A drag-out ends with a click on the row it started from; a plain
      // click never sets it.
      if (!swallowClickRef.current) return false;
      swallowClickRef.current = false;
      return true;
    },
  });

  // THE "PIN HERE" SLOT (#5323): one row after the pins while a My apps tile
  // is in the air. The refused states say what a drop would do instead of
  // doing it.
  const dropLabel = drop === 'already' ? t('core:rail.pin.already')
    : drop === 'full' ? t('core:rail.pin.full')
      : t('core:rail.pin.here');

  return (
    <>
      <div
        ref={ref}
        id="platform-rail-pinned"
        className="platform-rail-pinned hidden"
        role="group"
        aria-labelledby="platform-rail-pinned-label"
      >
        <div className="platform-rail-head">
          <span id="platform-rail-pinned-label" className="platform-rail-head-label">{t('core:rail.pinned')}</span>
        </div>
        {items.map((app) => (
          <RailCommunityRow key={app.slug} slug={app.slug} here={here} record={app} pin={handlers(app)} />
        ))}
        {drop ? (
          <div className="platform-rail-pin-drop" data-rail-pin-drop="" data-drop-state={drop}>
            <span className="platform-rail-pin-drop-tile" aria-hidden="true" />
            <span className="platform-rail-pin-drop-label">{dropLabel}</span>
          </div>
        ) : null}
      </div>
      {/* THE DRAGGED PINNED ROW'S TILE (#5323). Portaled to the body, because
          the sidebar clips what it holds and a ghost must cross it. The
          "Unpin" caption rides along only while the ghost is outside the
          sidebar: that is the state whose release takes the pin off. */}
      {ghost ? createPortal(
        <span
          className="platform-rail-pin-ghost"
          style={{ left: ghost.x, top: ghost.y }}
          data-unpin={ghost.unpin ? 'true' : undefined}
          aria-hidden="true"
        >
          <span className="app-icon-tile platform-rail-tile" data-icon={appIconKind({
            icon_url: ghost.app.iconUrl, icon_emoji: ghost.app.iconEmoji, name: ghost.app.name,
          })}>
            <AppIconContent app={{ icon_url: ghost.app.iconUrl, icon_emoji: ghost.app.iconEmoji, name: ghost.app.name }} />
          </span>
          {ghost.unpin ? <span className="platform-rail-pin-ghost-caption">{t('core:rail.pin.unpin')}</span> : null}
        </span>,
        document.body,
      ) : null}
    </>
  );
}
