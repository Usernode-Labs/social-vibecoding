import { useEffect } from 'react';

import { buttonVariants } from '@/components/ui/button';

import { useMessages } from '../../lib/i18n/react';
import { ActivityLink } from './bot-activity';
import { ENDED_STAGES, TrackBadge, TrackBar, trackDetail, trackEyebrow, trackPlace, useTrackOf } from './bot-track';
import { watchTrack } from './bot-work';
import { ObjectCard } from './format';
import type { BotLiveWork, BotTrack, ConversationMessage, SharedObjectCard } from './types';

/*
 * 18 Nov 2026: the live card under a reply that started work.
 *
 * When a turn of Homeroom bot's queues or starts a build, a fix or a new
 * plan ("I've queued a fix"), its reply names that request
 * (`metadata.homeroomBot.liveWork`, services/homeroom-bot-mayor.js
 * noteLiveWork) and this card stands under it: the request's own track
 * (./bot-track.tsx), in the words every screen uses (lib/work-state.ts),
 * moving in place as the server pushes `work_state` (./bot-work.tsx reads
 * again; no timer here): queued, building, checks, up for a vote with Vote,
 * live, or stopped and why. So the reply never has to ask "Want me to tell
 * you here when it's ready?".
 *
 * It takes the place of the request's plain card the reply carries. Until
 * the track is read, or when there is none to read, that plain card is
 * drawn as it was. A settled card (live, closed, stopped) has no fill, only
 * its hairline: the settled thing is never the loudest on screen.
 *
 * A request that is not the viewer's own is followed too: the card asks the
 * store to read it with theirs while it is on screen (watchTrack).
 */

/** The request a bot message's live card follows, or null. */
export function liveWorkOf(message: ConversationMessage): BotLiveWork | null {
  if (!message.sender.bot || message.deleted) return null;
  return message.metadata?.homeroomBot?.liveWork || null;
}

/** Pure: whether a card the message carries is the live card's own request, which the live card draws instead. */
export function isLiveCardObject(work: BotLiveWork | null, object: SharedObjectCard): boolean {
  return !!work && object.type === 'issue' && object.appSlug === work.appSlug && Number(object.issueNumber) === work.issueNumber;
}

// The one act a live card offers, once its change is up for a vote.
const VOTE_CLASS = buttonVariants({ layout: 'iconRow', variant: 'pillAccent', size: 'sm' });

/** The card, drawn from a track: its state, its title, where it is, its five steps, and Vote when it is time. */
export function LiveTrackCard({ track, title }: { track: BotTrack; title: string }) {
  const t = useMessages('messages');
  const ended = ENDED_STAGES.has(track.work.stage);
  const vote = track.work.stage === 'up_for_vote' && track.links?.proposal ? track.links.proposal : null;
  const facts = [trackDetail(track), trackPlace(track)].filter(Boolean).join(' · ');
  const request = track.links?.request && track.issueNumber ? track.links.request : null;
  return (
    <div
      className={`mt-1 flex max-w-[480px] flex-col gap-2.5 rounded-2xl px-3 py-2.5 ${ended
        ? 'shadow-[inset_0_0_0_1px_var(--app-sheet-line)]'
        : 'bg-[color:var(--messages-surface)]'}`}
      role="group"
      aria-label={t('messages:bot.live.label', { title })}
      data-bot-live={track.work.stage}
      data-bot-live-request={track.appSlug && track.issueNumber ? `${track.appSlug}#${track.issueNumber}` : undefined}
    >
      <div className="flex items-start gap-3">
        <TrackBadge track={track} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-bold uppercase tracking-[0.06em] text-zinc-500 dark:text-zinc-400" data-bot-live-state="">{trackEyebrow(track)}</div>
          <div className="line-clamp-2 text-[0.9375rem] font-[650] text-zinc-900 dark:text-zinc-100">{title}</div>
          {facts ? <p className="m-0 text-[0.8125rem] leading-[1.125rem] text-zinc-500 dark:text-zinc-400" role="status" data-bot-live-facts="">{facts}</p> : null}
        </div>
      </div>
      {ended ? null : <TrackBar track={track} />}
      {vote || request ? (
        <div className="flex flex-wrap gap-2">
          {vote ? <a className={VOTE_CLASS} href={vote} data-bot-live-vote="">{t('messages:bot.live.vote')}</a> : null}
          {request ? <ActivityLink href={request}>{t('messages:bot.track.link.request', { number: String(track.issueNumber) })}</ActivityLink> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Under a reply that started work: the request's live card, else (no track
 * read yet, or none) the request's plain card the reply carries.
 */
export function BotLiveCard({ work, objects }: { work: BotLiveWork; objects: readonly SharedObjectCard[] }) {
  useMessages('messages');
  useEffect(() => watchTrack(work.appSlug, work.issueNumber), [work.appSlug, work.issueNumber]);
  const track = useTrackOf({ appSlug: work.appSlug, appName: work.appName, issueNumber: work.issueNumber, firstVersion: false });
  const carried = objects.find((object) => isLiveCardObject(work, object)) || null;
  if (!track) return carried ? <div className="messages-object-list"><ObjectCard object={carried} /></div> : null;
  const title = work.title || track.title || carried?.title || track.appName || work.appName || work.appSlug;
  return <LiveTrackCard track={track} title={title} />;
}
