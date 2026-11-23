/**
 * A COMMUNITY'S TILE, and Home's one use left of it.
 *
 * The tiles here are what the Communities tab's page draws
 * (../communities/index.tsx, `#communities`): the communities you pinned
 * and the others you are in. They were Home's Pinned communities section
 * (One Home, #6361) until the tab came back (18 Nov 2026); Home no longer
 * lists your communities.
 *
 * The tile is 62px with 18px corners and the blue votes-waiting number, in
 * a ring of the community's colour (lib/community-color.ts) so it never
 * reads as an app. A community's tile opens its hub; an app's tile (Home's
 * Pinned apps) opens the app. Where the page draws a community as a card
 * (the standard look from 768px, the brand look from 1280px), the card is
 * ../communities/card.tsx, which takes this module's votes number, its edit
 * discs and its door (`openHub`). Beside the tiles, the page's own:
 *
 *   New community    the create flow: present for every signed-in account
 *                    but a private member, locked (muted, and its name says
 *                    how to see the quota) without the quota to make one. It
 *                    keeps the `data-panel-slot="create"` hook.
 *
 *   Needs you        while any vote waits on you, the way to Needs you
 *                    (#needs), every decision owed across your projects,
 *                    with the one count of votes waiting (community-scope
 *                    `badgeNeeds`, the number a vote cast or skipped lowers
 *                    at once). A zero says nothing, so the tile is not drawn
 *                    on a quiet day.
 *
 * WHAT HOME KEEPS (`HomeCommunityMatches`, `#home-communities-section`):
 * Home's search still finds your communities. While something is typed in
 * Home's field the section lists the ones that match, pinned or joined,
 * each a tile that opens its hub, so a search for a community you are in is
 * never answered with an offer to make it. With nothing typed it is hidden.
 * It is also where the account's pins are read and kept fresh
 * (./home-pins-store.ts `wireHomePins`), since Home is always mounted.
 *
 * Signed in only. Signed out, the guest Home draws its device's pins with
 * the same tile (features/guest).
 */
import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';

import { PlusIcon, SpeechCheckIcon } from '@/components/ui/icons';

import { useCommunityColor } from '../../lib/community-color';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { SectionHeading } from './panels/ui';
import {
  homePinsStore, importDevicePins, loadHomePins, loadHomePinsForSession,
  wireHomePins, type HomePin,
} from './home-pins-store';
import { rankCommunities, useSettledHomeQuery } from './use-home-query';

export const HEAD_ACTION = 'shrink-0 flex items-center text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target';
const TILE = 'flex min-w-0 flex-col items-center gap-1.5 rounded-2xl py-1 text-center no-underline un-touch-target';
const FACE = 'app-icon-tile w-14 h-14 shrink-0 rounded-[16px] overflow-hidden flex items-center justify-center font-bold text-2xl';
const RING = 'rounded-[21px] p-[3px] shadow-[inset_0_0_0_2px_var(--ring)]';
const NAME = 'max-w-full line-clamp-2 break-words text-[12.5px] font-semibold leading-[15px] text-zinc-800 dark:text-zinc-200';
export const VOTES = 'absolute -top-1.5 -end-2 min-w-[22px] h-[22px] px-1.5 rounded-full bg-violet-600 text-white text-xs font-extrabold tabular-nums flex items-center justify-center shadow-[0_0_0_2px_var(--dc-sheet-solid)]';
// The corner discs the grid's edit mode draws (app-grid.tsx .app-card-remove):
// a dark − to unpin; a white + in the accent ink to pin (Discover's add pill's
// treatment), never a primary button's fill on a 24px badge.
export const CORNER = 'absolute -top-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow-[0_0_0_2px_var(--dc-sheet-solid)]';
export const CORNER_UNPIN = 'bg-zinc-700 text-white dark:bg-zinc-500';
export const CORNER_PIN = 'bg-white text-violet-700 dark:bg-zinc-800 dark:text-violet-400';
/** No MinusIcon in the kit's set: the glyph is the minus itself, as app-grid.tsx draws it. */
export function MinusGlyph() {
  return <span aria-hidden="true" className="text-[15px] leading-none font-semibold">&minus;</span>;
}
const FACE_WRAP = 'relative z-[1] inline-flex';
export const WIGGLE = 'animate-[home-wiggle_260ms_ease-in-out_infinite_alternate] motion-reduce:animate-none';
const ACTION_FACE = 'flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-[18px]';

/** Open a community's hub, as the Communities tab's tile did (the door rule). */
export function openHub(event: React.MouseEvent<HTMLAnchorElement>, slug: string) {
  const win = window as any;
  if (win.NavLink?.isNativeClick?.(event)) return;
  event.preventDefault();
  try { win.AppView?._landOnHub?.(slug); } catch { /* the page opens on what it remembers */ }
  win.App?.navigateToApp?.(slug, 'dev');
}

export function CommunityTileFace({ slug, name, iconUrl, iconEmoji, iconColor }: {
  slug: string; name: string; iconUrl?: string | null; iconEmoji?: string | null; iconColor?: string | null;
}) {
  const ring = useCommunityColor({ color: iconColor || null, iconUrl: iconUrl || null, iconEmoji: iconEmoji || null, key: slug });
  const app = { slug, name, icon_url: iconUrl || null, icon_emoji: iconEmoji || null };
  return (
    <span className={RING} style={{ ['--ring' as string]: ring }}>
      <span className={FACE} data-icon={appIconKind(app as any)} aria-hidden="true">
        <AppIconContent app={app as any} />
      </span>
    </span>
  );
}

/** How many of the brand kit's backgrounds a community is given one of (app.css `--wip-scene-1` to `-6`). */
const LOGO_SCENES = 6;

/**
 * A community's scene, 1 to LOGO_SCENES: always the same one for the same
 * community. Its kit tile's band (app.css) and its card's background where
 * it has no picture (../communities/card.tsx `cardScene`) are drawn from it.
 */
export function communityScene(slug: string): number {
  // FNV-1a, so slugs that differ by a letter land on different scenes.
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i += 1) { h ^= slug.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ((h >>> 3) % LOGO_SCENES) + 1;
}

/**
 * A COMMUNITY'S FACE ON ITS SMALL TILE, where the page draws the kit's tiles
 * (the standard look under 768px): its own icon (its image, else its emoji
 * or initial on a white tile) at the tile's size, on a thin light outline,
 * over the picture its band shows. Until 20 Nov 2026 this was a drawn emblem
 * of the kit's colours; the community card took the real icon, and so did
 * the tile. `.home-community-logo` stays its hook (app.css).
 */
function CommunityTileIcon({ slug, name, iconUrl, iconEmoji }: {
  slug: string; name: string; iconUrl?: string | null; iconEmoji?: string | null;
}) {
  const app = { slug, name, icon_url: iconUrl || null, icon_emoji: iconEmoji || null };
  return (
    <span className={`${FACE} home-community-logo`} data-icon={appIconKind(app as any)} aria-hidden="true">
      <AppIconContent app={app as any} />
    </span>
  );
}

/** A picture's address as a CSS `url()`, for a band drawn by app.css; null for anything but a plain path of this origin. */
function cssUrl(url?: string | null): string | null {
  return url && /^\/[\w\-./]+$/.test(url) ? `url("${url}")` : null;
}

/**
 * The band's picture on a kit tile: the community's own (its dark twin in
 * the dark theme), as custom properties app.css lays over the tile's brand
 * background, which shows where there is none or it does not load.
 */
function bandStyle(pin: { illustrationUrl?: string | null; illustrationDarkUrl?: string | null }): CSSProperties | undefined {
  const light = cssUrl(pin.illustrationUrl);
  if (!light) return undefined;
  const dark = cssUrl(pin.illustrationDarkUrl);
  return { ['--cm-pic' as string]: light, ...(dark ? { ['--cm-pic-dark' as string]: dark } : {}) };
}

export function PinTile({ pin, votes, editing, faded = false, community = false, onUnpin, onPin }: {
  pin: Omit<HomePin, 'member'>;
  votes: number;
  editing: boolean;
  faded?: boolean;
  /** Draw the kit's tile: the community's picture on its band (a brand background where it has none) and its own icon over it. */
  community?: boolean;
  onUnpin?: () => void;
  onPin?: () => void;
}) {
  const t = useMessages('home');
  const tc = useMessages('communities');
  return (
    <a
      href={`/app/${encodeURIComponent(pin.slug)}/workshop`}
      className={faded ? `${TILE} opacity-60` : TILE}
      data-home-community={pin.slug}
      data-home-community-pinned={faded ? undefined : ''}
      data-home-community-scene={community ? String(communityScene(pin.slug)) : undefined}
      data-home-community-picture={community && bandStyle(pin) ? '' : undefined}
      style={community ? bandStyle(pin) : undefined}
      onClick={(event) => { if (editing) { event.preventDefault(); return; } openHub(event, pin.slug); }}
    >
      {/* z-[1] (#6372): the tile's own hit area (un-touch-target's ::after)
          paints after its children and covered the corner discs, so a press
          on − or + reached the tile, a no-op while editing. The lift is on
          this wrapper, not the discs: the wiggle's transform makes it a
          stacking context a disc's own z-index cannot leave. */}
      <span className={editing ? `${FACE_WRAP} ${WIGGLE}` : FACE_WRAP}>
        {community
          ? <CommunityTileIcon slug={pin.slug} name={pin.name} iconUrl={pin.iconUrl} iconEmoji={pin.iconEmoji} />
          : <CommunityTileFace slug={pin.slug} name={pin.name} iconUrl={pin.iconUrl} iconEmoji={pin.iconEmoji} iconColor={pin.iconColor} />}
        {votes > 0 && !editing ? <span className={VOTES} data-home-community-votes={String(votes)} aria-hidden="true">{votes > 99 ? '99+' : votes}</span> : null}
        {editing && onUnpin ? (
          <button
            type="button"
            className={`${CORNER} -start-1.5 ${CORNER_UNPIN}`}
            aria-label={t('home:communities.unpinNamed', { community: pin.name })}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onUnpin(); }}
          >
            <MinusGlyph />
          </button>
        ) : null}
        {onPin ? (
          <button
            type="button"
            className={`${CORNER} -end-1.5 ${CORNER_PIN}`}
            aria-label={t('home:communities.pinNamed', { community: pin.name })}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); onPin(); }}
          >
            <PlusIcon className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </span>
      <span className={NAME}>{pin.name}</span>
      {votes > 0 ? <span className="sr-only">{tc('communities:row.toVote', { count: votes })}</span> : null}
    </a>
  );
}

/**
 * Needs you's tile: a link to the page (`#needs`), so a modified click opens
 * it in a new tab, wearing the votes-waiting number a community's tile wears.
 */
export function NeedsTile({ count }: { count: number }) {
  const t = useMessages('home');
  return (
    <a
      href="#needs"
      id="communities-needs-tile"
      className={TILE}
      data-home-needs={String(count)}
      aria-label={t('home:communities.needsNamed', { count })}
    >
      <span className="relative inline-flex">
        <span className={`${ACTION_FACE} bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300`}>
          <SpeechCheckIcon className="w-7 h-7" aria-hidden="true" />
        </span>
        <span className={VOTES} aria-hidden="true">{count > 99 ? '99+' : count}</span>
      </span>
      <span className={NAME}>{t('home:communities.needs')}</span>
    </a>
  );
}

export function ActionTile({ label, icon, onClick, dashed = false, muted = false, pressed, id, attrs }: {
  label: string; icon: ReactNode; onClick: () => void; dashed?: boolean; muted?: boolean; pressed?: boolean; id?: string;
  attrs?: Record<string, string | undefined>;
}) {
  const face = pressed
    ? `${ACTION_FACE} bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)] shadow-[inset_0_0_0_1px_var(--lit-line)]`
    : dashed
      ? (muted
        ? `home-create-glyph ${ACTION_FACE} border-2 border-dashed transition-colors text-zinc-300 dark:text-zinc-600`
        : `home-create-glyph ${ACTION_FACE} border-2 border-dashed transition-colors text-zinc-500 dark:text-zinc-400`)
      : `${ACTION_FACE} bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200`;
  return (
    <button type="button" id={id} className={`${TILE} cursor-pointer`} aria-pressed={pressed} onClick={onClick} {...attrs}>
      <span className={face}>{icon}</span>
      <span className={pressed ? `${NAME} text-[color:var(--lit-ink)]` : `${NAME} text-zinc-600 dark:text-zinc-300`}>{label}</span>
    </button>
  );
}

/**
 * Your communities that match Home's search (see the header): hidden until
 * something is typed, then every pinned or joined community whose name
 * matches, each a tile that opens its hub. Mounted under every look, since
 * it is also what keeps the account's pins read (`wireHomePins`).
 */
export function HomeCommunityMatches() {
  const t = useMessages('home');
  const state = useStoreState(homePinsStore);
  const query = useSettledHomeQuery();

  useEffect(() => {
    const moved = (count: number) => t('home:devicePins.moved', { count });
    const unwire = wireHomePins(moved);
    // Signed in before Home mounted (the session event already went by):
    // move what this device pinned first, then read the list.
    if ((window as any).App?.user) void importDevicePins(moved).then((count) => (count ? loadHomePins() : loadHomePinsForSession()));
    return unwire;
  }, []);

  // Pinned first, in their order, then the others you are in, except that a
  // community named exactly what was typed leads (#7021).
  const matches = useMemo(() => {
    if (!query) return [];
    const on = new Set(state.pins.map((p) => p.slug));
    const joined = state.joined
      .filter((c) => !on.has(c.slug))
      .map((c) => ({ slug: c.slug, name: c.name || c.slug, iconUrl: c.icon_url || null, iconEmoji: c.icon_emoji || null, iconColor: c.icon_color || null }));
    return rankCommunities([...state.pins, ...joined], query);
  }, [state.pins, state.joined, query]);
  // Read after mount only (state.ready), so the prerender and the first
  // client render agree: both draw the section hidden.
  const visible = state.ready && matches.length > 0;

  return (
    <section id="home-communities-section" className="px-3" hidden={!visible}>
      <SectionHeading>{t('home:communities.matches')}</SectionHeading>
      <div className="grid grid-cols-4 gap-x-1 gap-y-4 px-1 pt-2 pb-2">
        {matches.map((c) => (
          <PinTile key={c.slug} pin={c} votes={state.owed[c.slug] || 0} editing={false} />
        ))}
      </div>
    </section>
  );
}
