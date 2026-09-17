/**
 * A proposal event in the general chat: put up for a vote, or merged.
 *
 * ── A message from whoever did it ─────────────────────────────────────
 *
 * The row is the transcript's own named row (@/components/ui/chat.tsx,
 * `ChatMessageRow`): the sender's square avatar, their name in bold and the
 * stamp on the header line, exactly where a person's message puts them, so
 * "cyrcle_0 proposed PR #2357 for a vote" reads as something cyrcle_0 did at
 * a time, in the same grid as what alice said a minute later. The sender is
 * the person for a submission and for a force-merge, and the app itself for
 * a merge its vote decided — the app announcing its own change. The avatar
 * is the swatch that person's messages wear (./swatch.ts), because it is
 * the same person.
 *
 * ── One box, in the Current status tab's language ─────────────────────
 *
 * Under the header sits one box in the surface of the Workshop's Current
 * status panes: the frosted sheet fill and hairline of `.dev-ws-strip`, not
 * a white card with a drop shadow, holding ONE glyph — the Dev board's for
 * this proposal, bare, without its tinted plate, as the general discussion
 * row (`.dev-ws-chat-row`) carries its own — and one line of simple text,
 * with the chevron every door wears when the box leads to the proposal's
 * page. Those are app.css's `.gc-event-box` rules. A submission whose vote is
 * still open carries `data-open`, and the box reads in the text ink rather
 * than the muted one: the one thing on the line that still wants the reader.
 * The viewer's own event — a proposal they put up, a merge they forced —
 * sits on the right with no avatar, as their own messages do (`gc-event-self`,
 * `from="me"` on the row).
 *
 * That is the whole row. No tally, no buttons, no bookmark, no react button,
 * no reactions: the controls live on the page the box opens.
 *
 * ── What the module decides, and what this does not ───────────────────
 *
 * Which rows are events, their number, title, actor, sender and tally, the
 * glyph and the link are all on the view model (`GroupChat._proposalEvent`,
 * `_eventIcon`, `_eventHref` in public/js/group-chat.js). This component
 * composes the line from those facts and draws. It renders no controls host,
 * and its class is `gc-event`, not `gc-msg`: group-chat.js's long-press and
 * react handlers select on the latter, so an event gets no reaction bar. Its
 * tap-to-quote takes `gc-event` as well (#2390) — a tap on the row replies to
 * it, while the box is an anchor, and a tap there follows the link.
 */

import { ChatMessageRow } from '@/components/ui/chat';
import { Avatar } from '@/components/ui/feed';
import { ChevronRightIcon } from '@/components/ui/icons';

import { CardIcon } from '../dev-board/card/dev-card';
import { swatchFor } from './swatch';
import type { TranscriptMessage } from './transcript-store';

/**
 * "Proposed PR #12 for a vote: Custom tier colors", "PR #12 went live with
 * 2/3 votes: Custom tier colors", "Force-merged PR #12 with 0/2 votes: …".
 * The number always leads; the title follows when the line carried one.
 */
export function eventText(msg: TranscriptMessage): string {
  const ev = msg.event;
  if (!ev) return '';
  const pr = `PR #${ev.prNumber}`;
  const title = ev.title ? `: ${ev.title}` : '';
  const votes = ev.votes ? ` with ${ev.votes} votes` : '';
  if (ev.type === 'submitted') return `Proposed ${pr} for a vote${title}`;
  if (ev.force) return `Force-merged ${pr}${votes}${title}`;
  return `${pr} went live${votes}${title}`;
}

export function EventRow({ msg }: { msg: TranscriptMessage }) {
  const ev = msg.event;
  if (!ev) return null;
  const href = msg.eventHref || null;
  const open = ev.type === 'submitted' && msg.votePhase !== 'settled';
  // The viewer's own event sits on the right, as their own messages do:
  // the row runs right to left, the box hugs the right edge, no avatar.
  const me = ev.mine;
  const box = (
    <>
      {ev.icon ? <CardIcon spec={{ ...ev.icon, small: true }} /> : null}
      <span className="gc-event-text">{eventText(msg)}</span>
      {href ? (
        <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" aria-hidden="true" />
      ) : null}
    </>
  );
  return (
    <ChatMessageRow
      className={me ? 'gc-event gc-event-self' : 'gc-event'}
      from={me ? 'me' : 'them'}
      data-msg-id={msg.id ?? ''}
      data-event={ev.type}
      // What refreshVoteControls reads back to resolve the row against the
      // vote snapshot — the same pair the thread's vote-controls host carries.
      data-session-id={ev.sessionId}
      data-pr-number={ev.prNumber}
      {...(open ? { 'data-open': '1' } : {})}
      avatar={me ? undefined : (
        <Avatar shape="square" size="md" color={swatchFor(ev.sender)} aria-hidden="true">
          {ev.sender.charAt(0).toUpperCase()}
        </Avatar>
      )}
      name={<span data-event-sender="">{ev.sender}</span>}
      timestamp={<span className="gc-msg-time" title={msg.timeTitle}>{msg.time}</span>}
    >
      {href
        ? <a className="gc-event-box" href={href} title="Open this proposal">{box}</a>
        : <div className="gc-event-box">{box}</div>}
    </ChatMessageRow>
  );
}
