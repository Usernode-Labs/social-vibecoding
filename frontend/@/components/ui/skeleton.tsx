import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The shape of content that has not arrived yet.
 *
 * ── Why this is a primitive and not three more copies ─────────────────
 *
 * Four surfaces had already grown their own — the Dev board's cards
 * (features/dev-board/card/skeleton.tsx), the launcher's tiles
 * (features/apps/tile-skeleton.tsx) — and three more screens were still
 * showing the WORD "Loading…" instead: the leaderboard, Messages and Profile.
 * What those three need is not a fourth bespoke skeleton, it is the two or
 * three greys every skeleton is made of, so each screen can lay them out at
 * ITS OWN row geometry. A shared row shape would be the wrong sharing: a
 * 66px conversation row, a bordered leaderboard row and a profile identity
 * card have nothing in common except the colour.
 *
 * ── The two greys, and why they differ ────────────────────────────────
 *
 * `line` is the strong one and stands in for a title; `muted` is dimmer and
 * stands in for the meta row under it, because that is the contrast the real
 * rows have. Rendering both at one weight makes a skeleton read as a graphic
 * rather than as text that has not arrived — the same reason the board's
 * placeholder bars vary in width by row.
 *
 * ── The pulse belongs to the GROUP ────────────────────────────────────
 *
 * <SkeletonGroup> carries `animate-pulse`, so every bar inside breathes on
 * one clock. Per-element animation drifts out of phase and reads as several
 * things loading independently, which is exactly what a skeleton is trying
 * not to say. It also carries the single `role="status"` label: a screen
 * reader should hear "Loading conversations" once, not a description of
 * fourteen decorative rectangles.
 *
 * Sizes come from the CALLER, as Tailwind literals on `className` — the
 * extractor is a regex over source text, so a computed `w-${n}/4` compiles
 * to nothing, and every width in a skeleton is a property of the row it is
 * standing in for rather than of this file.
 */
const skeleton = cva('shrink-0', {
  variants: {
    shape: {
      /** A title line. Defaults to the real thing's 12px cap height. */
      line: 'h-3 rounded bg-zinc-200 dark:bg-zinc-800',
      /** The dimmer meta line beneath it. */
      muted: 'h-2.5 rounded bg-zinc-200/70 dark:bg-zinc-800/70',
      /** An avatar. The caller sizes it; `rounded-full` is the shape. */
      circle: 'rounded-full bg-zinc-200 dark:bg-zinc-800',
      /** A tile, a card face, a button — anything with a squared corner. */
      block: 'rounded-lg bg-zinc-200 dark:bg-zinc-800',
    },
  },
  defaultVariants: { shape: 'line' },
});

export interface SkeletonProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof skeleton> {}

export function Skeleton({ className, shape, ...props }: SkeletonProps) {
  return <div className={cn(skeleton({ shape }), className)} {...props} />;
}

/**
 * The wrapper: one clock for the pulse, one label for assistive tech, and
 * `aria-hidden` over the geometry so the label is all that is announced.
 */
export function SkeletonGroup({
  label,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { label: string }) {
  return (
    <>
      <div className="sr-only" role="status">{label}</div>
      <div className={cn('animate-pulse', className)} aria-hidden="true" {...props}>
        {children}
      </div>
    </>
  );
}
