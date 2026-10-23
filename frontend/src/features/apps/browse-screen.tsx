// The browse-all-apps screen (#apps) as a React island — #1083 chunk F step 1,
// made STATEFUL by #1191 slice 6 (conversion 3).
//
// The whole subtree below #browse-screen is React-owned now. ./browse.js kept
// every decision it ever made — the sort, the search filter, the level
// derivation, the two fetches, the contributor cache, the action-list
// filtering, the screenshot deep link — and stopped making HTML: it pushes
// descriptors into ./browse-store.js, and ./browse-list.tsx and
// ./browse-detail.tsx render them. No `public/js/**` module writes into any
// node below this screen, which is what the island rule requires before a
// region may hold state.
//
// The three things the controller used to toggle from outside React are store
// fields now, for exactly that reason:
//   `level`     — was three classList.toggle calls in _syncLevel, across
//                 #browse-list-level, #browse-detail and #browse-search-bar.
//   `empty`     — was classList + textContent on #browse-empty.
//   `showClear` — was a classList.toggle on #browse-search-clear.
//
// #1383 added a fourth, `sort`: the directory's Sort control. It is the one
// field the controller reads back out (#browse-sort-select was CONTROLLED off
// it, unlike the search field), and 'recommended' is its prerender value — the
// remembered choice and the ?sort= override are resolved on screen entry, not
// during render, because neither localStorage nor location.search exists in
// the SSG pass. Sort lives in the Filters sheet now.
//
// The SEARCH FIELD stays uncontrolled: nothing re-renders its value, so the
// caret cannot jump mid-word — the same property the old wire-once discipline
// bought. Keystrokes go to Browse.setQuery, which still coalesces them on the
// 100ms debounce the input listener used to own.
//
// The prototype's FILTER CHIPS (scrDiscover) became the view switch and the
// Filters sheet: `view`, `only` and `activeCount` are CONTROLLED store fields
// beside `sort`, rendered from a copy of Browse.VIEWS for the reason the old
// chip row was a copy of Browse.FILTERS. 'foryou', [] and 0 are their
// prerender values; ?filter= and the session's choice apply on screen entry.
//
// INITIAL RENDER is the shipped shell exactly: #browse-list and #browse-empty
// empty, #browse-empty and #browse-detail hidden, the search bar and
// #browse-list-level visible, the clear button hidden. Every one of those
// falls out of browse-store.js's initial value, so the SSG prerender pass and
// the first client render agree and hydration is silent. Data loads in
// effects (App.navigateToBrowse → Browse.open → _load), never here.
//
// Visibility of the SCREEN itself is still the shell's visibility store, not
// this file's business: App._showOnlyScreen publishes (screenId, visible) for
// every id in App.REACT_SCREEN_IDS, and useVisibilityHiddenClass writes the
// class synchronously inside that notification, because _showOnlyScreen runs
// inside PlatformUI.transition(fn) and the native kit snapshots the DOM before
// fn returns. `false` is the shipped state: the shell ships this screen hidden.

import { useRef } from 'react';

import { Chip, ChipRail } from '@/components/ui/chip';
import { FilterIcon, SearchIcon } from '@/components/ui/icons';
import {
  SECTION_TAB_ACTIVE,
  SECTION_TAB_BASE,
  SECTION_TAB_INACTIVE,
  SECTION_TABS_LIST_BASE,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { useMessages } from '../../lib/i18n/react';
import { useVisibilityHiddenClass } from '../../lib/visibility-store';
import { useStoreState } from '../../lib/use-store-state';
import { BrowseDetail } from './browse-detail';
import { BrowseRows } from './browse-list';
import { openBrowseFilterSheet } from './browse-filter-sheet';
import { AppsLoadError } from './load-error';
import { browseStore } from './mount';

const CLEAR_CLASS = 'absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center '
  + 'justify-center rounded-full text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-200  dark:text-zinc-400'
  + 'hover:bg-zinc-500/10 text-base leading-none';

function browse(): any {
  return (typeof window !== 'undefined' ? (window as any).Browse : null) || null;
}

// The three views of the switch — Browse.VIEWS, labelled. A COPY for the same
// reason SORT_OPTIONS is one: the controller is not on `window` in the SSG
// pass, and a switch that prerendered empty and hydrated full would be a
// mismatch. tests/browse-screen.test.js pins the two lists together.
const VIEW_TABS: Array<{ key: string; label: string }> = [
  { key: 'foryou', label: 'discover:view.forYou' },
  { key: 'browse', label: 'discover:view.browse' },
  { key: 'joined', label: 'discover:filter.joined' },
];

export function BrowseScreen() {
  const t = useMessages('discover');
  const screenRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useVisibilityHiddenClass(screenRef, 'browse-screen', false);

  const state = useStoreState(browseStore) as {
    level: 'list' | 'detail';
    rows: any[] | null;
    site: { href: string; label: string } | null;
    empty: string | null;
    error: boolean;
    detail: any;
    showClear?: boolean;
    sort: string;
    filter: string;
    view: string;
    only: string[];
    activeCount: number;
    curated: boolean;
    grouped: boolean;
    moreExpanded: boolean;
    adminFilters?: boolean;
    categories?: Array<{ key: string; label: string }>;
    category?: string;
  };
  const onDetail = state.level === 'detail';
  const category = state.category || 'all';
  // The page row leaves Other out unless it is the picked type: no chip
  // pressed already means every type, so Other would be a second All. The
  // Filters sheet lists it always.
  const typeChips = (state.categories || [])
    .filter((c) => c.key !== 'other' || category === 'other');

  // Escape clears the field and re-filters immediately — the debounce exists
  // to coalesce typing, and a deliberate clear is not typing.
  const clear = (focus: boolean) => {
    const input = inputRef.current;
    if (input) input.value = '';
    browse()?.setQuery('', { immediate: true });
    if (focus && input) input.focus();
  };

  return (
    <main
      ref={screenRef}
      id="browse-screen"
      className="hidden flex-1 overflow-y-auto platform-safe-scroll"
      style={{ position: "relative" }}
      data-page-bounce=""
    >
      {/*
          The search bar rides the level: searching the directory is a level-1
          affordance, and on a detail page the field would filter a list
          nobody can see.

          ON THE PAGE'S OWN BACKGROUND at every width (#5267). At md and up it
          used to be a pinned bar filled with the wallpaper's base colour
          (--home-ground), which a pinned bar needs so the rows can scroll
          under it; over the wallpaper's washes that flat fill read as a band,
          a separate panel across the page. Now it has no fill and is not
          pinned, so the controls scroll away with the list, as they already
          did on a phone.

          ON A PHONE it sits ON THE GROUND, above the list's card, not as
          the card's head. #1919 drew the search, the sort and the list as
          one frosted pane; the communities prototype keeps the controls
          outside the card they narrow, the way Home and the Communities
          screen put a control row over a card, so the card holds only
          what it lists. The head still pins at the top, on the ground's own
          colour, and the rows slide under it. The parts keep their names —
          `browse-pane-head` / `browse-pane-body` / `browse-pane-note` in
          app.css, next to the .browse-row rules — so the phone padding and
          fill live there and only the md+ utilities stay here.

          `md:pt-5` CLEARS THE HEADER'S NOTCH, as Workshop, Messages and
          Profile do: the bar is `rounded-b-2xl -mb-2`, so this band starts
          8px under its bottom edge, and `pt-3` left the search field 4px
          below it (#spacing audit, 14 Oct 2026). 8 for the notch, 12 of air.
      */}
      <div
        id="browse-search-bar"
        className={`${onDetail ? 'hidden ' : ''}browse-pane-head md:px-3 md:pt-5 md:pb-2`}
      >
        <div className="relative max-w-xl">
          <SearchIcon
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none dark:text-zinc-400"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            id="browse-search-input"
            type="text"
            autoComplete="off"
            placeholder={t('discover:search.placeholder')}
            aria-label={t('discover:search.label')}
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-9 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
            onInput={(e) => browse()?.setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Enter opens the site when the field holds a web address —
              // what a browser's address bar does (#5364). The live value is
              // read, not the debounced one, so Enter does not wait for the
              // 100ms coalesce.
              if (e.key === 'Enter') {
                const site = browse()?.siteFor?.(e.currentTarget.value);
                if (site) {
                  e.preventDefault();
                  try { window.open(site.href, '_blank', 'noopener'); } catch (err) { /* ignore */ }
                }
              } else if (e.key === 'Escape' && e.currentTarget.value) {
                e.preventDefault();
                clear(false);
              }
            }}
          />
          <button
            id="browse-search-clear"
            className={state.showClear ? CLEAR_CLASS : `hidden ${CLEAR_CLASS}`}
            title={t('discover:search.clear')}
            aria-label={t('discover:search.clear')}
            onClick={() => clear(true)}
          >
            &times;
          </button>
        </div>
        {/*
            THE VIEW SWITCH. For you is the directory as it always was (the
            Recommended order, grouped under "Recommended for you"); Browse is
            every app as one flat list; Joined is the communities you are in.
            It is the Leaderboard's segmented strip — @/components/ui/tabs'
            SECTION_TAB_* — because a switch between three views of one list is
            a tab strip, not a filter: the selected part says `aria-current`,
            and the active/inactive class tables live in the primitive.

            Rendered from a COPY of Browse.VIEWS (VIEW_TABS) for the same
            reason the old chip row was a copy: window.Browse does not exist in
            the SSG prerender pass.
        */}
        <Tabs value={state.view} onValueChange={(value) => browse()?.setView(value)}>
          <TabsList
            id="browse-view-switch"
            role="group"
            aria-label={t('discover:view.groupLabel')}
            className={`${SECTION_TABS_LIST_BASE} mt-2 flex w-full max-w-xl`}
          >
            {VIEW_TABS.map((v) => (
              <TabsTrigger
                key={v.key}
                value={v.key}
                data-view={v.key}
                className={`${SECTION_TAB_BASE} flex-1`}
                activeClassName={SECTION_TAB_ACTIVE}
                inactiveClassName={SECTION_TAB_INACTIVE}
              >
                {t(v.label)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {/*
            THE TYPE ROW: the kinds of app the directory holds, read from each
            project's own dapp.json `category`, then the Filters button. A type
            chip narrows the list; tapping the pressed one goes back to every
            type, which is why there is no "All types" chip. The row itself is
            always drawn — the Filters button lives at its end and has to stay
            reachable — while the rail appears only once the store lists a
            type, which the prerender never does.

            The Filters button counts the choices that differ from the
            defaults (Browse.activeFilterCount) and opens the sheet. `px-4`
            over the primitive's `px-6`, through cn's twMerge.
        */}
        <div id="browse-type-row" className="mt-2 flex items-center gap-2 max-w-xl">
          {typeChips.length ? (
            <ChipRail
              id="browse-category-chips"
              role="group"
              aria-label={t('discover:category.groupLabel')}
              className="min-w-0 flex-1 gap-2 px-0 py-0"
            >
              {typeChips.map((c) => (
                <Chip
                  key={c.key}
                  size="bar"
                  className="browse-category-chip px-4"
                  selected={category === c.key}
                  data-category={c.key}
                  onClick={() => browse()?.setCategory(category === c.key ? 'all' : c.key)}
                >
                  {t(c.label)}
                </Chip>
              ))}
            </ChipRail>
          ) : null}
          <Chip
            id="browse-filters-btn"
            size="bar"
            className="browse-filters-btn shrink-0 gap-1.5 px-4"
            aria-pressed={undefined}
            aria-haspopup="dialog"
            data-active-count={state.activeCount > 0 ? state.activeCount : undefined}
            onClick={() => openBrowseFilterSheet()}
          >
            <FilterIcon className="h-4 w-4" aria-hidden="true" />
            <span>{t('discover:filters.button')}</span>
            {state.activeCount > 0 ? (
              <>
                <span
                  aria-hidden="true"
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-violet-600 px-1 text-xs font-bold text-white"
                >
                  {state.activeCount}
                </span>
                <span className="sr-only">
                  {t('discover:filters.activeCount', { count: state.activeCount })}
                </span>
              </>
            ) : null}
          </Chip>
        </div>
      </div>
      {/*
          Level 1: the app-store list. ONE row markup, two layouts, and the
          switch is pure CSS — no matchMedia, no re-render on resize.
          Narrow: a hairline-divided vertical list of full-width rows (the
          App Store idiom). md and up: a 2/3-column grid whose rows pick up
          a bordered-box treatment from .browse-row in app.css.
      */}
      <div id="browse-list-level" className={onDetail ? 'hidden' : undefined}>
        {/*
            Grid only. Every border — the phone hairline AND the desktop box —
            is .browse-row in app.css; a divide-* utility here would win the
            cascade against it and strip the boxes' top/bottom edges.
        */}
        <div
          id="browse-list"
          // The rendering anchor for the declared ?sort= checks: it names the
          // order the rows below were actually built with, which a screenshot
          // of a control cannot be asserted on.
          data-sort={state.sort}
          // The view, and the filter key derived from the switches beside it:
          // the declared checks read them for the same reason.
          data-view={state.view}
          data-filter={state.filter}
          // Phone: the BODY of the pane whose head is the search bar above
          // (#1919) — one frosted sheet holding the hairline-separated rows,
          // continuing the head's ring and closing its radius. It used to be
          // a plain white rounded-2xl card under a wallpaper-coloured bar;
          // the pane treatment is `browse-pane-body` in app.css, scoped to
          // below md. At md+ nothing changes: every row is its own box in the
          // grid (app.css), so only the grid utilities live here.
          //
          // Three columns only from xl (1280px), not lg (QA 2026-09-24 Q10):
          // at 1024 the sidebar leaves ~770px, and a third column squeezed
          // the name out of every box entirely.
          className="browse-pane-body md:grid md:grid-cols-2 xl:grid-cols-3 md:gap-3 md:p-3"
        >
          {state.error
            ? (
              // #1899: the shared error card, spanning the md+ grid; Retry
              // re-runs the same directory load.
              <AppsLoadError
                className="md:col-span-full"
                title={t('discover:loadError.directoryTitle')}
                onRetry={() => browse()?._load?.()}
              />
            )
            : <BrowseRows rows={state.rows} site={state.site} curated={state.curated} grouped={state.grouped} moreExpanded={state.moreExpanded} />}
        </div>
        {/*
            The nothing-to-show line. On a phone it stands in for the list as
            the pane's body (`browse-pane-note`, app.css): the list above it
            is empty and collapsed then, and without this the head would end
            on two square corners over a bare page.
        */}
        <div
          id="browse-empty"
          className={state.empty
            ? 'browse-pane-note px-3 pb-8 text-sm text-zinc-500 dark:text-zinc-400'
            : 'hidden browse-pane-note px-3 pb-8 text-sm text-zinc-500 dark:text-zinc-400'}
        >{state.empty}</div>
      </div>
      {/*
          Level 2: the per-app detail page (#apps/<slug>). Absorbs what the
          browse rows' "…" menu used to offer — see Browse._renderDetail.
      */}
      <div id="browse-detail" className={onDetail ? 'max-w-2xl mx-auto p-4' : 'hidden max-w-2xl mx-auto p-4'}>
        <BrowseDetail detail={state.detail} />
      </div>
    </main>
  );
}
