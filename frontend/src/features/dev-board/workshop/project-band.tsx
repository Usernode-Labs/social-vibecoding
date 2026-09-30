/**
 * A project's four tabs: Hub · Discussion · Needs you · Workshop.
 *
 * All items is a page under the Workshop (its "See all"), with a way back,
 * so while it is up the Workshop tab stays lit.
 *
 * TWO PLACES, ONE CONTROL. On a phone they are a BAND under the header, in
 * the community's colour, continuing it (./workshop.tsx renders it at the
 * head of the page). On a wide window the header has the room, so they sit
 * in its one row, after the community's name, and the band is not drawn
 * (features/header/header-project-tabs.tsx, app.css).
 *
 * The header is another React root, so the two meet through a store: the
 * page publishes which tab is up and what the tabs count (`projectTabsStore`),
 * and a press in the header asks for a tab (`requestProjectTab`) by the same
 * event a door to the hub already uses (`usernode:workshop-tab`, which the
 * page listens for), after AppView has remembered it as a press here would.
 */

import type { KeyboardEvent, ReactNode } from 'react';

import { createStore } from '../../../lib/plain-store.js';

export type ProjectTabKey = 'status' | 'discussion' | 'workshop' | 'needs' | 'all';

/** The four tabs, in the band's order. All items is the Workshop's page. */
export const PROJECT_TABS: ReadonlyArray<{ key: ProjectTabKey; label: string }> = [
  { key: 'status', label: 'Hub' },
  { key: 'discussion', label: 'Discussion' },
  { key: 'needs', label: 'Needs you' },
  { key: 'workshop', label: 'Workshop' },
];

/** The tab lit for a page: All items is the Workshop's. */
export function litTab(tab: ProjectTabKey): ProjectTabKey {
  return tab === 'all' ? 'workshop' : tab;
}

export interface ProjectTabsState {
  /** The project whose page is up, or null when none is. */
  slug: string | null;
  tab: ProjectTabKey;
  /** Votes waiting on you here: Needs you's count. */
  owed: number;
  /** All items' search or filters are on (#2915): a dot on the Workshop tab. */
  filtered: boolean;
}

const INITIAL: ProjectTabsState = { slug: null, tab: 'status', owed: 0, filtered: false };

export const projectTabsStore = createStore(INITIAL);

/** A tab pressed somewhere other than the page itself (the header). */
export function requestProjectTab(slug: string, tab: ProjectTabKey): void {
  try { (window as any).AppView?._setWorkshopTab?.(tab); } catch { /* the page still turns */ }
  try {
    window.dispatchEvent(new CustomEvent('usernode:workshop-tab', { detail: { slug, tab } }));
  } catch { /* no window */ }
}

/**
 * The tabs. A tablist with roving focus: the arrows move between tabs, and
 * the selected one is the one Tab reaches. Needs you carries how many votes
 * wait on you; the Workshop a dot while All items' search or filters are on
 * (#2915), which narrow that page alone.
 *
 * In the page (`inHeader` false) it keeps the old strip's box, `.dev-ws-tabs`
 * around a `.dev-ws-tabtrack`. Its colour is the root's `--community-tint`,
 * which the header sets (features/header/community-tint.ts).
 */
export function ProjectBand({ tab, owed, filtered, onTab, barRef, inHeader = false }: {
  tab: ProjectTabKey;
  owed: number;
  filtered: boolean;
  onTab: (key: ProjectTabKey) => void;
  barRef?: (el: HTMLElement | null) => void;
  inHeader?: boolean;
}): ReactNode {
  const lit = litTab(tab);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const at = PROJECT_TABS.findIndex((t) => t.key === lit);
    const next = PROJECT_TABS[(Math.max(0, at) + step + PROJECT_TABS.length) % PROJECT_TABS.length];
    e.preventDefault();
    onTab(next.key);
    (e.currentTarget.querySelector(`[data-ws-tab-btn="${next.key}"]`) as HTMLElement | null)?.focus();
  };
  const list = (
    <div className="dev-ws-tabtrack" role="tablist" aria-label="Project" onKeyDown={onKeyDown}>
      {PROJECT_TABS.map((t) => {
        const on = lit === t.key;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            className="dev-ws-ctab"
            data-ws-tab-btn={t.key}
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onTab(t.key)}
          >
            <span className="dev-ws-ctab-label">{t.label}</span>
            {t.key === 'needs' && owed > 0 ? (
              <span className="dev-ws-ctab-count" data-ws-tab-count="">{owed > 99 ? '99+' : owed}</span>
            ) : null}
            {t.key === 'workshop' && filtered ? (
              <>
                <span className="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true" />
                <span className="sr-only"> (filtered)</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
  if (inHeader) {
    return (
      <div className="header-project-tabs">
        {list}
      </div>
    );
  }
  return (
    <div
      ref={barRef}
      className="dev-ws-tabs dev-ws-band"
      data-ws-band=""
    >
      {list}
    </div>
  );
}
