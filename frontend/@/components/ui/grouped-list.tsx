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
      className={cn('px-4 pb-2 pt-6 text-[0.9375rem] font-normal text-zinc-500 dark:text-zinc-500', className)}
      {...props}
    />
  );
}

export function GroupedList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      // FRAMED, and near-square. A grouped list is a window onto a set of
      // rows, and the brand draws windows with a rule rather than floating
      // them on tone alone (see --frame-line in public/css/app.css). This is
      // the surface where it matters most inside the product: these lists sit
      // on sheets and panels whose own ground is a step away from the rows',
      // so without the rule the group's edge was doing almost no work.
      //
      // rounded-2xl → rounded-sm for the same reason the sheets tightened:
      // the brand's card corner is effectively square, and a 20px radius on a
      // framed rectangle reads as a bubble, which is the one thing it is not.
      // The radius lives on the BUTTONS in this language, not the boxes —
      // hard rectangles against round controls is the tension, and softening
      // the rectangles is what was flattening it.
      className={cn(
        'mx-4 overflow-hidden rounded-sm border border-[var(--frame-line)] bg-white dark:bg-zinc-900',
        className,
      )}
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
  extends Omit<React.HTMLAttributes<HTMLElement>, 'title'>,
    VariantProps<typeof rowSeparator> {
  /**
   * The element to render. `button` for a row that DOES something — which is
   * most of them, and is why this exists: a row with an `onClick` on a `<div>`
   * is invisible to keyboard and assistive tech, and wrapping every call site
   * in its own button would put the focus ring around the row instead of on
   * it. `div` stays the default for a row that is only ever read.
   */
  as?: 'div' | 'button';
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

/**
 * forwardRef because callers mount BEHAVIOUR on the row element: the browse
 * directory hands its node to NavLink so a modified click opens a new tab, and
 * a kit gesture would attach the same way. A primitive that swallows the ref
 * pushes those callers back into a wrapper div — which is the layout the row
 * exists to provide in the first place.
 */
export const ListRow = React.forwardRef<HTMLElement, ListRowProps>(function ListRow({
  className, leading, title, subtitle, dot, chevron = true, trailing, inset, as = 'div', ...props
}, ref) {
  const Tag = as;
  // A row with no tile has nothing to inset the hairline PAST, so it falls back
  // to the text inset rather than leaving a gap the eye reads as a broken rule.
  const depth = inset ?? (leading ? 'tile' : 'text');
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLButtonElement>}
      // `text-left w-full` only matter on a button — a button centres its
      // content and shrinks to it, which would break the row's layout the
      // moment `as` changed. Harmless on a div, so they are unconditional
      // rather than a second branch to keep in step.
      {...(as === 'button' ? { type: 'button' as const } : null)}
      className={cn(
        'relative flex w-full items-center gap-4 px-4 py-3.5 text-left',
        (props.onClick || as === 'button') && 'cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800',
        rowSeparator({ inset: depth }),
        className,
      )}
      {...props}
    >
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{title}</div>
        {subtitle ? (
          <div className="truncate text-[0.9375rem] text-zinc-500 dark:text-zinc-500">{subtitle}</div>
        ) : null}
      </div>
      {dot ? (
        <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-hidden="true" />
      ) : null}
      {trailing}
      {chevron ? (
        <ChevronRightIcon className="h-5 w-5 shrink-0 text-zinc-300 dark:text-zinc-600" aria-hidden="true" />
      ) : null}
    </Tag>
  );
});
