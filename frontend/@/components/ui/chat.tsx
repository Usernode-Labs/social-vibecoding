import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { ChevronDownIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/**
 * The conversation widgets: the day separator, the bubble, the named message
 * row, a thread's reply summary, and what marks the unread: the "New" line,
 * the banner that counts them and the jump to the latest.
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
 * The line above the first message the reader has not seen, Slack's and
 * Discord's "New": a hairline across the transcript with the word at its
 * trailing end. It asks for the reader's attention, so it is the accent
 * rather than a muted rule; the day separator above is the muted one.
 *
 * `ref` reaches the line itself: the transcript opens with it near the top
 * and measures it to know when the reader has reached it.
 */
export function NewMessagesDivider({
  className, ref, ...props
}: React.HTMLAttributes<HTMLDivElement> & { ref?: React.Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      role="separator"
      aria-label="New messages"
      data-unread-line=""
      className={cn('flex items-center gap-2 px-4 py-1.5', className)}
      {...props}
    >
      <span aria-hidden="true" className="h-px min-w-0 flex-1 bg-violet-500/60 dark:bg-violet-400/60" />
      <span aria-hidden="true" className="text-[0.8125rem] font-semibold leading-none text-violet-700 dark:text-violet-400">New</span>
    </div>
  );
}

/*
 * The two things a transcript draws OVER itself: the banner pinned at its
 * top and the jump button over its foot. Each stays in the document and is
 * shown and hidden by opacity and a short slide, both of which run on the
 * compositor (no size changes, no delay: iOS WebKit holds a delayed or a
 * width transition on the main thread). Hidden, it is `inert`: no pointer,
 * no focus, nothing read out. A reader who asked for less motion gets the
 * change without the slide.
 */
const FLOAT_MOTION = 'transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none';

/**
 * Where those two hang from: a box of no height beside the transcript's
 * scroller (before it for the top, after it for the foot), as the Homeroom
 * bot's tray hangs from its own. The scroller keeps its size and its class
 * string, and nothing is drawn inside it. The box passes taps through; the
 * control inside takes its own.
 *
 * `reserve` gives the foot a strip of its own instead of floating the
 * control up over the scroller's last rows (#4553): the box becomes a 44px
 * band and the foot disc sits fully inside it. For a foot that holds a
 * surface with its own controls — the change and request sheets' gate cards —
 * which a floating disc would cover. The height is permanent, shown or not:
 * growing and collapsing it with the control would shift the page and, at
 * some scroll positions, loop the control in and out of its own shown rule.
 */
export function TranscriptOverlay({ edge, reserve = false, children }: { edge: 'top' | 'foot'; reserve?: boolean; children?: React.ReactNode }) {
  return (
    <div className={reserve ? 'relative z-10 shrink-0 h-11' : 'relative z-10 h-0 shrink-0'} data-transcript-overlay={edge}>
      <div className={cn('pointer-events-none absolute inset-x-0 flex justify-center px-4', edge === 'top' ? 'top-2' : reserve ? 'bottom-1' : 'bottom-3')}>
        {children}
      </div>
    </div>
  );
}

/**
 * "3 new messages", over the top of the transcript; a tap takes the reader
 * to the line. An action with a number that asks for the reader, so it is
 * the accent, filled (AGENTS.md, "One accent").
 */
export function NewMessagesBanner({
  className, shown, ...props
}: { shown: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>) {
  return (
    <button
      type="button"
      inert={!shown}
      data-unread-banner=""
      className={cn(
        'pointer-events-auto rounded-full bg-violet-600 px-3.5 py-1.5 text-[0.8125rem] font-semibold leading-tight text-white shadow-[0_2px_10px_rgba(0,0,0,0.18)]',
        FLOAT_MOTION,
        shown ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-2 opacity-0',
        className,
      )}
      {...props}
    />
  );
}

/**
 * Jump to latest: a round disc with a down chevron over the foot of the
 * transcript, up whenever the reader is not at the bottom (Claude's). The
 * disc is the language's floating control, white on the sheet; `dot` is the
 * accent, for messages that arrived while the reader was up the
 * transcript, and the button's name says how many.
 */
export function JumpToLatestButton({
  className, shown, dot = false, ...props
}: { shown: boolean; dot?: boolean } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'>) {
  return (
    <button
      type="button"
      inert={!shown}
      data-jump-latest=""
      className={cn(
        'pointer-events-auto relative flex h-10 w-10 items-center justify-center rounded-full bg-white text-zinc-700 shadow-[0_1px_2px_rgba(0,0,0,0.08),0_4px_14px_rgba(0,0,0,0.14)] dark:bg-zinc-800 dark:text-zinc-200',
        FLOAT_MOTION,
        shown ? 'translate-y-0 scale-100 opacity-100' : 'pointer-events-none translate-y-2 scale-90 opacity-0',
        className,
      )}
      {...props}
    >
      <ChevronDownIcon aria-hidden="true" className="h-5 w-5" />
      {dot ? (
        <span aria-hidden="true" className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-violet-600 ring-2 ring-white dark:bg-violet-400 dark:ring-zinc-800" />
      ) : null}
    </button>
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
      <span className="text-[0.9375rem] font-bold text-violet-700 dark:text-violet-400">
        {count} {count === 1 ? 'reply' : 'replies'}
      </span>
      {timestamp ? (
        <span className="text-[0.9375rem] text-zinc-500 dark:text-zinc-500">{timestamp}</span>
      ) : null}
    </button>
  );
}
