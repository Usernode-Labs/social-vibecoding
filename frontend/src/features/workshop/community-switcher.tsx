/**
 * "Your communities": the switcher behind the Communities tab.
 *
 * All communities first (the list of every community you are in), then each
 * community with its tile, who it is for and how many are in it, how many
 * votes it is waiting on you for, and a tick on the one you are on; then
 * "Join or start a community", which is Discover. Picking one makes it the
 * tab's community and opens its hub (./community-scope.ts goToCommunity).
 *
 * It replaced the in-place "Which project?" panel under the header
 * (./workshop-chrome.tsx), and it opens from four places, all through the
 * same store: the tab pressed while it is lit, the community's name and ⌄ in
 * the coloured header, the Communities list's header, and the sidebar's
 * Communities row on a wide window.
 *
 * ── Two presentations ──────────────────────────────────────────────────
 *
 * On a phone it is a sheet from the floor, handed to the native kit when one
 * is there (lib/kit-surface.ts, the same hand-off as the staking sheet) and a
 * CSS sheet over a scrim when not. From 768px up it is a menu hung off
 * whatever opened it: beside the sidebar's row, or under the header's name.
 *
 * ── Island rules ───────────────────────────────────────────────────────
 *
 * Rendered only while open, into document.body, from state that only ever
 * changes after the first paint: nothing here is in the prerendered shell.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon, PlusIcon, UserGroupIcon } from '@/components/ui/icons';
import { AppIconContent, appIconKind } from '../apps/app-card-view';
import { adoptKitSurface, type KitAdoption } from '../../lib/kit-surface';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { useCommunityColor } from '../../lib/community-color';
import {
  closeSwitcher, communityScopeStore, goToCommunity, type CommunityInfo,
} from './community-scope';

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
          <span className="community-switcher-tile community-switcher-tile-all" aria-hidden="true">
            <UserGroupIcon className="w-6 h-6" />
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
        ) : rows.map((info) => (
          <Row key={info.slug} info={info} current={st.slug === info.slug} />
        ))}
        <button
          type="button"
          className="community-switcher-row"
          data-switcher-join=""
          onClick={() => { closeSwitcher(); window.location.hash = '#apps'; }}
        >
          <span className="community-switcher-tile community-switcher-tile-add" aria-hidden="true">
            <PlusIcon className="w-5 h-5" />
          </span>
          <span className="community-switcher-text">
            <span className="community-switcher-name">Join or start a community</span>
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
      if (t instanceof Element && t.closest('[data-community-switch], #platform-tab-workshop')) return;
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
  // Beside the sidebar's row, or under the header's name; a menu opened from
  // anywhere else sits under the header's left edge.
  const a = st.anchor;
  const style: Record<string, string> = st.switcher === 'rail' && a
    ? { left: `${Math.round(a.right + 8)}px`, top: `${Math.max(8, Math.round(a.top - 12))}px` }
    : a
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
