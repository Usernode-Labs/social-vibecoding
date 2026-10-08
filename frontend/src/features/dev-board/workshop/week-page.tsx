/**
 * Week by week, as rows (#4457), and a week's own page.
 *
 * The weekly digest was a walk that unfolded inside the Since list, and each
 * week's rows unfolded again inside the week — the double accordion #3947
 * named. Now each week is ONE row on the Workshop tab (its dates, its
 * summary line, how many went live, how much of it is new to you, ›), and
 * tapping it opens the week as its own page at its own address
 * (`/app/<slug>/dev/week/<Monday's date>`), with "‹ Workshop" to go back.
 * Nothing unfolds inside anything.
 *
 * The week's page groups the items the Workshop already holds for that week:
 * the latest 30 new and 30 seen rows, as the list always had. A week whose
 * rows have left the list says so.
 */

import type { ReactNode } from 'react';

import { SectionHeader } from '@/components/ui/grouped-list';

import { WorkRow } from './work-row';
import { openHref, type CardRow } from '../card/fold';

/** The Monday a week starts on, as the page's address spells it: "2026-10-05". */
export function weekStartIso(startMs: number): string {
  const d = new Date(startMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** The Monday back, from the address. Null when the text is not a date. */
export function parseWeekStart(iso: string | null | undefined): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // A date that does not exist (2026-02-31) rolls over; refuse it, so the
  // address names a week only when the week is real.
  const d = new Date(ms);
  if (d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null;
  return ms;
}

/** One group of a week's page: its caption and the rows under it. */
export interface WeekGroup {
  key: string;
  label: string;
  rows: CardRow[];
}

/**
 * The week's items in groups, in the page's order: what is new to you first,
 * then what is waiting on votes, what went live, the requests filed, what is
 * being worked on, and anything else. Empty groups are not drawn.
 */
export function weekGroups(week: { fresh: CardRow[]; seen: CardRow[] }): WeekGroup[] {
  const groups: WeekGroup[] = [
    { key: 'fresh', label: 'New since your last visit', rows: [] },
    { key: 'votes', label: 'Waiting for votes', rows: [] },
    { key: 'live', label: 'Went live', rows: [] },
    { key: 'requests', label: 'New requests', rows: [] },
    { key: 'underway', label: 'Being worked on', rows: [] },
    { key: 'also', label: 'Also this week', rows: [] },
  ];
  const by = (k: string) => groups.find((g) => g.key === k)!.rows;
  for (const row of week.fresh || []) if (row && row.t === 'card') by('fresh').push(row);
  for (const row of week.seen || []) {
    if (!row || row.t !== 'card') continue;
    const lane = row.lane || '';
    const kind = row.kind || '';
    if (lane === 'review') by('votes').push(row);
    else if (kind === 'merged') by('live').push(row);
    else if (kind === 'issue' && lane === 'open') by('requests').push(row);
    else if (lane === 'underway') by('underway').push(row);
    else by('also').push(row);
  }
  return groups.filter((g) => g.rows.length);
}

/**
 * One week on the Workshop tab's list: its dates, its line, how many went
 * live, and — when some of the week is new to the reader — "3 new" in the
 * accent. A button, because the whole row opens the week.
 */
export function WeekRow({ week, slug, onOpen }: {
  week: { key: string; title: string; line: string; counts: { closed: number; partial: boolean } | null; fresh: CardRow[] };
  slug: string;
  onOpen: () => void;
}): ReactNode {
  const closed = week.counts ? week.counts.closed : null;
  const fresh = (week.fresh || []).length;
  return (
    <button
      type="button"
      className="dev-ws-week-row"
      data-ws-week-row={weekStartIso(week.startMs ?? 0)}
      onClick={onOpen}
    >
      <span className="dev-ws-work-body">
        <span className="dev-ws-work-title">{week.title}</span>
        {week.line ? <span className="dev-ws-week-line">{week.line}</span> : null}
        {closed != null || fresh ? (
          <span className="dev-ws-week-counts">
            {closed != null
              ? `${week.counts && week.counts.partial ? '+' : ''}${closed} went live`
              : null}
            {closed != null && fresh ? ' · ' : null}
            {fresh ? <span className="dev-ws-week-new">{`${fresh} new`}</span> : null}
          </span>
        ) : null}
      </span>
      <span className="dev-ws-work-chev" aria-hidden="true">›</span>
    </button>
  );
}

/**
 * A week's own page: the way back to the Workshop, the week's summary line,
 * then its items in groups. The rows are the work list's rows, opening the
 * same pages the list's do.
 */
export function WeekPage({ week, slug, canPost, currentHref, onOpenRow }: {
  week: {
    title: string; line: string; counts: { closed: number; partial: boolean } | null;
    fresh: CardRow[]; seen: CardRow[];
  } | null;
  slug: string;
  canPost?: boolean;
  /** The row whose item is open in the panel beside the list, if one is. */
  currentHref?: string | null;
  onOpenRow?: (href: string) => void;
}): ReactNode {
  const groups = week ? weekGroups(week) : [];
  return (
    <div className="dev-ws-strip" data-ws-week-page="">
      <div className="dev-ws-pagehead" data-ws-pagehead="">
        <button
          type="button"
          className="dev-ws-page-back un-touch-target"
          data-ws-page-back=""
          aria-label="Back to Workshop"
          title="Back to Workshop"
          onClick={() => {
            const av = (window as unknown as { AppView?: { backToWorkshop?: (s: string) => void } }).AppView;
            if (av?.backToWorkshop) av.backToWorkshop(slug);
            else if (typeof window !== 'undefined') window.location.hash = `#app/${slug}/workshop?ws=workshop`;
          }}
        >
          ‹ Workshop
        </button>
        <div className="dev-ws-pagehead-text">
          <span className="dev-ws-pagehead-over">Workshop</span>
          <h2 className="dev-ws-pagehead-title">{week ? week.title : 'This week'}</h2>
        </div>
      </div>
      {week && week.line ? <p className="dev-ws-week-line" data-ws-week-line="">{week.line}</p> : null}
      {!week || !groups.length ? (
        <p className="dev-ws-week-note" data-ws-week-empty="">
          No items from this week are on the list any more.
        </p>
      ) : null}
      {groups.map((g) => (
        <div key={g.key} className="dev-ws-week-group" data-ws-week-group={g.key}>
          <SectionHeader>{g.label}</SectionHeader>
          <div className="dev-ws-work-list">
            {g.rows.map((row) => (
              <WorkRow
                key={row.key}
                row={row}
                slug={slug}
                current={!!currentHref && row.t === 'card' && openHref(slug, row.card) === currentHref}
                onOpen={onOpenRow}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
