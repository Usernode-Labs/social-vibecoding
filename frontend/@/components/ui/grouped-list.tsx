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
  // subtle-y2k: section labels wear the brand kit's technical-label voice —
  // Geist Mono, uppercase, tracked — one size down from the sentence-case
  // 0.9375rem they replaced, because a mono uppercase line runs wider than
  // the same words in the text face.
  return (
    <h2
      className={cn('px-4 pb-2 pt-6 font-mono text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-300', className)}
      {...props}
    />
  );
}

/**
 * The card itself: figure, and nothing about where it sits on the ground.
 *
 * It used to bake `mx-4` into this root. That was a component deciding its own
 * position in a layout it cannot see, and the evidence was unambiguous — the
 * ONE caller (features/settings/settings-nav.tsx) passed `mx-0` to cancel it,
 * so the baked margin was overridden at 100% of its call sites. `cn` is
 * tailwind-merge, so `mx-4` + `mx-0` already resolved to `mx-0`: dropping it
 * renders the same class attribute byte for byte, and leaves the caller's
 * `mx-0` as a no-op it can now delete.
 *
 * A screen that wants this card inset spells that inset on its own scroll
 * container, once, rather than every card self-insetting — which is the
 * defect, not the 16px.
 */
export function GroupedList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('overflow-hidden rounded-2xl bg-white dark:bg-zinc-900', className)}
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
  /**
   * Extra classes for the title line, merged over its defaults.
   *
   * The default is `font-bold`, which is right for the rows this primitive was
   * built for — a conversation, an app, a notification — where the title is
   * the row's subject and a subtitle sits under it. A settings MENU is the
   * other kind of grouped list: every row is one word, there are no subtitles,
   * and bolding all of them makes a page of headings with nothing under them.
   * Rather than fork the primitive, such a caller passes a weight here.
   */
  titleClassName?: string;
}

/**
 * forwardRef because callers mount BEHAVIOUR on the row element: the browse
 * directory hands its node to NavLink so a modified click opens a new tab, and
 * a kit gesture would attach the same way. A primitive that swallows the ref
 * pushes those callers back into a wrapper div — which is the layout the row
 * exists to provide in the first place.
 */
export const ListRow = React.forwardRef<HTMLElement, ListRowProps>(function ListRow({
  className, leading, title, subtitle, dot, chevron = true, trailing, inset, as = 'div',
  titleClassName, ...props
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
        <div className={cn(
          'truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100',
          titleClassName,
        )}>{title}</div>
        {subtitle ? (
          <div className="truncate text-[0.9375rem] text-zinc-500 dark:text-zinc-300">{subtitle}</div>
        ) : null}
      </div>
      {dot ? (
        <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-hidden="true" />
      ) : null}
      {trailing}
      {/* zinc-400, not zinc-300, and ONLY the light half moved: `dark:` already
          named zinc-400, so it always won in dark and the zinc-300 was never
          rendered there. This card's ground is `bg-white`, so the figures that
          matter are on a card (APCA-W3 0.1.9, the port in
          tests/theme-ink-guards.test.js): zinc-300 was Lc 25.9 and zinc-400 is
          56.3, against an unchanged -43.5 in dark.

          Read the ladder carefully before citing it, because an earlier draft
          of this comment got it backwards: 25.9 is INSIDE the non-content band
          (30 is its top, 15 is "barely visible"), not below it — a disclosure
          chevron is decorative and non-content is where it belongs. The move is
          made on CONSISTENCY, not on a failed rung: notifications-sheet.tsx
          spells `text-zinc-400 dark:text-zinc-400` for this same glyph, and one
          chevron in two inks is the thing worth fixing.

          The redundant `dark:` half is load-bearing in one narrow way — it is
          what exempts this run from tests/theme-ink-guards.test.js's unpaired
          zinc-400 ban, which tests for the presence of `dark:text-`. That is an
          exemption satisfied by spelling, so it is named here rather than left
          to look like a considered pair. */}
      {chevron ? (
        <ChevronRightIcon className="h-5 w-5 shrink-0 text-zinc-400 dark:text-zinc-400" aria-hidden="true" />
      ) : null}
    </Tag>
  );
});
