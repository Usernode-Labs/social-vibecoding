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
 *   Invite people        the page's action beside Edit: it lists every
 *                        community you are in, each row opening that
 *                        community's invite link to copy or share
 *                        (AppContext.openInvite). One clear way in, rather
 *                        than a button on every tile (Evan, 20 Nov 2026).
 *   New community        the create flow. In Standard (WIP) and the brand
 *                        look it is the filled button beside the search field
 *                        from 768px, as New project is on Home; everywhere
 *                        else, and on a phone, the last tile of Joined.
 *   Discover             the way to Home's Communities to join.
 *
 * On a wide screen in the brand look each community is a card that says how
 * many members it has, what went live this week and who was active
 * (GET /api/me/home-pins/activity; ../home/pinned-communities.tsx
 * `CommunityDetail`).
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
import { PlusIcon, SearchIcon, UserPlusIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { useSkin } from '../../lib/skin';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibility, useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import {
  homePinsActivityStore, homePinsStore, loadHomePinsActivity, refreshHomePins, setHomePin,
  type HomePin,
} from '../home/home-pins-store';
import { CommunitiesToJoin, readDirectory } from '../home/communities-to-join';
import type { GuestApp } from '../guest/guest-data';
import { SectionHeading } from '../home/panels/ui';
import { ActionTile, HEAD_ACTION, NeedsTile, PinTile, useWide } from '../home/pinned-communities';
import { matchesQuery } from '../home/use-home-query';
import { WipCard, WipCta, WipHeadMore } from '../home/wip-kit';
import { communityScopeStore } from '../workshop/community-scope';

const GRID = 'communities-grid grid grid-cols-4 gap-x-1 gap-y-4 px-1 pt-2 pb-2';
/**
 * The card the Invite people list sits in, outside Standard (WIP): the plane
 * colour, 20px corners, one inset hairline, the same three values as the
 * Discover card and every other shell card. The look's own card is WipCard's.
 */
const INVITE_CARD = 'rounded-[20px] bg-[color:var(--dc-sheet-solid)] shadow-[inset_0_0_0_1px_var(--app-sheet-line)]';

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

/**
 * Open a community's invite link: `AppContext.openInvite` carries the slug to
 * the invite pane, which reads that community's links while the header keeps
 * naming no project (this page is outside an app). `name` names the pane
 * ("Invite people to …").
 */
function invite(slug: string, name: string) {
  const win = typeof window !== 'undefined' ? (window as any) : null;
  win?.AppContext?.openInvite?.({ slug, name });
}

/** Open Home at Communities to join, the public directory (Home.showCommunitiesToJoin). */
function discover() {
  const win = window as any;
  if (win.Home?.showCommunitiesToJoin) win.Home.showCommunitiesToJoin();
  else win.App?.navigateHome?.();
}

/** A community the page can make an invite link to. */
export type InviteTarget = { slug: string; name: string; iconUrl?: string | null; iconEmoji?: string | null };

/**
 * THE COMMUNITIES' ROWS in the Invite people list: the icon, the name and the
 * people-with-a-plus glyph, each row the whole button. It reuses the Your
 * communities switcher's row, so a row is 60px, reads at the same type as the
 * rest of the platform's lists, and looks right in every look without a rule
 * of its own. The row's accessible name says what pressing it does, since the
 * visible words are only the community's name.
 */
export function InvitePeopleList({ communities, onPick }: {
  communities: InviteTarget[];
  onPick: (community: InviteTarget) => void;
}) {
  const t = useMessages('communities');
  return (
    <div className="py-1">
      {communities.map((c) => {
        const app = { slug: c.slug, name: c.name, icon_url: c.iconUrl || null, icon_emoji: c.iconEmoji || null };
        return (
          <button
            key={c.slug}
            type="button"
            className="community-switcher-row"
            data-communities-invite={c.slug}
            aria-label={t('communities:page.invite.to', { community: c.name })}
            onClick={() => onPick(c)}
          >
            <span className="app-icon-tile community-switcher-tile" data-icon={appIconKind(app as never)} aria-hidden="true">
              <AppIconContent app={app as never} />
            </span>
            <span className="community-switcher-text">
              <span className="community-switcher-name">{c.name}</span>
            </span>
            <UserPlusIcon className="w-5 h-5 shrink-0 opacity-60" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

export function CommunitiesScreen() {
  const t = useMessages('communities');
  const th = useMessages('home');
  const tc = useMessages('core');
  const screenRef = useRef<HTMLElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'communities-screen', false);
  const shown = useVisibility('communities-screen', false);
  const state = useStoreState(homePinsStore);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  // The Invite people list: it opens under the page's top row, above the
  // groups, and closes when a community is picked, when Edit is pressed, or
  // when the page is left.
  const [inviting, setInviting] = useState(false);
  // Standard (WIP): which groups are unfolded past their first rows.
  const [open, setOpen] = useState<{ pinned: boolean; joined: boolean }>({ pinned: false, joined: false });
  const { badgeNeeds } = useStoreState(communityScopeStore) as { badgeNeeds?: number };
  const needs = Math.max(0, Number(badgeNeeds) || 0);
  // The look, read after mount only (useSkin): the prerender knows none.
  const skin = useSkin();
  const wip = skin === 'wip';
  const brand = skin === 'brand';
  // Standard (WIP) and the brand look draw Home with the kit (../home/wip-kit):
  // their Home has the Needs you card and New project as a filled button, so
  // this page takes the same button and leaves the Needs you tile out.
  const kit = wip || brand;
  const wide = useWide();
  // THE CARDS (Drea's review of #6699): in the brand look on a wide screen
  // each community says what is going on there. Read only where it is drawn.
  // Standard (WIP) says how many members on each tile, at every width it draws a row (app.css).
  const cards = (brand && wide) || wip;
  const activity = useStoreState(homePinsActivityStore);
  const listKey = `${state.pins.map((p) => p.slug).join(',')}|${state.joined.map((c) => c.slug).join(',')}`;
  useEffect(() => {
    if (cards && shown && state.ready && listKey !== '|') void loadHomePinsActivity();
  }, [cards, shown, state.ready, listKey]);
  // Leaving the page ends an edit and a search: it opens as it was first seen.
  useEffect(() => { if (!shown) { setEditing(false); setQuery(''); setInviting(false); setOpen({ pinned: false, joined: false }); } }, [shown]);
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
  useEffect(() => { if (q) { setEditing(false); setInviting(false); } }, [q]);

  const pinned = useMemo(() => state.pins.filter((p) => matchesQuery(q, p.name, p.slug)), [state.pins, q]);
  const joined = useMemo(() => {
    const on = new Set(state.pins.map((p) => p.slug));
    return state.joined
      .filter((c) => !on.has(c.slug))
      .map((c) => ({ slug: c.slug, name: c.name || c.slug, iconUrl: c.icon_url || null, iconEmoji: c.icon_emoji || null, iconColor: c.icon_color || null }))
      .filter((c) => matchesQuery(q, c.name, c.slug));
  }, [state.joined, state.pins, q]);
  // EVERY COMMUNITY YOU CAN INVITE PEOPLE TO: the ones you are in, pinned or
  // not. A pin you have not joined has no membership whose link you could
  // make, so it is not one of them.
  const invitable = useMemo(() => {
    const bySlug = new Map<string, { slug: string; name: string; iconUrl: string | null; iconEmoji: string | null }>();
    for (const pin of state.pins) {
      if (pin.member) bySlug.set(pin.slug, { slug: pin.slug, name: pin.name, iconUrl: pin.iconUrl || null, iconEmoji: pin.iconEmoji || null });
    }
    for (const c of state.joined) {
      if (!bySlug.has(c.slug)) bySlug.set(c.slug, { slug: c.slug, name: c.name || c.slug, iconUrl: c.icon_url || null, iconEmoji: c.icon_emoji || null });
    }
    return [...bySlug.values()];
  }, [state.pins, state.joined]);
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
  // INVITE PEOPLE is the page's own action, beside Edit, not a small control
  // on every tile: the person asked for one clear way in, and the product is
  // moving away from extra tiny buttons on a grid of tiles (Evan, 20 Nov
  // 2026). It opens the list below, of every community they can invite to.
  const canInvite = state.ready && invitable.length > 0 && !q && !editing;
  const inviteAction = canInvite ? (
    <button
      type="button"
      id="communities-invite"
      className={HEAD_ACTION}
      aria-expanded={inviting}
      aria-controls="communities-invite-section"
      onClick={() => setInviting((on) => !on)}
    >
      <span className="whitespace-nowrap">{t('communities:page.invite')}</span>
    </button>
  ) : null;
  const edit = (
    <button
      type="button"
      id="communities-edit"
      className={HEAD_ACTION}
      aria-label={editing ? th('home:edit.done') : t('communities:page.editLabel')}
      aria-pressed={editing}
      onClick={() => { setInviting(false); setEditing((on) => !on); }}
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

        {/* INVITE PEOPLE'S LIST: every community you are in, each one a row
            that opens its invite link to copy or share. It is a list rather
            than a button on every tile, so the page keeps one clear Invite
            action and the tiles stay what they are (Evan, 20 Nov 2026). */}
        {state.ready && inviting && invitable.length ? (
          <section id="communities-invite-section" className="px-3">
            <SectionHeading
              action={(
                <button type="button" id="communities-invite-done" className={HEAD_ACTION} onClick={() => setInviting(false)}>
                  <span className="whitespace-nowrap">{tc('core:common.done')}</span>
                </button>
              )}
            >
              {t('communities:page.invite.heading')}
            </SectionHeading>
            <WipCard on={wip} className={wip ? undefined : INVITE_CARD}>
              <InvitePeopleList
                communities={invitable}
                onPick={(c) => { setInviting(false); invite(c.slug, c.name); }}
              />
            </WipCard>
          </section>
        ) : null}

        <section id="communities-pinned-section" className="px-3" hidden={!showPinned}>
          <SectionHeading action={editOn === 'pinned' ? <>{inviteAction}{edit}</> : null}>
            {groupLabel('pinned', t('communities:page.pinned'), pinned.length)}
          </SectionHeading>
          <WipCard on={wip}>
            <div className={GRID}>
              {needsTile ? <NeedsTile count={needs} /> : null}
              {pinnedShown.map((pin) => (
                <PinTile
                  key={pin.slug}
                  pin={pin}
                  votes={state.owed[pin.slug] || 0}
                  editing={editing}
                  community={wip}
                  detail={cards ? activity.bySlug[pin.slug] : undefined}
                  onUnpin={() => { void setHomePin(pin, false, say(pin.name)); }}
                />
              ))}
            </div>
          </WipCard>
        </section>

        <section id="communities-joined-section" className="px-3" hidden={!showJoined}>
          <SectionHeading action={editOn === 'joined' ? <>{inviteAction}{edit}</> : null}>
            {groupLabel('joined', t('communities:page.joined'), joined.length)}
          </SectionHeading>
          <WipCard on={wip}>
            <div className={GRID}>
              {joinedShown.map((c) => (
                <PinTile
                  key={c.slug}
                  pin={c}
                  votes={state.owed[c.slug] || 0}
                  editing={false}
                  community={wip}
                  detail={cards ? activity.bySlug[c.slug] : undefined}
                  onPin={editing ? () => { void setHomePin({ ...c, member: true } as HomePin, true, say(c.name)); } : undefined}
                />
              ))}
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
