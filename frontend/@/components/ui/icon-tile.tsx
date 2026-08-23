import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The rounded-square glyph tile, in its two sizes.
 *
 * `sm` is the leading tile in a grouped-list row (a neutral fill behind a
 * monochrome line glyph). `lg` is the launcher/app tile — the same shape at
 * 4rem, carrying one of the accent tints, used for app identity on Home, in
 * the Activity feed's app card, and on the record cards attached to chat
 * messages.
 *
 * ── The tints live in app.css, and BOTH systems read them ─────────────
 *
 * The values are `--tile-*` custom properties declared on `:root` in
 * public/css/app.css. They have to be there rather than in
 * tailwind.config.js because the launcher tiles app.css already owns
 * (`.app-icon-tile[data-tint]`) need the same six colours this table does —
 * one source, two readers, no drift. Correcting them against the real design
 * tokens is a value edit in that one block.
 *
 * The class strings stay COMPLETE literals (`bg-[var(--tile-lime)]`, never
 * `bg-[${name}]`): Tailwind's extractor is a regex over source text, so a
 * computed class name is a class name that never compiles.
 *
 * They are deliberately NOT routed through the zinc/violet ramps: those two
 * scales are the shell's neutral and its accent, and an app's identity colour
 * is neither. Adding six more shades to the accent ramp to hold them would
 * make every one of them look like a state.
 *
 * They are also NOT redefined for dark mode, and the ink on them is pinned
 * near-black in both themes: a tinted tile is an app's ICON, and an icon does
 * not invert with the page.
 */

const tile = cva('flex shrink-0 items-center justify-center', {
  variants: {
    size: {
      sm: 'h-11 w-11 rounded-xl [&>svg]:h-6 [&>svg]:w-6',
      lg: 'h-16 w-16 rounded-2xl [&>svg]:h-9 [&>svg]:w-9',
    },
    tint: {
      neutral: 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
      lime: 'bg-[var(--tile-lime)] text-[var(--tile-ink)]',
      sky: 'bg-[var(--tile-sky)] text-[var(--tile-ink)]',
      amber: 'bg-[var(--tile-amber)] text-[var(--tile-ink)]',
      rose: 'bg-[var(--tile-rose)] text-[var(--tile-ink)]',
      lilac: 'bg-[var(--tile-lilac)] text-[var(--tile-ink)]',
      sand: 'bg-[var(--tile-sand)] text-[var(--tile-ink)]',
    },
  },
  defaultVariants: { size: 'sm', tint: 'neutral' },
});

/**
 * The tint table and the slug hash come from ../../src/lib/app-tint.js, not
 * from here. They have a second reader in a different world — the classic
 * scripts, through `window.AppCard.tintFor` — and that reader cannot import a
 * .tsx module. Re-exported so this file stays the one import a React surface
 * needs for a tinted tile.
 */
export { TILE_TINTS, tintFor } from '../../../src/lib/app-tint.js';
export type TileTint = 'lime' | 'sky' | 'amber' | 'rose' | 'lilac' | 'sand';

export interface IconTileProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof tile> {}

export function IconTile({ className, size, tint, ...props }: IconTileProps) {
  return <div className={cn(tile({ size, tint }), className)} {...props} />;
}

/**
 * A launcher tile with its caption — the unit Home's "Your saved apps" rail
 * and the app-picker are built from. The caption truncates to one line at the
 * tile's width, which is what makes a long name read as "GOAL! World…" rather
 * than wrapping and shoving the rail's baseline around.
 */
export function AppTile({
  label, tint, className, children, ...props
}: { label: React.ReactNode; tint?: TileTint } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex w-16 shrink-0 flex-col items-center gap-1.5', className)} {...props}>
      <IconTile size="lg" tint={tint}>{children}</IconTile>
      <span className="w-full truncate text-center text-[0.8125rem] text-zinc-900 dark:text-zinc-100">
        {label}
      </span>
    </div>
  );
}
