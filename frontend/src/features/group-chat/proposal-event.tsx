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
 * The viewer's own event — a proposal they put up, a merge they forced — is
 * the same named row as anybody's, on the left with its avatar, as their own
 * messages are since every chat went to Discord's rows (#2783). It keeps
 * `gc-event-self`, which is how the stylesheet can still tell it apart.
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

import { memo } from 'react';

import { ChatMessageRow } from '@/components/ui/chat';
import { Avatar } from '@/components/ui/feed';
import { ChevronRightIcon } from '@/components/ui/icons';

import { CardIcon } from '../dev-board/card/dev-card';
import { swatchFor } from './swatch';
import type { ProposalEvent, TranscriptMessage } from './transcript-store';

/**
 * "Proposed PR #12 for a vote: Custom tier colors", "PR #12 went live with
 * 2/3 votes: Custom tier colors", "Force-merged PR #12 with 0/2 votes: …".
 * The number always leads; the title follows when the line carried one.
 * A merge on the platform's own app (`liveSoon`, follow-up to #2897) is
 * released after it merges, so it reads "PR #12 merged with 2/3 votes and
 * will be live in a few minutes: …" instead of claiming it is live.
 */
export function eventText(msg: TranscriptMessage): string {
  const ev = msg.event;
  if (!ev) return '';
  const pr = `PR #${ev.prNumber}`;
  const title = ev.title ? `: ${ev.title}` : '';
  const votes = ev.votes ? ` with ${ev.votes} votes` : '';
  // On the proposal's own page the row names the act, not the proposal:
  // the number and title are the page's heading.
  if (ev.type === 'vote') return `Voted ${ev.vote || 'yes'}${ev.reason ? `: “${ev.reason}”` : ''}`;
  if (ev.type === 'notice') return ev.text || '';
  if (ev.here && ev.type === 'submitted') return 'Proposed this change for a vote';
  if (ev.here && ev.type === 'merged') {
    if (ev.force) return `Force-merged this change${votes}`;
    if (ev.liveSoon) {
      if (ev.credits) return `This change merged and will be live in a few minutes. ${creditsSentence(ev.credits)}`;
      return `This change merged${votes} and will be live in a few minutes`;
    }
    if (ev.credits) return `This change is live. ${creditsSentence(ev.credits)}`;
    return `This change went live${votes}`;
  }
  if (ev.type === 'submitted') return `Proposed ${pr} for a vote${title}`;
  if (ev.type === 'weekly') return `This week on ${ev.weekly?.app || 'the app'}`;
  if (ev.force) return `Force-merged ${pr}${votes}${title}`;
  // #1688: a merge that named its people reads as the sentence it was —
  // the number and the tally move to the muted tail (see EventRow).
  if (ev.liveSoon) {
    if (ev.credits) return `${ev.title || pr} merged and will be live in a few minutes. ${creditsSentence(ev.credits)}`;
    return `${pr} merged${votes} and will be live in a few minutes${title}`;
  }
  if (ev.credits) return `${ev.title || pr} is live. ${creditsSentence(ev.credits)}`;
  return `${pr} went live${votes}${title}`;
}

/** "alice", "alice and bob", "alice, bob and carol". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "Built by evan, backed by alice and bob, shaped by carol." — the server's own shape (routes/votes.js creditsSentence). */
export function creditsSentence(c: { author: string; backers: string[]; shapers: string[] }): string {
  const parts: string[] = [];
  if (c.author) parts.push(`Built by ${c.author}`);
  if (c.backers.length) parts.push(`${parts.length ? 'backed' : 'Backed'} by ${nameList(c.backers)}`);
  if (c.shapers.length) parts.push(`${parts.length ? 'shaped' : 'Shaped'} by ${nameList(c.shapers)}`);
  return parts.length ? `${parts.join(', ')}.` : '';
}

/** The muted tail after a named merge: "PR #41 · 3/5 votes". */
export function eventTail(msg: TranscriptMessage): string {
  const ev = msg.event;
  if (!ev || ev.type !== 'merged' || ev.force || !ev.credits) return '';
  return [`PR #${ev.prNumber}`, ev.votes ? `${ev.votes} votes` : ''].filter(Boolean).join(' · ');
}

/**
 * The Friday card (#1688): what went live this week and who made it, then
 * what is waiting on votes, then the door to the Workshop. A message from
 * the app itself, in the event box's surface, with the lines the card
 * carries — never the whole week when it is long; the totals say the rest.
 */
function WeeklyBox({ w }: { w: NonNullable<ProposalEvent['weekly']> }) {
  const moreMerged = w.mergedTotal - w.merged.length;
  const moreOpen = w.openTotal - w.open.length;
  return (
    <div className="gc-event-box gc-event-weekly">
      <div className="gc-weekly-title">{`This week on ${w.app}`}</div>
      <div className="gc-weekly-section">
        <div className="gc-weekly-head gc-weekly-head-live">
          {w.mergedTotal === 0
            ? 'Nothing landed this week'
            : `${w.mergedTotal} ${w.mergedTotal === 1 ? 'change' : 'changes'} went live`}
        </div>
        {w.merged.map((m, i) => (
          <div key={m.id ?? `m${i}`} className="gc-weekly-line" data-weekly="merged">
            <span className="gc-weekly-line-title">{m.title}</span>
            {m.author ? (
              <span className="gc-weekly-line-who">
                {` · ${m.author}${m.backers.length ? `, backed by ${nameList(m.backers)}` : ''}`}
              </span>
            ) : null}
          </div>
        ))}
        {moreMerged > 0 ? <div className="gc-weekly-more">{`and ${moreMerged} more`}</div> : null}
      </div>
      {w.openTotal > 0 ? (
        <div className="gc-weekly-section">
          <div className="gc-weekly-head gc-weekly-head-open">
            {w.openTotal === 1 ? 'One proposal is waiting for eyes' : `${w.openTotal} proposals are waiting for eyes`}
          </div>
          {w.open.map((o, i) => (
            <div key={o.id ?? `o${i}`} className="gc-weekly-line" data-weekly="open">
              <span className="gc-weekly-line-title">{o.title}</span>
              {o.prNumber ? <span className="gc-weekly-line-who">{` · PR #${o.prNumber}`}</span> : null}
            </div>
          ))}
          {moreOpen > 0 ? <div className="gc-weekly-more">{`and ${moreOpen} more`}</div> : null}
        </div>
      ) : null}
      {w.slug ? (
        <a className="gc-weekly-door" href={`#app/${w.slug}/dev`}>Open the Workshop ›</a>
      ) : null}
    </div>
  );
}

export const EventRow = memo(function EventRow({ msg }: { msg: TranscriptMessage }) {
  const ev = msg.event;
  if (!ev) return null;
  if (ev.type === 'weekly' && ev.weekly) {
    return (
      <ChatMessageRow
        className="gc-event"
        from="them"
        data-msg-id={msg.id ?? ''}
        data-event="weekly"
        avatar={(
          <Avatar shape="square" size="md" color={swatchFor(ev.sender)} aria-hidden="true">
            {ev.sender.charAt(0).toUpperCase()}
          </Avatar>
        )}
        name={<span data-event-sender="">{ev.sender}</span>}
        timestamp={<span className="gc-msg-time" title={msg.timeTitle}>{msg.time}</span>}
      >
        <WeeklyBox w={ev.weekly} />
      </ChatMessageRow>
    );
  }
  const href = msg.eventHref || null;
  const open = ev.type === 'submitted' && msg.votePhase !== 'settled';
  // The viewer's own event is marked, not moved (#2783): the same left-hand
  // named row as everybody's, as the viewer's own messages are.
  const me = ev.mine;
  const tail = eventTail(msg);
  const box = (
    <>
      {ev.icon ? <CardIcon spec={{ ...ev.icon, small: true }} /> : null}
      <span className="gc-event-text">
        {eventText(msg)}
        {tail ? <span className="gc-event-tail">{` ${tail}`}</span> : null}
      </span>
      {href ? (
        <ChevronRightIcon className="w-4 h-4 text-zinc-500 dark:text-zinc-500 shrink-0" aria-hidden="true" />
      ) : null}
    </>
  );
  return (
    <ChatMessageRow
      className={me ? 'gc-event gc-event-self' : 'gc-event'}
      data-msg-id={msg.id ?? ''}
      data-event={ev.type}
      // What refreshVoteControls reads back to resolve the row against the
      // vote snapshot — the same pair the thread's vote-controls host carries.
      data-session-id={ev.sessionId}
      data-pr-number={ev.prNumber}
      {...(open ? { 'data-open': '1' } : {})}
      {...(ev.here ? { 'data-here': '1' } : {})}
      {...(ev.type === 'vote' && ev.vote ? { 'data-vote': ev.vote } : {})}
      avatar={(
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
});
