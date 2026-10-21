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

import { useMessages } from '../../lib/i18n/react';
import { t } from '../../lib/i18n/runtime';
import { CardIcon } from '../dev-board/card/dev-card';
import { swatchFor } from './swatch';
import type { ProposalEvent, TranscriptMessage } from './transcript-store';

/**
 * B10d: in the words every screen uses. "Asked for approval: Custom tier
 * colors", "Custom tier colors went live with 2/3 votes", "An admin made
 * “Custom tier colors” live (0/2 votes)". The pull request number is not
 * said; a line with no title names "a change". A change on the platform's own
 * app (`liveSoon`, follow-up to #2897) goes live after it is approved, so it
 * reads "“Custom tier colors” was approved with 2/3 votes and will be live in
 * a few minutes" instead of claiming it is live. These are drawn words: the
 * stored server lines keep their old wording, and the parser that reads them
 * (group-chat.js `_proposalEvent`) is unchanged.
 */
export function eventText(msg: TranscriptMessage): string {
  const ev = msg.event;
  if (!ev) return '';
  // `ev.votes` is a tally the server wrote ("2/3"), not a count; '' when
  // there is none. Each sentence has a wording with it and one without.
  const tally = ev.votes;
  const title = ev.title;
  if (ev.type === 'vote') {
    if (ev.vote === 'no') {
      return ev.reason ? t('chat:group.event.votedNoReason', { reason: ev.reason }) : t('chat:group.event.votedNo');
    }
    return ev.reason ? t('chat:group.event.votedYesReason', { reason: ev.reason }) : t('chat:group.event.votedYes');
  }
  if (ev.type === 'notice') return ev.text || '';
  // On the change's own page the row names the act, not the change: the
  // title is the page's heading.
  if (ev.here && ev.type === 'submitted') return t('chat:group.event.here.submitted');
  if (ev.here && ev.type === 'merged') {
    if (ev.force) return tally ? t('chat:group.event.here.forcedTally', { tally }) : t('chat:group.event.here.forced');
    if (ev.liveSoon) {
      if (ev.credits) return t('chat:group.event.here.liveSoonCredits', { credits: creditsSentence(ev.credits) });
      return tally ? t('chat:group.event.here.liveSoonTally', { tally }) : t('chat:group.event.here.liveSoon');
    }
    if (ev.credits) return t('chat:group.event.here.liveCredits', { credits: creditsSentence(ev.credits) });
    return tally ? t('chat:group.event.here.wentLiveTally', { tally }) : t('chat:group.event.here.wentLive');
  }
  if (ev.type === 'submitted') return title ? t('chat:group.event.submitted', { title }) : t('chat:group.event.submittedUntitled');
  if (ev.type === 'weekly') return ev.weekly?.app ? t('chat:group.weekly.title', { app: ev.weekly.app }) : t('chat:group.weekly.titleNoApp');
  if (ev.force) {
    if (title) return tally ? t('chat:group.event.forcedTally', { title, tally }) : t('chat:group.event.forced', { title });
    return tally ? t('chat:group.event.forcedUntitledTally', { tally }) : t('chat:group.event.forcedUntitled');
  }
  // #1688: a change that named its people reads as the sentence it was;
  // the tally moves to the muted tail (see EventRow).
  if (ev.liveSoon) {
    if (ev.credits) {
      const credits = creditsSentence(ev.credits);
      return title ? t('chat:group.event.liveSoonCredits', { title, credits }) : t('chat:group.event.liveSoonCreditsUntitled', { credits });
    }
    if (title) return tally ? t('chat:group.event.liveSoonTally', { title, tally }) : t('chat:group.event.liveSoon', { title });
    return tally ? t('chat:group.event.liveSoonUntitledTally', { tally }) : t('chat:group.event.liveSoonUntitled');
  }
  if (ev.credits) {
    const credits = creditsSentence(ev.credits);
    return title ? t('chat:group.event.liveCredits', { title, credits }) : t('chat:group.event.liveCreditsUntitled', { credits });
  }
  if (title) return tally ? t('chat:group.event.wentLiveTally', { title, tally }) : t('chat:group.event.wentLive', { title });
  return tally ? t('chat:group.event.wentLiveUntitledTally', { tally }) : t('chat:group.event.wentLiveUntitled');
}

/** "alice", "alice and bob", "alice, bob and carol". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names.join('');
  const before = names.slice(0, -1).reduce((listed, name) => t('chat:group.names.next', { names: listed, name }));
  return t('chat:group.names.last', { names: before, name: names[names.length - 1] });
}

/** "Built by evan, backed by alice and bob, shaped by carol." — the server's own shape (routes/votes.js creditsSentence). */
export function creditsSentence(c: { author: string; backers: string[]; shapers: string[] }): string {
  const author = c.author;
  const backers = c.backers.length ? nameList(c.backers) : '';
  const shapers = c.shapers.length ? nameList(c.shapers) : '';
  if (author) {
    if (backers && shapers) return t('chat:group.credits.builtBackedShaped', { author, backers, shapers });
    if (backers) return t('chat:group.credits.builtBacked', { author, backers });
    if (shapers) return t('chat:group.credits.builtShaped', { author, shapers });
    return t('chat:group.credits.built', { author });
  }
  if (backers && shapers) return t('chat:group.credits.backedShaped', { backers, shapers });
  if (backers) return t('chat:group.credits.backed', { backers });
  if (shapers) return t('chat:group.credits.shaped', { shapers });
  return '';
}

/**
 * The muted tail after a named merge: "3/5 votes" (B10d: no pull request
 * number). After a vote
 * that no longer counts because the proposal changed since (#3411):
 * "· on an earlier version, not counted", so the line agrees with the tally.
 */
export function eventTail(msg: TranscriptMessage): string {
  const ev = msg.event;
  if (ev && ev.type === 'vote' && ev.earlier) return t('chat:group.event.tail.earlier');
  if (!ev || ev.type !== 'merged' || ev.force || !ev.credits) return '';
  return ev.votes ? t('chat:group.event.tail.tally', { tally: ev.votes }) : '';
}

/**
 * The Friday card (#1688): what went live this week and who made it, then
 * what is waiting on votes, then the door to the Workshop. A message from
 * the app itself, in the event box's surface, with the lines the card
 * carries — never the whole week when it is long; the totals say the rest.
 */
function WeeklyBox({ w }: { w: NonNullable<ProposalEvent['weekly']> }) {
  const t = useMessages('chat');
  const moreMerged = w.mergedTotal - w.merged.length;
  const moreOpen = w.openTotal - w.open.length;
  return (
    <div className="gc-event-box gc-event-weekly">
      <div className="gc-weekly-title">{t('chat:group.weekly.title', { app: w.app })}</div>
      <div className="gc-weekly-section">
        <div className="gc-weekly-head gc-weekly-head-live">
          {w.mergedTotal === 0
            ? t('chat:group.weekly.nothingLanded')
            : t('chat:group.weekly.wentLive', { count: w.mergedTotal })}
        </div>
        {w.merged.map((m, i) => (
          <div key={m.id ?? `m${i}`} className="gc-weekly-line" data-weekly="merged">
            <span className="gc-weekly-line-title">{m.title}</span>
            {m.author ? (
              <span className="gc-weekly-line-who">
                {` · ${m.backers.length ? t('chat:group.weekly.authorBacked', { author: m.author, backers: nameList(m.backers) }) : m.author}`}
              </span>
            ) : null}
          </div>
        ))}
        {moreMerged > 0 ? <div className="gc-weekly-more">{t('chat:group.weekly.moreLive', { count: moreMerged })}</div> : null}
      </div>
      {w.openTotal > 0 ? (
        <div className="gc-weekly-section">
          <div className="gc-weekly-head gc-weekly-head-open">
            {t('chat:group.weekly.waiting', { count: w.openTotal })}
          </div>
          {w.open.map((o, i) => (
            <div key={o.id ?? `o${i}`} className="gc-weekly-line" data-weekly="open">
              <span className="gc-weekly-line-title">{o.title}</span>
            </div>
          ))}
          {moreOpen > 0 ? <div className="gc-weekly-more">{t('chat:group.weekly.moreWaiting', { count: moreOpen })}</div> : null}
        </div>
      ) : null}
      {w.slug ? (
        <a className="gc-weekly-door" href={`#app/${w.slug}/dev`}>{t('chat:group.weekly.door')}</a>
      ) : null}
    </div>
  );
}

export const EventRow = memo(function EventRow({ msg }: { msg: TranscriptMessage }) {
  // Subscribed: eventText and eventTail are read in the language on screen.
  const t = useMessages('chat');
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
      {...(ev.type === 'vote' && ev.earlier ? { 'data-earlier': '1' } : {})}
      avatar={(
        <Avatar shape="square" size="md" color={swatchFor(ev.sender)} aria-hidden="true">
          {ev.sender.charAt(0).toUpperCase()}
        </Avatar>
      )}
      name={<span data-event-sender="">{ev.sender}</span>}
      timestamp={<span className="gc-msg-time" title={msg.timeTitle}>{msg.time}</span>}
    >
      {href
        ? <a className="gc-event-box" href={href} title={t('chat:group.event.open')}>{box}</a>
        : <div className="gc-event-box">{box}</div>}
    </ChatMessageRow>
  );
});
