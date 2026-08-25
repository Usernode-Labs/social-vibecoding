import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';
import { ChevronRightIcon } from './icons';

/**
 * The activity feed's four widgets: the actor avatar, the event row it leads,
 * the quoted card an event can carry, and the pills under both.
 *
 * ── The avatar carries a BADGE, and that is load-bearing ──────────────
 *
 * Every row in the deck's Activity screen is "<someone> <did something>", and
 * the badge overlaid on the avatar's corner is what the verb is — a small
 * monochrome glyph in a page-coloured disc (a rocket for "went Live", a pencil
 * for "started working on this", quotes for "shared Feedback"). It reads as
 * one unit with the avatar rather than as a second icon in the row, which is
 * why it is positioned INSIDE this component and not left to callers: an
 * inconsistent badge offset across event kinds is immediately visible when the
 * rows stack.
 *
 * The disc is `bg-zinc-100 dark:bg-zinc-900`, i.e. the PAGE ground, not white
 * — the badge has to punch a hole in the avatar to read as an overlay, and on
 * the grey ground a white disc reads as a sticker sitting on top instead.
 *
 * ── Avatars are two shapes, on purpose ────────────────────────────────
 *
 * `circle` for people acting in a feed, `square` for people speaking in a
 * conversation. That is the deck's own split (Activity uses circles, the chat
 * screens use rounded squares) and it is a useful one: the same person reads
 * as an actor in one context and as a voice in the other.
 */

const avatar = cva(
  'relative flex shrink-0 items-center justify-center font-bold text-white',
  {
    variants: {
      shape: { circle: 'rounded-full', square: 'rounded-xl' },
      size: { sm: 'h-9 w-9 text-[0.8125rem]', md: 'h-11 w-11 text-[1.0625rem]' },
    },
    defaultVariants: { shape: 'circle', size: 'md' },
  },
);

export interface AvatarProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof avatar> {
  /** Background colour. Callers pass their own identity colour as an inline style. */
  color?: string;
  /** Small glyph disc on the lower-trailing corner — the event's verb. */
  badge?: React.ReactNode;
}

export function Avatar({ className, shape, size, color, badge, children, style, ...props }: AvatarProps) {
  return (
    <span
      className={cn(avatar({ shape, size }), className)}
      style={{ backgroundColor: color, ...style }}
      {...props}
    >
      {children}
      {badge ? (
        <span
          className="absolute -bottom-0.5 -right-0.5 flex h-[1.125rem] w-[1.125rem] items-center justify-center rounded-full bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 [&>svg]:h-3 [&>svg]:w-3"
          aria-hidden="true"
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
}

/**
 * One event. `summary` is the sentence — callers bold the verb inside it with
 * <strong>, because which span is the verb varies by event kind ("Evan moved
 * this · asking", "this went Live", "Mira started working on this") and
 * splitting it into fixed subject/verb/object props would fit none of them.
 */
export function ActivityRow({
  className, avatar: avatarNode, summary, timestamp, children, ...props
}: {
  avatar: React.ReactNode;
  summary: React.ReactNode;
  timestamp?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "relative flex gap-3 px-4 py-3.5 [&:not(:last-child)]:after:absolute [&:not(:last-child)]:after:bottom-0 [&:not(:last-child)]:after:left-4 [&:not(:last-child)]:after:right-4 [&:not(:last-child)]:after:h-px [&:not(:last-child)]:after:bg-zinc-200 dark:[&:not(:last-child)]:after:bg-zinc-800 [&:not(:last-child)]:after:content-['']",
        className,
      )}
      {...props}
    >
      {avatarNode}
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 text-[1.0625rem] leading-snug text-zinc-500 dark:text-zinc-500 [&>strong]:font-bold [&>strong]:text-zinc-900 dark:[&>strong]:text-zinc-100">
            {summary}
          </div>
          {timestamp ? (
            <span className="shrink-0 text-[0.9375rem] text-zinc-500 dark:text-zinc-500">{timestamp}</span>
          ) : null}
        </div>
        {children ? <div className="mt-2 space-y-2">{children}</div> : null}
      </div>
    </div>
  );
}

/**
 * The quoted record an event points at. Outlined rather than filled: it sits
 * INSIDE a white card already, so a second white surface would vanish and a
 * grey one would read as a disabled state.
 */
export function QuoteCard({
  className, title, body, children, ...props
}: { title?: React.ReactNode; body?: React.ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>) {
  return (
    <div
      className={cn('rounded-xl border border-zinc-200 p-3 dark:border-zinc-800', className)}
      {...props}
    >
      {title ? (
        <div className="text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{title}</div>
      ) : null}
      {body ? (
        <div className="mt-0.5 line-clamp-2 text-[1.0625rem] text-zinc-500 dark:text-zinc-500">{body}</div>
      ) : null}
      {children ? <div className="mt-3 flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

const pill = cva(
  'inline-flex items-center gap-1.5 rounded-full font-medium transition-colors',
  {
    variants: {
      size: {
        // `action` is the primary "go here" pill; `reaction` is the smaller
        // emoji+count chip that sits under a card.
        action: 'h-10 px-4 text-[1.0625rem]',
        reaction: 'h-8 px-3 text-[0.9375rem]',
      },
      // `accent` is "this one is YOURS" — the reaction you already added, and
      // the same shape of state on an action pill. A tinted accent ground
      // with accent ink, not an outline: the language fills its controls, and
      // a bordered pill among filled ones reads as a different component
      // rather than a different state. The pre-reskin spelling of this was
      // `.gc-react-mine` in app.css — an accent border over a surface that
      // Tailwind then won back, so it drew nothing at all.
      //
      // `hover:text-violet-800` is not decoration: accent ink on the light
      // hover ground is 3.86:1 without it and 5.28:1 with it. The neutral
      // tone needs no such correction (13.9:1 at hover) and the dark accent
      // does not either (5.71:1).
      tone: {
        neutral: 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700',
        accent: 'bg-violet-100 text-violet-700 hover:bg-violet-200 hover:text-violet-800 dark:bg-violet-950 dark:text-violet-300 dark:hover:bg-violet-900',
      },
    },
    defaultVariants: { size: 'action', tone: 'neutral' },
  },
);

export interface ActionPillProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    VariantProps<typeof pill> {
  /** Trailing disclosure chevron — "open the Change ›". */
  chevron?: boolean;
}

export function ActionPill({ className, size, tone, chevron, children, ...props }: ActionPillProps) {
  return (
    <button type="button" className={cn(pill({ size, tone }), className)} {...props}>
      {children}
      {chevron ? <ChevronRightIcon className="h-4 w-4" aria-hidden="true" /> : null}
    </button>
  );
}

export function ReactionPill({
  emoji, count, tone, className, ...props
}: { emoji: React.ReactNode; count?: number }
  & Pick<VariantProps<typeof pill>, 'tone'>
  & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  return (
    <button type="button" className={cn(pill({ size: 'reaction', tone }), className)} {...props}>
      <span aria-hidden="true">{emoji}</span>
      {typeof count === 'number' ? <span>{count}</span> : null}
    </button>
  );
}
