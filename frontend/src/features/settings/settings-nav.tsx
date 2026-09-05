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
import { ChevronDownIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { settingsNavStore } from './settings-nav-store.js';

interface NavItem {
  key: string;
  label: string;
  active: boolean;
  className: string;
}

/**
 * The three disclosure fields ../settings.js attaches to BOTH descriptors
 * (`_groupDisclosure`). `collapsible` is false for every group but Advanced,
 * and a non-collapsible group renders exactly the markup it did before #1554
 * — a plain heading, no button, no wrapper element.
 */
interface Disclosure {
  collapsible: boolean;
  expanded: boolean;
  domId: string | null;
}

interface NavGroup extends Disclosure {
  name: string;
  first: boolean;
  items: NavItem[];
}

interface MenuGroup extends Disclosure {
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

/**
 * `Settings._toggleGroup` — the disclosure handler both hosts route through.
 * A press mutates the persisted set and repaints the nav; it never changes
 * the section, the hash or the content pane.
 */
const toggleGroup = (name: string) => {
  (window as { Settings?: { _toggleGroup?(name: string): void } }).Settings?._toggleGroup?.(name);
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

// The collapsible heading is a real <button>, so Tab plus Enter/Space come
// for free and no keydown handler is needed, with the aria-expanded /
// aria-controls pair and the platform's chevron idiom (down when open, right
// when closed) — the admin console's _groupToggleHtml, as JSX.
const TOGGLE_BASE = 'flex w-full items-center gap-1.5 text-left';
const CHEVRON = 'w-3 h-3 shrink-0 transition-transform';
const CHEVRON_CLOSED = 'w-3 h-3 shrink-0 transition-transform -rotate-90';

/**
 * The heading of one group, on either surface. `collapsible` groups get the
 * button; everything else keeps the bare SectionHeader it always had, so the
 * only heading whose shape changes is Advanced's.
 */
function GroupHeading({ group, className }: { group: Disclosure & { name: string }; className: string }) {
  if (!group.collapsible) {
    return <SectionHeader className={className}>{group.name}</SectionHeader>;
  }
  // No em dash and no punctuation: this string is read out by screen readers
  // and shown as the hover title.
  const label = `${group.expanded ? 'Collapse' : 'Expand'} ${group.name}`;
  return (
    <SectionHeader className={className}>
      <button
        type="button"
        data-settings-group-toggle={group.name}
        aria-expanded={group.expanded ? 'true' : 'false'}
        aria-controls={group.domId || undefined}
        title={label}
        aria-label={label}
        className={TOGGLE_BASE}
        onClick={() => toggleGroup(group.name)}
      >
        <ChevronDownIcon className={group.expanded ? CHEVRON : CHEVRON_CLOSED} />
        <span className="flex-1 min-w-0 truncate">{group.name}</span>
      </button>
    </SectionHeader>
  );
}

/**
 * One sidebar row. Extracted so both branches of the group body below render
 * the SAME element — a collapsible group wraps its rows for aria-controls,
 * every other group keeps them as direct children, and neither is allowed to
 * grow its own copy of the row.
 */
function NavRow({ item }: { item: NavItem }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={item.active ? 'true' : 'false'}
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
  const { desktop } = useStoreState(settingsNavStore) as NavState;
  return (
    <nav id="settings-nav-desktop" aria-label="Settings sections" className="space-y-1">
      {(desktop || []).map((group) => (
        <div key={group.name} className={group.first ? '' : GROUP_SPACED}>
          <GroupHeading group={group} className={NAV_HEADING} />
          {/*
              The rows of a COLLAPSIBLE group get their own element, so
              aria-controls has something to point at and `hidden` takes them
              out of tab order rather than just out of sight. Every other
              group keeps the rows as direct children of this div, exactly as
              before #1554 — the wrapper carries no classes of its own, so it
              adds no spacing either way (`space-y-1` is the host <nav>'s and
              applies to the group divs, never to the rows).
          */}
          {group.collapsible ? (
            <div id={group.domId || undefined} className={group.expanded ? undefined : 'hidden'}>
              {group.items.map((item) => <NavRow key={item.key} item={item} />)}
            </div>
          ) : group.items.map((item) => <NavRow key={item.key} item={item} />)}
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
          <GroupHeading group={group} className="px-4 pb-1.5" />
          <GroupedList
            id={group.domId || undefined}
            className={group.collapsible && !group.expanded ? 'mx-0 hidden' : 'mx-0'}
          >
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
