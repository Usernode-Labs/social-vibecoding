import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The rounded-square glyph tile, in its three sizes.
 *
 * `sm` is the leading tile in a grouped-list row; `lg` is the launcher/app
 * tile — the same shape at 4rem, used for app identity on Home, in the
 * Activity feed's app card, and on the record cards attached to chat
 * messages. `xs` is the same face at 2rem, for a row whose whole height is
 * the 44px tap target and where an 11-unit tile would leave no air: the
 * Improve panel's App / Board / Activity rows.
 *
 * ── There is ONE face, and it is neutral ──────────────────────────────
 *
 * The reskin gave each app a slug-derived identity tint here — six pastels,
 * picked by hashing the slug — and it was removed rather than tuned: a
 * launcher of six unrelated pastels reads as six unrelated things instead of
 * as one shelf, and an app's icon is its own artwork, which the tile should
 * hold rather than compete with. The face is a single off-white surface with
 * a hairline, identical everywhere, and app.css's `.app-icon-tile` is the one
 * rule that draws it.
 *
 * That is also why there is no `data-tint` and no slug hash any more. The
 * class strings below stay COMPLETE literals: Tailwind's extractor is a regex
 * over source text, so a computed class name is one that never compiles.
 */

const tile = cva('flex shrink-0 items-center justify-center', {
  variants: {
    size: {
      xs: 'h-8 w-8 rounded-lg [&>svg]:h-5 [&>svg]:w-5',
      sm: 'h-11 w-11 rounded-xl [&>svg]:h-6 [&>svg]:w-6',
      lg: 'h-16 w-16 rounded-2xl [&>svg]:h-9 [&>svg]:w-9',
    },
    tint: {
      neutral: 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
    },
  },
  defaultVariants: { size: 'sm', tint: 'neutral' },
});

export type TileTint = 'neutral';

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
