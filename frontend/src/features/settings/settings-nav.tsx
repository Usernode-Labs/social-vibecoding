/**
 * The Settings screen's two navigation hosts, as React (#1191 slice 6,
 * conversion 8).
 *
 * ── What this renders ─────────────────────────────────────────────────
 *
 * `#settings-nav-desktop` — the grouped sidebar: one button per PAGE in a
 * <nav>, the current one marked `aria-current="page"` (which dapp.json
 * selects on). It was a `role="tab"` set with no tablist around it until QA
 * 2026-09-24.
 * `#settings-mobile-menu-host` — the phone's level-1 menu, a LIST of drawer
 * rows: no current marker, a 44px minimum target and a chevron, exactly as
 * the admin console's level-1 menu.
 *
 * Both open with the same FILTER box. A page is a stack of parts since the
 * settings restructure (see SECTIONS in ../settings.js), so "where is
 * Password?" no longer has a row of its own to answer it; typing does. A
 * query swaps the grouped list for a flat list of the pages that match, each
 * naming the parts that did, and choosing one opens that page scrolled to
 * the first matching part.
 *
 * Both are fed by ./settings-nav-store.js, which ../settings.js writes from
 * `_renderNav()`. The grouping is shared (`_groupedSections()`), so the two
 * can never drift into different headings — that was true of the two HTML
 * builders and it stays true of the two descriptor builders.
 *
 * ── Initial render ────────────────────────────────────────────────────
 *
 * Both hosts ship EMPTY in the hand-written shell, and both descriptors start
 * `null`, so the prerendered markup is the two empty elements and nothing
 * else — the filter box included, which renders only beside a descriptor.
 * `Settings.init()` runs from ../index.tsx's layout effect and paints them;
 * no data is fetched during render.
 *
 * ── Why the active row's className comes from the module ──────────────
 *
 * `item.className` is computed in ../settings.js. That is the shaping-stays-
 * in-plain-JS rule (the vm harnesses evaluate that file's real source), and
 * it is also how the string survives the conversion character for character
 * instead of being retyped here. The static classes — group wrappers,
 * headings, menu rows — are this file's, because they never vary. So are the
 * filter's matches: ../settings.js hands over each page's lower-cased terms
 * (`_filterTerms`), and the only work here is comparing them with what the
 * viewer typed.
 *
 * ── Whitespace ────────────────────────────────────────────────────────
 *
 * No `{' '}` anywhere: tests/shell-build.test.js rejects adjacent text
 * children outright (React #418 at hydration). Nothing here needs one — every
 * label is a single expression inside its own element.
 */

import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { Input } from '@/components/ui/input';

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { settingsNavStore } from './settings-nav-store.js';

interface FilterPart {
  key: string;
  label: string;
  terms: string;
}

/** What ../settings.js's `_filterTerms` attaches to every row, on both hosts. */
interface Filterable {
  key: string;
  label: string;
  terms: string;
  parts: FilterPart[];
}

interface NavItem extends Filterable {
  active: boolean;
  className: string;
}

interface NavGroup {
  name: string;
  first: boolean;
  items: NavItem[];
}

interface MenuGroup {
  name: string;
  items: Filterable[];
}

interface NavState {
  desktop: NavGroup[] | null;
  mobile: MenuGroup[] | null;
  visit: number;
}

/** One page that matched the filter, and the parts on it that did. */
interface FilterHit {
  item: Filterable;
  parts: FilterPart[];
}

/** `Settings._navClick` — the single handler both hosts route through. */
const navClick = (key: string) => {
  (window as { Settings?: { _navClick(key: string): void } }).Settings?._navClick(key);
};

/**
 * The pages whose label, part labels or keywords contain every word of the
 * query, in menu order. A page that matched on its own label lists no parts
 * (the row already says why it is there); one that matched through its parts
 * names them, so "password" answers "Account · Password" rather than a bare
 * "Account" that leaves the viewer guessing.
 */
function filterPages(groups: { items: Filterable[] }[], query: string): FilterHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: FilterHit[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const parts = item.parts.filter((p) => words.every((w) => p.terms.includes(w)));
      const own = words.every((w) => item.terms.includes(w));
      // Words spread across the page label and one part ("account email")
      // still find the page: each word only has to land somewhere on it.
      const anywhere = words.every((w) => item.terms.includes(w) || item.parts.some((p) => p.terms.includes(w)));
      if (!own && !parts.length && !anywhere) continue;
      // Repeating the label of a page's only part ("Usage" under "Usage")
      // says nothing.
      const named = own ? [] : parts.filter((p) => p.label !== item.label);
      hits.push({ item, parts: named });
    }
  }
  return hits;
}

/**
 * The filter's query, emptied on every new visit to the screen (`visit` is
 * Settings._visit). Kept across page switches within a visit, so a viewer
 * can work down a list of results.
 */
function useFilterQuery(visit: number): [string, (q: string) => void] {
  const [query, setQuery] = useState('');
  useEffect(() => { setQuery(''); }, [visit]);
  return [query, setQuery];
}

/**
 * SIGN OUT IS FOUND TOO (5 Oct 2026). It is the button under the menu, not
 * a page, so no page's terms held it, and a search for "Sign out" said "No
 * settings match". The filter offers it as a hit of its own, after the
 * pages, when every word typed starts one of these words ("sign out", "log
 * out", "logout", "sign off"…), three letters at least between them so a
 * stray letter does not offer it. Choosing it presses that button
 * (#settings-logout, whose handler settings.js binds), the one way out.
 */
export const SIGN_OUT_WORDS = ['sign', 'out', 'signout', 'log', 'logout', 'off', 'logoff', 'signoff'];

export function matchesSignOut(query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length || words.join('').length < 3) return false;
  return words.every((w) => SIGN_OUT_WORDS.some((term) => term.startsWith(w)));
}

/** The Sign out hit: the screen's own button, pressed. */
function signOut(setQuery: (q: string) => void) {
  setQuery('');
  (document.getElementById('settings-logout') as HTMLButtonElement | null)?.click();
}

/** Where choosing a hit goes: the first matching part, else the page. */
const hitTarget = (hit: FilterHit) => (hit.parts[0] ? hit.parts[0].key : hit.item.key);

/**
 * Choosing a hit opens it and empties the box. The filter is a way to a page,
 * not a view of its own: once the page is open, the menu goes back to the
 * grouped list with that page marked current, so the viewer can see where
 * they landed instead of a results list that marks nothing.
 */
function choose(hit: FilterHit, setQuery: (q: string) => void) {
  setQuery('');
  navClick(hitTarget(hit));
}

/**
 * The filter field, identical on both hosts apart from its id (both hosts are
 * in the document at phone width, so the ids must differ). Enter opens the
 * first hit; Escape clears. A `search` input, so the platform's own clear
 * control and the "search" keyboard return key come for free.
 */
function FilterField({ id, query, setQuery, hits, signOutHit }: {
  id: string;
  query: string;
  setQuery: (q: string) => void;
  hits: FilterHit[];
  signOutHit: boolean;
}) {
  const t = useMessages('settings');
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && hits[0]) {
      e.preventDefault();
      choose(hits[0], setQuery);
    } else if (e.key === 'Enter' && signOutHit) {
      // Sign out is the only hit: Enter presses it, as it opens a page.
      e.preventDefault();
      signOut(setQuery);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  };
  return (
    <Input
      id={id}
      type="search"
      data-settings-filter=""
      aria-label={t('settings:nav.filter.field')}
      placeholder={t('settings:nav.filter.field')}
      autoComplete="off"
      spellCheck={false}
      value={query}
      onChange={(e) => setQuery(e.currentTarget.value)}
      onKeyDown={onKeyDown}
    />
  );
}

/** The one line both hosts show when nothing matches. */
function NoMatch({ query, className }: { query: string; className: string }) {
  const t = useMessages('settings');
  return (
    <p data-settings-filter-empty="" role="status" className={className}>
      {t('settings:nav.filter.noMatch', { query: query.trim() })}
    </p>
  );
}

/** Carried over verbatim from the retired _navItemsHtml / _mobileMenuHtml. */
const GROUP_SPACED = 'mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800';
// The widget language labels a group in SENTENCE CASE at reading size, not as
// a small-caps micro-caption — same treatment as SectionHeader in
// @/components/ui/grouped-list.tsx, which is what the deck's grouped lists use.
// The settings screen was already grouped-list shaped, so this is the last
// thing that made it read as the old vocabulary.
const NAV_HEADING = 'px-3 pb-1';
const MENU_ROW = 'settings-menu-row min-h-[44px] py-2 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors';
// The sidebar's filter hits: the row's own class string, unhighlighted, with
// room for the matched parts under the label.
const HIT_ROW = 'settings-nav-item block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800';
const HIT_PARTS = 'block text-xs font-normal text-zinc-500 dark:text-zinc-400';
// The Sign out hit: a hit row in the button's own red, an action and not a page.
const SIGN_OUT_HIT_ROW = 'settings-nav-item block w-full text-left rounded-lg px-3 py-2 text-sm font-medium transition-colors text-red-700 dark:text-red-400 hover:bg-red-500/10';
const SIGN_OUT_TITLE = 'font-normal text-red-700 dark:text-red-400';

/**
 * One sidebar row. Navigation, not a tab set (QA 2026-09-24 Q20): a tab
 * needs a tablist parent, and these rows sit in a <nav> between group
 * headings, which no tablist may hold. They are the section links of that
 * <nav>, so the current one says so with aria-current.
 */
function NavRow({ item }: { item: NavItem }) {
  return (
    <button
      type="button"
      aria-current={item.active ? 'page' : undefined}
      data-settings-nav={item.key}
      className={item.className}
      onClick={() => navClick(item.key)}
    >
      {item.label}
    </button>
  );
}

/**
 * The desktop sidebar. `className` is NOT rendered on the <nav> — it is a
 * constant on the element below because nothing writes classes to this node
 * at runtime, but the host element itself is rendered here rather than in
 * ../index.tsx so the whole subtree has one owner.
 */
export function SettingsNavDesktop() {
  const t = useMessages('settings');
  const { desktop, visit } = useStoreState(settingsNavStore) as NavState;
  const [query, setQuery] = useFilterQuery(visit);
  const groups = desktop || [];
  const hits = filterPages(groups, query);
  const signOutHit = matchesSignOut(query);
  const filtering = query.trim() !== '';
  return (
    <nav id="settings-nav-desktop" aria-label={t('settings:nav.sectionsName')} className="space-y-1">
      {desktop ? (
        <div className="pb-3">
          <FilterField id="settings-filter-desktop" query={query} setQuery={setQuery} hits={hits} signOutHit={signOutHit} />
        </div>
      ) : null}
      {filtering ? (
        <div data-settings-filter-results="">
          {hits.map((hit) => (
            <button
              key={hit.item.key}
              type="button"
              data-settings-nav={hit.item.key}
              className={HIT_ROW}
              onClick={() => choose(hit, setQuery)}
            >
              <span className="block">{hit.item.label}</span>
              {hit.parts.length ? (
                <span className={HIT_PARTS}>{hit.parts.map((p) => p.label).join(' · ')}</span>
              ) : null}
            </button>
          ))}
          {signOutHit ? (
            <button type="button" data-settings-sign-out="" className={SIGN_OUT_HIT_ROW} onClick={() => signOut(setQuery)}>
              {t('settings:nav.filter.signOut')}
            </button>
          ) : null}
          {hits.length || signOutHit ? null : (
            <NoMatch query={query} className="px-3 py-2 text-sm text-zinc-500 dark:text-zinc-400" />
          )}
        </div>
      ) : groups.map((group) => (
        <div key={group.name} className={group.first ? '' : GROUP_SPACED}>
          <SectionHeader className={NAV_HEADING}>{group.name}</SectionHeader>
          {group.items.map((item) => <NavRow key={item.key} item={item} />)}
        </div>
      ))}
    </nav>
  );
}

/**
 * The phone's level-1 menu. Empty on desktop — `md:hidden` on the host is
 * what hides it there, and `mobile: null` is what keeps it empty; both, so
 * that a viewport change without a repaint still cannot show two navs.
 */
export function SettingsMobileMenu() {
  const t = useMessages('settings');
  const { mobile, visit } = useStoreState(settingsNavStore) as NavState;
  const [query, setQuery] = useFilterQuery(visit);
  const groups = mobile || [];
  const hits = filterPages(groups, query);
  const signOutHit = matchesSignOut(query);
  const filtering = query.trim() !== '';
  return (
    <div id="settings-mobile-menu-host" className="md:hidden">
      {mobile ? (
        <div className="px-1 pb-4">
          <FilterField id="settings-filter-mobile" query={query} setQuery={setQuery} hits={hits} signOutHit={signOutHit} />
        </div>
      ) : null}
      {filtering ? (
        <div className="mb-5" data-settings-filter-results="">
          {hits.length || signOutHit ? (
            <GroupedList className="mx-0">
              {hits.map((hit) => (
                <ListRow
                  key={hit.item.key}
                  as="button"
                  inset="text"
                  data-settings-nav={hit.item.key}
                  className={MENU_ROW}
                  titleClassName="font-normal"
                  title={hit.item.label}
                  subtitle={hit.parts.length ? hit.parts.map((p) => p.label).join(' · ') : undefined}
                  onClick={() => choose(hit, setQuery)}
                />
              ))}
              {signOutHit ? (
                <ListRow
                  as="button"
                  inset="text"
                  data-settings-sign-out=""
                  className={MENU_ROW}
                  titleClassName={SIGN_OUT_TITLE}
                  title={t('settings:nav.filter.signOut')}
                  chevron={false}
                  onClick={() => signOut(setQuery)}
                />
              ) : null}
            </GroupedList>
          ) : (
            <NoMatch query={query} className="px-4 text-[15px] text-zinc-500 dark:text-zinc-400" />
          )}
        </div>
      ) : groups.map((group) => (
        <div key={group.name} className="mb-5">
          <SectionHeader className="px-4 pb-1.5">{group.name}</SectionHeader>
          <GroupedList className="mx-0">
            {group.items.map((item) => (
              <ListRow
                key={item.key}
                as="button"
                inset="text"
                data-settings-nav={item.key}
                className={MENU_ROW}
                // ListRow bolds its title for the rows it was built for, where
                // the title is a subject with a subtitle under it. These are
                // one-word menu entries with no second line, so bold made the
                // whole menu read as a stack of headings.
                titleClassName="font-normal"
                title={item.label}
                onClick={() => navClick(item.key)}
              />
            ))}
          </GroupedList>
        </div>
      ))}
    </div>
  );
}
