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
 *
 * ── No consumers yet, and that is the deferral ────────────────────────
 *
 * Nothing in the shell imports this. The deck leads its Changes screen with a
 * filter rail, and the platform's nearest equivalent — the Dev screen's
 * proposal and issue list — has no filter at all today. ADDING one is a
 * navigation change, which this reskin deliberately does not make; the two
 * places that needed the language's SELECTION idiom without a new control
 * (features/improve/view-toggle.tsx and the Leaderboard's section strip)
 * state it themselves, for the reason immediately below.
 *
 * ── What this is NOT for ──────────────────────────────────────────────
 *
 * A TABLIST. `features/improve/view-toggle.tsx` looks like a row of chips and
 * is not one: its segments are `role="tab"` with `aria-selected`, three
 * mutually exclusive views of the same thing. This component is a toggle and
 * says so with `aria-pressed`, and a node carrying both is wrong for assistive
 * tech — a tab is selected, not pressed. That toggle therefore states the
 * language's selection idiom itself rather than importing this. Sharing the
 * LOOK is not a reason to share the SEMANTICS.
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
        text: 'px-6',
        icon: 'aspect-square',
      },
      size: {
        // `rail` is the deck's own filter rail — a row of big, finger-sized
        // chips that IS the screen's primary control.
        rail: 'h-14 text-[1.0625rem] [&>svg]:h-6 [&>svg]:w-6',
        // `bar` is the same idiom shrunk to sit inside a header row beside a
        // title and an action button. Same shape, same selection inversion,
        // sized to the 36px controls the shell's bars are built from.
        bar: 'h-9 text-[0.9375rem] [&>svg]:h-5 [&>svg]:w-5',
      },
    },
    defaultVariants: { selected: false, shape: 'text', size: 'rail' },
  },
);

export interface ChipProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    VariantProps<typeof chip> {}

export function Chip({ className, selected, shape, size, ...props }: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected ?? false}
      className={cn(chip({ selected, shape, size }), className)}
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

/**
 * `ActivityChip` — the brand's event token.
 *
 * BRAND KIT 2026's landing page scrolls a rail of these under the hero:
 * "+Lukas voted yes on change", "+Andrea just joined", "+Evan proposed a
 * change". Each is a white rectangle with a 1px near-black rule, a flush
 * identity gradient square on the leading edge, and a Geist label. It is the
 * most characterful element the brand owns, and the product has the same
 * thing to say — someone did something — on every activity surface.
 *
 * Three geometry decisions are the brand's, not preferences:
 *
 * - SQUARE. The reference chip has no radius at all. It is the counterweight
 *   to the fully-round CTA: the brand's shape language is hard rectangles and
 *   round buttons, and softening this one collapses that tension.
 * - The gradient square is FLUSH — it bleeds to the chip's top, bottom and
 *   leading edges with no padding, so the chip reads as two joined materials
 *   rather than as an icon sitting inside a box. `overflow-hidden` on the
 *   chip plus zero leading padding is what does it.
 * - The shadow is a SOFT grey offset (not the CTA's hard black one). These
 *   are ambient, many-at-once, and a hard shadow on a rail of them buzzes.
 *
 * Identity comes from `lib/identity-gradient` at the call site, passed as
 * `identity` — this primitive does not import it, because @/components/ui
 * must not depend on src/lib.
 */
export interface ActivityChipProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** The identity square's inline style — `identityStyle(name)` from the caller. */
  identity?: React.CSSProperties;
  /** What sits in the identity square: an initial, or an event glyph. */
  mark?: React.ReactNode;
}

export function ActivityChip({ className, identity, mark, children, ...props }: ActivityChipProps) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-2 overflow-hidden bg-white dark:bg-zinc-900',
        'border border-[var(--frame-line)] pr-3',
        'shadow-[2px_2px_4px_0_rgba(161,152,152,0.25)] dark:shadow-none',
        'text-[0.8125rem] text-zinc-900/80 dark:text-zinc-100/80',
        className,
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="flex h-8 w-8 shrink-0 items-center justify-center self-stretch font-bold"
        style={identity}
      >
        {mark}
      </span>
      {children}
    </span>
  );
}
