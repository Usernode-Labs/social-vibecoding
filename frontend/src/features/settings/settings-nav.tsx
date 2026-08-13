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

import { ChevronRightIcon } from '@/components/ui/icons';

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
const NAV_HEADING = 'px-3 pb-1 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500';
const MENU_HEADING = 'px-4 pb-1.5 text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500';
const MENU_CARD = 'rounded-lg overflow-hidden border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 [&>button:last-child]:border-b-0';
const MENU_ROW = 'settings-menu-row flex items-center gap-3 w-full text-left min-h-[44px] px-4 py-2 border-b border-zinc-100 dark:border-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors';
const MENU_LABEL = 'flex-1 min-w-0 text-sm font-medium truncate';
const CHEVRON = 'w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500';

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
          <div className={NAV_HEADING}>{group.name}</div>
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
          <div className={MENU_HEADING}>{group.name}</div>
          <div className={MENU_CARD}>
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                data-settings-nav={item.key}
                className={MENU_ROW}
                onClick={() => navClick(item.key)}
              >
                <span className={MENU_LABEL}>{item.label}</span>
                <ChevronRightIcon className={CHEVRON} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
