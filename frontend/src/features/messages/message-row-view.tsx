import type { ReactNode, Ref } from 'react';

import { useMessages } from '../../lib/i18n/react';

/*
 * The shared message row, on its own so every place can draw it without
 * bringing in Messages' store and screens: ./message-row.tsx (Messages),
 * ../group-chat/transcript.tsx (a project's channels, reply threads and a
 * request's or a change's stream) and ../dev-board/card/feed-thread.tsx (the
 * comments under a change on the board). It imports nothing but the words.
 */

/**
 * Where a row's bar hangs. Audit D13 (2 Nov 2026): on somebody else's
 * bubble it hangs at the end of its name line (`head`), beside the message,
 * not at the transcript's far edge, where on a wide screen it sat 800px from
 * a short bubble and over the row above. Desktop polish 11 (24 Nov 2026): a
 * continuation line of theirs has no name line, so its bar sits on the
 * bubble itself (`bubble`), over its top edge and ending where the bubble
 * ends; MessageActionBar measures the bubble as the pointer or the keyboard
 * comes in, and app.css `.msgx-bar-on-bubble` places it. Your own bubble and
 * a room's rows already end where the bar is (`row`).
 */
export function barPlacement({ sided, mine, grouped }: { sided: boolean; mine: boolean; grouped: boolean }): 'head' | 'bubble' | 'row' {
  if (!sided || mine) return 'row';
  return grouped ? 'bubble' : 'head';
}

/**
 * ONE MESSAGE ROW, WHEREVER THE MESSAGE CAME FROM: the picture (or, on a
 * continuation line, the time in the gutter), the line naming its author
 * with the time, the words (in a bubble on the sender's side in a
 * conversation, flat in a room), the pictures above them, and under them
 * whatever the message carries, its notes and the controls.
 *
 * Messages' conversations draw it (./message-row.tsx MessageRow), and so do a project's
 * topic channels, its general chat, its reply threads and a request's or a
 * change's stream (../group-chat/transcript.tsx), and the comments under a
 * change on the board, at the feed's size (`compact`,
 * ../dev-board/card/feed-thread.tsx). It knows nothing about where the
 * message came from: each place hands it the parts, already drawn, and its
 * own classes and data-* attributes (`className`, `attrs`), which that
 * place's code and its declared checks look the row up by. The controls are
 * ../message-actions/controls.tsx's, gated by ../message-actions/rules.ts.
 */
export function MessageRowView({
  rowRef, id, className = '', attrs, sided, mine, end, grouped, compact = false, state = {},
  avatar, author, lead, bot = false, badge, at, time, timeTitle, timeClassName, stamp, meta, gutter, continuedMeta,
  pictures, body, rich = false, under, extras, notes, bar, barInHead = false, sheet, longPress,
}: {
  rowRef?: Ref<HTMLElement>;
  /** The row's own id, where a link to the message lands. */
  id?: string;
  /** The place's own classes on the row. */
  className?: string;
  /** The place's own attributes on the row (data-msg-id, data-message-id, …). */
  attrs?: Record<string, string | number | null | undefined>;
  /** The words in a bubble on their sender's side (a conversation), else the flat named row (a room). */
  sided: boolean;
  /** The viewer's own message: no face beside a bubble, the name for a screen reader alone. */
  mine: boolean;
  /** A room's own message on the right, its face at the trailing edge (#7163). */
  end: boolean;
  /** A continuation of the same person's previous message: no face and no name line. */
  grouped: boolean;
  /** At the board's size: a comment under a change. */
  compact?: boolean;
  state?: { saved?: boolean; pending?: boolean; failed?: boolean; deleted?: boolean; focused?: boolean; system?: boolean };
  avatar: ReactNode;
  author: string;
  /** Before the name: an unread dot. */
  lead?: ReactNode;
  /** Homeroom bot's message: the AI badge after its name. */
  bot?: boolean;
  /** After the name: a "via agent" chip. */
  badge?: ReactNode;
  /** The instant (ISO), its words for the line, and its unelided form for the title. */
  at: string;
  time: string;
  timeTitle: string;
  /** The place's own class on the time. */
  timeClassName?: string;
  /** In place of the time, a sentence that carries it ("3:04 PM · on GitHub"). */
  stamp?: ReactNode;
  /** After the time: what it was written on, edited. */
  meta?: ReactNode;
  /** The gutter's clock on a continuation line. */
  gutter: string;
  /** A continuation line's own meta line (its edited mark), as it has no name line. */
  continuedMeta?: ReactNode;
  /** Pictures, above the words. */
  pictures?: ReactNode;
  /** The words; null when the message is nothing but pictures, so no empty bubble is drawn. */
  body: ReactNode | null;
  /** Task 2020: a laid-out answer takes the bubble's full width (app.css .messages-bubble-rich). */
  rich?: boolean;
  /** Right under the words: the way back from a translation. */
  under?: ReactNode;
  /** Files, cards, reactions, a thread. */
  extras?: ReactNode;
  /** A send's state: not sent, sending, waiting for a connection. */
  notes?: ReactNode;
  bar?: ReactNode;
  /** Hang the bar at the end of the name line (somebody else's bubble). */
  barInHead?: boolean;
  sheet?: ReactNode;
  longPress?: object;
}) {
  const states = `${mine ? 'messages-message-self' : ''} ${end ? 'messages-message-end' : ''} ${state.saved ? 'messages-message-saved' : ''} ${state.pending ? 'messages-message-pending' : ''} ${state.failed ? 'messages-message-failed' : ''} ${state.deleted ? 'messages-message-deleted' : ''} ${state.focused ? 'messages-message-focus' : ''} ${state.system ? 'messages-message-system' : ''}`;
  return (
    <article
      ref={rowRef}
      id={id}
      {...attrs}
      className={`messages-message group ${sided ? 'messages-message-bubble ' : ''}${grouped ? 'messages-message-grouped' : ''} ${states}${compact ? ' messages-message-compact' : ''}${className ? ` ${className}` : ''}`}
      {...longPress}
    >
      {/* #5680: your own message is already on its side — the tint and the
          right edge say whose it is — so it needs no face. A room's row
          keeps it: there the side says nothing. */}
      {grouped
        ? <time className="messages-message-gutter" dateTime={at} title={timeTitle}>{gutter}</time>
        : sided && mine ? null : avatar}
      <div className={sided ? 'min-w-0 flex-1 messages-bubble-wrap' : 'min-w-0 flex-1'}>
        {/* Audit C05/Y06 (2 Nov 2026): the line over a message names its
            author the one way every chat does, their bare username; a handle
            in a sentence keeps its @. Your own bubble is already on your side
            and tinted, so its line says only the time, and your name is there
            for a screen reader alone, not in the accent, which marks an action. */}
        {grouped ? null : (
          <div className="messages-message-head">
            {lead}
            <span dir="auto" className={`messages-message-author ${mine && sided ? 'sr-only' : ''}`}>{author}</span>
            {bot ? <BotBadge /> : null}
            {badge}
            {stamp || <time className={timeClassName} dateTime={at} title={timeTitle}>{time}</time>}
            {meta}
            {barInHead ? bar : null}
          </div>
        )}
        {/* #5680: in a conversation the words sit in a bubble on their
            sender's side; the head above them, and everything under them
            (pictures, shared items, reactions, a thread) stays outside it. */}
        {pictures}
        {body === null ? null : sided ? <div className={rich ? 'messages-bubble messages-bubble-rich' : 'messages-bubble'} dir="auto">{body}</div> : body}
        {under}
        {extras}
        {grouped && continuedMeta ? <div className="messages-message-meta">{continuedMeta}</div> : null}
        {notes}
      </div>
      {barInHead ? null : bar}
      {sheet}
    </article>
  );
}

/** Homeroom bot's AI badge after its name. */
function BotBadge() {
  const t = useMessages('messages');
  return <span className="messages-bot-badge">{t('messages:row.aiBadge')}</span>;
}
