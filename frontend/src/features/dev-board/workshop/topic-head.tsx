/**
 * #4417: A TOPIC'S LINE, above its channel.
 *
 * One line of 13px muted text: what the topic is for (dapp.json's `about`),
 * then how many requests are filed under it, as a link that opens All items
 * narrowed to the topic. The channel's name is the bar's (a phone) or the
 * page title's (desktop), so the line does not say it again.
 *
 *   How it plans, builds and answers · 14 requests ›
 *
 * A retired topic says what became of it instead, and has no count: its
 * requests are the survivor's (a merge) or are being sorted again (an
 * archive).
 */

import type { MouseEvent, ReactNode } from 'react';

import type { PlaceChannel } from './community-card';
import { channelPlace, placeHref } from './places';

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The words of the line, for a topic as its record has it. Pure. */
export function topicLine(topic: Pick<PlaceChannel, 'about' | 'state' | 'requests'>, survivor: string | null = null): {
  about: string;
  link: string | null;
} {
  if (topic.state === 'merged') {
    return { about: survivor ? `Merged into #${survivor}. Read only.` : 'Merged into another topic. Read only.', link: null };
  }
  if (topic.state === 'archived') return { about: 'Archived. Read only.', link: null };
  // No requests yet says nothing: a zero is not a door (AGENTS.md).
  const n = Number(topic.requests);
  return {
    about: String(topic.about || '').trim(),
    link: Number.isFinite(n) && n > 0 ? `${plural(n, 'request', 'requests')} ›` : null,
  };
}

export function TopicHead({ slug, topic, survivor = null, onRequests, onSurvivor }: {
  slug: string;
  topic: PlaceChannel;
  /** A merged topic: the handle of the topic it joined. */
  survivor?: string | null;
  /** Open All items narrowed to this topic. */
  onRequests: () => void;
  /** A merged topic: open the topic it joined. */
  onSurvivor?: () => void;
}): ReactNode {
  const line = topicLine(topic, survivor);
  const press = (event: MouseEvent<HTMLAnchorElement>, run?: () => void) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(event)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0 || !run) return;
    event.preventDefault();
    run();
  };
  return (
    <p className="dev-ws-topic-head" data-ws-topic-head={topic.handle}>
      {topic.state === 'merged' && survivor && onSurvivor ? (
        <>
          {'Merged into '}
          <a className="dev-ws-topic-head-link" href={placeHref(slug, channelPlace(survivor))} onClick={(e) => press(e, onSurvivor)}>
            {`#${survivor}`}
          </a>
          {'. Read only.'}
        </>
      ) : line.about}
      {line.about && line.link ? ' · ' : null}
      {line.link ? (
        <a
          className="dev-ws-topic-head-link"
          data-ws-topic-requests={topic.handle}
          href={`/app/${encodeURIComponent(slug)}/board`}
          onClick={(e) => press(e, onRequests)}
        >
          {line.link}
        </a>
      ) : null}
    </p>
  );
}
