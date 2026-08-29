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
      className={cn('py-3 text-center text-[0.9375rem] text-zinc-500 dark:text-zinc-300', className)}
      {...props}
    />
  );
}

const bubble = cva('max-w-[78%] rounded-2xl px-4 py-2.5 text-[1.0625rem] leading-snug', {
  variants: {
    from: {
      // `me` is the accent; `them` is a neutral surface that still reads as a
      // bubble on the grey page ground, which is why it is white and not
      // zinc-100 (that IS the ground — the bubble would disappear).
      // Your own bubble is blue, not the action yellow — see --link-fill in
      // app.css. The yellow marks the one thing to DO on a screen.
      //
      // The fill is azure-800, not -700: white on -700 measures Lc -73.5
      // (APCA-W3 0.1.9), which is UNDER the 75 body minimum, while near-black
      // on the same fill is 35.3 — the one step where neither ink reads. It
      // also left your own message 30 Lc weaker than the `them` bubble beside
      // it (103.5 light / -93.3 dark). -800 is -83.1, and it is the step the
      // rest of the blue is converging on, so this spends no new value.
      // Stays one value across themes: `me` is a self-contained fill, so it
      // needs no dark partner — `them` carries the theme swap.
      me: 'bg-azure-800 text-white',
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
 * ── The row is FULL-BLEED, and its px-3 is an INTERIOR ─────────────────
 *
 * This was `px-4`, and because three different hosts wrap it — `#gc-messages`
 * (no inset), `#gc-thread-scroll` (`px-3`) and the boxed `#gc-thread-messages`
 * (`px-2`) — the same row rendered at 16 / 28 / 24px from the screen edge. A
 * child self-insetting inside a scroll container is verbatim the defect
 * tests/screen-keyline.test.js exists for, and the three hosts have been
 * emptied of horizontal padding in the same change so the row is now the ONLY
 * thing that says how far in a message starts: 12px, in all three.
 *
 * The inset stays ON the row rather than moving to the scroller, which is the
 * shape that file's `KEEP: the full-bleed session row keeps px-3` test names.
 * `.gc-msg:hover` paints a background band, and that band has always run edge
 * to edge; a scroller-owned gutter would inset the hover ground by 12px on
 * both sides and leave a dead strip. It is also the only arrangement the
 * transcript's other two row kinds agree with — `.gc-msg-system` and
 * `.gc-spec-card` carry their own `12px` in app.css, so a 12px scroller would
 * push them to 24 and trade a cross-host disagreement for a worse within-host
 * one.
 *
 * `px-3`, deliberately NOT `px-gutter`. This is a shell primitive, so its
 * padding answers to its own surface and must not track a screen-level token
 * it knows nothing about — the same reason `.dc-session-item` keeps its raw
 * spelling. It agrees by construction with `.gc-msg`'s own `padding: 6px 12px`
 * in app.css, which `px-4` had been masking; the two now say 12 together
 * instead of one quietly overriding the other with 16.
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
   * one is a muted text span and a button inheriting `text-zinc-500 dark:text-zinc-300` on a
   * transcript is a control you cannot see.
   */
  actions?: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex gap-3 px-3 py-2', className)} {...props}>
      {avatar}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">{name}</span>
          {timestamp ? (
            <span className="shrink-0 text-[0.9375rem] text-zinc-500 dark:text-zinc-300">{timestamp}</span>
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
 *
 * The ink is `azure-800` / `azure-200`.
 *
 * This paragraph used to argue for `azure-700` / `azure-300`, on the grounds
 * that azure's light ink "deliberately sits lower to stay near the brand hex,
 * so its dark partner sits lower too", and that 300 matched the accent pill in
 * ./feed.tsx. It is corrected in place rather than deleted, because the reading
 * it records is still true of the pill and no longer true of THIS.
 *
 * What separates them is ROLE, not ramp. The pill is a chip: accent ink on an
 * accent WASH, and 700 is the step that carries the brand hex #3090E1 — it
 * stays, and tests/group-chat-reactions.test.js pins that spelling. This is a
 * text button on the transcript's own ground, i.e. a LINK, and the owner has
 * settled link ink at 800/200 — their measurement, not one taken here: light
 * ink Lc 68.0 at 700 against 77.8 at 800, with true dark parity at 200, and
 * 24 of the roughly 30 link sites already spelled 800. A link is not a chip,
 * and the two now spell that difference.
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
      <span className="text-[0.9375rem] font-bold text-azure-800 dark:text-azure-200">
        {count} {count === 1 ? 'reply' : 'replies'}
      </span>
      {timestamp ? (
        <span className="text-[0.9375rem] text-zinc-500 dark:text-zinc-300">{timestamp}</span>
      ) : null}
    </button>
  );
}
