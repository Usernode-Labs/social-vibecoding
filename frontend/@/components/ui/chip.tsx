import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The filter chip and the rail it scrolls in.
 *
 * The deck's Changes screen leads with a horizontal rail of these: a text chip
 * ("All") followed by icon-only chips, one per kind. Selection is a SOLID
 * INVERSION — near-black fill, page-coloured ink — not a tint or an outline.
 * That is the language's one high-contrast state, and it is deliberately not
 * the accent: the accent means "actionable/mine", selection means "you are
 * looking at this subset", and colouring both blue would collapse the two.
 *
 * ── Why a `<button>` with `aria-pressed` and not a radio group ─────────
 *
 * The rail is a filter, and a filter chip is a toggle: the deck shows "All"
 * selected with the others available, and nothing about it implies exactly one
 * must be chosen. `aria-pressed` says that; `role="radio"` would promise
 * single-selection semantics the caller may not want. A caller that DOES want
 * exclusivity gets it by managing state, without fighting the roles.
 *
 * Note `shrink-0` on the chip and `overflow-x-auto` on the rail: without the
 * first, a rail wider than the viewport compresses its chips into ellipses
 * instead of scrolling.
 */

const chip = cva(
  'inline-flex shrink-0 items-center justify-center rounded-full text-[1.0625rem] font-medium transition-colors',
  {
    variants: {
      selected: {
        true: 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900',
        false: 'bg-white text-zinc-900 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800',
      },
      shape: {
        // Icon-only chips are circles; text chips are pills with room to breathe.
        text: 'h-14 px-6',
        icon: 'h-14 w-14 [&>svg]:h-6 [&>svg]:w-6',
      },
    },
    defaultVariants: { selected: false, shape: 'text' },
  },
);

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    VariantProps<typeof chip> {}

export function Chip({ className, selected, shape, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected ?? false}
      className={cn(chip({ selected, shape }), className)}
      {...props}
    />
  );
}

/**
 * `[-ms-overflow-style:none]` / `[scrollbar-width:none]` / the webkit
 * pseudo-element together hide the scrollbar without killing the scroll — the
 * rail is finger-scrolled on the surface this language targets, and a visible
 * bar under a row of circles reads as a rendering fault.
 */
export function ChipRail({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex gap-3 overflow-x-auto px-4 py-2 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      {...props}
    />
  );
}
