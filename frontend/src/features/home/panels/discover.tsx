/**
 * The Discover block: the admin-curated tiles, the most-used apps this viewer
 * doesn't have yet, and the way into the `#apps` directory.
 *
 * ── One shape at every width ──────────────────────────────────────────
 *
 * It used to be two (#949), because the widget's registry footprint was
 * asymmetric — 4x1 on a phone, 2x2 on desktop — so a phone got the title bar
 * and the featured lane and nothing else. THE UI OVERHAUL made Discover a
 * fixed section, so the Popular lane renders everywhere. That is the point of
 * an area called Discover rather than a strip of curated tiles: the curated
 * lane alone is whatever an admin got round to featuring.
 *
 * ── The browse control ALWAYS renders ─────────────────────────────────
 *
 * It is THE discovery path, so it must not depend on curation existing. With
 * nothing left to feature the tile lane is dropped entirely — rather than
 * drawn empty — and one centred line takes its place. The control rides in the
 * TITLE BAR rather than a footer of its own: Discover has one destination, so
 * it belongs beside the title rather than in 27px of chrome under two lanes.
 *
 * ── The tiles keep Home's wiring ──────────────────────────────────────
 *
 * `Home._wireDiscoveryCards(lane)` binds tap-to-open, the modified-click
 * anchor and the +/✓ badge, exactly as it bound the featured row this
 * replaced. It attaches listeners to nodes and writes no markup, so calling it
 * from an effect keeps one owner for the subtree — the same split app-grid.tsx
 * makes for the canvas recognizer. Per LANE, not per block: Discover draws
 * two, and a lane whose tiles were never wired looks identical in a screenshot
 * while every tap in it is dead.
 */

import { useEffect, useRef } from 'react';

import { CheckIcon, PlusWideIcon, SearchIcon } from '@/components/ui/icons';

import { auraFor } from '../../apps/app-card.js';
import type { IconView } from '../grid-store';
import type { DiscoverTileView, DiscoverView } from '../panels-store';
import { PanelShell, PanelTitle } from './ui';

function home(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

function TileIcon({ icon }: { icon: IconView }) {
  if (icon.kind === 'image') {
    return (
      <img
        src={icon.src}
        alt=""
        loading="lazy"
        draggable={false}
        className="w-full h-full rounded-lg object-cover"
      />
    );
  }
  if (icon.kind === 'emoji') {
    return <span className="text-xl leading-none" aria-hidden="true">{icon.emoji}</span>;
  }
  return <>{icon.letter}</>;
}

/**
 * One compact discovery tile — the same markup in both lanes, carrying
 * `.app-card` + `data-slug` so `Home._wireDiscoveryCards` binds it exactly as
 * it bound the row this replaced.
 *
 * The icon carries NO `w-10 h-10`: app.css sizes it fluidly (100% of its
 * track, capped at the 2.5rem it always drew at) because a lane's six tracks
 * are only ~32px wide in the narrowest window, where a fixed 40px box would
 * overflow its track and be clipped by the panel.
 */
function DiscoverTile({ tile }: { tile: DiscoverTileView }) {
  const { added } = tile;
  return (
    <div
      className="app-card home-discover-tile relative flex flex-col items-center gap-1 cursor-pointer"
      data-slug={tile.slug}
      data-status={tile.status}
      {...(tile.demo ? { 'data-demo': 'true' } : null)}
    >
      <div className="home-discover-icon-wrap relative">
        <div
          className="app-icon-tile home-discover-icon rounded-lg overflow-hidden flex items-center justify-center font-bold text-base"
          data-icon={tile.icon.kind}
          data-aura={auraFor(tile.slug)}
        >
          <TileIcon icon={tile.icon} />
        </div>
        <button
          className={`card-add-btn absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full border shadow-sm transition-colors ${
            added
              ? 'bg-emerald-500 border-emerald-500 text-white'
              : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-600 text-violet-700 dark:text-violet-400 hover:border-violet-400'
          }`}
          data-slug={tile.slug}
          data-added={String(added)}
          title={added ? 'Added. Tap to remove from Your apps' : 'Add to Your apps'}
          aria-label={added ? `Remove ${tile.name} from Your apps` : `Add ${tile.name} to Your apps`}
          aria-pressed={added}
        >
          {added
            ? <CheckIcon className="w-3 h-3" strokeWidth="3" aria-hidden="true" />
            : <PlusWideIcon className="w-3 h-3" strokeWidth="3" aria-hidden="true" />}
        </button>
      </div>
      <span className="text-[0.6rem] leading-tight truncate w-full text-center text-zinc-600 dark:text-zinc-300">
        {tile.name}
      </span>
    </div>
  );
}

function Lane({ tiles, extraClass }: { tiles: DiscoverTileView[]; extraClass?: string }) {
  const laneRef = useRef<HTMLDivElement | null>(null);

  // Re-bind whenever the tiles change identity — a slug added or removed
  // replaces the element the handler was on. Home owns every callback; this
  // owns only WHEN the binding happens, which used to be the tail of _wire.
  useEffect(() => {
    const el = laneRef.current;
    if (el) home()?._wireDiscoveryCards?.(el);
  }, [tiles.map((t) => `${t.slug}:${t.added}`).join(',')]);

  return (
    <div
      ref={laneRef}
      className={`home-panel-rows home-discover-lane home-discover-tiles${
        extraClass ? ` ${extraClass}` : ''
      }`}
    >
      {tiles.map((tile) => <DiscoverTile key={tile.slug} tile={tile} />)}
    </div>
  );
}

export function DiscoverPanel({ view }: { view: DiscoverView }) {
  return (
    <PanelShell
      panelKey={view.key}
      expanded={false}
      stamps={{ featured: view.featured.length, popular: view.popular.length }}
      title={
        <>
          <PanelTitle>{view.title}</PanelTitle>
          <button
            type="button"
            id="home-browse-btn"
            className="home-panel-browse shrink-0 flex items-center gap-1 text-[12px] font-medium text-violet-700 dark:text-violet-400 hover:underline whitespace-nowrap"
            title="Browse every app in the directory"
            aria-label="Browse all apps"
            onClick={(e) => {
              e.stopPropagation();
              // Through the hash, so the browse screen gets a real history
              // entry and the OS back gesture returns here.
              window.location.hash = '#apps';
            }}
          >
            <SearchIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span className="whitespace-nowrap">Browse all apps</span>
          </button>
        </>
      }
    >
      {view.featured.length ? (
        <Lane tiles={view.featured} />
      ) : (
        <p className="home-panel-rows home-discover-lane home-discover-empty flex items-center justify-center px-2.5 text-center text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">
          Nothing featured right now. Browse the directory.
        </p>
      )}
      {/*
          No popular apps → no divider and no second lane, rather than a second
          apology stacked under the first. The featured lane (or its note) then
          has the whole box, which is exactly the pre-#949 rendering.
      */}
      {view.popular.length ? (
        <>
          <div className="home-discover-divider flex-none flex items-center px-2.5">
            <span className="text-[0.9375rem] text-zinc-500 dark:text-zinc-500">Popular</span>
          </div>
          <Lane tiles={view.popular} extraClass="home-discover-popular" />
        </>
      ) : null}
    </PanelShell>
  );
}
