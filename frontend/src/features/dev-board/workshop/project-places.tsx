/**
 * #4417: A PROJECT'S PLACES, AS ONE LIST.
 *
 * It replaced the four tabs (Hub · Discussion · Needs you · Workshop, the
 * retired project-band.tsx). The pages first, a line, then the project's
 * channels under their headings:
 *
 *   Hub
 *   Needs you              29
 *   Workshop
 *   ─────────────
 *   CHANNELS
 *   # general
 *   TOPICS
 *   # onboarding            3
 *   # homeroom-bot
 *
 * A project with no topics has no Topics heading: Hub, Needs you, Workshop
 * and #general. Retired topics are not listed; their channels stay readable
 * by their links (a merge's card, a `#name` in a message).
 *
 * A `<nav>` of links, because each entry is somewhere to go: an anchor with
 * the place's own address (./places.ts placeHref), so a new tab opens it
 * too, and a plain press moves the page in place (`onPlace`). The open place
 * carries `aria-current="page"` and the left rail's lit-row treatment
 * (`--lit-tint`, `--lit-ink`). Channels and Topics are each a `role="group"`
 * labelled by its heading. A count says what it counts to a screen reader
 * (an `sr-only` phrase, "29 to vote", "3 unread"), and a zero says nothing.
 *
 * Drawn in two places, never both at once: the section column beside the
 * strip on a wide window (../../nav/section-column.tsx), and the tray behind
 * the place bar on a phone (./places-tray.tsx), which adds "Switch
 * community" at its foot.
 */

import { useId, type MouseEvent, type ReactNode } from 'react';

import { BallotIcon, BoardIcon, HashIcon, Squares2X2Icon, UserGroupIcon } from '@/components/ui/icons';

import type { PlacesPayload } from './community-card';
import { channelPlace, litPlace, liveTopics, PAGE_PLACES, placeHref, type PlaceKey } from './places';

/** "99+" past 99, as every count on the page caps. */
export function countText(n: number): string {
  return n > 99 ? '99+' : String(n);
}

/** What a place's count says aloud, or null for none (a zero says nothing). */
export function countPhrase(key: PlaceKey, n: number): string | null {
  if (!(n > 0)) return null;
  if (key === 'needs') return `${n} to vote`;
  return `${n} unread`;
}

/** The entries the list draws, in order: what the tests read. Pure. */
export function placeRows(places: PlacesPayload | null | undefined, owed: number): {
  pages: Array<{ key: PlaceKey; label: string; count: number }>;
  general: { key: PlaceKey; label: string; count: number };
  topics: Array<{ key: PlaceKey; label: string; count: number; name: string; icon: string }>;
} {
  const channels = places && Array.isArray(places.channels) ? places.channels : [];
  const general = channels.find((c) => c.kind === 'general');
  return {
    pages: PAGE_PLACES.map((p) => ({ key: p.key, label: p.label, count: p.key === 'needs' ? Math.max(0, Number(owed) || 0) : 0 })),
    general: { key: 'discussion', label: 'general', count: Math.max(0, Number(general?.unread) || 0) },
    topics: liveTopics(places).map((t) => ({
      key: channelPlace(t.handle),
      label: t.handle,
      count: Math.max(0, Number(t.unread) || 0),
      name: t.name,
      icon: t.icon,
    })),
  };
}

function PageGlyph({ k }: { k: PlaceKey }) {
  const cls = 'dev-ws-place-glyph';
  if (k === 'status') return <Squares2X2Icon className={cls} aria-hidden="true" />;
  if (k === 'needs') return <BallotIcon className={cls} aria-hidden="true" />;
  if (k === 'workshop') return <BoardIcon className={cls} aria-hidden="true" />;
  return <HashIcon className={`${cls} dev-ws-place-hash`} aria-hidden="true" />;
}

function PlaceLink({ slug, k, label, count, lit, title, extra, onPlace }: {
  slug: string;
  k: PlaceKey;
  label: string;
  count: number;
  lit: boolean;
  title?: string;
  extra?: ReactNode;
  onPlace: (key: PlaceKey) => void;
}) {
  const phrase = countPhrase(k, count);
  const press = (event: MouseEvent<HTMLAnchorElement>) => {
    const nav = (window as unknown as { NavLink?: { isNativeClick?: (e: unknown) => boolean } }).NavLink;
    if (nav?.isNativeClick?.(event)) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onPlace(k);
  };
  return (
    <a
      className="dev-ws-place"
      href={placeHref(slug, k)}
      data-place={k}
      aria-current={lit ? 'page' : undefined}
      title={title}
      onClick={press}
    >
      <PageGlyph k={k} />
      <span className="dev-ws-place-label">{label}</span>
      {phrase ? (
        <>
          <span className="dev-ws-place-count" data-place-count="" aria-hidden="true">{countText(count)}</span>
          <span className="sr-only">{` (${phrase})`}</span>
        </>
      ) : null}
      {extra}
    </a>
  );
}

export function ProjectPlaces({ slug, name, place, owed, places, filtered = false, onPlace, onSwitch }: {
  slug: string;
  /** The project's name, which names the list for a screen reader. */
  name: string;
  /** The place on show; a page under one (All items, the plan) lights it. */
  place: PlaceKey;
  /** Votes waiting on the viewer here (the page's own count). */
  owed: number;
  places: PlacesPayload | null | undefined;
  /** All items' search or filters are on: a dot on the Workshop (#2915). */
  filtered?: boolean;
  onPlace: (key: PlaceKey) => void;
  /** The tray's foot: "Switch community". */
  onSwitch?: (el: HTMLElement | null) => void;
}): ReactNode {
  const id = useId();
  const lit = litPlace(place);
  const rows = placeRows(places, owed);
  const channelsId = `${id}-channels`;
  const topicsId = `${id}-topics`;
  return (
    <div className="dev-ws-places" data-places={slug}>
      <nav className="dev-ws-places-nav" aria-label={name ? `${name}'s places` : 'Places'}>
        {rows.pages.map((p) => (
          <PlaceLink
            key={p.key}
            slug={slug}
            k={p.key}
            label={p.label}
            count={p.count}
            lit={lit === p.key}
            onPlace={onPlace}
            extra={p.key === 'workshop' && filtered ? (
              <>
                <span className="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true" />
                <span className="sr-only"> (filtered)</span>
              </>
            ) : null}
          />
        ))}
        <div className="dev-ws-places-line" role="separator" />
        <div className="dev-ws-places-group" role="group" aria-labelledby={channelsId} data-places-group="channels">
          <div id={channelsId} className="dev-ws-places-head">Channels</div>
          <PlaceLink
            slug={slug}
            k={rows.general.key}
            label={rows.general.label}
            count={rows.general.count}
            lit={lit === 'discussion'}
            onPlace={onPlace}
          />
        </div>
        {rows.topics.length ? (
          <div className="dev-ws-places-group" role="group" aria-labelledby={topicsId} data-places-group="topics">
            <div id={topicsId} className="dev-ws-places-head">Topics</div>
            {rows.topics.map((t) => (
              <PlaceLink
                key={t.key}
                slug={slug}
                k={t.key}
                label={t.label}
                title={t.name}
                count={t.count}
                lit={lit === t.key}
                onPlace={onPlace}
              />
            ))}
          </div>
        ) : null}
      </nav>
      {onSwitch ? (
        <div className="dev-ws-places-foot">
          <button
            type="button"
            className="dev-ws-place"
            data-places-switch=""
            onClick={(e) => onSwitch(e.currentTarget)}
          >
            <UserGroupIcon className="dev-ws-place-glyph" aria-hidden="true" />
            <span className="dev-ws-place-label">Switch community</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
