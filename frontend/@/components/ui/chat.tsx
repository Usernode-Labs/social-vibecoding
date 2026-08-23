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
      className={cn('py-3 text-center text-[0.9375rem] text-zinc-400 dark:text-zinc-500', className)}
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
 */
export function ChatMessageRow({
  className, avatar, name, timestamp, actions, children, ...props
}: {
  avatar?: React.ReactNode;
  name: React.ReactNode;
  timestamp?: React.ReactNode;
  /**
   * Per-row controls, pinned to the header's trailing edge — the group chat's
   * edit / save / react buttons. A separate slot from `timestamp` because that
   * one is a muted text span and a button inheriting `text-zinc-400` on a
   * transcript is a control you cannot see.
   */
  actions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex gap-3 px-4 py-2', className)} {...props}>
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{name}</span>
          {timestamp ? (
            <span className="shrink-0 text-[0.9375rem] text-zinc-400 dark:text-zinc-500">{timestamp}</span>
          ) : null}
          {actions ? <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span> : null}
        </div>
        <div className="text-[1.0625rem] leading-snug text-zinc-900 dark:text-zinc-100">{children}</div>
      </div>
    </div>
  );
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
      <span className="text-[0.9375rem] font-bold text-violet-600 dark:text-violet-400">
        {count} {count === 1 ? 'reply' : 'replies'}
      </span>
      {timestamp ? (
        <span className="text-[0.9375rem] text-zinc-400 dark:text-zinc-500">{timestamp}</span>
      ) : null}
    </button>
  );
}
