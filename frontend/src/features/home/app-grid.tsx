/**
 * `#app-list` — the launcher grid, as the only React writer below that node.
 *
 * ── The ownership split this conversion makes ─────────────────────────
 *
 * Before: `Home.render()` built the whole grid as an HTML string, assigned it
 * to `#app-list.innerHTML`, and then re-attached every listener with four
 * `querySelectorAll` sweeps (`Home._wireCards`). Every WS app event and every
 * search keystroke destroyed and rebuilt the subtree.
 *
 * After: `Home.render()` computes the view model in ./grid-store.ts and this
 * component renders it. React reconciles — a status change repaints one tile's
 * label instead of rebuilding forty nodes, and a card element survives across
 * renders, which is what lets the per-card gesture wiring below attach once.
 *
 * home.js keeps everything that is NOT markup: the app list and its WS
 * fan-out, the layout fetch and its persistence, the card menus, the drag
 * geometry (`_targetCellFor` / `_planFor` / `_rectForCell`), and the kit
 * attachment. That is the boundary the migration skill asks for — one owner
 * per subtree — and it is why the gesture code below is CALLED from here
 * rather than reimplemented here: those functions attach listeners to nodes,
 * they do not write markup, so they are not a second writer.
 *
 * ── The markup is like-for-like, and that is load-bearing ─────────────
 *
 * Same classes, same `data-*`, same structure as the string this replaces.
 * Four separate consumers depend on it and none of them would fail loudly:
 *
 *   * the kit's placement recognizer selects
 *     `.app-card[data-yours]:not([data-demo])`;
 *   * `App._tileFor(slug)` (public/js/app.js) finds the zoom-out rect with
 *     `#app-list .app-card[data-slug="…"]`;
 *   * app.css styles `.app-card`, `.app-icon-tile[data-icon]`,
 *     `.app-card-title` and `.app-card-status`;
 *   * dapp.json's declared checks select on these chains.
 *
 * The new widget language reaches these tiles through the token layer
 * (tailwind.config.js) and app.css, not by respelling the classes here — so
 * the reskin and this conversion stay independently reviewable.
 *
 * ── Why the cell is an inline style ───────────────────────────────────
 *
 * Per-cell placement is `grid-column`/`grid-row` on the item. Those cannot be
 * Tailwind utilities: the values are per-viewer data, and Tailwind's extractor
 * is a regex over source text, so an arbitrary-value class built from a
 * variable would never compile. Inline is also what the string version did.
 */

import { useCallback, useEffect, useRef } from 'react';

import { Bars3Icon } from '@/components/ui/icons';
import { tintFor } from '@/components/ui/icon-tile';

import { useStoreState } from '../../lib/use-store-state';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { gridStore, type GridItem, type HomeAppView, type IconView } from './grid-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

function cellStyle(item: GridItem): React.CSSProperties | undefined {
  const p = item.placement;
  if (!p) return undefined;
  return {
    gridColumn: `${p.col + 1}/span ${p.w}`,
    gridRow: `${p.row + 1}/span ${p.h}`,
  };
}

function AppIcon({ icon }: { icon: IconView }) {
  if (icon.kind === 'image') {
    // w-full/h-full, not a fixed size: the tile draws a 1px hairline border
    // and the image fills the CONTENT box so it stays flush inside the ring
    // rather than being cropped by it (same note as AppCard.iconTileFor).
    return <img src={icon.src} alt="" className="w-full h-full object-cover" />;
  }
  if (icon.kind === 'emoji') return <span className="text-3xl leading-none">{icon.emoji}</span>;
  return <>{icon.letter}</>;
}

/**
 * One launcher tile.
 *
 * `wireRef` receives the card element once (React keeps the node across
 * re-renders because the list is keyed by slug), and hands it to the gesture
 * wiring in home.js. The WeakSet guard is belt-and-braces for a remount:
 * attaching the prewarm listener twice would fire two `mountFrame` calls for
 * one press.
 */
const wired = new WeakSet<Element>();

function AppCardTile({ app, style, yours }: { app: HomeAppView; style?: React.CSSProperties; yours: boolean }) {
  const wireRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || wired.has(el)) return;
    wired.add(el);
    const N = controller();
    N?._wirePrewarm?.(el);
    // The placement recognizer owns long-press-lift-drag on every card it
    // matches; the long-press ACTIONS menu survives only where it does not —
    // the search view (no layout to write) and inert staging demo tiles.
    if (!yours || app.demo) N?._wireCardLongPressMenu?.(el);
  }, [app.demo, yours]);

  return (
    <div
      ref={wireRef}
      className={`app-card app-card-draggable touch-pan-y relative rounded-xl transition-colors p-3 flex flex-col items-center text-center gap-1.5 ${
        app.clickable ? (yours ? 'cursor-grab' : 'cursor-pointer') : 'cursor-not-allowed opacity-70'
      }`}
      data-slug={app.slug}
      data-status={app.status}
      data-locked={String(app.locked)}
      {...(app.demo ? { 'data-demo': 'true' } : null)}
      {...(yours ? { 'data-yours': 'true' } : null)}
      style={style}
      onClick={(e) => {
        const N = controller();
        // A completed drag (or a long-press that opened the menu) ends with
        // the pointer still on the card, so the browser fires a click right
        // after pointerup — eat it so the gesture doesn't also open the app.
        if (N?._suppressClick) { N._suppressClick = false; return; }
        const t = e.target as HTMLElement;
        if (t.closest('.retry-btn') || t.closest('.card-menu-btn')) return;
        if (!app.clickable) return;
        (window as any).App?.navigateToApp(app.slug);
      }}
    >
      {app.showRetry ? (
        <button
          className="retry-btn absolute top-2 right-2 text-xs text-emerald-500 hover:text-emerald-400 px-2 py-0.5 rounded-md hover:bg-emerald-500/10 transition-colors"
          data-slug={app.slug}
          onClick={(e) => { e.stopPropagation(); controller()?._onRetry?.(app.slug, e.currentTarget); }}
        >
          Retry
        </button>
      ) : null}
      <div className="relative w-14 h-14 shrink-0">
        {/*
            `data-tint` is the widget language's launcher face: app.css turns
            it into the app's identity colour, drops the hairline and pins the
            glyph near-black (see `.app-icon-tile[data-tint]` there). The tile
            KEEPS its 3.5rem box — the grid's cell height, the drag overlay's
            mirror and HomeLayout's geometry are all measured against it, so
            growing it to the deck's 4rem is a layout change, not a reskin, and
            belongs in its own commit.

            The tint is derived from the slug rather than stored, so it is
            stable per app and identical on every surface that renders it,
            with no migration and no per-app column to backfill.
        */}
        <div
          className="app-icon-tile w-14 h-14 rounded-2xl overflow-hidden flex items-center justify-center font-bold text-xl"
          data-icon={app.icon.kind}
          data-tint={tintFor(app.slug)}
        >
          <AppIcon icon={app.icon} />
        </div>
        <button
          className="card-menu-btn absolute -top-1.5 -right-1.5 w-6 h-6 flex items-center justify-center rounded-full bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 shadow-sm text-zinc-500 dark:text-zinc-300 hover:text-zinc-700 dark:hover:text-zinc-100 hover:border-zinc-300 dark:hover:border-zinc-500 transition-colors"
          data-slug={app.slug}
          title="App actions"
          aria-label="App actions"
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            // The ELEMENT, not a rect: the kit popover toggles closed on a
            // re-click against the same anchor and manages its aria-expanded.
            // (openCardMenu also accepts a rect — that is what the long-press
            // path in home.js hands it, where there is no button to anchor to.)
            controller()?.openCardMenu?.(app.slug, e.currentTarget);
          }}
        >
          <Bars3Icon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
        {app.forkName ? (
          <span
            className="fork-tag absolute -bottom-1 -left-1 w-5 h-5 flex items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold shadow-sm"
            title={`Forked from ${app.forkName}`}
            aria-label={`Forked from ${app.forkName}`}
          >
            ⑂
          </span>
        ) : null}
      </div>
      <div className="w-full min-w-0">
        <div className="app-card-title" title={app.name}>{app.name}</div>
        {app.statusLabel ? (
          <p
            className={`app-card-status ${app.isAwaiting ? 'text-amber-500' : 'text-yellow-500'}`}
            {...(app.failureReason ? { title: app.failureReason } : null)}
          >
            {app.statusLabel}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AppGrid() {
  const state = useStoreState(gridStore);
  const listRef = useRef<HTMLDivElement | null>(null);

  // `grid-template-rows` is written to the ELEMENT rather than rendered as a
  // style prop for one reason: app.css's `grid-auto-rows` must remain the only
  // row sizing when the template is '' (desktop and the search view), and an
  // empty `style={{gridTemplateRows: ''}}` still emits a style attribute that
  // reads as an author-level override. Writing it imperatively lets '' mean
  // "remove the declaration", which is what the string version's
  // `listEl.style.gridTemplateRows = ''` did.
  useIsomorphicLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.style.gridTemplateRows = state.rowTemplate;
  }, [state.rowTemplate]);

  // The kit's placement recognizer, re-attached whenever the canvas it
  // measures against changes. home.js owns every callback (the geometry is
  // its); this owns only WHEN the attachment happens, which used to be the
  // tail of _wireCards. Detach on unmount so a remount cannot leave two
  // recognizers fighting for the same gesture.
  const canDrag = state.view === 'grid' && state.ready;
  useEffect(() => {
    const el = listRef.current;
    const N = controller();
    if (!el || !N) return undefined;
    N._attachGridPlacement?.(el, canDrag);
    return () => { N._detachGridPlacement?.(); };
  }, [canDrag, state.items.length, state.rowTemplate]);

  // Everything below runs AFTER the grid has painted, exactly where the tail
  // of the old Home.render() ran it.
  useEffect(() => {
    if (!state.ready) return;
    const N = controller();
    const el = listRef.current;
    if (el) { N?._maybeOpenShotMenu?.(el); }
    N?._searchReveal?.sync?.();
    if (el) N?._maybeShowShotGrid?.(el);
  });

  return (
    <div
      ref={listRef}
      id="app-list"
      className="grid grid-cols-4 gap-1.5 sm:gap-2 p-2 pt-1.5 sm:p-3 sm:pt-2"
      data-view={state.ready ? state.view : undefined}
    >
      {state.emptyQuery !== null ? (
        <div className="col-span-full py-10 text-center text-sm text-zinc-500 dark:text-zinc-400">
          {`No apps match “${state.emptyQuery}” — clear the search and try the `}
          <span className="text-violet-500">Discover</span>
          {' widget.'}
        </div>
      ) : null}
      {state.resultsHeading ? (
        <div className="home-section-header col-span-full">{state.resultsHeading}</div>
      ) : null}
      {state.items.map((item) => (
        <AppCardTile
          key={`card:${item.app.slug}`}
          app={item.app}
          style={cellStyle(item)}
          yours={state.view === 'grid'}
        />
      ))}
    </div>
  );
}
