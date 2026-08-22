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
 * ── The tints are PLACEHOLDERS ────────────────────────────────────────
 *
 * The three in the design deck (a lime, a sky, an amber) are eyedropped from
 * the screenshots, and it is not yet settled whether they are a fixed palette
 * or picked per app. They are written as arbitrary-value literals in one cva
 * table so that correcting them is a single edit here rather than a sweep —
 * and as COMPLETE literals, never `bg-[${hex}]`, because Tailwind's extractor
 * is a regex over source text (see tailwind.config.js).
 *
 * They are deliberately NOT routed through the zinc/violet ramps: those two
 * scales are the shell's neutral and its accent, and an app's identity colour
 * is neither. Adding six more shades to the accent ramp to hold them would
 * make every one of them look like a state.
 *
 * The glyph inside is always monochrome and near-black IN BOTH THEMES — the
 * tint is the surface, so the ink on it does not flip with the page. That is
 * why this component pins `text-zinc-900` with no `dark:` counterpart, which
 * is otherwise a smell in this codebase.
 */

const tile = cva('flex shrink-0 items-center justify-center', {
  variants: {
    size: {
      sm: 'h-11 w-11 rounded-xl [&>svg]:h-6 [&>svg]:w-6',
      lg: 'h-16 w-16 rounded-2xl [&>svg]:h-9 [&>svg]:w-9',
    },
    tint: {
      neutral: 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
      lime: 'bg-[#c5e86c] text-zinc-900',
      sky: 'bg-[#bfe9f5] text-zinc-900',
      amber: 'bg-[#fcefc0] text-zinc-900',
      rose: 'bg-[#f8c9cd] text-zinc-900',
      lilac: 'bg-[#d9d2f9] text-zinc-900',
      sand: 'bg-[#ecdcc4] text-zinc-900',
    },
  },
  defaultVariants: { size: 'sm', tint: 'neutral' },
});

export const TILE_TINTS = ['lime', 'sky', 'amber', 'rose', 'lilac', 'sand'] as const;
export type TileTint = (typeof TILE_TINTS)[number];

/**
 * Pick a stable tint for an app that has not chosen one. Same input → same
 * tint, so a launcher grid doesn't reshuffle its colours on every render.
 */
export function tintFor(key: string): TileTint {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TILE_TINTS[h % TILE_TINTS.length];
}

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
