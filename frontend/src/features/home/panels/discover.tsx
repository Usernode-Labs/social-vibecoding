/**
 * The Discover block: the admin-curated apps, the most-used apps this viewer
 * doesn't have yet, and the way into the `#apps` directory.
 *
 * ── The lane is a RAIL OF CARDS now, not a grid of icons ──────────────
 *
 * It was six 40px icon tiles in a grid inside the block's white card, so the
 * most an area called Discover could say about an app was its name, clamped
 * to two lines at 9.6px. The homescreen design draws it as the reference
 * does: a horizontal rail of cards, each with art, the app's name, its own
 * sentence and how many people built it — which is what makes the area answer
 * "should I open this?" rather than "here are some logos".
 *
 * What that costs and why it is paid: a rail is taller than a lane (a card is
 * ~13rem against the tile's ~5.25rem). The block's height cap is long gone —
 * a section is as tall as its content — and the launcher is a scrolling feed,
 * so the cost is scroll rather than clipping. What it buys is the sentence: an
 * app that says what it is gets opened, and the directory is one tap away for
 * everything else.
 *
 * ── BOTH LANES SURVIVE, as two rails ──────────────────────────────────
 *
 * Featured, then "Popular" (the most-used apps this viewer doesn't have).
 * The reference draws ONE rail, and merging the two would halve the block's
 * height — but the second lane is a deliberate decision (#949 hid it on
 * phones; the fix that brought it back at every width is asserted from
 * dapp.json), and a redesign is not the place to quietly undo it. Same card
 * in both, so the block reads as one idea at two levels of curation.
 *
 * ── The tiles keep Home's wiring ─────────────────────────────────────
 *
 * `Home._wireDiscoveryCards(lane)` binds tap-to-open, the modified-click
 * anchor and the +/✓ badge. It selects on `.app-card`, `.card-add-btn` and
 * `.card-menu-btn`, so the CARD keeps those class names however it is drawn;
 * it attaches listeners and writes no markup, which is what keeps one owner
 * for the subtree. Per LANE, not per block: a lane whose cards were never
 * wired looks identical in a screenshot while every tap in it is dead.
 *
 * It is also IDEMPOTENT (#1567), which the effect below now depends on: the
 * badge really does flip between renders since an add repaints in place, and
 * React hands back the same card elements it kept.
 *
 * ── AND THE RAIL IS A DRAG SURFACE (#1763) ────────────────────────────
 *
 * A card can be long-pressed and dragged onto the launcher grid above, which
 * adds the app AND places it in the cell it was dropped in — the ⊕ badge can
 * only append it wherever the layout happens to have room. That is the kit's
 * own placement recognizer, attached per LANE by the second effect below and
 * driven entirely by `Home._attachDiscoverPlacement`; nothing about it lives
 * here, for the same reason none of the click wiring does.
 *
 * It also means the rail may not deny vertical panning. `.home-discover-rail`
 * declares `touch-action: pan-x pan-y` for that (#1762) — `pan-x` alone took
 * the feed's own scroll away from every touch landing on a card — and the
 * lift survives it because the kit arms on a long press with a movement slop:
 * a scroll cancels the press rather than competing with it.
 */

import { useEffect, useRef, useState } from 'react';

import { CheckIcon, PlusWideIcon } from '@/components/ui/icons';

import { clampFrame } from '../../../lib/illustration-framing';

import type { IconView } from '../grid-store';
import type { DiscoverTileView, DiscoverView } from '../panels-store';
import { PanelShell, cardTint } from './ui';

function home(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

/**
 * The card's art block. An uploaded image FILLS it — that is the one case
 * that looks like the design's own artwork — while an emoji or an initial is
 * a glyph centred on the tint, which is the honest rendering of "this app has
 * no art yet" and still gives the card its colour.
 */
function CardArt({ icon }: { icon: IconView }) {
  if (icon.kind === 'image') {
    return (
      <img
        src={icon.src}
        alt=""
        loading="lazy"
        draggable={false}
        className="home-discover-art-img"
      />
    );
  }
  if (icon.kind === 'emoji') {
    return <span className="home-discover-art-emoji" aria-hidden="true">{icon.emoji}</span>;
  }
  return <span className="home-discover-art-letter" aria-hidden="true">{icon.letter}</span>;
}

/**
 * One discovery card.
 *
 * `.app-card` and `data-slug` are the contract with `_wireDiscoveryCards` and
 * with dapp.json's own Discover check, so they stay whatever the card looks
 * like. `home-discover-tile` does NOT stay: it named a 40px tile in a grid,
 * the CSS that sized it is retired with the grid, and a class that says
 * "tile" on a 152px card is a name the next reader has to disbelieve.
 *
 * The blurb and the contributor line are both CONDITIONAL. Most apps declare
 * no description (there is no such column on `apps` — it comes off the
 * manifest snapshot, see HomePanels.appBlurb), and a card with nothing to say
 * says nothing rather than padding itself with filler. The name and the art
 * are the floor.
 */
function IllustrationArt({ tile }: { tile: DiscoverTileView }) {
  const [failed, setFailed] = useState(false);
  const art = tile.illustration;
  if (!art || failed) return <CardArt icon={tile.icon} />;
  // Re-clamped on render, not trusted as stored: the art `cover`s the block,
  // so a zoom under 1 or an offset past the cover limit would open a gutter
  // of tint along one edge. The editor cannot produce one; the API's framing
  // range is wider than the editor's, so the card does not assume it.
  const frame = clampFrame(art);
  return <img src={art.url} alt="" draggable={false} className="home-discover-illustration"
    onError={() => setFailed(true)}
    style={{ transform: `translate(${frame.x}%, ${frame.y}%) scale(${frame.zoom})` }} />;
}

export function DiscoverCard({ tile, preview = false }: { tile: DiscoverTileView; preview?: boolean }) {
  const { added } = tile;
  return (
    <div
      // The tint saved with the illustration when its author picked one, and
      // the hash of the slug when they did not — see `cardTint`. Both branches
      // are pure functions of props, so the prerender and the client agree.
      className={`app-card home-discover-card ${cardTint(tile.slug, tile.illustration?.tint)} relative flex flex-col cursor-pointer`}
      data-slug={tile.slug}
      data-status={tile.status}
      {...(tile.demo ? { 'data-demo': 'true' } : null)}
    >
      <div className="home-discover-art relative">
        <IllustrationArt key={tile.illustration?.url || 'default'} tile={tile} />
        <button
          type="button"
          disabled={preview}
          tabIndex={preview ? -1 : undefined}
          className={`card-add-btn absolute top-1.5 right-1.5 w-6 h-6 flex items-center justify-center rounded-full border shadow-sm transition-colors ${
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
            ? <CheckIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" />
            : <PlusWideIcon className="w-3.5 h-3.5" strokeWidth="3" aria-hidden="true" />}
        </button>
      </div>
      <div className="flex flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
        {/*
            ONE LINE, truncated. The two-line clamp this name used to carry
            was for a 55px grid track, where a single line rendered most of
            them as "Opinio…"; a card is 152px and gives a real name the room
            to be read, so a second line would only ever be spent on the
            longest few.
        */}
        <span className="home-discover-name truncate whitespace-nowrap text-[15px] font-semibold leading-tight text-zinc-900 dark:text-zinc-100">
          {tile.name}
        </span>
        {tile.blurb ? (
          <span className="home-discover-blurb text-[12px] leading-snug text-zinc-600 dark:text-zinc-400">
            {tile.blurb}
          </span>
        ) : null}
        {tile.contributors ? (
          <span className="home-discover-meta pt-0.5 text-[12px] leading-none text-zinc-500 dark:text-zinc-400">
            {tile.contributors === 1 ? '1 contributor' : `${tile.contributors} contributors`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Lane({ tiles, extraClass }: { tiles: DiscoverTileView[]; extraClass?: string }) {
  const laneRef = useRef<HTMLDivElement | null>(null);

  // Re-bind whenever the tiles change identity — a slug added or removed
  // replaces the element the handler was on. Home owns every callback; this
  // owns only WHEN the binding happens.
  //
  // The `added` half of the key is no longer hypothetical: #1567 repaints the
  // rail the moment the badge is tapped, so this effect re-runs over cards
  // React KEPT (they are keyed by slug). Re-binding them would give one badge
  // two click handlers and make a single tap toggle twice; _wireDiscoveryCards
  // skips what it has already wired, so the second sweep only ever picks up
  // genuinely new cards.
  useEffect(() => {
    const el = laneRef.current;
    if (el) home()?._wireDiscoveryCards?.(el);
    // The screenshot state (?shot=discover-drag) needs A CARD to lift, and
    // on first mount this lane has none: the tiles arrive with their own
    // fetch. The effect below runs once, finds nothing, and returns — and
    // nothing called it again, because the grid's own post-commit effect
    // (the other caller) does not re-commit when a PANEL's data lands. So
    // the state painted only when the cards happened to beat the mount, and
    // stopped painting at all once curation (#1753) changed how the lanes
    // fill. Calling it here as well is the fix: this effect already runs on
    // every tile change, and the state is repeatable by design.
    home()?._maybeShowShotIncoming?.();
  }, [tiles.map((t) => `${t.slug}:${t.added}`).join(',')]);

  // The drag-to-add recognizer (#1763), and the screenshot state that stands
  // in for it (?shot=discover-drag). ONCE PER LANE, not once per tile change:
  // the kit binds to this element and re-queries its items on every press, so
  // cards coming and going need no re-attachment — unlike the click wiring
  // above, which is per element. Two lanes means two handles, which is why
  // Home hands one back rather than parking it on itself.
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return undefined;
    home()?._maybeShowShotIncoming?.();
    return home()?._attachDiscoverPlacement?.(el) || undefined;
  }, []);

  return (
    <div
      ref={laneRef}
      className={`home-discover-lane home-discover-rail${extraClass ? ` ${extraClass}` : ''}`}
    >
      {tiles.map((tile) => <DiscoverCard key={tile.slug} tile={tile} />)}
    </div>
  );
}

/**
 * NO CARD AROUND THE RAILS. `PanelShell` still draws the article — it is what
 * carries `data-panel` and the lane stamps — but without the white plate: the
 * cards ARE the surface now, and a white box behind a row of tinted cards is
 * a second frame around things that already have one. It also lets the rail
 * bleed to both screen edges, which is the affordance that says the row
 * continues (see `.home-discover-rail` in app.css).
 */
export function DiscoverPanel({ view }: { view: DiscoverView }) {
  return (
    <PanelShell
      panelKey={view.key}
      expanded={false}
      plate="none"
      stamps={{ featured: view.featured.length, popular: view.popular.length }}
    >
      {view.featured.length ? (
        <Lane tiles={view.featured} />
      ) : (
        <p className="home-discover-lane home-discover-empty flex items-center justify-center px-2.5 text-center text-[12px] leading-snug text-zinc-500 dark:text-zinc-400">
          Nothing featured right now. Browse the directory.
        </p>
      )}
      {/*
          No popular apps → no divider and no second rail, rather than a second
          apology stacked under the first.
      */}
      {view.popular.length ? (
        <>
          <div className="home-discover-divider flex-none flex items-center px-2.5">
            <span className="text-[12px] font-medium text-zinc-500 dark:text-zinc-400">Popular</span>
          </div>
          <Lane tiles={view.popular} extraClass="home-discover-popular" />
        </>
      ) : null}
    </PanelShell>
  );
}
