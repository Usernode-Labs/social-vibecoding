/**
 * "Create an app" — the launcher grid's trailing tile.
 *
 * ── Why it is a tile at the end of Your apps ───────────────────────────
 *
 * The prototype's Home (nav-prototype.html, `scrHome`) closes the Your apps
 * grid with a dashed `.tile.create`, and the navigation spec retires the old
 * chip menu's Create entry into "Home's launcher grid and its Create tile".
 * The product had it as a fourth area instead — a full-width dashed card in a
 * section of its own below Discover and Challenges, two sections' scroll away
 * from the grid it adds to. This is that button put back where a launcher
 * keeps it: the last cell of the grid.
 *
 * ── It sits IN the grid but is not OF it ──────────────────────────────
 *
 * It is not a layout item. `Home.render()` derives its cell on every paint
 * (HomeLayout.trailingCell: straight after the last tile on screen), so it:
 *
 *   * is always LAST, in the collapsed grid and after "Show all N apps";
 *   * cannot be dragged — it is not an `.app-card`, which is what the kit's
 *     placement recognizer selects on, and it has no long-press menu;
 *   * cannot be rearranged — nothing stores its cell, and a drop onto the
 *     cell it is drawn in lands in an empty cell of the model; the next paint
 *     moves the tile along behind the app that arrived. app.css makes it
 *     transparent to hit-testing for the span of a lift so the drag overlay's
 *     cell beneath it stays a target.
 *
 * ── Hydration ─────────────────────────────────────────────────────────
 *
 * It renders only once `gridStore.create` is set, which only `Home.render()`
 * does, after the first /api/apps answer. The initial store value is null,
 * so the SSG prerender and the first client render both draw the skeleton
 * without it: the same child count, byte for byte, which is the contract
 * app-grid.tsx's header describes.
 *
 * ── Every account gets it; quota decides the treatment ───────────────
 *
 * Carried over from the section it replaces: `canCreateApps` flips without
 * any user action (creating your one allowed app, an admin editing a quota),
 * so a tile that came and went with it would be a layout change under the
 * viewer. At the limit it stays, in quieter ink, and a tap opens the same
 * dialog — which is where the used-of-limit numbers are printed. The locked
 * state is NOT the `disabled` attribute: that would swallow the tap that
 * explains it.
 */

import { useRef } from 'react';

import { PlusWideIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import type { CreateTileView } from './grid-store';

function win(): any {
  return typeof window !== 'undefined' ? (window as any) : {};
}

// The cell geometry is the app card's (app-grid.tsx): `rounded-xl`, the same
// column of 56px face over the 26px title lane, `gap-1.5`, and the card's
// padding — `p-3`, stepped down to `p-2` below 640px where app.css tightens
// the cards (`.app-card.app-card`). So the tile lines up with its neighbours
// and fits the same --home-cell-h row.
//
// The face is the prototype's `.tile.create .aic`: no fill, a 2px DASHED ring
// in the strong line colour, a muted plus. Neutral at rest on purpose — it is
// the end of a shelf of app icons, and an accent face would outshout every app
// on it. The blue accent arrives on hover and focus, while creation is open.
// Complete class literals throughout: Tailwind's extractor is a regex over
// source text.
const TILE = 'home-create-tile home-create-btn group relative flex select-none flex-col items-center '
  + 'gap-1.5 rounded-xl p-2 text-center transition-colors sm:p-3';
const FACE = 'home-create-glyph flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl '
  + 'border-2 border-dashed transition-colors';
const FACE_ON = 'border-zinc-300 text-zinc-500 group-hover:border-violet-500 group-hover:text-violet-600 '
  + 'group-focus-visible:border-violet-500 group-focus-visible:text-violet-600 '
  + 'dark:border-zinc-600 dark:text-zinc-400 dark:group-hover:border-violet-400 dark:group-hover:text-violet-400';
const FACE_OFF = 'border-zinc-300 text-zinc-400 dark:border-zinc-700 dark:text-zinc-500';
// `.app-card-title` is the tiles' own label box: 11px on a 13px line, two
// lines, clamped — so "Create an app" wraps and truncates exactly as an app
// name in the next cell does.
const LABEL_ON = 'home-create-label app-card-title text-zinc-500 group-hover:text-violet-700 '
  + 'dark:text-zinc-400 dark:group-hover:text-violet-400';
const LABEL_OFF = 'home-create-label app-card-title text-zinc-400 dark:text-zinc-500';

export const CREATE_TILE_LABEL = 'Create an app';

export function CreateTile({ view, style }: { view: CreateTileView; style?: string }) {
  const node = useRef<HTMLButtonElement | null>(null);

  // The cell, written as an ATTRIBUTE for the reason app-grid.tsx's header
  // gives: through React's `style` prop the CSSOM folds grid-column +
  // grid-row into a `grid-area` shorthand. Layout effect, so the tile is in
  // its cell in the frame it first appears.
  useIsomorphicLayoutEffect(() => {
    const el = node.current;
    if (!el) return;
    if (style) el.setAttribute('style', style);
    else el.removeAttribute('style');
  }, [style]);

  const on = view.enabled;
  // The locked tile's name starts with its visible label (the name a voice
  // user says has to be the one on screen), then says what a tap does.
  const locked = `${CREATE_TILE_LABEL}. View app quota. ${view.hint}`;
  return (
    <button
      ref={node}
      type="button"
      id="home-create-tile"
      className={TILE}
      // `data-panel-slot="create"` is the hook the declared checks and the
      // welcome tour have always selected the Create entry by; it names WHICH
      // control this is, which is as true of the tile as it was of the
      // section it replaces. `data-create-enabled` is the quota state.
      data-panel-slot="create"
      data-create-enabled={String(on)}
      title={on ? 'Create a new app' : locked}
      {...(on ? null : { 'aria-label': locked })}
      onClick={() => {
        // Both states open the same dialog. At the limit its quota row
        // explains the lock and its submit is disabled; a generic toast here
        // would hide the exact numbers precisely when they matter most.
        win().App?.showCreateModal?.();
      }}
    >
      <span className={`${FACE} ${on ? FACE_ON : FACE_OFF}`} aria-hidden="true">
        <PlusWideIcon className="h-6 w-6" strokeWidth="2" />
      </span>
      <span className={on ? LABEL_ON : LABEL_OFF}>{CREATE_TILE_LABEL}</span>
    </button>
  );
}
