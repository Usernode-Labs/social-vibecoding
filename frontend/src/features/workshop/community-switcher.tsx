/**
 * "Your communities": the switcher behind the Communities tab.
 *
 * All communities first (the list of every community you are in), then each
 * community with its tile, who it is for and how many are in it, how many
 * votes it is waiting on you for, and a tick on the one you are on; then
 * "Join or start a community", which is Discover. Picking one makes it the
 * tab's community and opens its hub (./community-scope.ts goToCommunity).
 *
 * The communities are drawn as the Communities screen draws them (#3519):
 * Public communities, Private communities, Just you, newest first inside
 * each, three out and then "Show N more", five a press, then "Show fewer"
 * (./sections.ts, shared with the screen, so the switcher and the page can
 * never disagree about the order of your communities). The one you are on is
 * never folded away.
 *
 * It replaced the in-place "Which project?" panel under the header, and it
 * opens from three places, all through the same store: the community's name
 * and ⌄ in the coloured header, the header's "Communities ⌄" on the
 * Communities list, and the phone's tab HELD (#3701). The tab PRESSED while
 * it is lit no longer opens it, at any width: it goes up a level, to the
 * community, its top, then All communities (./tab-ladder.ts).
 *
 * ── Two presentations ──────────────────────────────────────────────────
 *
 * On a phone it is a sheet from the floor, handed to the native kit when one
 * is there (lib/kit-surface.ts, the same hand-off as the staking sheet) and a
 * CSS sheet over a scrim when not. From 768px up it is a menu hung off
 * whatever opened it: under the header's name.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * Rendered only while open, into document.body, from state that only ever
 * changes after the first paint: nothing here is in the prerendered shell.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon, PlusIcon, SearchIcon, UserGroupIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useCommunityColor } from '../../lib/community-color';
import {
  closeSwitcher, communityScopeStore, goToCommunity, type CommunityInfo,
} from './community-scope';
import { SECTIONS, sectionFloor, sectionFoldFrom, type Audience } from './sections';

const WIDE = '(min-width: 768px)';

function useWide(): boolean {
  const [wide, setWide] = useState(() => {
    try { return window.matchMedia(WIDE).matches; } catch { return false; }
  });
  useEffect(() => {
    let mq: MediaQueryList | null = null;
    try { mq = window.matchMedia(WIDE); } catch { return undefined; }
    const on = () => setWide(!!mq?.matches);
    mq.addEventListener?.('change', on);
    return () => mq?.removeEventListener?.('change', on);
  }, []);
  return wide;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Public · 23 members", "Private · 11 members", "Just you". */
export function switcherSub(info: Pick<CommunityInfo, 'audience' | 'memberCount'>): string {
  if (info.audience === 'solo') return 'Just you';
  const who = info.audience === 'invited' ? 'Private' : 'Public';
  return `${who} · ${plural(Number(info.memberCount) || 0, 'member', 'members')}`;
}

function Waiting({ n }: { n: number }) {
  if (!n) return null;
  return <span className="community-switcher-waiting" data-switcher-waiting="">{`${n} to vote`}</span>;
}

function Row({ info, current }: { info: CommunityInfo; current: boolean }) {
  const color = useCommunityColor({ color: info.iconColor, iconUrl: info.iconUrl, iconEmoji: info.iconEmoji, key: info.slug });
  const app = { slug: info.slug, name: info.name, icon_url: info.iconUrl, icon_emoji: info.iconEmoji };
  return (
    <button
      type="button"
      className="community-switcher-row"
      data-switcher-community={info.slug}
      aria-current={current ? 'true' : undefined}
      style={current ? { background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
      onClick={() => goToCommunity(info.slug)}
    >
      <span className="app-icon-tile community-switcher-tile" data-icon={appIconKind(app as never)} aria-hidden="true">
        <AppIconContent app={app as never} />
      </span>
      <span className="community-switcher-text">
        <span className="community-switcher-name">{info.name}</span>
        <span className="community-switcher-sub">{switcherSub(info)}</span>
      </span>
      <Waiting n={Number(info.needs) || 0} />
      <span className="community-switcher-tick" style={{ color, visibility: current ? 'visible' : 'hidden' }} aria-hidden="true">
        <CheckIcon className="w-5 h-5" strokeWidth="2.5" />
      </span>
    </button>
  );
}

/**
 * One audience's part of the list (#3519): its label and count, its most
 * recent rows, and the row that shows more of them.
 *
 * THE LABEL IS NOT A STOP. The arrows rove `.community-switcher-row` only
 * (roveRows), so they go from the last row of one section to the first row
 * of the next. The fold row IS a row, so the keyboard reaches it; pressing it
 * moves focus to the first row it revealed, and "Show fewer" keeps focus on
 * itself.
 */
function SwitcherSection({ audience, label, rows, current }: {
  audience: Audience;
  label: string;
  rows: CommunityInfo[];
  current: string | null;
}) {
  const floor = sectionFloor(rows, current);
  const [limit, setLimit] = useState(floor);
  const fold = sectionFoldFrom(rows.length, limit, floor);
  const shown = rows.slice(0, fold.shown);
  const groupRef = useRef<HTMLDivElement>(null);
  // The index of the first row a press revealed, focused once it renders.
  const revealFrom = useRef<number | null>(null);
  useEffect(() => {
    const from = revealFrom.current;
    revealFrom.current = null;
    if (from === null) return;
    groupRef.current?.querySelectorAll<HTMLElement>('[data-switcher-community]')[from]?.focus({ preventScroll: true });
  }, [fold.shown]);
  const labelId = `community-switcher-section-${audience}`;
  return (
    <div ref={groupRef} role="group" aria-labelledby={labelId} data-switcher-section={audience}>
      <h3 className="community-switcher-section" id={labelId}>
        <span>{label}</span>
        <span className="community-switcher-section-n" aria-label={`${rows.length} in ${label}`}>{rows.length}</span>
      </h3>
      {shown.map((info) => (
        <Row key={info.slug} info={info} current={current === info.slug} />
      ))}
      {fold.label ? (
        <button
          type="button"
          className="community-switcher-row community-switcher-more"
          data-switcher-more={audience}
          aria-expanded={fold.shown === rows.length}
          onClick={() => {
            if (fold.next > fold.shown) revealFrom.current = fold.shown;
            setLimit(fold.next);
          }}
        >
          {fold.label}
        </button>
      ) : null}
    </div>
  );
}

/** Arrow keys between the rows; Home and End to either end. */
function roveRows(e: React.KeyboardEvent<HTMLDivElement>): void {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const rows = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('.community-switcher-row'));
  if (!rows.length) return;
  e.preventDefault();
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'Home' ? 0
    : e.key === 'End' ? rows.length - 1
      : (at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
  rows[next]?.focus();
}

/** The switcher's contents, in either presentation. Exported for tests. */
export function SwitcherBody(): ReactNode {
  const st = useStoreState(communityScopeStore);
  const all = !st.slug;
  const rows = (st.list || []).map((slug) => st.info[slug]).filter(Boolean) as CommunityInfo[];
  // The list is already newest first (community-scope.ts reads orderRows);
  // each section keeps that order. An audience the client does not know is
  // read as public, the server's own default, so no row falls out.
  const known = (a: unknown): Audience => (a === 'invited' || a === 'solo' ? a : 'open');
  const sections = SECTIONS
    .map((section) => ({ ...section, rows: rows.filter((info) => known(info.audience) === section.key) }))
    .filter((section) => section.rows.length > 0);
  return (
    <>
      <div className="community-switcher-head">
        <h2 className="community-switcher-title" id="community-switcher-title">Your communities</h2>
      </div>
      {/* Up and Down move between the rows, as in the Homeroom menu. */}
      <div className="community-switcher-list" onKeyDown={roveRows}>
        <button
          type="button"
          className="community-switcher-row"
          data-switcher-community="all"
          aria-current={all ? 'true' : undefined}
          style={all ? { background: 'rgba(0,0,0,0.06)' } : undefined}
          onClick={() => goToCommunity(null)}
        >
          {/* THE TAB'S OWN FACE for All communities (#3663): the people
              glyph in a square ring, not a dark tile, which in a list
              holding Homeroom's own read as a second Homeroom. app.css sizes
              the glyph to the tile, as it does the tab's. */}
          <span className="community-switcher-tile community-switcher-tile-all" aria-hidden="true">
            <UserGroupIcon />
          </span>
          <span className="community-switcher-text">
            <span className="community-switcher-name">All communities</span>
            <span className="community-switcher-sub">
              {st.list ? plural(st.list.length, 'community', 'communities') : 'Every community you are in'}
            </span>
          </span>
          <Waiting n={Number(st.totalNeeds) || 0} />
          <span className="community-switcher-tick" style={{ visibility: all ? 'visible' : 'hidden' }} aria-hidden="true">
            <CheckIcon className="w-5 h-5" strokeWidth="2.5" />
          </span>
        </button>
        {st.list == null ? (
          <p className="community-switcher-note" data-switcher-loading="">Loading your communities…</p>
        ) : sections.map((section) => (
          <SwitcherSection
            key={section.key}
            audience={section.key}
            label={section.label}
            rows={section.rows}
            current={st.slug}
          />
        ))}
        {/* #3543: two ways out, not one. "Join or start a community" went
            to Discover, where there is nothing to start; Start opens the
            new-project dialog, which asks who it is for first. */}
        <button
          type="button"
          className="community-switcher-row"
          data-switcher-join=""
          onClick={() => { closeSwitcher(); window.location.hash = '#apps'; }}
        >
          <span className="community-switcher-tile community-switcher-tile-add" aria-hidden="true">
            <SearchIcon className="w-5 h-5" />
          </span>
          <span className="community-switcher-text">
            <span className="community-switcher-name">Join a community</span>
          </span>
        </button>
        <button
          type="button"
          className="community-switcher-row"
          data-switcher-start=""
          onClick={() => { closeSwitcher(); (window as any).App?.showCreateModal?.(); }}
        >
          <span className="community-switcher-tile community-switcher-tile-add" aria-hidden="true">
            <PlusIcon className="w-5 h-5" />
          </span>
          <span className="community-switcher-text">
            <span className="community-switcher-name">Start a community</span>
          </span>
        </button>
      </div>
    </>
  );
}

function SwitcherSheet(): ReactNode {
  const panel = useRef<HTMLDivElement | null>(null);
  const [adopted, setAdopted] = useState(false);
  useIsomorphicLayoutEffect(() => {
    if (!panel.current) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    let adoption: KitAdoption | null = adoptKitSurface({
      kind: 'sheet',
      contentEl: panel.current,
      home: 'placeholder',
      gate: 'kit',
      onDismiss: () => { adoption = null; closeSwitcher(); },
    });
    setAdopted(!!adoption);
    panel.current.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    return () => {
      if (adoption) adoption.release();
      previousFocus?.focus?.();
    };
  }, []);
  return (
    <div
      className={adopted ? 'contents' : 'community-switcher-scrim'}
      onClick={(e) => { if (e.target === e.currentTarget) closeSwitcher(); }}
    >
      <div
        ref={panel}
        id="community-switcher"
        className="community-switcher community-switcher-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="community-switcher-title"
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSwitcher(); } }}
      >
        {adopted ? null : <span className="community-switcher-grab" aria-hidden="true" />}
        <SwitcherBody />
      </div>
    </div>
  );
}

function SwitcherMenu(): ReactNode {
  const st = useStoreState(communityScopeStore);
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    const onDown = (e: Event) => {
      const t = e.target as Node | null;
      if (t && panel.current?.contains(t)) return;
      // The opener toggles on its own; a press on it must not close and reopen.
      // (Not the rail's Communities row: it opens nothing since #3701, so a
      // press on it closes the menu like a press anywhere else.)
      if (t instanceof Element && t.closest('[data-community-switch]')) return;
      closeSwitcher();
    };
    // Escape gives focus back to whatever opened it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      closeSwitcher();
      previousFocus?.focus?.();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  // Under what opened it (the header's name, or its "Communities ⌄"); with no box
  // to hang from, under the header's left edge.
  const a = st.anchor;
  const style: Record<string, string> = a
    ? { left: `${Math.max(8, Math.round(a.left))}px`, top: `${Math.round(a.bottom + 8)}px` }
    : { left: '240px', top: '64px' };
  return (
    <div
      ref={panel}
      id="community-switcher"
      className="community-switcher community-switcher-menu"
      role="dialog"
      aria-labelledby="community-switcher-title"
      style={style}
    >
      <SwitcherBody />
    </div>
  );
}

/** The switcher, while it is open: a sheet on a phone, a menu on a wide window. */
export function CommunitySwitcher(): ReactNode {
  const st = useStoreState(communityScopeStore);
  const wide = useWide();
  // A route change closes it: the page it was about has gone.
  useEffect(() => {
    if (!st.switcher) return undefined;
    const close = () => closeSwitcher();
    window.addEventListener('hashchange', close);
    window.addEventListener('popstate', close);
    return () => {
      window.removeEventListener('hashchange', close);
      window.removeEventListener('popstate', close);
    };
  }, [st.switcher]);
  if (!st.switcher || typeof document === 'undefined') return null;
  return createPortal(wide ? <SwitcherMenu /> : <SwitcherSheet />, document.body);
}
