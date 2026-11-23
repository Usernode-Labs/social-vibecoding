/**
 * `#communities-screen` — the Communities tab's page (`#communities`).
 *
 * The communities you are in, in two groups: the ones you PINNED, in your
 * order, and the others you have JOINED. Each is a tile that opens its hub.
 * Then a Discover card, whose button opens Home at Communities to join,
 * where the public communities you are not in are listed.
 *
 * One Home (#6361) had retired the Communities screen and listed your
 * communities on Home, as Pinned communities with an All communities tile.
 * The tab came back on 18 Nov 2026, in every look, and they are its page's
 * again: Home keeps Pinned apps, Challenges and Communities to join.
 *
 * The page has no heading of its own: the header names it, as it names
 * every tab's page but Home (App.navigateToCommunities).
 *
 * ── What is on it ──────────────────────────────────────────────────────
 *
 *   Search (from 768px)  filters both groups by name. A phone has no field:
 *                        the two groups fit a screen or two.
 *   Pinned               `home_community_pins` (services/home-pins.js), the
 *                        account's list. Edit lets each be unpinned, which
 *                        moves it to Joined when you are a member; a pin made
 *                        without joining simply goes.
 *   Joined               every community you are a member of that is not
 *                        pinned. While editing, each takes a + that pins it.
 *   Needs you            the tile that opens Needs you (`#needs`), first in
 *                        Pinned, while a vote waits. Only in a look whose Home
 *                        has no Needs you card (Standard and the frame's
 *                        looks): Standard (WIP) and the brand look say it on
 *                        Home.
 *   New community        the create flow. In Standard (WIP) and the brand
 *                        look it is the filled button beside the search field
 *                        from 768px, as New project is on Home; everywhere
 *                        else, and on a phone, the last tile of Joined.
 *   Discover             the way to Home's Communities to join.
 *
 * THE COMMUNITY CARD (./card.tsx, approved 20 Nov 2026). A community you
 * pinned is the big card: its picture, its icon, its name over how many
 * members, what it says it is and this week on one line (the pins' own
 * picture, GET /api/me/home-pins; the rest from GET
 * /api/me/home-pins/activity). One you joined is the compact card, its icon
 * beside its name and its week: the members (the joined list's own count)
 * and who was active, then what went live, from the same activity read,
 * one to a line on a phone, two across from 768px and three from 1280px.
 * The standard look (and Standard (WIP)) draws the big cards from
 * 768px and the compact ones at every width; under 768px a pin is the small
 * tile, its picture on its band and its own icon on it. The brand look draws
 * both cards from 1280px, as it drew its cards before, and keeps its tiles
 * under that. Every other look keeps the tiles.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes inside this root, so the region may hold
 * state. Its FIRST render is the shipped document: `hidden`, with both
 * groups hidden and empty, since the pins and the joined list are read
 * after mount (../home/home-pins-store.ts). Screen visibility is the
 * shell's store (`#communities-screen` is in App.REACT_SCREEN_IDS) and the
 * root's `className` is a constant, so the class has exactly one owner.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { PlusIcon, SearchIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useSkin, isKitHome } from '../../lib/skin';
import { useMinWidth } from '../../lib/use-min-width';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  homePinsActivityStore, homePinsStore, loadHomePinsActivity, refreshHomePins, setHomePin,
  type HomePin,
} from '../home/home-pins-store';
import { CommunitiesToJoin, readDirectory } from '../home/communities-to-join';
import type { GuestApp } from '../guest/guest-data';
import { SectionHeading } from '../home/panels/ui';
import { ActionTile, HEAD_ACTION, NeedsTile, PinTile } from '../home/pinned-communities';
import { matchesQuery } from '../home/use-home-query';
import { WipCard, WipCta, WipHeadMore } from '../home/wip-kit';
import { communityScopeStore } from '../workshop/community-scope';
import { CommunityPageCard, type CardCommunity } from './card';

const GRID = 'communities-grid grid grid-cols-4 gap-x-1 gap-y-4 px-1 pt-2 pb-2';
/** A group drawn as community cards (./card.tsx): app.css `.cm-grid` lays them out. */
const CARDS = 'cm-grid';

/**
 * How many communities a group shows folded under Standard (WIP): three rows
 * of four, as Home's Pinned projects holds three rows. The group's label
 * unfolds the rest and folds them back (the kit's WipHeadMore).
 */
const FOLD_AT = 12;

// The router's door (App.navigateToCommunities): each visit reads the pins,
// the joined list and the votes waiting again, so a community joined or a
// vote cast elsewhere is on the page without a reload. Signed out it reads
// nothing.
if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  (host.UsernodeReact ||= {}).communities = {
    open() { void refreshHomePins(); },
  };
}

/** Open Home at Communities to join, the public directory (Home.showCommunitiesToJoin). */
function discover() {
  const win = window as any;
  if (win.Home?.showCommunitiesToJoin) win.Home.showCommunitiesToJoin();
  else win.App?.navigateHome?.();
}

export function CommunitiesScreen() {
  const t = useMessages('communities');
  const th = useMessages('home');
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'communities-screen', false);
  const shown = useVisibility('communities-screen', false);
  const state = useStoreState(homePinsStore);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  // Standard (WIP): which groups are unfolded past their first rows.
  const [open, setOpen] = useState<{ pinned: boolean; joined: boolean }>({ pinned: false, joined: false });
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number };
  const needs = Math.max(0, Number(badgeNeeds) || 0);
  // The look, read after mount only (useSkin): the prerender knows none.
  const skin = useSkin();
  // The standard look's page too since 20 Nov 2026 (lib/skin.ts isKitHome): the
  // first render's 'standard' is one of the two, so the prerender agrees.
  const wip = isKitHome(skin);
  const brand = skin === 'brand';
  // Standard (WIP) and the brand look draw Home with the kit (../home/wip-kit):
  // their Home has the Needs you card and New project as a filled button, so
  // this page takes the same button and leaves the Needs you tile out.
  const kit = wip || brand;
  // THE COMMUNITY CARD (see the header): a pin is the big card from 768px
  // under the standard look and from 1280px under the brand look, and a
  // joined community the compact card wherever its look draws cards. Read
  // after mount only (useMinWidth), as the look is.
  const wideCards = useMinWidth(768);
  const brandCards = useMinWidth(1280);
  const pinCards = wip ? wideCards : brand && brandCards;
  const joinCards = wip || (brand && brandCards);
  // What a card says beyond its name (a pin's, and a joined community's
  // week), read only where a card is drawn. Until it lands a joined card
  // says what the joined list knows, its members, and its week's lines
  // then appear under them.
  const activity = useStoreState(homePinsActivityStore);
  const pinKey = state.pins.map((p) => p.slug).join(',');
  const joinedKey = state.joined.map((c) => c.slug).join(',');
  useEffect(() => {
    if (shown && state.ready && ((pinCards && pinKey) || (joinCards && joinedKey))) void loadHomePinsActivity();
  }, [pinCards, joinCards, shown, state.ready, pinKey, joinedKey]);
  // The joined list's member counts: the compact card's second line, and a
  // pinned card's while its activity is on its way.
  const joinedMembers = useMemo(() => new Map(state.joined.map((c) => [c.slug, c.member_count])), [state.joined]);
  const pinCard = (pin: HomePin): CardCommunity => {
    const week = activity.bySlug[pin.slug];
    return {
      slug: pin.slug,
      name: pin.name,
      iconUrl: pin.iconUrl,
      iconEmoji: pin.iconEmoji,
      pictureUrl: pin.illustrationUrl,
      pictureDarkUrl: pin.illustrationDarkUrl,
      members: week ? week.members : joinedMembers.get(pin.slug),
      description: week?.description,
      activeWeek: week?.activeWeek,
      liveWeek: week?.liveWeek,
    };
  };
  // Leaving the page ends an edit and a search: it opens as it was first seen.
  useEffect(() => { if (!shown) { setEditing(false); setQuery(''); setOpen({ pinned: false, joined: false }); } }, [shown]);
  const q = query.trim();
  // Standard (WIP): every community there is to join is listed here too, under
  // Joined, as Home lists them (the same section, ../home/communities-to-join).
  // Read when the page is first shown; `readDirectory` answers a later visit
  // from the read already made.
  const [directory, setDirectory] = useState<GuestApp[] | null>(null);
  const [directoryFailed, setDirectoryFailed] = useState(false);
  const [directoryAttempt, setDirectoryAttempt] = useState(0);
  useEffect(() => {
    if (!wip || !shown) return undefined;
    let live = true;
    setDirectoryFailed(false);
    void readDirectory(directoryAttempt > 0).then((list) => {
      if (!live) return;
      if (list) setDirectory(list);
      else { setDirectory(null); setDirectoryFailed(true); }
    });
    return () => { live = false; };
  }, [wip, shown, directoryAttempt]);
  const mine = useMemo(() => new Set([...state.joined.map((c) => c.slug), ...state.pins.map((p) => p.slug)]), [state.joined, state.pins]);
  useEffect(() => { if (q) setEditing(false); }, [q]);

  const pinned = useMemo(() => state.pins.filter((p) => matchesQuery(q, p.name, p.slug)), [state.pins, q]);
  const joined = useMemo(() => {
    const on = new Set(state.pins.map((p) => p.slug));
    return state.joined
      .filter((c) => !on.has(c.slug))
      .map((c) => ({
        slug: c.slug, name: c.name || c.slug, iconUrl: c.icon_url || null, iconEmoji: c.icon_emoji || null, iconColor: c.icon_color || null,
        members: c.member_count,
      }))
      .filter((c) => matchesQuery(q, c.name, c.slug));
  }, [state.joined, state.pins, q]);
  /** A joined community as its compact card draws it: its week, once the activity read has it. */
  const joinedCard = (c: (typeof joined)[number]): CardCommunity => {
    const week = activity.bySlug[c.slug];
    return week ? { ...c, activeWeek: week.activeWeek, liveWeek: week.liveWeek } : c;
  };
  /** A joined community as the pin a + makes of it. */
  const pinOf = ({ members: _members, ...c }: (typeof joined)[number]) => ({ ...c, member: true } as HomePin);
  const say = (name: string) => ({
    pinned: th('home:communities.pinned', { community: name }),
    unpinned: th('home:communities.unpinned', { community: name }),
    failed: (reason: string) => th('home:communities.failed', { reason }),
  });
  // Read after mount only (state.ready), so the prerender and the first
  // client render agree: both draw the groups hidden.
  const win = typeof window !== 'undefined' ? (window as any) : null;
  const offerCreate = state.ready && !win?.App?.user?.privateMember;
  const createOn = offerCreate && !!win?.Home?.canCreate?.();
  const locked = th('home:communities.newLocked', { hint: th('home:create.disabledHint') });
  const create = () => { (window as any).App?.showCreateModal?.(); };
  // The Needs you tile, where Home has no card for it (see the header).
  const needsTile = !kit && needs > 0 && !q && !editing;
  // New community as a tile: where the look has no filled button for it, and
  // on a phone under every look (app.css hides whichever is not the width's).
  // Standard (WIP) has the filled button at every width (app.css shows the
  // search row on a phone too), so it draws no tile.
  const createTile = offerCreate && !q && !editing && !wip;
  // Folded, a group shows its first rows; a search or an edit shows all of it.
  const folds = wip && !q && !editing;
  const pinnedShown = folds && !open.pinned ? pinned.slice(0, FOLD_AT) : pinned;
  const joinedShown = folds && !open.joined ? joined.slice(0, FOLD_AT) : joined;
  /** A group's label: the way to all of it while some are held back, and back again once they are out. */
  const groupLabel = (key: 'pinned' | 'joined', words: string, count: number) => {
    if (!folds || count <= FOLD_AT) return words;
    return open[key] ? (
      <WipHeadMore id={`communities-${key}-less`} direction="up" expanded label={t('communities:page.showLess')} pill={t('communities:page.showLess')} onClick={() => setOpen((o) => ({ ...o, [key]: false }))}>
        {words}
      </WipHeadMore>
    ) : (
      <WipHeadMore id={`communities-${key}-all`} direction="down" expanded={false} label={t('communities:page.showAll', { count })} pill={t('communities:page.showAll', { count })} onClick={() => setOpen((o) => ({ ...o, [key]: true }))}>
        {words}
      </WipHeadMore>
    );
  };
  const total = state.pins.length + state.joined.filter((c) => !state.pins.some((p) => p.slug === c.slug)).length;
  const showPinned = state.ready && (pinned.length > 0 || needsTile);
  const showJoined = state.ready && (joined.length > 0 || createTile);
  // One Edit, on the first group there is: with nothing pinned yet it rides
  // Joined, so the first pin can be made from here.
  const canEdit = state.ready && total > 0 && !q;
  const editOn: 'pinned' | 'joined' | null = !canEdit ? null : state.pins.length ? 'pinned' : 'joined';
  const edit = (
    <button
      type="button"
      id="communities-edit"
      className={HEAD_ACTION}
      aria-label={editing ? th('home:edit.done') : t('communities:page.editLabel')}
      aria-pressed={editing}
      onClick={() => setEditing((on) => !on)}
    >
      <span className="whitespace-nowrap">{editing ? th('home:edit.done') : th('home:edit.start')}</span>
    </button>
  );

  return (
    <main ref={screenRef} id="communities-screen" className="hidden flex-1 overflow-y-auto" data-page-bounce="">
      <div id="communities-body" className="home-column communities-page" data-editing={editing ? '' : undefined}>
        {/* The search row, from 768px (app.css): the field, and in the looks
            that draw Home with the kit, New community as the page's one
            filled action at the row's end, as New project is on Home. */}
        <div className="communities-top">
          <div className="relative communities-search">
            <SearchIcon
              className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none dark:text-zinc-400"
              aria-hidden="true"
            />
            <input
              id="communities-search-input"
              type="search"
              autoComplete="off"
              value={query}
              placeholder={t('communities:page.search.placeholder')}
              aria-label={t('communities:page.search.label')}
              className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 ps-9 pe-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {kit && offerCreate ? (
            <WipCta
              id="communities-new-top"
              data-create-enabled={String(createOn)}
              title={createOn ? th('home:communities.newTip') : locked}
              aria-label={createOn ? undefined : locked}
              onClick={create}
            >
              {th('home:communities.new')}
            </WipCta>
          ) : null}
        </div>

        <section id="communities-pinned-section" className="px-3" hidden={!showPinned}>
          <SectionHeading action={editOn === 'pinned' ? edit : null}>
            {groupLabel('pinned', t('communities:page.pinned'), pinned.length)}
          </SectionHeading>
          <WipCard on={wip}>
            <div className={pinCards ? CARDS : GRID} data-cm-grid={pinCards ? 'pinned' : undefined}>
              {needsTile ? <NeedsTile count={needs} /> : null}
              {pinnedShown.map((pin) => (pinCards ? (
                <CommunityPageCard
                  key={pin.slug}
                  community={pinCard(pin)}
                  votes={state.owed[pin.slug] || 0}
                  editing={editing}
                  onUnpin={() => { void setHomePin(pin, false, say(pin.name)); }}
                />
              ) : (
                <PinTile
                  key={pin.slug}
                  pin={pin}
                  votes={state.owed[pin.slug] || 0}
                  editing={editing}
                  community={wip}
                  onUnpin={() => { void setHomePin(pin, false, say(pin.name)); }}
                />
              )))}
            </div>
          </WipCard>
        </section>

        <section id="communities-joined-section" className="px-3" hidden={!showJoined}>
          <SectionHeading action={editOn === 'joined' ? edit : null}>
            {groupLabel('joined', t('communities:page.joined'), joined.length)}
          </SectionHeading>
          {/* Compact cards stand on the page, as the pinned ones do: no group card round them. */}
          <WipCard on={wip && !joinCards}>
            <div className={joinCards ? CARDS : GRID} data-cm-grid={joinCards ? 'joined' : undefined}>
              {joinedShown.map((c) => (joinCards ? (
                <CommunityPageCard
                  key={c.slug}
                  community={joinedCard(c)}
                  votes={state.owed[c.slug] || 0}
                  editing={false}
                  compact
                  onPin={editing ? () => { void setHomePin(pinOf(c), true, say(c.name)); } : undefined}
                />
              ) : (
                <PinTile
                  key={c.slug}
                  pin={c}
                  votes={state.owed[c.slug] || 0}
                  editing={false}
                  /* Joined tiles wear the app's own icon in its ring. */
                  community={false}
                  onPin={editing ? () => { void setHomePin(pinOf(c), true, say(c.name)); } : undefined}
                />
              )))}
              {createTile ? (
                <ActionTile
                  id="communities-new-community"
                  dashed
                  muted={!createOn}
                  label={th('home:communities.new')}
                  icon={<PlusIcon className="w-6 h-6" aria-hidden="true" />}
                  attrs={{
                    'data-panel-slot': 'create',
                    'data-create-enabled': String(createOn),
                    // The filled button stands for it from 768px (app.css).
                    'data-has-top': kit ? '' : undefined,
                    title: createOn ? th('home:communities.newTip') : locked,
                    'aria-label': createOn ? undefined : locked,
                  }}
                  // Both states open the same dialog: at the limit its quota
                  // row explains the lock.
                  onClick={create}
                />
              ) : null}
            </div>
          </WipCard>
        </section>

        {state.ready && q && !pinned.length && !joined.length ? (
          <p id="communities-no-match" className="communities-note" role="status">{t('communities:page.noMatch', { query: q })}</p>
        ) : null}
        {/* "Not in a community yet" only from an answer that says so: a read
            with no answer and nothing saved on this phone says what will
            happen instead (the native-offline proposal, 18 Nov 2026). */}
        {state.ready && !q && total === 0 && !state.failed ? (
          <p id="communities-empty" className="communities-note">{t('communities:page.empty')}</p>
        ) : null}
        {state.ready && !q && total === 0 && state.failed ? (
          <p id="communities-not-saved" className="communities-note" role="status">{t('communities:page.notSaved')}</p>
        ) : null}

        {wip && state.ready ? (
          <CommunitiesToJoin
            apps={directory}
            failed={directoryFailed}
            exclude={mine}
            signedIn
            query={q}
            ids={{ section: 'communities-all-section', featured: 'communities-all-featured-label' }}
            onRetry={() => { setDirectory(null); setDirectoryAttempt((n) => n + 1); }}
          />
        ) : null}
        {/* Discover leads to that list on Home; where the list is on this page there is nothing to lead to. */}
        {wip ? null : (
          <section id="communities-discover-section" className="px-3">
            <SectionHeading>{t('communities:page.discover.heading')}</SectionHeading>
            <div className="communities-discover">
              <p className="communities-discover-text">
                <b>{t('communities:page.discover.title')}</b>
                {t('communities:page.discover.text')}
              </p>
              {/* Standard (WIP): the kit's filled action. Elsewhere the shell's filled pill (the brand look draws it as its sun pill). */}
              {wip ? (
                <WipCta id="communities-discover-btn" glyph={false} onClick={discover}>
                  <SearchIcon className="wip-cta-glyph" aria-hidden="true" />
                  {t('communities:page.discover.button')}
                </WipCta>
              ) : (
                <Button
                  type="button"
                  id="communities-discover-btn"
                  layout="iconRow"
                  variant="pillAccent"
                  size="default"
                  ink="solid"
                  className="communities-discover-btn shrink-0 min-h-[44px]"
                  onClick={discover}
                >
                  <SearchIcon className="w-[18px] h-[18px]" aria-hidden="true" />
                  {t('communities:page.discover.button')}
                </Button>
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
