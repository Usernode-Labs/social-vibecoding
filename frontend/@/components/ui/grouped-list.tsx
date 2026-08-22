import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { ChevronRightIcon } from './icons';

/**
 * The grouped list: SECTION LABEL over a white card of hairline-separated rows.
 *
 * This is the widget language's primary content shape — every screen in the
 * design deck is built out of it (the Changes list's Feedback/Previews/
 * Decisions groups, Home's "Your saved apps", the Activity feed's app card).
 *
 * ── Why this is a NEW primitive rather than a restyled old one ─────────
 *
 * Nothing in the shell drew this before. The pre-reskin shell separated
 * content with borders on a white page: a "card" was a bordered rectangle
 * flush against the same background as everything around it. The language
 * separates by FIGURE/GROUND instead — a white card floating on the grey page
 * ground now set in BODY_ATTRS (frontend/scripts/build-shell.mjs) — so the
 * card carries no border at all, and the only rule inside it is the row
 * separator.
 *
 * ── The separator is a pseudo-element, deliberately ───────────────────
 *
 * Rows are separated by a hairline INSET to the text column (it starts where
 * the title starts, not at the card's edge), and the last row has none. Three
 * ways to do that; this file uses the third:
 *
 *   * `divide-y` — can't inset, and would draw under the icon tile.
 *   * a border on every row but the last — needs the caller to know which row
 *     is last, which it usually doesn't (rows come from a `.map`).
 *   * `[&:not(:last-child)]:after:*` on the row — no caller knowledge needed,
 *     survives conditional rows, and insets to wherever we say.
 *
 * The inset (`left-[4.75rem]`) is the row's padding (1rem) + the icon tile
 * (2.75rem) + the gap (1rem). It is a literal rather than a computed value
 * because Tailwind's extractor is a regex over source text — see the note in
 * tailwind.config.js. A row rendered WITHOUT a leading tile passes
 * `inset="none"` and the hairline runs the full width.
 */

export function SectionHeader({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('px-4 pb-2 pt-6 text-[0.9375rem] font-normal text-zinc-400 dark:text-zinc-500', className)}
      {...props}
    />
  );
}

export function GroupedList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mx-4 overflow-hidden rounded-2xl bg-white dark:bg-zinc-900', className)}
      {...props}
    />
  );
}

const rowSeparator = cva('', {
  variants: {
    inset: {
      // The three inset depths the deck uses, as complete literals.
      tile: "[&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:bottom-0 [&:not(:last-child)]:after:left-[4.75rem] [&:not(:last-child)]:after:right-0 [&:not(:last-child)]:after:h-px [&:not(:last-child)]:after:bg-zinc-200 dark:[&:not(:last-child)]:after:bg-zinc-800 [&:not(:last-child)]:after:content-['']",
      text: "[&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:bottom-0 [&:not(:last-child)]:after:left-4 [&:not(:last-child)]:after:right-0 [&:not(:last-child)]:after:h-px [&:not(:last-child)]:after:bg-zinc-200 dark:[&:not(:last-child)]:after:bg-zinc-800 [&:not(:last-child)]:after:content-['']",
      none: '',
    },
  },
  defaultVariants: { inset: 'tile' },
});

export interface ListRowProps
  // `title` is omitted from the DOM attributes because ours is a ReactNode and
  // HTMLAttributes' is the tooltip string. Same reason in QuoteCard and
  // StackedTitle below — an intersection would silently narrow ours to string.
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof rowSeparator> {
  /** The leading rounded-square glyph tile. */
  leading?: React.ReactNode;
  title: React.ReactNode;
  /** The grey second line — "Private, 3m ago agent finished". */
  subtitle?: React.ReactNode;
  /** Unread/attention marker, drawn between the subtitle and the chevron. */
  dot?: boolean;
  /** Trailing disclosure chevron. On by default; a non-navigating row turns it off. */
  chevron?: boolean;
  /** Anything else on the trailing edge (a count pill, a switch, a state circle). */
  trailing?: React.ReactNode;
}

export function ListRow({
  className, leading, title, subtitle, dot, chevron = true, trailing, inset, ...props
}: ListRowProps) {
  // A row with no tile has nothing to inset the hairline PAST, so it falls back
  // to the text inset rather than leaving a gap the eye reads as a broken rule.
  const depth = inset ?? (leading ? 'tile' : 'text');
  return (
    <div
      className={cn(
        'relative flex items-center gap-4 px-4 py-3.5',
        props.onClick && 'cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800',
        rowSeparator({ inset: depth }),
        className,
      )}
      {...props}
    >
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{title}</div>
        {subtitle ? (
          <div className="truncate text-[0.9375rem] text-zinc-400 dark:text-zinc-500">{subtitle}</div>
        ) : null}
      </div>
      {dot ? (
        <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-hidden="true" />
      ) : null}
      {trailing}
      {chevron ? (
        <ChevronRightIcon className="h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
      ) : null}
    </div>
  );
}
