import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * The conversation widgets: the day separator, the bubble, the named message
 * row, and a thread's reply summary.
 *
 * ── Two message shapes, because the deck has two conversations ────────
 *
 * The agent chat ("Your new idea") is a BUBBLE transcript: your turns are
 * accent-filled and right-aligned, the agent's are neutral and left-aligned,
 * with no names because there are only two participants and one of them is
 * you. The group chat ("Recipe App · 2 members") is a NAMED ROW transcript:
 * square avatar, bold name, time, flat text, no bubble — because with n
 * participants the name is the disambiguator and bubbles would waste the
 * width the text needs.
 *
 * Both live here rather than in one over-parameterised component: they share
 * the screen and the vocabulary, but not a single class.
 */

export function DaySeparator({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('py-3 text-center text-[0.9375rem] text-zinc-500 dark:text-zinc-500', className)}
      {...props}
    />
  );
}

const bubble = cva('max-w-[78%] rounded-[1.25rem] px-4 py-2.5 text-[1.0625rem] leading-snug', {
  variants: {
    from: {
      // `me` is the accent; `them` is a neutral surface that still reads as a
      // bubble on the grey page ground, which is why it is white and not
      // zinc-100 (that IS the ground — the bubble would disappear).
      me: 'bg-violet-600 text-white',
      them: 'bg-white text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
    },
  },
  defaultVariants: { from: 'them' },
});

export interface MessageBubbleProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof bubble> {}

export function MessageBubble({ className, from, ...props }: MessageBubbleProps) {
  return (
    <div className={cn('flex px-4 py-1', from === 'me' ? 'justify-end' : 'justify-start')}>
      <div className={cn(bubble({ from }), className)} {...props} />
    </div>
  );
}

/**
 * One message in a named transcript. `children` is the body, so a caller can
 * pass rendered markdown, an attachment card, or a reaction row without this
 * component knowing what any of them are.
 *
 * `from` is the row's side. `them` is the named row as the deck draws it:
 * avatar on the left, name then time on the header line, the body under
 * them. `me` mirrors it for the viewer's own message — the row runs right to
 * left, but the header still reads name then time (#2392): it is pushed
 * against the right edge rather than reversed, with the controls at the far
 * left, and the body column stacks its children
 * against the right edge, where a bubble hugs the side that says who is
 * speaking. The caller drops the avatar for `me`; a group chat does not
 * draw your own face beside your own words.
 */
export function ChatMessageRow({
  className, from = 'them', avatar, name, timestamp, actions, grouped = false, gutter, children, ...props
}: {
  from?: 'them' | 'me';
  avatar?: React.ReactNode;
  /**
   * A continuation of the same person's previous message (#2783): no avatar
   * and no header line, just the body, indented to the column the named row
   * above it writes in. `gutter` is what sits where the avatar would — the
   * time, muted, so the line still says when without a header.
   */
  grouped?: boolean;
  gutter?: React.ReactNode;
  name: React.ReactNode;
  timestamp?: React.ReactNode;
  /**
   * Per-row controls, pinned to the header's trailing edge — the group chat's
   * edit / save / react buttons. A separate slot from `timestamp` because that
   * one is a muted text span and a button inheriting `text-zinc-500 dark:text-zinc-400` on a
   * transcript is a control you cannot see.
   */
  actions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const me = from === 'me';
  if (grouped) {
    return (
      <div className={cn('flex gap-3 px-4 py-0.5', className)} data-grouped="" {...props}>
        <span className="w-11 shrink-0 pt-0.5 text-right text-[0.6875rem] leading-5 text-zinc-500 dark:text-zinc-500">{gutter}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[1.0625rem] leading-snug text-zinc-900 dark:text-zinc-100">{children}</div>
        </div>
        {actions ? <span className="flex shrink-0 items-start gap-1">{actions}</span> : null}
      </div>
    );
  }
  return (
    <div className={cn('flex gap-3 px-4 py-2', me && 'flex-row-reverse', className)} {...props}>
      {avatar}
      <div className="min-w-0 flex-1">
        <div className={cn('flex items-baseline gap-2', me && 'justify-end')}>
          <span className="truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{name}</span>
          {timestamp ? (
            <span className="shrink-0 text-[0.9375rem] text-zinc-500 dark:text-zinc-500">{timestamp}</span>
          ) : null}
          {actions ? (
            <span className={cn('flex shrink-0 items-center gap-1', me ? 'order-first mr-auto' : 'ml-auto')}>{actions}</span>
          ) : null}
        </div>
        <div
          className={cn(
            'text-[1.0625rem] leading-snug text-zinc-900 dark:text-zinc-100',
            me && 'flex flex-col items-end',
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * Whether a message continues the one before it (#2783) — Discord's rule,
 * shared by every transcript so the two surfaces group alike: the same
 * author, within seven minutes, on the same day, and not a reply (a quoted
 * message restates who it answers, so it gets its own header).
 */
export const GROUP_WINDOW_MS = 7 * 60 * 1000;
export function groupsWithPrevious(
  previous: { author: string | number; at: string | number | Date } | null | undefined,
  current: { author: string | number; at: string | number | Date; reply?: boolean },
): boolean {
  if (!previous || current.reply) return false;
  if (String(previous.author) !== String(current.author)) return false;
  const a = new Date(previous.at);
  const b = new Date(current.at);
  const gap = b.getTime() - a.getTime();
  if (!Number.isFinite(gap) || gap < 0 || gap > GROUP_WINDOW_MS) return false;
  return a.toDateString() === b.toDateString();
}

/**
 * "◆◆◆ 6 replies · Today at 7:58 AM" — the affordance that opens a thread.
 *
 * The count is the ACCENT, and it is the only accent-coloured text in the
 * transcript: it is the one thing in a message row that navigates. The
 * stacked avatars are decorative and marked `aria-hidden`, so the button's
 * accessible name is just the count and time.
 */
export function ThreadReplySummary({
  className, avatars, count, timestamp, ...props
}: {
  avatars?: React.ReactNode;
  count: number;
  timestamp?: React.ReactNode;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  return (
    <button
      type="button"
      className={cn('mt-1 flex items-center gap-2 rounded-lg py-0.5 text-left', className)}
      {...props}
    >
      {avatars ? <span className="flex -space-x-1" aria-hidden="true">{avatars}</span> : null}
      <span className="text-[0.9375rem] font-bold text-violet-700 dark:text-violet-400">
        {count} {count === 1 ? 'reply' : 'replies'}
      </span>
      {timestamp ? (
        <span className="text-[0.9375rem] text-zinc-500 dark:text-zinc-500">{timestamp}</span>
      ) : null}
    </button>
  );
}
