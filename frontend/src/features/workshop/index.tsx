/**
 * `#workshop-screen` — the Workshop across all of your apps.
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
 * ── The two tabs (#3051) ───────────────────────────────────────────────
 *
 * The owner asked for the app Workshop's own two questions here too, read
 * across all of your apps: an "All apps" scope chip at the head of the
 * screen, then Current status (the list above, plus the work you have in
 * flight, item by item under each app) and Needs you (the votes waiting on
 * you, item by item under each app). The items are the rows behind the two
 * counts, from GET /api/workshop/items, which reads the same five
 * populations through the same predicates; see its module header.
 *
 * ── Where the numbers come from ────────────────────────────────────────
 *
 * GET /api/workshop/counts (src/routes/workshop-overview.js), which answers
 * for every app in one query. NOT the board's own load: that is eight
 * requests per app, and at forty apps it is not a page. Its module header
 * documents the two populations and the one thing the "needs you" number
 * leaves out — the unclaimed GitHub issues at the tail of that deck, which
 * are not in Postgres — which is why this screen's own legend says "votes
 * waiting" rather than claiming the whole tab.
 *
 * The APP LIST is a second read, and deliberately a different one:
 * GET /api/apps plus `Home.partitionApps(...).yours`, exactly as the app
 * chip's menu composes its strip (features/app-context/app-context-sheet.tsx).
 * "Which apps are mine" is a decision the platform already makes once, and a
 * count endpoint that re-answered it in SQL would be a second copy of it that
 * could drift. The counts arrive keyed by slug and are joined onto those rows
 * here; a slug the endpoint said nothing about is two zeroes.
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

import { useRef, type MouseEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';
import {
  BallotIcon, HandRaisedIcon, SpeechCheckIcon,
} from '@/components/ui/icons';
import {
  SECTION_TABS_LIST_BASE, SECTION_TAB_ACTIVE, SECTION_TAB_BASE, SECTION_TAB_INACTIVE,
  Tabs, TabsList, TabsTrigger,
} from '@/components/ui/tabs';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { AppsLoadError } from '../apps/load-error';
import { agoStamp } from '../../lib/timestamp';
import { useStoreState } from '../../lib/use-store-state';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { AllAppsScope } from './workshop-chrome';
import { workshopStore } from './workshop-store.js';

// The legacy router reads the DOM on the line after it routes — the ?shot=
// capture fixtures assert the revealed screen inside the same task — so the
// store's notification has to land synchronously. Same install, same reason,
// as features/header/mount.ts.
workshopStore.setFlush(flushSync);

type WorkshopRow = {
  slug: string;
  name?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  working: number;
  needs: number;
};

type Counts = Record<string, { working?: number; needs?: number } | undefined>;

type WorkshopItem = {
  kind: 'session' | 'proposal' | 'governance';
  id: number;
  title: string;
  status: string;
  at: string | null;
};

type Items = Record<string, { working?: WorkshopItem[]; needs?: WorkshopItem[] } | undefined>;

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
 * The viewer's apps with their two counts, newest question first.
 *
 * Exported and pure so tests can drive the ordering without a fetch. The
 * order is the argument this screen makes: an app that needs a decision from
 * you outranks one where you have work of your own outstanding, which
 * outranks a quiet one — and inside each band the platform's own "Your apps"
 * order (favourite order, then activity) is preserved, because `sort` is
 * stable and this comparator answers 0 for two rows in the same band.
 */
export function orderRows(apps: WorkshopRow[]): WorkshopRow[] {
  const band = (row: WorkshopRow) => (row.needs > 0 ? 0 : (row.working > 0 ? 1 : 2));
  return apps.slice().sort((a, b) => band(a) - band(b));
}

/** Join a counts map onto the app rows. A slug with no entry is two zeroes. */

export function joinCounts(apps: Array<Omit<WorkshopRow, 'working' | 'needs'>>, counts: Counts): WorkshopRow[] {
  return apps.map((app) => {
    const found = counts[app.slug];
    return {
      ...app,
      working: Number(found?.working) || 0,
      needs: Number(found?.needs) || 0,
    };
  });
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
 * Where an item opens: its own full-screen page inside its app, in the
 * spelling the app's board uses (features/dev-board/card/fold.tsx's
 * `openHref` / `sessionHref`). A hash route, so a tap routes in place and a
 * modified click opens a tab, like every other row here.
 */
export function itemHref(slug: string, item: WorkshopItem): string {
  const app = encodeURIComponent(slug);
  if (item.kind === 'session') return `#app/${app}/dev/sessions/${item.id}`;
  if (item.kind === 'governance') return `#app/${app}/dev/governance/${item.id}`;
  return `#app/${app}/dev/proposals/${item.id}`;
}

/** The grey line under an item: what kind of thing it is, and when. */
export function itemCaption(item: WorkshopItem, section: TabKey): string {
  let what: string;
  if (section === 'needs') {
    what = item.kind === 'governance' ? 'Group decision waiting on your vote' : 'Change waiting on your vote';
  } else if (item.kind === 'session') {
    what = item.status === 'paused' ? 'Your change, paused' : 'Your change, in progress';
  } else if (item.kind === 'governance') {
    what = 'Your group decision, open for votes';
  } else {
    what = item.status === 'merging' ? 'Your change, merging' : 'Your change, up for a vote';
  }
  const when = item.at ? agoStamp(item.at).text : '';
  return when ? `${what} · ${when}` : what;
}

/**
 * The item groups one tab draws: each of your apps that has something in
 * `section`, in the order the app list shows them, with its rows.
 *
 * Exported and pure so tests can drive it. `more` is how many of the app's
 * items the bounded read left out (GET /api/workshop/items returns the
 * newest few per app); it is read from the count the app's row already
 * carries, so the tab says "and 4 more" rather than silently stopping.
 */
export function groupItems(
  rows: WorkshopRow[],
  items: Items,
  section: TabKey,
): Array<{ app: WorkshopRow; items: WorkshopItem[]; more: number }> {
  const key = section === 'needs' ? 'needs' : 'working';
  const out: Array<{ app: WorkshopRow; items: WorkshopItem[]; more: number }> = [];
  for (const app of rows) {
    const list = items[app.slug]?.[key] || [];
    if (!list.length) continue;
    const counted = section === 'needs' ? app.needs : app.working;
    out.push({ app, items: list, more: Math.max(0, (counted || 0) - list.length) });
  }
  return out;
}

/**
 * One app's items under one tab: the app's name as a section label over a
 * card of item rows, the widget language's primary shape again.
 *
 * The label is the way into the app's own Workshop, where the rest of that
 * app's items are, so it is an anchor to the same address an app row uses.
 */
function ItemGroup({ app, items, more, section }: {
  app: WorkshopRow;
  items: WorkshopItem[];
  more: number;
  section: TabKey;
}) {
  const workshopHref = `/app/${encodeURIComponent(app.slug)}/workshop`;
  const go = (event: MouseEvent) => {
    const win = window as any;
    if (win.NavLink?.isNativeClick?.(event)) return;
    event.preventDefault();
    win.App?.navigateToApp?.(app.slug, 'dev');
  };
  return (
    <section data-workshop-group={app.slug}>
      <SectionHeader className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="app-icon-tile w-6 h-6 shrink-0 rounded-lg overflow-hidden flex items-center justify-center text-xs font-bold"
          data-icon={appIconKind(app as any)}
        >
          <AppIconContent app={app as any} />
        </span>
        <a href={workshopHref} onClick={go} className="min-w-0 truncate hover:underline">
          {app.name || app.slug}
        </a>
      </SectionHeader>
      <GroupedList>
        {items.map((item) => (
          <ListRow
            key={`${item.kind}-${item.id}`}
            as="a"
            href={itemHref(app.slug, item)}
            data-workshop-item={item.kind}
            leading={(
              <span
                aria-hidden="true"
                className="w-11 h-11 shrink-0 rounded-xl flex items-center justify-center bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300"
              >
                {section === 'needs'
                  ? <BallotIcon className="w-5 h-5" />
                  : <HandRaisedIcon className="w-5 h-5" />}
              </span>
            )}
            title={item.title || 'Untitled'}
            titleClassName="font-semibold"
            subtitle={itemCaption(item, section)}
          />
        ))}
        {more > 0 ? (
          <ListRow
            as="a"
            href={workshopHref}
            onClick={go}
            data-workshop-more={String(more)}
            title={`${more} more in ${app.name || app.slug}`}
            titleClassName="font-medium text-[0.9375rem] text-zinc-500 dark:text-zinc-400"
          />
        ) : null}
      </GroupedList>
    </section>
  );
}

/**
 * A tab's item groups, or what stands in for them: skeletons while the read
 * is in flight, a quiet line when it failed or found nothing. Never the
 * apps' error card: the app list above is the screen's one hard dependency,
 * and it already has one.
 */
function ItemPane({ rows, items, itemsError, section, emptyText, heading }: {
  rows: WorkshopRow[] | null;
  items: Items | null;
  itemsError: boolean;
  section: TabKey;
  /** The line for "nothing here". Empty: say nothing at all. */
  emptyText: string;
  /**
   * A label over the groups, for a pane where they follow something else
   * (Current status: the app list). Given one, the pane is quiet while it
   * loads too, because the list above is already drawing skeletons.
   */
  heading?: string;
}): ReactNode {
  const NOTE = 'px-4 py-3 text-sm text-zinc-500 dark:text-zinc-400';
  if (itemsError) {
    return <p className={NOTE} data-workshop-items-error="">Couldn't load these items. Each app's own Workshop still has them.</p>;
  }
  if (!rows || !items) {
    if (heading) return null;
    return (
      <SkeletonGroup label="Loading items">
        <GroupedList className="mt-2">
          {[0, 1].map((i) => (
            <ListRow
              key={i}
              chevron={false}
              leading={<Skeleton shape="block" className="w-11 h-11 rounded-xl" />}
              title={<Skeleton className="max-w-[60%]" />}
            />
          ))}
        </GroupedList>
      </SkeletonGroup>
    );
  }
  const groups = groupItems(rows, items, section);
  if (!groups.length) {
    return emptyText ? <p className={NOTE} data-workshop-items-empty="">{emptyText}</p> : null;
  }
  return (
    <>
      {/* Heavier than the app labels under it, so the two levels read
          as a heading and its groups rather than as four equal labels. */}
      {heading ? (
        <SectionHeader className="font-semibold text-zinc-900 dark:text-zinc-100" data-workshop-items-heading="">
          {heading}
        </SectionHeader>
      ) : null}
      {groups.map((g) => (
        <ItemGroup key={g.app.slug} app={g.app} items={g.items} more={g.more} section={section} />
      ))}
    </>
  );
}

/**
 * One number with its glyph.
 *
 * TINTED ONLY WHEN IT IS NOT ZERO. A row of grey zeroes is the common case on
 * a big account, and painting those in the accent would make every app look
 * like it was asking for something. The glyphs are the ones the app's own
 * Workshop uses for the same two things — the raised hand for your own work,
 * the bubble-with-a-tick for the Needs-you deck — so the number here and the
 * pane it counts wear the same mark.
 */
function Count({ kind, n, label }: { kind: 'working' | 'needs'; n: number; label: string }) {
  const lit = n > 0;
  const tint = kind === 'needs'
    ? 'text-violet-700 dark:text-violet-300 bg-violet-500/10'
    : 'text-zinc-700 dark:text-zinc-200 bg-zinc-500/10';
  return (
    <span
      {...{ [`data-workshop-${kind}`]: String(n) }}
      // ONE accessible name, not a glyph plus a bare digit. The pill reads
      // "2 items you are working on" to a screen reader and carries the same
      // sentence as its pointer tooltip; the glyph is decoration, which is
      // what a legend a thumb cannot hover is for.
      aria-label={`${n} ${label}`}
      title={`${n} ${label}`}
      className={'shrink-0 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 '
        + 'text-xs font-semibold tabular-nums '
        + (lit ? tint : 'text-zinc-400 dark:text-zinc-500')}
    >
      {kind === 'needs'
        ? <SpeechCheckIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        : <HandRaisedIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />}
      {n}
    </span>
  );
}

/**
 * One app, as a grouped-list row.
 *
 * `ListRow` from @/components/ui/grouped-list is the widget language's primary
 * content shape, and this is the shape it is for: a leading app tile, the
 * app's name as the row's subject, something on the trailing edge and a
 * disclosure chevron. It draws the inset hairline between rows (a
 * pseudo-element, so the last row has none without this file knowing which
 * one is last) and the `active:` press state.
 *
 * AN ANCHOR, which is what `as="a"` on that primitive is for: cmd/ctrl-click,
 * middle-click, "open in new tab" and the context menu are the browser's to
 * give, and the shell takes that seriously enough that #back-btn and the app
 * chip's own menu rows are anchors. `/app/<slug>/workshop` is App._appUrl's
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
function AppRow({ row }: { row: WorkshopRow }) {
  return (
    <ListRow
      as="a"
      href={`/app/${encodeURIComponent(row.slug)}/workshop`}
      data-workshop-app={row.slug}
      onClick={(event) => {
        const win = window as any;
        if (win.NavLink?.isNativeClick?.(event)) return;
        event.preventDefault();
        win.App?.navigateToApp?.(row.slug, 'dev');
      }}
      leading={(
        <div
          className={'app-icon-tile w-11 h-11 shrink-0 rounded-xl overflow-hidden '
            + 'flex items-center justify-center font-bold text-lg'}
          data-icon={appIconKind(row as any)}
        >
          <AppIconContent app={row as any} />
        </div>
      )}
      title={row.name || row.slug}
      trailing={(
        /* ONE trailing group, with its own tight gap. `ListRow` sets `gap-4`
           between every element it lays out, which is right between the tile,
           the title and the trailing edge and is 16px too much BETWEEN two
           numbers that read as one column. Grouping them also buys the title
           that width back, and at phone width the title is what truncates. */
        <span className="flex shrink-0 items-center gap-1.5">
          <Count kind="working" n={row.working} label="items you are working on" />
          <Count kind="needs" n={row.needs} label="votes waiting on you" />
        </span>
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
function RowSkeletons(): ReactNode {
  return (
    <SkeletonGroup label="Loading your apps">
      {[0, 1, 2, 3].map((i) => (
        <ListRow
          key={i}
          chevron={false}
          leading={<Skeleton shape="block" className="w-11 h-11 rounded-xl" />}
          title={<Skeleton className="max-w-[40%]" />}
          trailing={(
            <>
              <Skeleton shape="block" className="w-10 h-5 rounded-full" />
              <Skeleton shape="block" className="w-10 h-5 rounded-full" />
            </>
          )}
        />
      ))}
    </SkeletonGroup>
  );
}

export function WorkshopScreen() {
  const screenRef = useRef<HTMLElement | null>(null);
  const state = useStoreState(workshopStore) as {
    open: boolean; rows: WorkshopRow[] | null; error: boolean;
    tab: TabKey; scopeOpen: boolean; items: Items | null; itemsError: boolean;
  };
  useVisibilityHiddenClass(screenRef, 'workshop-screen', false);
  // TWO TABS, READ ACROSS EVERY APP (#3051). #2718's review took the app
  // Workshop's three tabs off this screen because up here they only FILTERED
  // the list of apps by whether a number on a row was non-zero. These two
  // are not filters over that list: Current status keeps the list, with its
  // numbers, and adds the work you have in flight; Needs you is the votes
  // waiting on you, item by item, grouped by app. Both are the app
  // Workshop's own two questions asked of all your apps at once. (All items
  // stays an app's own: every item of every app is not a page.)
  const rows = state.rows ? orderRows(state.rows) : null;
  const all = rows;
  // `#workshop-empty` keeps its ONE meaning — you have no apps at all — and
  // that is a contract rather than a nicety: dapp.json selects
  // `#workshop-empty.hidden` to prove the card is gone once the list has
  // rows, so a tab that merely filters to nothing must not raise it. A tab
  // with nothing in it says so in its own line below.
  // The totals the legend prints. Across EVERY app, not the filtered tab:
  // the question is "how much is there altogether", and an answer that moved
  // when you changed tabs would be answering a different one. Null until the
  // list has answered — see the legend's note.
  // Nothing to total with no apps: the empty card below already says why the
  // screen is bare, and "0 working on · 0 waiting on your vote" over it is the
  // same nothing said twice, in the confident voice of a measurement.
  const TOTAL = 'font-semibold text-zinc-900 dark:text-zinc-100';
  const totals = all && all.length > 0
    ? all.reduce((acc, row) => ({
      working: acc.working + (row.working || 0),
      needs: acc.needs + (row.needs || 0),
    }), { working: 0, needs: 0 })
    : null;
  const empty = !!all && all.length === 0 && !state.error;

  return (
    <main
      ref={screenRef}
      id="workshop-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: 'relative' }}
    >
      {/* SECTION LABEL over a card of hairline-separated rows — the widget
          language's primary content shape, drawn by @/components/ui/grouped-list
          rather than by hand. The card carries no border: the language
          separates by figure/ground, and this route paints the wallpaper
          ground (see the `:is(...)` list in app.css) that the white card
          floats on. `max-w-2xl mx-auto` is the only thing here that is this
          screen's own — GroupedList owns its own `mx-4` gutter and radius. */}
      <div className="max-w-2xl mx-auto pb-8">
        {/* NO TITLE HERE (#2718 review). This screen and Messages both drew
            their own name under a bar that was already saying it — the same
            word twice, an inch apart, on the two screens that had been made
            to agree about what a title IS. The bar is the title, which is
            what it is for on every other screen in the shell. */}
        {/* THE SCOPE CHIP IS BACK (#3051, reversing #2759 on the owner's
            request). #2759 took it off because this screen was then only the
            list of your apps, and a chip whose panel listed them again
            repeated the page. The screen now has the app Workshop's two tabs
            read across all of your apps, and "All apps" is what says so: the
            same chip an app's Workshop wears with that app's name
            (./workshop-chrome.tsx), at its other end. */}
        {/* THE LEGEND IS NOT DECORATION. Two bare numbers on a row cannot be
            read, and the per-pill tooltip is not available to a thumb — so the
            two glyphs are named once, here, in the muted line the language
            uses under a section label.

            IT CARRIES THE TOTALS NOW (#2718). The design study put three
            count cards at the top of this screen — "4 in vote / 2 working / 7
            open issues" — and the question they answer is a fair one this
            screen could not answer: the rows say which APPS need you, and
            nowhere said how much there is altogether.

            As numbers in the legend rather than as cards, because the legend
            is already the line that explains these two glyphs, and a card
            deck above a list whose every row carries the same two figures
            would be the third telling of one fact. "Open issues" is not here:
            /api/workshop/counts folds governance issues into `working`
            alongside sessions and promoted proposals, so a third figure would
            have to be invented rather than read.

            Null until the list answers — the totals are a fact about the
            rows, so they wait for the rows rather than printing a confident
            zero over skeletons.

            THE WORDS ARE NOT THE NUMBER'S TO CHANGE. This first shipped as
            "2 working on" / "3 waiting on your vote", which reworded the
            legend on the way past — and a declared check pins the phrase
            "Votes waiting on you" on this screen, so it went red on the
            platform's own run. The number is ADDITIVE: the legend says
            exactly what it said before and gains a figure at the end. That is
            also the better reading, because the glyph's name and its count
            are two different things and the name is the one that has to be
            legible cold. */}
        {/* `pt-5` CLEARS THE HEADER'S NOTCH (#2718 review). The bar is
            `rounded-b-2xl -mb-2`, so every screen root starts 8px UNDER its
            bottom edge and whatever leads a screen has to step down past it:
            the 8 the notch owes plus 12 of air, which is what Messages' own
            first element steps down by. The chip's row leads again (#3051),
            so it carries that step, and the legend under it sits close. */}
        {/* THE ALL APPS CHIP AND THE TABS (#3051) lead the screen, and this
            row carries the header notch clearance (`pt-5`, see above) the
            legend carried while it led. The chip says what the tabs are
            about, all of your apps, and its panel is the way into one. */}
        <div className="px-4 pt-5 pb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <AllAppsScope
            apps={rows}
            open={state.scopeOpen}
            onToggle={(next) => workshopStore.set({ scopeOpen: next })}
          />
          <Tabs value={state.tab} onValueChange={(v) => workshopController.setTab(v as TabKey)}>
            <TabsList className={SECTION_TABS_LIST_BASE} aria-label="Workshop sections">
              <TabsTrigger
                id="workshop-tab-status"
                type="button"
                value="status"
                data-workshop-tab="status"
                className={SECTION_TAB_BASE}
                activeClassName={SECTION_TAB_ACTIVE}
                inactiveClassName={SECTION_TAB_INACTIVE}
              >
                Current status
              </TabsTrigger>
              <TabsTrigger
                id="workshop-tab-needs"
                type="button"
                value="needs"
                data-workshop-tab="needs"
                className={SECTION_TAB_BASE}
                activeClassName={SECTION_TAB_ACTIVE}
                inactiveClassName={SECTION_TAB_INACTIVE}
              >
                Needs you
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        {/* THE STATUS PANE IS HIDDEN, NOT UNMOUNTED, on the other tab:
            #workshop-list is in the prerendered document (the id inventory
            and three declared checks resolve against it), and a tab switch
            must not throw the list's rows away to redraw them. The Needs you
            pane is all client data, so it renders only while it is showing,
            which keeps the cold document as small as it was.

            NO GLYPHS IN THE TABS, unlike the app Workshop's bottom rail: this
            is the segmented strip @/components/ui/tabs draws on the
            Leaderboard, a text control, and the chip beside it already
            carries the one mark this row needs. */}
        <div data-workshop-pane="status" className={state.tab === 'status' ? '' : 'hidden'}>
          <p className="px-4 pt-1 pb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-zinc-500 dark:text-zinc-500">
            <span className="inline-flex items-center gap-1">
              <HandRaisedIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              You are working on
              {totals ? <b id="workshop-total-working" className={TOTAL}>{totals.working}</b> : null}
            </span>
            <span className="inline-flex items-center gap-1">
              <SpeechCheckIcon className="w-4 h-4 shrink-0" aria-hidden="true" />
              Votes waiting on you
              {totals ? <b id="workshop-total-needs" className={TOTAL}>{totals.needs}</b> : null}
            </span>
          </p>
          <GroupedList id="workshop-list">
            {/* #2445: THE EMPTY STATE IS A CARD, NOT A GREY CAPTION — the same
                correction Home's Discover block took in #1913
                (features/home/panels/discover.tsx): a title, a quieter second
                line and a trailing chevron, and the whole thing is the way on
                to the one thing there is to do here. It reads as an
                INVITATION rather than as an error note where the rows usually
                are. Same destination as Discover's, `#apps`, because "you have
                no apps" and "there is nothing to discover" are answered by the
                same directory.

                It is a `ListRow`, not a hand-rolled copy of Discover's plate:
                that card wears the Home panels' lane language
                (`home-discover-lane`, a tint, a hairline) because that is the
                surface it sits on, and THIS surface is the grouped-list card
                every other row on this screen is drawn in. Same shape, this
                screen's vocabulary. An anchor rather than a button for the
                reason AppRow gives — a hash href is the browser's to open in a
                new tab — and with no leading tile.

                FIRST, not last, and that is load-bearing: the row separator is
                `[&:not(:last-child)]:after:*` on the row itself, so a note after
                the rows would leave the last one drawing a hairline under
                nothing. Ahead of them it changes which element is last not at
                all. It ships in the prerender — hidden — because the shell's id
                inventory resolves against that document.

                THE CARD DRAWS NO HAIRLINE OF ITS OWN, in either state, and that
                is right rather than incidental. Showing, it is the only thing in
                the list, and a rule under the last row is a rule under nothing —
                which is the very reason this sits first. Hidden, the wrapper is
                `display: none`, so neither it nor the row inside it renders
                anything at all, and the rows below keep the separators they
                would have had. The row gets there by being the wrapper's only
                child, so `:not(:last-child)` is false for it always.

                THE ID AND THE `hidden` CLASS ARE THE API. dapp.json selects
                `#workshop-empty.hidden` to prove the card is gone once the list
                has rows, so the id stays on ONE element and visibility stays a
                class toggle on it — never conditional rendering, which would
                take the element out of the document the check resolves against.

                AND IT IS A WRAPPER, NOT THE ANCHOR ITSELF. That is the whole
                reason this div exists, and removing it breaks a merge-gating
                check silently. A second declared selector reads

                  #workshop-list a[data-workshop-app]:first-of-type
                    [data-workshop-needs]:not([data-workshop-needs="0"])

                to prove an app with a decision waiting LEADS the list.
                `:first-of-type` counts siblings OF THAT ELEMENT NAME and is
                purely structural — `display: none` does not exempt an element
                from it — so an `<a id="workshop-empty">` sitting here as a
                sibling of the rows makes the first app row the SECOND `<a>`,
                and that selector matches nothing whether the card is showing or
                not. It shipped that way once (#2445) and the check failed on
                the very next run. Inside this div the card's anchor is the
                first `<a>` among ITS siblings, where it satisfies nothing and
                blocks nothing, and the first row is the first `<a>` among the
                list's own children again. */}
            <div id="workshop-empty" className={empty ? '' : 'hidden'}>
              <ListRow
                as="a"
                href="#apps"
                title="You have no apps yet"
                subtitle="Browse the directory to find one to join."
                subtitleClassName="whitespace-normal"
              />
            </div>
            {state.error
              ? (
                <AppsLoadError
                  title="Couldn't load your workshop"
                  onRetry={() => { void workshopController.reload(); }}
                />
              )
              : rows === null
                ? <RowSkeletons />
                : rows.map((row) => <AppRow key={row.slug} row={row} />)}
          </GroupedList>
          {/* The work you have in flight, item by item, under each app. Quiet
              when there is none: the legend's total already says 0. */}
          {state.error ? null : (
            <ItemPane
              rows={rows}
              items={state.items}
              itemsError={state.itemsError}
              section="status"
              emptyText=""
              heading="What you are working on"
            />
          )}
        </div>
        {state.tab === 'needs' ? (
          <div data-workshop-pane="needs">
            {state.error ? null : (
              <ItemPane
                rows={rows}
                items={state.items}
                itemsError={state.itemsError}
                section="needs"
                emptyText="Nothing is waiting on your vote in any of your apps."
              />
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
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
    return workshopController.reload();
  },
  close() {
    workshopStore.set({ open: false, scopeOpen: false });
  },
  isOpen() {
    return workshopStore.get().open;
  },
  /** Show one of the two tabs, and close the chip's panel on the way. */
  setTab(tab: TabKey) {
    workshopStore.set({ tab: tab === 'needs' ? 'needs' : 'status', scopeOpen: false });
  },
  async reload() {
    const demo = demoQuery();
    workshopStore.set({ error: false });
    let apps: Array<Omit<WorkshopRow, 'working' | 'needs'>> | null = null;
    let counts: Counts = {};
    let items: Items | null = null;
    try {
      const [appsRes, countsRes, itemsRes] = await Promise.all([
        fetch(`/api/apps${demo}`),
        fetch(`/api/workshop/counts${demo}`).catch(() => null),
        fetch(`/api/workshop/items${demo}`).catch(() => null),
      ]);
      if (appsRes.ok) {
        const data = await appsRes.json();
        const home = (window as any).Home;
        apps = home?.partitionApps
          ? home.partitionApps(data.apps || []).yours
          : (data.apps || []);
      }
      if (countsRes && countsRes.ok) {
        const data = await countsRes.json().catch(() => null);
        if (data && data.counts && typeof data.counts === 'object') counts = data.counts;
      }
      // THE ITEMS ARE OPTIONAL TOO, like the counts: losing them costs the
      // two tabs' item lists (each says so in a line), never the screen.
      if (itemsRes && itemsRes.ok) {
        const data = await itemsRes.json().catch(() => null);
        if (data && data.items && typeof data.items === 'object') items = data.items;
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
      rows: joinCounts(apps, counts),
      error: false,
      items: items || {},
      itemsError: !items,
    });
  },
};

if (typeof window !== 'undefined') {
  const host = (window as unknown as { UsernodeReact?: Record<string, unknown> });
  const bridge = (host.UsernodeReact ||= {});
  bridge.workshop = workshopController;
}

export { workshopStore };
