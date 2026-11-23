/**
 * A COMMUNITY'S CARD ("New, lighter", approved 20 Nov 2026), wherever a
 * community is drawn as a card: the Communities page's Pinned (here), and
 * Featured and Communities to join on Home, the Communities page and the
 * visitor's landing (../guest/guest-discover.tsx `Card`).
 *
 *   picture   first, edge to edge, 16:9, cover, not shaded: the picture its
 *             group chose (its dark twin in the dark theme), else one of
 *             the brand kit's six backgrounds, always the same one for the
 *             same community (`cardScene`). A picture that does not load
 *             falls back to that background.
 *   icon      the community's own icon (its image, else its emoji or initial
 *             on a white tile), standing mostly below the picture with its
 *             top over the picture's lower edge, on a thin light outline.
 *   beside it the name over how many members, in words.
 *   then      what it says it is, two lines at most, and this week on one
 *             line: "33 active · 5 changes live this week", "6 active this
 *             week", or nothing when both are zero. It follows the words;
 *             it is not held to the card's foot. Under 640px it is two
 *             glyphs with their numbers, so it is always one line, and a
 *             screen reader hears the words.
 *
 * THE COMPACT CARD is the same card with its picture taken off: the icon
 * smaller beside the name, and under the name its week in two plain lines
 * (the Communities page's Joined; approved 23 Nov 2026, "F, without the
 * little people icons"): "34 members, 6 active this week" in grey, then
 * "6 changes live this week" after a tick in the link's blue. A quiet
 * community is "16 members" alone, and the second line is drawn only when
 * something went live. No faces, no description. A narrow card wraps the
 * first line between its two facts, never inside one.
 *
 * Everything here is markup with fixed class names; the sizes, inks, edges
 * and corners are app.css's (`.cm-card`, "A COMMUNITY'S CARD"), read from
 * `--cm-*` tokens each look sets, so a look draws the same card in its own
 * colours. The root (a link, or an article with a stretched link) is the
 * caller's, so each place keeps its own ids, `data-*` and behaviour.
 */
import { type ReactNode, useEffect, useState } from 'react';

import { CheckIcon, PlusIcon, UserGroupIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useMinWidth } from '../../lib/use-min-width';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  CORNER, CORNER_PIN, CORNER_UNPIN, MinusGlyph, VOTES, WIGGLE, communityScene, openHub,
} from '../home/pinned-communities';

/** What a card draws of a community. A number left out says nothing. */
export interface CardCommunity {
  slug: string;
  name: string;
  iconUrl?: string | null;
  iconEmoji?: string | null;
  /** The picture its group chose for its card, and that picture's dark twin. */
  pictureUrl?: string | null;
  pictureDarkUrl?: string | null;
  members?: number | null;
  /** What it says it is (dapp.json's description). */
  description?: string | null;
  /** People who took part in the last seven days, and changes that went live in them. */
  activeWeek?: number | null;
  liveWeek?: number | null;
}

/** How many of the brand kit's backgrounds a card without a picture takes from (app.css `.cm-card-pic[data-cm-scene]`). */
const SCENES = 6;

/**
 * The background a community's card wears when it has no picture of its
 * own, 1 to 6 (sky, halftone, dream, stars, collage, stripes): the one the
 * pinned card's band has worn since 19 Nov 2026, three on from
 * `communityScene`, so a community keeps its background.
 */
export function cardScene(slug: string): number {
  return ((communityScene(slug) + 2) % SCENES) + 1;
}

const count = (n: number | null | undefined) => Math.max(0, Math.floor(Number(n) || 0));

/** What goes over a picture: drawn as it is, or asked whether the picture itself is shown (a preview loop plays only over one). */
export type PictureOverlay = ReactNode | ((picture: boolean) => ReactNode);

/**
 * The card's picture, or its background. `attrs` and `children` are the
 * caller's: the hooks a card-to-page morph finds, a "New" pill, a preview
 * loop that plays over the picture.
 */
export function CommunityPicture({ community, eager = false, attrs, children }: {
  community: CardCommunity;
  eager?: boolean;
  attrs?: Record<string, string | undefined>;
  children?: PictureOverlay;
}) {
  const { pictureUrl: url, pictureDarkUrl: dark } = community;
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url, dark]);
  const picture = !!url && !failed;
  return (
    <span className="cm-card-pic" data-cm-scene={picture ? undefined : String(cardScene(community.slug))} {...attrs}>
      {picture ? (
        <>
          <img
            src={url!}
            alt=""
            loading={eager ? 'eager' : 'lazy'}
            draggable={false}
            onError={() => setFailed(true)}
            className={dark ? 'cm-card-img dark:hidden' : 'cm-card-img'}
          />
          {dark ? (
            <img src={dark} alt="" loading={eager ? 'eager' : 'lazy'} draggable={false} onError={() => setFailed(true)} className="cm-card-img hidden dark:block" />
          ) : null}
        </>
      ) : null}
      {typeof children === 'function' ? children(picture) : children}
    </span>
  );
}

/** The community's own icon: its image, else its emoji or its initial on a white tile. */
export function CommunityIcon({ community, eager = false }: { community: CardCommunity; eager?: boolean }) {
  const app = { slug: community.slug, name: community.name, icon_url: community.iconUrl || null, icon_emoji: community.iconEmoji || null };
  return (
    <span className="cm-card-icon" data-icon={appIconKind(app)} aria-hidden="true">
      <AppIconContent app={app} eager={eager} />
    </span>
  );
}

/**
 * This week, on one line. In words from 640px: "33 active", a dot, "5
 * changes live this week" in the link's blue; "6 active this week" alone
 * when nothing went live; nothing at all for a quiet week. A line too long
 * for its card wraps between the two, and the dot is drawn before each part
 * where a wrapped line's first one is cut off (app.css), so no line starts
 * with it. Under 640px the same two numbers each after its glyph (people,
 * a tick), so the line is always one line; the words are then the screen
 * reader's alone.
 */
export function CommunityWeek({ active, live }: { active?: number | null; live?: number | null }) {
  const t = useMessages('home');
  const a = count(active);
  const l = count(live);
  if (!a && !l) return null;
  const people = a ? t('home:communities.activeWeek', { count: a, formatted: a.toLocaleString() }) : null;
  const changes = l ? t('home:communities.liveThisWeek', { count: l, formatted: l.toLocaleString() }) : null;
  return (
    <span className="cm-card-week" data-cm-week="">
      <span className="cm-week-words">
        <span className="cm-week-in">
          {a ? <span>{l ? t('home:communities.activeShort', { count: a, formatted: a.toLocaleString() }) : people}</span> : null}
          {l ? <span className="cm-week-live">{changes}</span> : null}
        </span>
      </span>
      <span className="cm-week-glyphs" aria-hidden="true">
        {a ? <span><UserGroupIcon className="cm-week-glyph" />{a.toLocaleString()}</span> : null}
        {l ? <span className="cm-week-live"><CheckIcon className="cm-week-glyph" />{l.toLocaleString()}</span> : null}
      </span>
      <span className="cm-week-sr sr-only">
        {people ? <span>{people}</span> : null}
        {changes ? <span>{changes}</span> : null}
      </span>
    </span>
  );
}

/**
 * The name over how many members, beside the icon. `name` replaces the plain
 * name (a card whose name is its link). `week` is the compact card's: the
 * members line says who was active this week too, and a second line what
 * went live (see the header). A zero says nothing.
 */
function CardId({ community, name, week = false }: { community: CardCommunity; name?: ReactNode; week?: boolean }) {
  const t = useMessages('home');
  const members = count(community.members);
  const active = week ? count(community.activeWeek) : 0;
  const live = week ? count(community.liveWeek) : 0;
  const membersText = t('home:communities.members', { count: members, formatted: members.toLocaleString() });
  return (
    <span className="cm-card-id">
      {name ?? <span className="cm-card-name">{community.name}</span>}
      {members ? (
        <span className="cm-card-members" data-cm-members="">
          {active ? (
            <RichMessage
              id="home:communities.compactMembersActive"
              values={{ count: active, formatted: active.toLocaleString(), members: membersText }}
              components={[<span className="cm-card-fact" />, <span className="cm-card-fact" />]}
            />
          ) : membersText}
        </span>
      ) : null}
      {live ? (
        <span className="cm-card-live" data-cm-live="">
          <CheckIcon className="cm-card-live-tick" aria-hidden="true" />
          <span className="cm-card-fact">{t('home:communities.compactLive', { count: live, formatted: live.toLocaleString() })}</span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * The big card's insides, inside the caller's root (`.cm-card`). `face` is
 * drawn on the icon (a count, the edit discs) and `faceClass` moves it (the
 * edit wiggle); `picture` goes over the picture.
 */
export function CommunityCardContent({ community, eager = false, name, face, faceClass, picture, pictureAttrs, aboutAttrs }: {
  community: CardCommunity;
  eager?: boolean;
  name?: ReactNode;
  face?: ReactNode;
  faceClass?: string;
  picture?: PictureOverlay;
  pictureAttrs?: Record<string, string | undefined>;
  /** Hooks on the sentence (a card on Discover keeps its `data-guest-card-about`). */
  aboutAttrs?: Record<string, string | undefined>;
}) {
  const about = (community.description || '').trim();
  return (
    <>
      <CommunityPicture community={community} eager={eager} attrs={pictureAttrs}>{picture}</CommunityPicture>
      <span className="cm-card-body">
        <span className="cm-card-head">
          <span className={faceClass ? `cm-card-face ${faceClass}` : 'cm-card-face'}>
            <CommunityIcon community={community} eager={eager} />
            {face}
          </span>
          <CardId community={community} name={name} />
        </span>
        {about ? <span className="cm-card-desc" data-cm-desc="" {...aboutAttrs}>{about}</span> : null}
        <CommunityWeek active={community.activeWeek} live={community.liveWeek} />
      </span>
    </>
  );
}

/** The compact card's insides: the icon beside the name and its week (the members, who was active, what went live), no picture. */
export function CommunityCardCompactContent({ community, face, faceClass }: {
  community: CardCommunity;
  face?: ReactNode;
  faceClass?: string;
}) {
  return (
    <span className="cm-card-head">
      <span className={faceClass ? `cm-card-face ${faceClass}` : 'cm-card-face'}>
        <CommunityIcon community={community} />
        {face}
      </span>
      <CardId community={community} week />
    </span>
  );
}

/**
 * A community on the Communities page as a card (../communities/index.tsx):
 * the big card for one you pinned, the compact one for one you joined. It
 * is the tile it replaces in all it does: one link to the community's hub
 * (the door rule), its `data-home-community` hooks, the votes waiting on
 * the icon's corner with their words for a screen reader, and, while the
 * page is edited, the − that unpins it (the icon wiggles) or the + that
 * pins it.
 */
export function CommunityPageCard({ community, votes, editing, compact = false, onUnpin, onPin }: {
  community: CardCommunity;
  votes: number;
  editing: boolean;
  compact?: boolean;
  onUnpin?: () => void;
  onPin?: () => void;
}) {
  const t = useMessages('home');
  const tc = useMessages('communities');
  const { slug, name } = community;
  const face = (
    <>
      {votes > 0 && !editing ? <span className={VOTES} data-home-community-votes={String(votes)} aria-hidden="true">{votes > 99 ? '99+' : votes}</span> : null}
      {editing && onUnpin ? (
        <button
          type="button"
          className={`${CORNER} -start-1.5 ${CORNER_UNPIN}`}
          aria-label={t('home:communities.unpinNamed', { community: name })}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onUnpin(); }}
        >
          <MinusGlyph />
        </button>
      ) : null}
      {onPin ? (
        <button
          type="button"
          className={`${CORNER} -end-1.5 ${CORNER_PIN}`}
          aria-label={t('home:communities.pinNamed', { community: name })}
          onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPin(); }}
        >
          <PlusIcon className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
  const faceClass = editing ? WIGGLE : undefined;
  return (
    <a
      href={`/app/${encodeURIComponent(slug)}/workshop`}
      className="cm-card"
      data-cm-size={compact ? 'compact' : undefined}
      data-home-community={slug}
      data-home-community-pinned=""
      onClick={(event) => { if (editing) { event.preventDefault(); return; } openHub(event, slug); }}
    >
      {compact
        ? <CommunityCardCompactContent community={community} face={face} faceClass={faceClass} />
        : <CommunityCardContent community={community} face={face} faceClass={faceClass} />}
      {votes > 0 ? <span className="sr-only">{tc('communities:row.toVote', { count: votes })}</span> : null}
    </a>
  );
}

/**
 * A card held in place while what it shows is read: the card's own ground,
 * its picture's shape and about as tall as its words, so the page does not
 * move when the cards land. `lead` holds the larger card's place.
 */
export function CommunityCardSkeleton({ lead = false }: { lead?: boolean }) {
  return (
    <span className="cm-card cm-card-skel" data-cm-size={lead ? 'lead' : undefined} aria-hidden="true">
      <span className="cm-card-pic" />
      <span className="cm-card-skel-body" />
    </span>
  );
}

/** The most featured communities the larger first row holds. */
export const LEAD_MAX = 3;

/**
 * HOW MANY FEATURED COMMUNITIES ARE DRAWN LARGER, in a first row of their
 * own (asked 20 Nov 2026: "first row of featured larger everywhere"): one
 * fewer than a row of the cards under it holds, so each is wider than they
 * are, three at most and two at least; on a phone (under 640px), one, the
 * whole width. How many a row holds is read off the grid itself: `probe` is
 * an empty grid of the same kind (`data-cm-grid="join"`), whose columns the
 * CSS decides (the caller hands it over from a ref callback, so a probe
 * drawn anew is measured anew), read again whenever its width changes.
 * Before it is measured (and in a prerender) the answer is the most.
 */
export function useLeadCount(probe: HTMLElement | null): number {
  const wide = useMinWidth(640);
  const [cols, setCols] = useState(LEAD_MAX + 1);
  useIsomorphicLayoutEffect(() => {
    const el = probe;
    if (!el || typeof window === 'undefined') return undefined;
    const measure = () => {
      const tracks = getComputedStyle(el).gridTemplateColumns.split(' ').filter((track) => /^[\d.]+px$/.test(track)).length;
      if (tracks) setCols(tracks);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [probe]);
  return wide ? Math.max(2, Math.min(LEAD_MAX, cols - 1)) : 1;
}

/** A row of the public directory (GET /api/public/apps) as the card draws it. */
export function communityFromDirectory(app: {
  slug: string; name: string; icon_url?: string | null; icon_emoji?: string | null;
  illustration_url?: string | null; illustration_dark_url?: string | null; member_count?: number;
  description?: string | null; active_users?: number; merged_week?: number;
}): CardCommunity {
  return {
    slug: app.slug,
    name: app.name,
    iconUrl: app.icon_url,
    iconEmoji: app.icon_emoji,
    pictureUrl: app.illustration_url,
    pictureDarkUrl: app.illustration_dark_url,
    members: app.member_count,
    description: app.description,
    activeWeek: app.active_users,
    liveWeek: app.merged_week,
  };
}
