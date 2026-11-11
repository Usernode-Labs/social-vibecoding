/**
 * Where Homeroom bot's work on a request stands, as the kit's Status card
 * in the context column of the request's page (the tour's s32, holding what
 * the standard page's progress card says: version 2).
 *
 * Everything it says is read from the same track, through the same helpers,
 * as the product's card (../../../messages/bot-track.tsx TrackCard): its
 * state word and try as the pill, the five steps with the one it is on
 * lit, where it is and why with its place in line and this try's clock,
 * its pictures and its links. Only the drawing is the kit's.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { useMessages } from '../../../../lib/i18n/react';
import type { BotTrack } from '../../../messages/types';
import { TrackPictures, stepLooks, trackClock, trackDetail, trackEyebrow, trackLook, trackPlace } from '../../../messages/bot-track';
import { k, type PillKind } from '@/components/ui/kit';
import { dotLine } from './topic-page';
import { TopicFrameStatus } from './topic-frame';

type Stop = 'done' | 'now' | 'wait' | 'live' | '';

/** Pure: the pill's colour for a track: amber while it waits (on you, or on hold), blue up for a vote, green live, red in trouble. */
export function trackPillKind(track: Pick<BotTrack, 'work' | 'busy'>): PillKind {
  const tone = trackLook(track).tone;
  if (tone === 'need' || tone === 'held') return 'wait';
  if (tone === 'ready') return 'act';
  if (tone === 'good') return 'ok';
  if (tone === 'trouble') return 'bad';
  return '';
}

/** Pure: the five stops as the kit's line draws them: the step it is on is amber while the work waits. */
export function trackStops(track: Pick<BotTrack, 'work' | 'step' | 'doneBy' | 'busy'>): Stop[] {
  const waits = trackPillKind(track) === 'wait';
  return stepLooks(track).map((look) => (look === 'next' ? '' : look === 'now' && waits ? 'wait' : look));
}

export function TopicTrackStatus({ track, label, links = [], now }: {
  track: BotTrack;
  label: string;
  /** Its links, as the product's card has them (trackLinks). */
  links?: ReactNode[];
  /** For a test: the moment its clock counts to. */
  now?: Date;
}) {
  const tc = useMessages('changes');
  // This try's clock moves every half minute while the bot is at it.
  const ticking = !now && trackClock(track, new Date()) != null;
  const [at, setAt] = useState(() => now || new Date());
  useEffect(() => {
    if (!ticking) return undefined;
    setAt(new Date());
    const timer = window.setInterval(() => setAt(new Date()), 30 * 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);
  return (
    <TopicFrameStatus
      label={label}
      pill={{ word: trackEyebrow(track), kind: trackPillKind(track) }}
      stops={trackStops(track)}
      words={[tc('changes:track.plan'), tc('changes:track.build'), tc('changes:track.checks'), tc('changes:track.vote'), tc('changes:track.live')]}
      say={dotLine([trackDetail(track), trackPlace(track), trackClock(track, now || at)]) || null}
    >
      <TrackPictures track={track} />
      {links.length ? <div className={k('btnrow')}>{links}</div> : null}
    </TopicFrameStatus>
  );
}
