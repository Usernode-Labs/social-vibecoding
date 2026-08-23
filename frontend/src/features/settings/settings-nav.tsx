/**
 * The Settings screen's two navigation hosts, as React (#1191 slice 6,
 * conversion 8).
 *
 * ── What this renders ─────────────────────────────────────────────────
 *
 * `#settings-nav-desktop` — the grouped sidebar, a real tab set
 * (`role="tab"` + `aria-selected`, which dapp.json line 1660 selects on).
 * `#settings-mobile-menu-host` — the phone's level-1 menu, a LIST of drawer
 * rows: no `role="tab"`, no `aria-selected`, a 44px minimum target and a
 * chevron, exactly as the admin console's level-1 menu.
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
 * else. `Settings.init()` runs from ../index.tsx's layout effect and paints
 * them; no data is fetched during render.
 *
 * ── Why the active row's className comes from the module ──────────────
 *
 * `item.className` is computed in ../settings.js. That is the shaping-stays-
 * in-plain-JS rule (the vm harnesses evaluate that file's real source), and
 * it is also how the string survives the conversion character for character
 * instead of being retyped here. The static classes — group wrappers,
 * headings, menu rows — are this file's, because they never vary.
 *
 * ── Whitespace ────────────────────────────────────────────────────────
 *
 * No `{' '}` anywhere: tests/shell-build.test.js rejects adjacent text
 * children outright (React #418 at hydration). Nothing here needs one — every
 * label is a single expression inside its own element.
 */

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';

import { useStoreState } from '../../lib/use-store-state';
import { settingsNavStore } from './settings-nav-store.js';

interface NavItem {
  key: string;
  label: string;
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
  items: { key: string; label: string }[];
}

interface NavState {
  desktop: NavGroup[] | null;
  mobile: MenuGroup[] | null;
}

/** `Settings._navClick` — the single handler both hosts route through. */
const navClick = (key: string) => {
  (window as { Settings?: { _navClick(key: string): void } }).Settings?._navClick(key);
};

/** Carried over verbatim from the retired _navItemsHtml / _mobileMenuHtml. */
const GROUP_SPACED = 'mt-4 pt-3 border-t border-zinc-200 dark:border-zinc-800';
// The widget language labels a group in SENTENCE CASE at reading size, not as
// a small-caps micro-caption — same treatment as SectionHeader in
// @/components/ui/grouped-list.tsx, which is what the deck's grouped lists use.
// The settings screen was already grouped-list shaped, so this is the last
// thing that made it read as the old vocabulary.
const NAV_HEADING = 'px-3 pb-1';
const MENU_ROW = 'settings-menu-row min-h-[44px] py-2 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors';

/**
 * The desktop sidebar. `className` is NOT rendered on the <nav> — it is a
 * constant on the element below because nothing writes classes to this node
 * at runtime, but the host element itself is rendered here rather than in
 * ../index.tsx so the whole subtree has one owner.
 */
export function SettingsNavDesktop() {
  const { desktop } = useStoreState(settingsNavStore) as NavState;
  return (
    <nav id="settings-nav-desktop" aria-label="Settings sections" className="space-y-1">
      {(desktop || []).map((group) => (
        <div key={group.name} className={group.first ? '' : GROUP_SPACED}>
          <SectionHeader className={NAV_HEADING}>{group.name}</SectionHeader>
          {group.items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={item.active ? 'true' : 'false'}
              data-settings-nav={item.key}
              className={item.className}
              onClick={() => navClick(item.key)}
            >
              {item.label}
            </button>
          ))}
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
  const { mobile } = useStoreState(settingsNavStore) as NavState;
  return (
    <div id="settings-mobile-menu-host" className="md:hidden">
      {(mobile || []).map((group) => (
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
