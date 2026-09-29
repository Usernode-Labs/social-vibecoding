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

/**
 * THE SECTION LABEL IS SMALL CAPS: 12px, bold, uppercase, tracked. It names
 * the card under it; it is not a line of text in its own right, and at the
 * body's 15px in grey it read as one, the same size as the rows' own titles,
 * so a screen of three sections looked like a screen of three paragraphs.
 * Small and tracked is the label every grouped list in the design reference
 * wears (AGENTS.md, "Type and colour"), and it is the one place in the shell
 * that is uppercase. dark:text-zinc-400 for the contrast reason the row's
 * subtitle gives below.
 */
export function SectionHeader({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn('px-4 pb-2 pt-6 text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400', className)}
      {...props}
    />
  );
}

/*
 * ── Tone ──────────────────────────────────────────────────────────────
 *
 * `card` (the default) is the white card the deck draws. `plane` is the warm
 * off-white the Discover pane and the sheets use: app.css `--dc-sheet-solid`,
 * the pane glass over the wallpaper made solid, which already follows the
 * dark theme. A screen that sits on the wallpaper asks for it so its lists
 * read as the same material as Discover rather than as white cutouts.
 * `PLANE_FILL` is the same class for a card that is not a list (a profile
 * header, a stat tile), so the literal lives once, here, where Tailwind's
 * extractor sees it.
 */
export const PLANE_FILL = 'bg-[color:var(--dc-sheet-solid)]';

/*
 * ONE HAIRLINE AND A 20px RADIUS (AGENTS.md, "Type and colour"). Figure and
 * ground still do the separating; the hairline is what keeps the card's edge
 * where it is when the ground under it is the pale end of the wallpaper and
 * the plane colour is a point or two off it, which is most of a phone
 * screen. Inset, as a shadow, so it adds no width and a row's own hairline
 * inset (below) still lands where the tile ends. The colour is
 * `--app-sheet-line`, the sheets' own edge, which already has its dark value.
 */
const groupedList = cva('mx-4 overflow-hidden rounded-[20px] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]', {
  variants: {
    tone: {
      card: 'bg-white dark:bg-zinc-900',
      plane: 'bg-[color:var(--dc-sheet-solid)]',
    },
  },
  defaultVariants: { tone: 'card' },
});

export function GroupedList({ className, tone, ...props }: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof groupedList>) {
  return (
    <div
      className={cn(groupedList({ tone }), className)}
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
  //
  // AnchorHTMLAttributes rather than HTMLAttributes so `href`, `target` and
  // `rel` reach the element for `as="a"` (see below). Its own `type` — the
  // anchor's MIME hint — is omitted because this component writes a button's
  // `type`, and two meanings on one prop name is a trap rather than a union.
  extends Omit<React.AnchorHTMLAttributes<HTMLElement>, 'title' | 'type'>,
    VariantProps<typeof rowSeparator> {
  /**
   * The element to render. `button` for a row that DOES something — which is
   * most of them, and is why this exists: a row with an `onClick` on a `<div>`
   * is invisible to keyboard and assistive tech, and wrapping every call site
   * in its own button would put the focus ring around the row instead of on
   * it. `div` stays the default for a row that is only ever read.
   *
   * `a` for a row that NAVIGATES, and it is not interchangeable with `button`:
   * cmd/ctrl-click, middle-click, "open in new tab", the context menu, the
   * status bar and drag-to-bookmark are all the browser's to give, and only an
   * anchor with an href gets them. The shell takes that seriously enough that
   * #back-btn and the app chip's own menu rows are anchors for this reason —
   * so a grouped-list row that is a link should be one too, rather than a
   * button that assigns `location`.
   *
   * A row that WRAPS its own controls cannot be one (nested interactives are
   * invalid inside an anchor); features/apps/browse-list.tsx is that case, and
   * it keeps `div` plus NavLink's modified-click interception instead.
   */
  as?: 'div' | 'button' | 'a';
  /**
   * For `as="button"` only. Anchor attributes have no `disabled`, so it is
   * named here rather than smuggled through a cast: a ?demo= fixture renders
   * the control it cannot let navigate as a real, inert button
   * (features/settings/social-identity.tsx).
   */
  disabled?: boolean;
  /**
   * The DOM `title` TOOLTIP.
   *
   * It needs its own name because `title` is this component's row CONTENT (see
   * the Omit above), so a caller that wants a hover hint as well as a row
   * label has no other way to ask for one — and dropping the hint was the last
   * thing keeping the app detail page's rows hand-rolled (#2446). Rendered as
   * the attribute, so `undefined` writes nothing at all.
   */
  tooltip?: string;
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
   * The default is a 650 weight at 15px, which is right for the rows this
   * primitive was built for — a conversation, an app, a notification — where
   * the title is the row's subject and a subtitle sits under it. A settings MENU is the
   * other kind of grouped list: every row is one word, there are no subtitles,
   * and bolding all of them makes a page of headings with nothing under them.
   * Rather than fork the primitive, such a caller passes a weight here.
   */
  titleClassName?: string;
  /** Optional layout hooks; defaults retain the standard single-line row. */
  contentClassName?: string;
  subtitleClassName?: string;
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
  titleClassName, contentClassName, subtitleClassName, tooltip, ...props
}, ref) {
  const Tag = as;
  // A row with no tile has nothing to inset the hairline PAST, so it falls back
  // to the text inset rather than leaving a gap the eye reads as a broken rule.
  const depth = inset ?? (leading ? 'tile' : 'text');
  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement & HTMLButtonElement & HTMLAnchorElement>}
      // `text-left w-full` only matter on a button — a button centres its
      // content and shrinks to it, which would break the row's layout the
      // moment `as` changed. Harmless on a div, so they are unconditional
      // rather than a second branch to keep in step. An anchor needs neither
      // (`flex` blockifies it) and takes no `type`.
      {...(as === 'button' ? { type: 'button' as const } : null)}
      className={cn(
        'relative flex w-full items-center gap-4 px-4 py-3.5 text-left',
        (props.onClick || as === 'button' || as === 'a') && 'cursor-pointer active:bg-zinc-50 dark:active:bg-zinc-800',
        rowSeparator({ inset: depth }),
        className,
      )}
      title={tooltip}
      {...props}
    >
      {leading}
      <div className={cn('min-w-0 flex-1', contentClassName)}>
        {/* 15 OVER 13 (AGENTS.md, "Type and colour"). The title was 17px
            bold over a 15px subtitle: the size of a heading, on every row,
            so a list of five rows read as five headings and the one real
            heading above them had nothing left to be louder with. 15px at
            650 is the row's subject; 13px grey is the fact under it. */}
        <div className={cn(
          'truncate text-[0.9375rem] font-[650] leading-5 text-zinc-900 dark:text-zinc-100',
          titleClassName,
        )}>{title}</div>
        {/* dark:text-zinc-400, not -500 (QA 2026-09-24 Q20): zinc-500 is
            3.54:1 on the #0b0b0c page and 3.06 on a zinc-900 card, the
            Discover rows' and the Me screen's meta lines. zinc-400 is 6.0 and
            5.2, and is still the quiet line under a bold title. */}
        {subtitle ? (
          <div className={cn('mt-0.5 truncate text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400', subtitleClassName)}>{subtitle}</div>
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
