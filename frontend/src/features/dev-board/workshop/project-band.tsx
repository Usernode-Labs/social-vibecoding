/**
 * A project's four tabs: Hub · Discussion · Needs you · Workshop.
 *
 * All items is a page under the Workshop (its "See all"), with a way back,
 * so while it is up the Workshop tab stays lit. The plan (#4074, the First
 * version card's "See the plan") is a page under the Hub the same way.
 *
 * ONE PLACE, THE PAGE. ./workshop.tsx renders them at the head of the page at
 * every width. On a phone they are a BAND under the header, in the
 * community's colour, continuing it, four equal cells with each label
 * centred in its own. On a wide window they are the first row of the page's
 * panel, under the coloured header rather than in it (#852 review: they sat
 * in the header's row for a round).
 */

import type { KeyboardEvent, ReactNode } from 'react';

import { useMessages } from '../../../lib/i18n/react';

export type ProjectTabKey = 'status' | 'discussion' | 'workshop' | 'needs' | 'all' | 'plan';

/** The four tabs, in the band's order. All items is the Workshop's page.
 *  `label` is a message id (frontend/locales/en/project.json), read when the
 *  band renders. */
export const PROJECT_TABS: ReadonlyArray<{ key: ProjectTabKey; label: string }> = [
  { key: 'status', label: 'project:band.tab.hub' },
  { key: 'discussion', label: 'project:band.tab.discussion' },
  { key: 'needs', label: 'project:band.tab.needsYou' },
  { key: 'workshop', label: 'project:band.tab.workshop' },
];

/** The tab lit for a page: All items is the Workshop's, the plan the Hub's. */
export function litTab(tab: ProjectTabKey): ProjectTabKey {
  if (tab === 'all') return 'workshop';
  if (tab === 'plan') return 'status';
  return tab;
}

/**
 * The tabs. A tablist with roving focus: the arrows move between tabs, and
 * the selected one is the one Tab reaches. Needs you carries how many votes
 * wait on you; the Workshop a dot while All items' search or filters are on
 * (#2915), which narrow that page alone.
 *
 * The label and its count or dot are one `.dev-ws-ctab-text`, so a cell
 * centres the WORD and the count hangs off its corner (app.css) rather than
 * pushing it aside: "Needs you" and its "86" are wider together than a
 * phone's quarter. It keeps the old strip's box, `.dev-ws-tabs` around a
 * `.dev-ws-tabtrack`, for the hooks that measure it. Its colour is the root's
 * `--community-tint`, which the header sets (features/header/community-tint.ts).
 */
export function ProjectBand({ tab, owed, filtered, onTab, barRef }: {
  tab: ProjectTabKey;
  owed: number;
  filtered: boolean;
  onTab: (key: ProjectTabKey) => void;
  barRef?: (el: HTMLElement | null) => void;
}): ReactNode {
  const translate = useMessages('project');
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
  return (
    <div
      ref={barRef}
      className="dev-ws-tabs dev-ws-band"
      data-ws-band=""
    >
      <div className="dev-ws-tabtrack" role="tablist" aria-label={translate('project:band.label')} onKeyDown={onKeyDown}>
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
              <span className="dev-ws-ctab-text">
                <span className="dev-ws-ctab-label">{translate(t.label)}</span>
                {t.key === 'needs' && owed > 0 ? (
                  <span className="dev-ws-ctab-count" data-ws-tab-count="">{owed > 99 ? '99+' : owed}</span>
                ) : null}
                {t.key === 'workshop' && filtered ? (
                  <span className="dev-ws-filter-dot" data-ws-filtered="" aria-hidden="true" />
                ) : null}
              </span>
              {t.key === 'workshop' && filtered ? <span className="sr-only">{` ${translate('project:band.filtered')}`}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
