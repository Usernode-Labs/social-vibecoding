/**
 * #4417: AFTER A MERGE, A CARD MARKS IT.
 *
 * When a topic is merged into another (a voted change to dapp.json's
 * `topics`), its requests move to the survivor and its own channel turns
 * read-only. The survivor's channel says so where it happened: one card in
 * its history, at the moment the merge applied, the way a date divider sits
 * between the rows around it —
 *
 *   #signup was merged into this topic                     Read #signup ›
 *
 * — and "Read #signup ›" opens the merged channel, read-only, with its whole
 * history.
 *
 * DRAWN FROM THE MERGE ITSELF. Homeroom writes no activity into a channel
 * (AGENTS.md: "a channel is what people said"), so nothing is posted for a
 * merge: the card is the registry's `merged_at` (the community record's
 * `places`), handed to the history as a marker
 * (../../group-chat/transcript-store.ts TranscriptMarker) and placed there
 * by time (../../group-chat/transcript.tsx). Nothing about it is a message:
 * no author, no reactions, no reply.
 */

import type { MouseEvent, ReactNode } from 'react';

import { channelPlace, placeHref } from './places';
import { openPlace } from './place-store';

/** The current project, which the card's link opens a channel of. */
function currentSlug(): string | null {
  const app = (window as unknown as { App?: { currentApp?: string | null } }).App;
  return app?.currentApp || null;
}

export function MergedTopicCard({ from, at, slug = null }: {
  from: { handle: string; name: string; icon: string };
  at: string;
  slug?: string | null;
}): ReactNode {
  const project = slug || (typeof window !== 'undefined' ? currentSlug() : null);
  const place = channelPlace(from.handle);
  const href = project ? placeHref(project, place) : '#';
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(event)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (!project) return;
    event.preventDefault();
    openPlace(project, place);
  };
  return (
    <div className="dev-ws-merged-card" data-merged-topic={from.handle} data-merged-at={at} role="note">
      <span className="dev-ws-merged-card-text">{`#${from.handle} was merged into this topic`}</span>
      <a className="dev-ws-merged-card-link" href={href} onClick={open} data-merged-topic-link={from.handle}>
        {`Read #${from.handle} ›`}
      </a>
    </div>
  );
}
