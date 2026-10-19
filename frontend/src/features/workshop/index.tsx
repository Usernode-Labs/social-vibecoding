/**
 * `#workshop-screen` — the Workshop across all of your communities.
 *
 * ── What it is for ─────────────────────────────────────────────────────
 *
 * Every app has a Workshop page: its Dev lander, which opens on "What you
 * are working on" and carries a "Needs you" tab beside it
 * (features/dev-board/workshop/workshop.tsx). That page answers "what is
 * happening in THIS app", and it is the right page — but the question a
 * person actually arrives with is one level up: WHICH of my apps wants
 * something from me right now. Answering it meant opening each app's
 * Workshop in turn, which is how a good screen becomes a chore.
 *
 * So this is the same two numbers, once per app, on one screen. A row says
 * how many items that app's own Workshop holds for you, and tapping it goes
 * to that Workshop — the existing page, not a copy of it. The header's back
 * control then points back here (see App.navigateToWorkshop and
 * `App._appBackHref` in public/js/app.js), so the two screens read as one
 * level and its drill-in rather than as two places that happen to link.
 *
 * ── Needs you, one row and one page ────────────────────────────────────
 *
 * #3051 put the app Workshop's own two questions here as two tabs, Current
 * status and Needs you, with the work you had in flight listed item by item
 * under the list. The tabs are gone. When a vote waits on you, the list
 * opens with ONE row that says so ("3 votes waiting on you", and in which
 * communities), and it opens the cross-community Needs you feed as a page
 * with a way back (`?ws=needs` still deep-links it). Your own work in flight
 * is Profile's Your changes now: this screen is where your communities are,
 * and a list of your items under it was a second, longer answer to a
 * question the row counts already ask.
 *
 * ── Your communities, in three sections ────────────────────────────────
 *
 * The rows are the COMMUNITIES you are in (services/communities.js), not the
 * shortcuts on Home. Every project belongs to one community and while the two
 * are one-to-one a community is drawn as its only project — so a row still
 * looks like an app and still goes to that app's Workshop — but which rows are
 * here is membership (`is_member` on GET /api/apps), and taking a tile off
 * Home no longer takes it off this screen.
 *
 * They are grouped by AUDIENCE, in the order a person reaches for them:
 * Public communities (open), Private communities (invite-only, more than one
 * person) and Just you.
 * Inside each section the rows are by recency (`last_active_at`: your joining,
 * your last visit, the last thing that happened in its changes), and only the
 * three most recent show until "Show N more" is pressed. Recency rather than
 * "needs you first" is the point of the sections: an ordering by urgency is
 * how a quiet project you care about falls off the bottom and is lost, and
 * the numbers on each row already say which ones are asking for you.
 *
 * ── Where the numbers come from ────────────────────────────────────────
 *
 * GET /api/workshop/counts (src/routes/workshop-overview.js), which answers
 * for every app in one query. NOT the board's own load: that is eight
 * requests per app, and at forty apps it is not a page. Its module header
 * documents the two populations and the one thing the "needs you" number
 * leaves out — the unclaimed GitHub issues at the tail of that deck, which
 * are not in Postgres — which is why the Needs you row says "votes
 * waiting" rather than claiming the whole of a project's Needs you.
 *
 * Since #3526 each project's entry also says WHICH votes (`owed`), and the
 * rows and the Needs you row leave out the ones this viewer swiped past in a
 * Needs you feed (`unseenRow`, ./needs-seen.ts): a vote you have seen and
 * moved on from is not news, and the number is the news.
 *
 * The COMMUNITY LIST is a second read, and deliberately a different one:
 * GET /api/apps filtered by `Home.isJoined`, the same predicate Discover's
 * Join pill and its Joined chip read. "Which communities am I in" is a
 * decision the platform already makes once, and a count endpoint that
 * re-answered it in SQL would be a second copy of it that could drift. The
 * counts arrive keyed by slug and are joined onto those rows here; a slug the
 * endpoint said nothing about is two zeroes.
 *
 * ── The island rules it keeps ──────────────────────────────────────────
 *
 * Nothing in `public/js/**` writes inside this root, so the region may hold
 * state. Its FIRST render is the shipped document — `hidden`, an empty list,
 * no rows — and both fetches run from `open()`, never during render. Screen
 * visibility is the shell's store (`#workshop-screen` is in
 * App.REACT_SCREEN_IDS) and the root's `className` is a constant, so the
 * class has exactly one owner.
 */

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import {
  BallotIcon, ChevronLeftIcon, HandRaisedIcon, LockIcon, PlusIcon, SearchIcon, SpeechCheckIcon, UserGroupIcon, UserIcon,
} from '@/components/ui/icons';
import { AppIconContent, AppIconLink, appIconKind } from '../apps/app-card-view';
import { AppsLoadError } from '../apps/load-error';
import { useMessages } from '../../lib/i18n/react';
import { listText, t as translate } from '../../lib/i18n/runtime';
import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import {
  publishVoteSaved,
  voteSavedStore,
} from '../dev-board/card/cards-store';
import { landKeepingPlace } from '../dev-board/workshop/place-store';
import { channelUnread, useMessagesSnapshot } from '../messages/store';
import { openPinMenu } from '../nav/pin-actions';
import { useSidebarRows } from '../nav/sidebar-rows';
import { communitiesSearchStore } from './communities-search';
import { NeedsReel, type NeedsFeedItem } from './needs-reel';
import { unseenNeeds, useNeedsSeen } from './needs-seen';
import {
  groupRows, matchRows, orderRows, SECTION_LIMIT, sectionFold, type Audience,
} from './sections';
import { workshopStore } from './workshop-store.js';

// The legacy router reads the DOM on the line after it routes — the ?shot=
// capture fixtures assert the revealed screen inside the same task — so the
// store's notification has to land synchronously. Same install, same reason,
// as features/header/mount.ts.
workshopStore.setFlush(flushSync);

// The sections, their order and their fold are ./sections.ts's, shared with
// the "Which project?" panel (#3363); exported from here too, where the
// screen's tests have always found them.
export {
  groupRows, orderRows, SECTION_LIMIT, SECTION_STEP, SECTIONS, sectionFold,
} from './sections';

export type WorkshopRow = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  audience?: Audience | string;
  member_count?: number;
  last_active_at?: string | null;
  /** Homeroom's own row: its channel is #general. */
  self_hosted?: boolean;
  /** A ?demo=1 fixture row (see orderRows). */
  demo?: boolean;
  working: number;
  needs: number;
  /** Which votes `needs` counts, when the counts said (#3526). */
  owed?: string[];
  /** Every vote owed, the ones swiped past too (`unseenRow` sets it). */
  owedCount?: number;
  /** The viewer has an invite link out for it and nobody has joined yet
      (GET /api/apps `invite_link_out`, routes/apps.js inviteLinkOut). */
  invite_link_out?: boolean;
};

function SectionGlyph({ audience }: { audience: Audience }) {
  const cls = 'w-4 h-4 shrink-0';
  if (audience === 'solo') return <UserIcon className={cls} aria-hidden="true" />;
  if (audience === 'invited') return <LockIcon className={cls} aria-hidden="true" />;
  return <UserGroupIcon className={cls} aria-hidden="true" />;
}

type Counts = Record<string, { working?: number; needs?: number; owed?: unknown } | undefined>;

type TabKey = 'status' | 'needs';

/** The demo flag the board's own fetches forward, in the same spelling. */
function demoQuery(): string {
  try {
    return new URLSearchParams(location.search).get('demo') === '1' ? '?demo=1' : '';
  } catch {
    return '';
  }
}

/**
 * The quiet fact on the row's second line, after its status (see StatusLine):
 * ONE short fact, because the status leads that line and at phone width the
 * text column is about thirty characters wide. "12 members · 2h ago" after
 * "3 to vote" is cut before it says anything, so each audience gets the fact
 * that says the most about it:
 *
 *   Public / Private community → how many people are in it ("12 members").
 *     The order of the section already says which moved last.
 *   Just you                   → when it last moved ("2h ago"). There is one
 *     member, and it is you.
 *
 * AN INVITE OUT (15 Oct 2026): a project the viewer has sent an invite link
 * for, that nobody has joined yet, says "Invite link out" in that fact's
 * place: it is what is going on with it. It stays in its section: a link
 * out does not make Just you a private community, somebody joining does.
 */
export function rowSubtitle(row: WorkshopRow, now = Date.now()): string {
  if (row.invite_link_out) return translate('communities:row.inviteOut');
  if (row.audience !== 'solo') {
    const members = Number(row.member_count) || 0;
    return members > 0 ? translate('communities:row.members', { count: members }) : '';
  }
  const t = row.last_active_at ? Date.parse(row.last_active_at) : NaN;
  if (Number.isNaN(t)) return '';
  const mins = Math.max(0, Math.round((now - t) / 60000));
  if (mins < 1) return translate('communities:row.active.justNow');
  if (mins < 60) return translate('communities:row.active.minutes', { count: mins });
  if (mins < 60 * 24) return translate('communities:row.active.hours', { count: Math.round(mins / 60) });
  return translate('communities:row.active.days', { count: Math.round(mins / (60 * 24)) });
}

/** Join a counts map onto the app rows. A slug with no entry is two zeroes. */

export function joinCounts(apps: Array<Omit<WorkshopRow, 'working' | 'needs'>>, counts: Counts): WorkshopRow[] {
  return apps.map((app) => {
    const found = counts[app.slug];
    const owed = found?.owed;
    return {
      ...app,
      working: Number(found?.working) || 0,
      needs: Number(found?.needs) || 0,
      ...(Array.isArray(owed) ? { owed: owed.map(String) } : {}),
    };
  });
}

/**
 * #3526: a row's "to vote" less the votes swiped past in a Needs you feed
 * (./needs-seen.ts). Worked out as the screen draws, not when the counts
 * land: the feed on this same screen marks votes seen, and the list it goes
 * back to has to say so without asking the server again. A row the counts
 * did not list the votes of keeps its number.
 */
export function unseenRow(row: WorkshopRow): WorkshopRow {
  return { ...row, needs: unseenNeeds(row.slug, row.needs, row.owed), owedCount: row.needs };
}

/**
 * `?ws=needs` or `?ws=status` opens the screen on that tab: the same
 * parameter, in the same spelling, the app's own Workshop reads
 * (AppView._workshopTabParam). A declared check runs against the default
 * state and never clicks, so without it the Needs you pane could not be
 * checked at all. Anything else leaves the tab where the viewer left it.
 */
export function tabFromQuery(search: string): TabKey | null {
  try {
    const v = new URLSearchParams(search).get('ws');
    return v === 'needs' || v === 'status' ? v : null;
  } catch {
    return null;
  }
}

/**
 * The Needs you row's second line: which projects the votes are owed on,
 * in list order, the first three by name and the rest as a count.
 */
export function needsApps(rows: WorkshopRow[], seenToo = false): string {
  const names = rows.filter((row) => ((seenToo ? row.owedCount : row.needs) || 0) > 0).map((row) => row.name || row.slug);
  if (names.length <= 3) return listText(names);
  return translate('communities:needsYou.projectsMore', { projects: listText(names.slice(0, 3)), count: names.length - 3 });
}

/**
 * The row's status IN WORDS: "3 to vote", "2 in progress". Both halves are
 * always in the document, each carrying its number in a data attribute, and
 * a half with nothing to say is `hidden` rather than absent: the declared
 * checks select `[data-workshop-working="2"] + [data-workshop-needs="3"]`,
 * an adjacency that has to hold whichever of the two is showing.
 *
 * WORDS, NOT TWO GLYPH PILLS. The pills put a raised hand and a speech
 * bubble on every row, grey zeroes included, and a bare number next to a
 * glyph is a legend lookup: the eye goes to the line at the top of the
 * screen to find out what "2" means. "2 in progress · 3 to vote" says it
 * where it is. A ZERO SAYS NOTHING: a row with no work in it reads quiet
 * rather than as two measured nothings, which is what a big account's
 * forty-row list mostly is. The one thing that asks for the viewer, a vote,
 * is the accent colour; everything else stays grey.
 */
export function StatusLine({ working, needs }: { working: number; needs: number }) {
  const t = useMessages('communities');
  return (
    <>
      <span
        data-workshop-working={String(working)}
        className={working > 0 ? 'text-zinc-700 dark:text-zinc-300' : 'hidden'}
      >
        {t('communities:row.inProgress', { count: working })}
      </span>
      <span
        data-workshop-needs={String(needs)}
        className={needs > 0 ? 'font-semibold text-violet-700 dark:text-violet-300' : 'hidden'}
      >
        {working > 0 ? <span className="font-normal text-zinc-500 dark:text-zinc-400" aria-hidden="true"> · </span> : null}
        {t('communities:row.toVote', { count: needs })}
      </span>
    </>
  );
}

/**
 * One app, as a grouped-list row.
 *
 * `ListRow` from @/components/ui/grouped-list is the widget language's primary
 * content shape, and this is the shape it is for: a leading app tile, the
 * app's name as the row's subject, its status and one fact on the second line
 * and a disclosure chevron. It draws the inset hairline between rows (a
 * pseudo-element, so the last row has none without this file knowing which
 * one is last) and the `active:` press state.
 *
 * AN ANCHOR, which is what `as="a"` on that primitive is for: cmd/ctrl-click,
 * middle-click, "open in new tab" and the context menu are the browser's to
 * give, and the shell takes that seriously enough that #back-btn and the app
 * chip's own menu rows are anchors. Beside the desktop sidebar the right-click
 * menu is the shell's (18 Oct 2026): Pin to sidebar or Unpin, and Open in
 * new tab, the browser's one the shell keeps (../nav/pin-actions.ts). `/app/<slug>/workshop` is App._appUrl's
 * spelling for that page (`boardView: 'workshop'`), so a copied address
 * restores the same screen cold.
 *
 * A plain primary click routes in place through `App.navigateToApp`, which is
 * also what records the back breadcrumb — it reads `App._inWorkshop`, so the
 * arrow appears because the visit came from here rather than because this row
 * asked for it. A modified click never reaches the handler: the browser
 * handles it natively, which is the whole reason this is an anchor.
 *
 * The leading tile is `.app-icon-tile` at the primitive's own `sm` geometry
 * (2.75rem, `rounded-xl`), exactly as features/apps/browse-list.tsx draws it —
 * app.css owns that face, and a call site must not repaint it.
 */
export function AppRow({ row, onOpen, current = false }: {
  row: WorkshopRow;
  /**
   * What a plain press does instead of opening the project's hub: the
   * phone's drawer (../nav-drawer/outer-level.tsx) switches community in
   * place, keeping the place you were on.
   */
  onOpen?: (row: WorkshopRow) => void;
  /** The community the drawer is on, marked on its tile. */
  current?: boolean;
}) {
  // Subscribed: the row's fact (rowSubtitle) is read in the language on screen.
  const t = useMessages('communities');
  const fact = rowSubtitle(row);
  const busy = row.working > 0 || row.needs > 0;
  // THE CHANNEL'S UNREAD, on the row that opens it. A project's channel
  // lives on its hub, not in Messages, so "something was said" is shown
  // where the room is — read from the Messages store, which loads both the
  // channels and #general on every signed-in page for the tab badges.
  useMessagesSnapshot();
  const unread = channelUnread(row.slug, !!row.self_hosted);
  // Pins are drawn in the sidebar, so only beside it is there one to make.
  const pinnable = useSidebarRows();
  const href = `/app/${encodeURIComponent(row.slug)}/workshop`;
  return (
    <ListRow
      as="a"
      href={href}
      onContextMenu={pinnable ? (event: MouseEvent<HTMLElement>) => {
        openPinMenu(event, { slug: row.slug, name: row.name || row.slug, iconUrl: row.icon_url ?? null, iconEmoji: row.icon_emoji ?? null }, href);
      } : undefined}
      data-workshop-app={row.slug}
      data-workshop-audience={row.audience || 'open'}
      aria-current={current ? 'true' : undefined}
      onClick={(event) => {
        const win = window as any;
        if (win.NavLink?.isNativeClick?.(event)) return;
        event.preventDefault();
        if (onOpen) {
          onOpen(row);
          return;
        }
        // A row opens the project on the place you were on, when it has it,
        // else its hub: a switch keeps your page (landKeepingPlace).
        landKeepingPlace(row.slug);
        win.App?.navigateToApp?.(row.slug, 'dev');
      }}
      leading={(
        <AppIconLink
          nested
          slug={row.slug}
          name={row.name}
          className={'app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden '
            + 'flex items-center justify-center font-bold text-lg'}
          data-icon={appIconKind(row as any)}
        >
          <AppIconContent app={row as any} />
        </AppIconLink>
      )}
      title={row.name || row.slug}
      trailing={unread > 0 ? (
        <span className="messages-unread" data-workshop-unread={String(unread)} aria-label={t('communities:row.unread', { count: unread })}>
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
      // THE STATUS LEADS THE SECOND LINE, then the quiet fact after it, so a
      // narrow screen truncates the fact and never the part that changes.
      // The status spans are always here (see StatusLine) so the checks'
      // adjacency holds on every row, busy or not.
      subtitle={(
        <>
          <StatusLine working={row.working} needs={row.needs} />
          {fact ? (
            <span>{busy ? <span aria-hidden="true"> · </span> : null}{fact}</span>
          ) : null}
        </>
      )}
    />
  );
}

/**
 * Four rows of the real geometry, so the list does not change shape on load.
 *
 * The bars sit in a `ListRow` rather than a hand-built div, which is what
 * keeps "the real geometry" true when the row's padding or its tile size
 * changes. `chevron={false}` because a disclosure arrow on a row that
 * discloses nothing yet is the one part of the shape worth NOT reproducing.
 */
export function RowSkeletons(): ReactNode {
  const t = useMessages('communities');
  return (
    <SkeletonGroup label={t('communities:list.loading')}>
      {[0, 1, 2, 3].map((i) => (
        <ListRow
          key={i}
          chevron={false}
          leading={<Skeleton shape="block" className="w-11 h-11 rounded-xl" />}
          title={<Skeleton className="max-w-[40%]" />}
          subtitle={<Skeleton className="max-w-[30%]" />}
        />
      ))}
    </SkeletonGroup>
  );
}

/**
 * One audience: its label, its count, a card of its three most recent rows,
 * and the rest behind "Show N more".
 *
 * `SectionHeader` over `GroupedList` — the language's label-over-card shape,
 * the same pair Discover's tiers use. The header carries the count of the
 * whole section, not of the rows showing, so "Private communities 5" over
 * three rows is what tells you there are two more before you find the
 * button.
 *
 * THE FOLD IS A ROW OF THE CARD, not a link under it: the language's "Show
 * more" (Messages' channels, Discover's tiers) is the last row of the group it
 * extends, full-width with no tile, so it reads as more of the same list. It
 * reveals SECTION_STEP rows a press and says how many ("Show 5 more"), and
 * becomes "Show fewer" once the section is all out (#3269). A
 * `button`, not an anchor, because it navigates nowhere — which also keeps it
 * out of `a[data-workshop-app]:first-of-type` for good.
 */
export function Section({ audience, label, count, rows, idPrefix = 'workshop-section', onOpen, current }: {
  audience: Audience;
  /** The section's heading and its count's accessible name, as message ids. */
  label: string;
  count: string;
  rows: WorkshopRow[];
  /** The heading's id is `<idPrefix>-<audience>`: the drawer draws its own copy. */
  idPrefix?: string;
  /** AppRow's: a press that is not a door to the hub. */
  onOpen?: (row: WorkshopRow) => void;
  /** The community the drawer is on. */
  current?: string | null;
}) {
  // Subscribed: the heading and the fold row (sectionFold) follow the language.
  const t = useMessages('communities');
  // How many rows are out. Each press of "Show N more" adds SECTION_STEP;
  // once every row is out the same row folds the section back to three.
  const [limit, setLimit] = useState(SECTION_LIMIT);
  const fold = sectionFold(rows.length, limit);
  const shown = rows.slice(0, fold.shown);
  const expanded = fold.shown === rows.length;
  const headingId = `${idPrefix}-${audience}`;
  return (
    <section data-workshop-section={audience} aria-labelledby={headingId}>
      <SectionHeader id={headingId} className="flex items-center gap-1.5">
        <SectionGlyph audience={audience} />
        <span>{t(label)}</span>
        <span className="ml-auto tabular-nums" aria-label={t(count, { count: rows.length })}>{rows.length}</span>
      </SectionHeader>
      <GroupedList tone="plane">
        {shown.map((row) => <AppRow key={row.slug} row={row} onOpen={onOpen} current={!!current && current === row.slug} />)}
        {rows.length > SECTION_LIMIT ? (
          <ListRow
            as="button"
            inset="none"
            chevron={false}
            data-workshop-more={audience}
            aria-expanded={expanded}
            onClick={() => setLimit(fold.next)}
            title={fold.label || ''}
            titleClassName="text-center font-semibold text-violet-700 dark:text-violet-300"
          />
        ) : null}
      </GroupedList>
    </section>
  );
}

export function WorkshopScreen() {
  const t = useMessages('communities');
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(workshopStore) as {
    open: boolean; rows: WorkshopRow[] | null; error: boolean;
    tab: TabKey;
    feed: NeedsFeedItem[] | null; feedError: boolean; feedCapped: boolean;
  };
  useVisibilityHiddenClass(screenRef, 'workshop-screen', false);
  useNeedsSeen();
  // D (18 Oct 2026): ON A DESKTOP THE LIST HAS A SEARCH at its head, which
  // filters it by name into one list, as the phone's drawer does, and which
  // the sidebar's Communities heading opens (../nav/sidebar-rows.ts). It was
  // a column there with Needs you beside it; with v3's nested sidebar there
  // are no second columns, so it is the one page it is on a phone, Needs
  // you a row at its top. False on the first render, so the prerender is
  // the page it always was.
  const wide = useSidebarRows();
  const [query, setQuery] = useState('');
  const [lit, setLit] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const q = wide ? query.trim() : '';
  // The sidebar's search (./communities-search.ts): each new request is
  // answered once, after the screen is showing, by focusing the box and
  // lighting it until focus leaves.
  const { asked } = useStoreState(communitiesSearchStore) as { asked: number };
  const answered = useRef(0);
  useEffect(() => {
    if (!state.open || !wide || asked <= answered.current) return undefined;
    answered.current = asked;
    // The search is at the list's head, so from Needs you it goes back to the list.
    if (state.tab !== 'status') workshopController.setTab('status');
    let frames = 0;
    let raf = 0;
    const tryFocus = () => {
      const input = searchRef.current;
      // The router reveals the screen after `open()`: wait for it to show.
      if (input && input.offsetParent !== null) {
        setLit(true);
        input.focus({ preventScroll: true });
        input.select();
        return;
      }
      if (frames++ < 30) raf = window.requestAnimationFrame(tryFocus);
    };
    tryFocus();
    return () => window.cancelAnimationFrame(raf);
    // `state.tab` is read once, not followed: a change of it re-running this
    // would cancel the focus it is waiting to give.
  }, [asked, state.open, wide]);
  // Leaving the screen ends a search.
  useEffect(() => {
    if (state.open) return;
    setQuery('');
    setLit(false);
  }, [state.open]);
  // ONE PAGE: the list of your projects, with Needs you as a row at its top
  // that opens the feed of votes owed across all of them (`tab: 'needs'`,
  // also reached by `?ws=needs`), and a way back. See the markup below.
  const rows = state.rows ? orderRows(state.rows.map(unseenRow)) : null;
  const found = rows && q ? matchRows(rows, q) : null;
  const sections = rows ? groupRows(rows) : null;
  const all = rows;
  // `#workshop-empty` keeps its ONE meaning — you have no apps at all — and
  // that is a contract rather than a nicety: dapp.json selects
  // `#workshop-empty.hidden` to prove the card is gone once the list has
  // rows.
  // The totals across EVERY project, for the Needs you row. Null until the
  // list has answered, and with no projects at all: the empty card already
  // says why the screen is bare.
  //
  // #3526: `needs` is the votes not yet swiped past, and `owed` every vote,
  // those too. The row is drawn while ANY vote is owed: it is the only door
  // to the feed on this screen, and a vote you skipped is still one you can
  // cast. With nothing new it says how many you skipped instead.
  const totals = all && all.length > 0
    ? all.reduce((acc, row) => ({
      working: acc.working + (row.working || 0),
      needs: acc.needs + (row.needs || 0),
      owed: acc.owed + (row.owedCount || 0),
    }), { working: 0, needs: 0, owed: 0 })
    : null;
  const empty = !!all && all.length === 0 && !state.error;

  return (
    <main
      ref={screenRef}
      id="workshop-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      data-page-bounce=""
      style={{ position: 'relative' }}
    >
      {/* SECTION LABEL over a card of hairline-separated rows — the widget
          language's primary content shape, drawn by @/components/ui/grouped-list
          rather than by hand. The card carries no border: the language
          separates by figure/ground, and this route paints the wallpaper
          ground (see the `:is(...)` list in app.css) that the white card
          floats on. `max-w-2xl mx-auto` is the only thing here that is this
          screen's own — GroupedList owns its own `mx-4` gutter and radius. */}
      <div className="max-w-2xl mx-auto pb-8" data-workshop-panes="">
        {/* NO TITLE HERE (#2718 review). This screen and Messages both drew
            their own name under a bar that was already saying it — the same
            word twice, an inch apart, on the two screens that had been made
            to agree about what a title IS. The bar is the title, which is
            what it is for on every other screen in the shell. */}
        {/* THE SWITCHER IS THE HEADER'S, at every width (#852): the bar's
            title on this screen is "Communities ⌄" (#header-scope-switch,
            features/header/header-title.tsx), which opens Your communities.
            It led the page as a chip of its own, #workshop-scope (#3051), and
            on a phone the header was already it (#3271); a control that says
            where you are belongs in the bar that says it everywhere else.

            `pt-5` CLEARS THE HEADER'S NOTCH (#2718 review). The bar is
            `rounded-b-2xl -mb-2`, so every screen root starts 8px UNDER its
            bottom edge and whatever leads a screen has to step down past it:
            the 8 the notch owes plus 12 of air, which is what Messages' own
            first element steps down by. The chip's row carried that step; the
            spacer below does now. */}
        <div className="pt-5" aria-hidden="true" />
        {/* ONE PAGE, NO TABS. The screen had two, Current status and Needs
            you (#3051), over a line of totals. What you are working
            on moved to your profile (Your changes), which left Current status
            holding only the list, so the list is the page, and Needs you is
            one row at its top that opens the same feed, with a way back.

            THE LIST IS HIDDEN, NOT UNMOUNTED, while the feed is up:
            #workshop-list is in the prerendered document (the id inventory
            and three declared checks resolve against it), and opening the
            feed must not throw the list's rows away to redraw them. The feed
            is all client data, so it renders only while it is showing, which
            keeps the cold document as small as it was. */}
        <div data-workshop-pane="status" className={state.tab === 'status' ? '' : 'hidden'}>
          {/* D: THE SEARCH, at the head of the list from 768px (app.css
              draws it there only): your communities by name, as one list,
              in the drawer's words. Lit while the sidebar's search put the
              caret in it. */}
          <div className="workshop-search" {...(lit ? { 'data-lit': '' } : {})}>
            <div className="messages-search">
              <SearchIcon className="messages-search-glyph w-5 h-5" aria-hidden="true" />
              <input
                ref={searchRef}
                id="workshop-search"
                type="search"
                className="messages-search-input"
                placeholder={t('communities:drawer.search.placeholder')}
                aria-label={t('communities:drawer.search.label')}
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onBlur={() => setLit(false)}
              />
            </div>
          </div>
          {/* The search's answer, in the list's place: app.css puts the
              sections and Join and Start away while it is up. */}
          {found ? (
            found.length ? (
              <GroupedList tone="plane" data-workshop-results="">
                {found.map((row) => <AppRow key={row.slug} row={row} />)}
              </GroupedList>
            ) : (
              <p className="workshop-search-none" data-workshop-none="">{t('communities:drawer.search.none', { query: q })}</p>
            )
          ) : null}
          {/* NEEDS YOU, when something waits: how many votes are owed across
              your projects, which projects, and the way to them. A zero says
              nothing, so the row is not drawn over a quiet day. While a
              search is up (from 768px) app.css puts it away with the
              sections: the answer is the whole list. */}
          {totals && totals.owed > 0 ? (
            <section data-workshop-needs-door="" aria-labelledby="workshop-needs-heading">
              <SectionHeader id="workshop-needs-heading">{t('communities:needsYou.heading')}</SectionHeader>
              <GroupedList tone="plane">
                <ListRow
                  as="button"
                  data-workshop-needs-open=""
                  onClick={() => workshopController.setTab('needs')}
                  leading={(
                    <span className="app-icon-tile w-11 h-11 shrink-0 rounded-xl flex items-center justify-center bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300">
                      <SpeechCheckIcon className="w-5 h-5" aria-hidden="true" />
                    </span>
                  )}
                  title={totals.needs > 0
                    ? t('communities:needsYou.waiting', { count: totals.needs })
                    : t('communities:needsYou.skipped', { count: totals.owed })}
                  subtitle={needsApps(rows || [], !totals.needs)}
                  // "Review" is the row's affordance; a chevron beside it
                  // would say the same thing twice.
                  trailing={<span className="text-sm font-semibold text-violet-700 dark:text-violet-300">{t('communities:needsYou.review')}</span>}
                  chevron={false}
                />
              </GroupedList>
            </section>
          ) : null}
          {/* `#workshop-list` IS A PLAIN WRAPPER, not the card. The pane has
              up to three cards, one per section (see Section above), so the
              list is the thing that holds them and each card is a
              GroupedList of its own. The id stays on the one element that
              holds every row: the declared checks select
              `#workshop-list a[data-workshop-app=…]` and `#workshop-list
              [data-workshop-app]`, both descendant selectors, and the
              sections check reads `#workshop-list > [data-workshop-section]`,
              which is why the sections are its direct children. */}
          <div id="workshop-list">
            {/* #2445: THE EMPTY STATE IS A CARD, NOT A GREY CAPTION: a title,
                a quieter second line and a trailing chevron, the whole thing
                the way on to the one thing there is to do here (the
                directory, where you join). Same destination as Home's
                Discover block.

                THE ID AND THE `hidden` CLASS ARE THE API. dapp.json selects
                `#workshop-empty.hidden` to prove the card is gone once the
                list has rows, so the id stays on ONE element and visibility
                stays a class toggle on it, never conditional rendering, which
                would take the element out of the document the check resolves
                against. It ships in the prerender, hidden, because the
                shell's id inventory resolves against that document.

                A CARD OF ITS OWN, inside a plain wrapper that carries the id
                and the toggle. The card is a GroupedList like every
                section's, and GroupedList's own classes include
                `overflow-hidden`, so the `hidden` toggle sits one level up,
                on an element whose class string is nothing but that toggle,
                where no selector or reader can mistake one for the other. It
                also keeps the empty card's anchor apart from every app row:
                `a[data-workshop-app]` rows are among their section's
                children, never among this card's. */}
            <div id="workshop-empty" className={empty ? '' : 'hidden'}>
              <GroupedList tone="plane">
                <ListRow
                  as="a"
                  href="#apps"
                  title={t('communities:list.empty.title')}
                  subtitle={t('communities:list.empty.subtitle')}
                  subtitleClassName="whitespace-normal"
                />
              </GroupedList>
            </div>
            {state.error
              ? (
                <GroupedList tone="plane">
                  <AppsLoadError
                    title={t('communities:list.loadError')}
                    onRetry={() => { void workshopController.reload(); }}
                  />
                </GroupedList>
              )
              : rows === null
                ? <GroupedList tone="plane"><RowSkeletons /></GroupedList>
                : (sections || []).map((section) => (
                  <Section key={section.key} audience={section.key} label={section.label} count={section.count} rows={section.rows} />
                ))}
          </div>
          {/* #3543: JOIN OR START, under the list, where Your communities has
              them. Drawn once the list has loaded (so never in the prerender,
              and never under a skeleton or a load error). Join is left out
              while the empty card above already says it. Outside
              #workshop-list, whose direct children are the sections. */}
          {rows !== null && !state.error ? (
            <GroupedList tone="plane" className="mt-6">
              {empty ? null : (
                <ListRow
                  as="a"
                  href="#apps"
                  data-workshop-join=""
                  leading={<IconTile size="sm" tint="neutral"><SearchIcon aria-hidden="true" /></IconTile>}
                  title={t('communities:list.join.title')}
                  subtitle={t('communities:list.join.subtitle')}
                />
              )}
              <ListRow
                as="button"
                data-workshop-start=""
                onClick={() => { (window as any).App?.showCreateModal?.(); }}
                leading={<IconTile size="sm" tint="neutral"><PlusIcon aria-hidden="true" /></IconTile>}
                title={t('communities:list.start.title')}
                subtitle={t('communities:list.start.subtitle')}
              />
            </GroupedList>
          ) : null}
        </div>
        {state.tab === 'needs' ? (
          <div data-workshop-pane="needs">
            {/* The way back to the list, and the page's name: the project
                page's own page head (app.css .dev-ws-pagehead). */}
            <div className="px-4 pb-2">
              <div className="dev-ws-pagehead">
                <button
                  type="button"
                  className="dev-ws-page-back un-touch-target"
                  data-workshop-needs-back=""
                  aria-label={t('communities:needsYou.back')}
                  title={t('communities:needsYou.back')}
                  onClick={() => workshopController.setTab('status')}
                >
                  <ChevronLeftIcon className="dev-ws-page-back-glyph" aria-hidden="true" />
                </button>
                <div className="dev-ws-pagehead-text">
                  <span className="dev-ws-pagehead-over">{t('communities:needsYou.over')}</span>
                  <h2 className="dev-ws-pagehead-title">{t('communities:needsYou.title')}</h2>
                </div>
              </div>
            </div>
            {/* ONE FEED, EVERYTHING MIXED (#3270): every decision owed by you
                across your projects, one per screen, newest first, drawn by
                a project's own Needs you feed (#3488). See ./needs-reel.tsx. */}
            {state.error ? null : (
              <NeedsReel
                items={state.feed}
                error={state.feedError}
                capped={state.feedCapped}
                onDone={() => workshopController.setTab('status')}
                onAnswered={(id, epoch) => workshopController.answered(id, epoch)}
              />
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}

/**
 * The votes cast in a Needs you feed this visit, by `proposal:<id>@<epoch>`
 * (`proposal:<id>` when the row carried no epoch). The store's feed is a copy
 * read BEFORE the vote: once the reel unmounts its "Voted yes" state goes
 * with it, and a remount would redraw the answered card as still owed — the
 * report this answers. The set takes the voted items out of every read that
 * hands the feed its rows, so a read issued before the vote and landing after
 * it cannot bring one back. A NEWER epoch passes: the card changed under the
 * vote and asks again. `close()` clears the set — a fresh visit starts from
 * what the server says.
 */
const answeredVotes = new Set<string>();

function answeredVoteKey(id: number, epoch: number | null): string {
  return `proposal:${id}@${epoch == null ? '' : epoch}`;
}

/** Whether this feed item is a vote answered here, at its own epoch. */
function voteAnswered(item: NeedsFeedItem): boolean {
  if (item.kind !== 'proposal') return false;
  for (const key of answeredVotes) {
    const at = key.indexOf('@');
    if (Number(key.slice('proposal:'.length, at)) !== item.id) continue;
    const raw = key.slice(at + 1);
    const epoch = raw === '' ? null : Number(raw);
    if (item.epoch == null || epoch == null || item.epoch === epoch) return true;
  }
  return false;
}

/** The feed's rows, less the votes answered here. */
function stripAnswered(items: NeedsFeedItem[]): NeedsFeedItem[] {
  return answeredVotes.size ? items.filter((item) => !voteAnswered(item)) : items;
}

/**
 * Whether a counts row's `owed` key names a vote in the answered set (#5463),
 * matched the way `voteAnswered` matches its feed items — either epoch null
 * decides by id alone, and a different epoch is a different vote.
 */
function countKeyAnswered(key: string): boolean {
  if (!key.startsWith('proposal:')) return false;
  const at = key.indexOf('@');
  const id = Number(key.slice('proposal:'.length, at < 0 ? key.length : at));
  if (!Number.isFinite(id)) return false;
  const raw = at < 0 ? '' : key.slice(at + 1);
  const epoch = raw === '' ? null : Number(raw);
  return voteAnswered({ kind: 'proposal', id, epoch } as unknown as NeedsFeedItem);
}

/**
 * The rows, with every counts fact a saved vote has already answered taken
 * off (#5463): the `owed` key goes and `needs` drops one, so the "1 to vote"
 * line and the Needs you row leave the vote out the moment it lands instead
 * of waiting for the next quiet read. A row without `owed` keeps its number:
 * a count this cannot check is never lowered on a guess, as in `unseenNeeds`.
 */
function stripAnsweredCounts(rows: WorkshopRow[]): WorkshopRow[] {
  if (!answeredVotes.size) return rows;
  return rows.map((row) => {
    if (!row.owed || !row.owed.length) return row;
    const owed = row.owed.filter((key) => !countKeyAnswered(String(key)));
    if (owed.length === row.owed.length) return row;
    return { ...row, owed, needs: Math.max(0, row.needs - (row.owed.length - owed.length)) };
  });
}

/** How often the open screen quietly re-reads what waits on you (#5164). */
export const WORKSHOP_REFRESH_MS = 30_000;

/**
 * The quiet refresh behind #5164: while the screen is showing, the counts
 * and the Needs you feed are read again every WORKSHOP_REFRESH_MS, and once
 * more the moment the browser tab comes back to the front — the moment
 * people most often notice the lag and reach for a page reload.
 *
 * A module-level watch rather than an effect, because the screen's roots
 * outlive React's mounts the way the controller does: `open()` starts it and
 * `close()` stops it, so nothing runs while the screen is hidden and
 * re-entering never stacks a second timer. The interval skips its tick while
 * the tab is hidden; the listener answers the return instead. Guarded on
 * `document` because the tests run in node with only `window` faked.
 */
let watchTimer: number | null = null;
let watchVisibility: (() => void) | null = null;

function startWatch() {
  if (typeof document === 'undefined') return;
  stopWatch();
  watchTimer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void workshopController.refreshNeeds();
  }, WORKSHOP_REFRESH_MS);
  watchVisibility = () => {
    if (document.visibilityState === 'visible') void workshopController.refreshNeeds();
  };
  document.addEventListener('visibilitychange', watchVisibility);
}

function stopWatch() {
  if (watchTimer !== null) {
    window.clearInterval(watchTimer);
    watchTimer = null;
  }
  if (watchVisibility) {
    document.removeEventListener('visibilitychange', watchVisibility);
    watchVisibility = null;
  }
}

/**
 * The legacy seam, the same shape as `window.UsernodeReact.messages`.
 *
 * `App.navigateToWorkshop()` calls `open()` on the still-hidden root and
 * `_exitWorkshop` calls `close()` on the way out. `open` is not decoration:
 * it is the LIVENESS flag a load checks before it publishes, so a fetch that
 * lands after the viewer has left cannot paint rows into a screen they are no
 * longer on — and cannot race the next entry's own load. The re-entry guard
 * is the router's (see App.navigateToWorkshop), not this flag's, for the
 * reason its note gives.
 *
 * Both reads are fired together and the counts are tolerated as missing: an
 * app list with no numbers is a usable launcher, a screen that refuses to
 * draw because one of two requests failed is not. Losing the LIST is the
 * error card, because there is then nothing to draw.
 */
export const workshopController = {
  open() {
    let asked: TabKey | null = null;
    try { asked = tabFromQuery(location.search); } catch { asked = null; }
    workshopStore.set(asked ? { open: true, tab: asked } : { open: true });
    // #5164: the quiet refresh runs for as long as the screen is showing.
    startWatch();
    return workshopController.reload();
  },
  close() {
    workshopStore.set({ open: false });
    answeredVotes.clear();
    stopWatch();
  },
  isOpen() {
    return workshopStore.get().open;
  },
  /** Show one of the two tabs. */
  setTab(tab: TabKey) {
    workshopStore.set({ tab: tab === 'needs' ? 'needs' : 'status' });
    // Re-entering the list or the feed quietly reloads what waits (#4794):
    // the reads behind both were answered when the screen was entered, and a
    // vote cast in the feed has moved them since. Not while the screen is
    // closed — the notifications path calls setTab('needs') and then routes,
    // and open() reloads anyway.
    if (workshopStore.get().open) void workshopController.refreshNeeds();
  },
  /**
   * A vote cast in the Needs you feed, taken down at once (#4794): the item
   * leaves the store's feed, so leaving the feed and coming back cannot draw
   * it as still owed, and every read until the screen closes skips it too.
   * #5463: the counts leave it out the same breath — the row's `owed` loses
   * the key and `needs` drops one, so the "1 to vote" line goes with the card
   * instead of waiting for the next read to correct it.
   */
  answered(id: number, epoch: number | null) {
    answeredVotes.add(answeredVoteKey(id, epoch));
    const state = workshopStore.get();
    const patch: { feed?: NeedsFeedItem[]; rows?: WorkshopRow[] } = {};
    if (state.feed) patch.feed = stripAnswered(state.feed);
    if (state.rows) patch.rows = stripAnsweredCounts(state.rows);
    if (patch.feed || patch.rows) workshopStore.set(patch);
  },
  /**
   * The quiet reload behind a tab switch: the counts and the Needs you feed
   * again, nothing else. What is on screen stays until the answers land, and
   * a failed read leaves its half untouched — no skeleton, no error card, no
   * `rows: null`. Like reload(), a read that lands after the viewer left the
   * screen publishes nothing.
   */
  async refreshNeeds() {
    if (!workshopStore.get().open) return;
    const demo = demoQuery();
    try {
      // `no-cache` (the #4177 spelling): a quiet read asks for the CURRENT
      // answer. The worker's boot lane would answer it from the saved copy,
      // which is one reason a page reload looked fresher than this screen.
      const [countsRes, feedRes] = await Promise.all([
        fetch(`/api/workshop/counts${demo}`, { cache: 'no-cache' }).catch(() => null),
        fetch(`/api/workshop/needs-feed${demo}`, { cache: 'no-cache' }).catch(() => null),
      ]);
      if (!workshopStore.get().open) return;
      const state = workshopStore.get();
      const patch: {
        rows?: WorkshopRow[];
        feed?: NeedsFeedItem[];
        feedError?: boolean;
        feedCapped?: boolean;
      } = {};
      if (countsRes && countsRes.ok && state.rows) {
        const data = await countsRes.json().catch(() => null);
        if (data && data.counts && typeof data.counts === 'object') {
          // The rows' app halves stand; the counts answer them again, so the
          // owed lists of the read they came from go with them. A read issued
          // before a saved vote and landing after it keeps the vote out
          // (#5463), as the feed's read does through stripAnswered.
          patch.rows = stripAnsweredCounts(joinCounts(
            state.rows.map(({ owed, ...rest }) => rest),
            data.counts,
          ));
        }
      }
      if (feedRes && feedRes.ok) {
        const data = await feedRes.json().catch(() => null);
        if (data && Array.isArray(data.items)) {
          const feed = stripAnswered(data.items as NeedsFeedItem[]);
          patch.feed = feed;
          patch.feedError = false;
          patch.feedCapped = Number(data.max) > 0 && feed.length >= Number(data.max);
        }
      }
      if (patch.rows || patch.feed) workshopStore.set(patch);
    } catch {
      // Offline is a state, not a crash: the screen keeps what it had.
    }
  },
  async reload() {
    const demo = demoQuery();
    workshopStore.set({ error: false });
    let apps: Array<Omit<WorkshopRow, 'working' | 'needs'>> | null = null;
    let counts: Counts = {};
    let feed: NeedsFeedItem[] | null = null;
    let feedCapped = false;
    // #5462: RE-ENTRY asks for the current answer, the same spelling
    // refreshNeeds() sends — the store already holding rows or a feed is what
    // says this is not the first read. Without it the worker's boot lane
    // (sw.js networkFirstApi) answers a read whose network leg misses its
    // deadline with the saved copy from BEFORE the vote, `close()` having
    // cleared the answered set leaves nothing to strip the card out with, and
    // the proposal just voted on is drawn as still owed. The FIRST entry keeps
    // the boot lane (#5164): it is the cold start's fast paint, and with
    // nothing answered yet there is no copy of it to be stale against. The
    // apps read is unchanged: the list of your communities is not what the
    // vote moved.
    const state = workshopStore.get();
    const fresh = state.rows != null || state.feed != null;
    const freshOpts = fresh ? { cache: 'no-cache' as const } : undefined;
    try {
      const [appsRes, countsRes, feedRes] = await Promise.all([
        // Only the communities you are in (#5023): the list below keeps
        // nothing else, so the rest of the catalog was payload for nothing.
        fetch(`/api/apps?scope=joined${demo.replace('?', '&')}`),
        fetch(`/api/workshop/counts${demo}`, freshOpts).catch(() => null),
        fetch(`/api/workshop/needs-feed${demo}`, freshOpts).catch(() => null),
      ]);
      if (appsRes.ok) {
        const data = await appsRes.json();
        const home = (window as any).Home;
        const list = (data.apps || []) as Array<Record<string, any>>;
        // Membership, through the predicate Discover's Join pill reads — not
        // Home's "Your apps", which is a set of shortcuts (see the header).
        const joined = home?.isJoined
          ? (app: Record<string, any>) => !!home.isJoined(app)
          : (app: Record<string, any>) => !!app?.is_member;
        apps = list.filter(joined) as Array<Omit<WorkshopRow, 'working' | 'needs'>>;
      }
      if (countsRes && countsRes.ok) {
        const data = await countsRes.json().catch(() => null);
        if (data && data.counts && typeof data.counts === 'object') counts = data.counts;
      }
      // The Needs you feed is optional like the counts: losing it costs the
      // feed its cards (it says so), never the screen. A read issued before a
      // vote in the feed and landing after it runs through the answered set
      // with refreshNeeds()'s, so it cannot bring the card back.
      if (feedRes && feedRes.ok) {
        const data = await feedRes.json().catch(() => null);
        if (data && Array.isArray(data.items)) {
          feed = stripAnswered(data.items as NeedsFeedItem[]);
          feedCapped = Number(data.max) > 0 && feed.length >= Number(data.max);
        }
      }
    } catch {
      // Offline is a state, not a crash: fall through to the error card,
      // which offers the same load again rather than a page reload.
    }
    // Left the screen while this was in flight: say nothing. The rows are
    // kept as they were, so a re-entry paints the last list at once and
    // refreshes under it — the app strip in the chip's menu takes the same
    // view of a stale answer.
    if (!workshopStore.get().open) return;
    if (!apps) {
      workshopStore.set({ error: true });
      return;
    }
    workshopStore.set({
      // #5463: a vote saved this visit leaves the counts out of the fresh
      // rows too, the way the feed's own read is stripped below.
      rows: stripAnsweredCounts(joinCounts(apps, counts)),
      error: false,
      feed: feed || [],
      feedError: !feed,
      feedCapped,
    });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.workshop = workshopController;
}

/**
 * #5463: a vote the server saved ANYWHERE — in a feed, on the change's own
 * page, from a notification's "Still yes" — reaches the screen through the
 * dev board's voteSavedStore, shown or not: `open()` paints the kept store
 * copy, so it has to be right before that paint, not corrected by the read
 * that lands after it. Each new entry takes the card out of the feed and out
 * of the counts, exactly as `answered()` does for a vote cast in the feed.
 * `close()` still clears the answered set, as today: a fresh visit starts
 * from what the server says. The seq (cards-store.ts) marks what is new, so a
 * re-vote of the same side is seen too; re-running `answered()` is harmless.
 */
let savedVoteSeqSeen = 0;
voteSavedStore.subscribe(() => {
  const saved = voteSavedStore.get();
  let seen = savedVoteSeqSeen;
  for (const [id, entry] of Object.entries(saved)) {
    if (!entry || entry.seq <= seen) continue;
    seen = entry.seq;
    workshopController.answered(Number(id), entry.epoch);
  }
  savedVoteSeqSeen = seen;
});

// `publishVoteSaved` and `voteSavedStore` are re-exported so the saved-vote
// tests can drive the real publish path against this screen's own store.
export { workshopStore, publishVoteSaved, voteSavedStore };
