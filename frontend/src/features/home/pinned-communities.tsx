/**
 * PINNED COMMUNITIES (One Home, #6361): Home's second section, under Pinned
 * apps. A community's tile opens its hub; an app's tile (Pinned apps, above)
 * opens the app.
 *
 * The tile is the Communities tab's own phone tile (features/workshop
 * CommunityTile: 62px, 18px corners, the blue votes-waiting number), in a
 * ring of the community's colour (lib/community-color.ts) so it never reads
 * as an app.
 *
 * TWO ROWS AT MOST (#6650). The section shows the first pins and, when
 * there is more to see (more pins than two rows hold, or communities the
 * viewer is in but has not pinned), ends on one tile of its own:
 *
 *   See all communities  every pin, then the communities you are in but
 *                        have not pinned (an automatic membership, or one
 *                        you unpinned), shown faded with a + to pin each;
 *                        pressed again, back to two rows.
 *
 * Needs you and New community were tiles here too. They are cards of Home's
 * For you column now (./for-you.tsx): what asks for the viewer is not one
 * more tile among their communities, and making something is New project.
 *
 * Edit, as on Pinned apps: every pin shows, the tiles wiggle and each takes
 * a − to unpin it. Unpinning keeps the membership; leaving is the hub's.
 *
 * Signed in only. Signed out, the guest Home draws its device's pins with
 * the same tile (features/guest).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { PlusIcon, Squares2X2Icon } from '@/components/ui/icons';

import { useCommunityColor } from '../../lib/community-color';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { SectionHeading } from './panels/ui';
import { homePinsStore, importDevicePins, loadHomePins, loadHomePinsForSession, setHomePin, wireHomePins, type HomePin } from './home-pins-store';
import { matchesQuery, useHomeQuery } from './use-home-query';

const HEAD_ACTION = 'shrink-0 flex items-center text-[14px] font-semibold text-[color:var(--accent)] hover:underline whitespace-nowrap un-touch-target';
const TILE = 'flex min-w-0 flex-col items-center gap-1.5 rounded-2xl py-1 text-center no-underline un-touch-target';
const FACE = 'app-icon-tile w-14 h-14 shrink-0 rounded-[16px] overflow-hidden flex items-center justify-center font-bold text-2xl';
const RING = 'rounded-[21px] p-[3px] shadow-[inset_0_0_0_2px_var(--ring)]';
const NAME = 'max-w-full line-clamp-2 break-words text-[12.5px] font-semibold leading-[15px] text-zinc-800 dark:text-zinc-200';
const VOTES = 'absolute -top-1.5 -end-2 min-w-[22px] h-[22px] px-1.5 rounded-full bg-violet-600 text-white text-xs font-extrabold tabular-nums flex items-center justify-center shadow-[0_0_0_2px_var(--dc-sheet-solid)]';
// The corner discs the grid's edit mode draws (app-grid.tsx .app-card-remove):
// a dark − to unpin; a white + in the accent ink to pin (Discover's add pill's
// treatment), never a primary button's fill on a 24px badge.
const CORNER = 'absolute -top-1.5 w-6 h-6 rounded-full flex items-center justify-center shadow-[0_0_0_2px_var(--dc-sheet-solid)]';
export const CORNER_UNPIN = 'bg-zinc-700 text-white dark:bg-zinc-500';
export const CORNER_PIN = 'bg-white text-violet-700 dark:bg-zinc-800 dark:text-violet-400';
/** No MinusIcon in the kit's set: the glyph is the minus itself, as app-grid.tsx draws it. */
export function MinusGlyph() {
  return <span aria-hidden="true" className="text-[15px] leading-none font-semibold">&minus;</span>;
}
const FACE_WRAP = 'relative z-[1] inline-flex';
const WIGGLE = 'animate-[home-wiggle_260ms_ease-in-out_infinite_alternate] motion-reduce:animate-none';
const ACTION_FACE = 'flex h-[62px] w-[62px] shrink-0 items-center justify-center rounded-[18px]';

/** Open a community's hub, as the Communities tab's tile did (the door rule). */
function openHub(event: React.MouseEvent<HTMLAnchorElement>, slug: string) {
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

function PinTile({ pin, votes, editing, faded = false, onUnpin, onPin }: {
  pin: Omit<HomePin, 'member'>;
  votes: number;
  editing: boolean;
  faded?: boolean;
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
      onClick={(event) => { if (editing) { event.preventDefault(); return; } openHub(event, pin.slug); }}
    >
      {/* z-[1] (#6372): the tile's own hit area (un-touch-target's ::after)
          paints after its children and covered the corner discs, so a press
          on − or + reached the tile, a no-op while editing. The lift is on
          this wrapper, not the discs: the wiggle's transform makes it a
          stacking context a disc's own z-index cannot leave. */}
      <span className={editing ? `${FACE_WRAP} ${WIGGLE}` : FACE_WRAP}>
        <CommunityTileFace slug={pin.slug} name={pin.name} iconUrl={pin.iconUrl} iconEmoji={pin.iconEmoji} iconColor={pin.iconColor} />
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

function ActionTile({ label, icon, onClick, pressed, id }: {
  label: string; icon: ReactNode; onClick: () => void; pressed?: boolean; id?: string;
}) {
  const face = pressed
    ? `${ACTION_FACE} bg-[color:var(--lit-tint)] text-[color:var(--lit-ink)] shadow-[inset_0_0_0_1px_var(--lit-line)]`
    : `${ACTION_FACE} bg-white text-zinc-700 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900 dark:text-zinc-200`;
  return (
    <button type="button" id={id} className={`${TILE} cursor-pointer`} aria-pressed={pressed} onClick={onClick}>
      <span className={face}>{icon}</span>
      <span className={pressed ? `${NAME} text-[color:var(--lit-ink)]` : `${NAME} text-zinc-600 dark:text-zinc-300`}>{label}</span>
    </button>
  );
}

/** Two rows of four: the tiles the section shows before See all. */
export const PINNED_COMMUNITIES_SHOWN = 8;

export function PinnedCommunities() {
  const t = useMessages('home');
  const state = useStoreState(homePinsStore);
  const query = useHomeQuery();
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  // "All communities" elsewhere (the switcher, the tour's last step) opens
  // this section's (Home.showCommunities, SHOW_ALL_COMMUNITIES).
  useEffect(() => {
    const open = () => setShowAll(true);
    document.addEventListener('home:show-all-communities', open);
    return () => document.removeEventListener('home:show-all-communities', open);
  }, []);

  useEffect(() => {
    const moved = (count: number) => t('home:devicePins.moved', { count });
    const unwire = wireHomePins(moved);
    // Signed in before Home mounted (the session event already went by):
    // move what this device pinned first, then read the list.
    if ((window as any).App?.user) void importDevicePins(moved).then((count) => (count ? loadHomePins() : loadHomePinsForSession()));
    return unwire;
  }, []);
  useEffect(() => { if (query) setEditing(false); }, [query]);

  const pinned = useMemo(() => state.pins.filter((p) => matchesQuery(query, p.name, p.slug)), [state.pins, query]);
  const unpinned = useMemo(() => {
    const on = new Set(state.pins.map((p) => p.slug));
    return state.joined
      .filter((c) => !on.has(c.slug))
      .map((c) => ({ slug: c.slug, name: c.name || c.slug, iconUrl: c.icon_url || null, iconEmoji: c.icon_emoji || null, iconColor: c.icon_color || null }))
      .filter((c) => matchesQuery(query, c.name, c.slug));
  }, [state.joined, state.pins, query]);
  const say = (name: string) => ({
    pinned: t('home:communities.pinned', { community: name }),
    unpinned: t('home:communities.unpinned', { community: name }),
    failed: (reason: string) => t('home:communities.failed', { reason }),
  });
  // Read after mount only (state.ready), so the prerender and the first
  // client render agree: both draw the section hidden.
  const visible = state.ready && (pinned.length > 0 || unpinned.length > 0);
  // #6650: two rows, the last tile See all whenever there is more to see.
  // Searching, editing or with See all pressed, every pin shows.
  const more = !query && !editing && (pinned.length > PINNED_COMMUNITIES_SHOWN || unpinned.length > 0);
  const shownPins = more && !showAll ? pinned.slice(0, PINNED_COMMUNITIES_SHOWN - 1) : pinned;

  return (
    <section id="home-communities-section" className="home-section-rule px-3" hidden={!visible} data-editing={editing ? '' : undefined}>
      <SectionHeading
        action={state.pins.length && !query ? (
          <button
            type="button"
            className={HEAD_ACTION}
            aria-label={editing ? t('home:edit.done') : t('home:communities.editLabel')}
            onClick={() => setEditing((on) => !on)}
          >
            <span className="whitespace-nowrap">{editing ? t('home:edit.done') : t('home:edit.start')}</span>
          </button>
        ) : null}
      >
        {t('home:communities.heading')}
      </SectionHeading>
      <div className="grid grid-cols-4 gap-x-1 gap-y-4 px-1 pt-2 pb-2">
        {shownPins.map((pin) => (
          <PinTile
            key={pin.slug}
            pin={pin}
            votes={state.owed[pin.slug] || 0}
            editing={editing}
            onUnpin={() => { void setHomePin(pin, false, say(pin.name)); }}
          />
        ))}
        {(showAll || query) && !editing ? unpinned.map((c) => (
          <PinTile
            key={c.slug}
            pin={c}
            votes={state.owed[c.slug] || 0}
            editing={false}
            faded
            onPin={() => { void setHomePin({ ...c, member: true } as HomePin, true, say(c.name)); }}
          />
        )) : null}
        {more ? (
          <ActionTile
            id="home-all-communities"
            label={showAll ? t('home:communities.fewer') : t('home:communities.seeAll')}
            pressed={showAll}
            icon={<Squares2X2Icon className="w-[30px] h-[30px]" aria-hidden="true" />}
            onClick={() => setShowAll((on) => !on)}
          />
        ) : null}
      </div>
    </section>
  );
}
