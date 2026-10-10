/**
 * Week by week, on the Workshop tab (#4457, and #3947 before it).
 *
 * The weeks used to unfold inside Since your last visit, and each week's
 * rows unfolded again inside the week ("Seen before", "Show 5 more · 25
 * left", "Show an earlier week"): two levels of the same gesture, nested,
 * and a quiet visit read "Nothing has changed since you were last here."
 * over thirty rows of history. The information hierarchy was right; the
 * nesting was not.
 *
 * Now each week is ONE ROW: its name and dates, its summary line, how many
 * changes went live, and "3 new" when some of it is new to you. Tapping it
 * opens the week as its own page inside the tab, with "‹ Workshop" to go
 * back, and the page groups the week: New since your last visit (when
 * any), Waiting for votes, Went live, New requests, Being worked on.
 * "Show earlier weeks" adds rows to the same list. Nothing unfolds inside
 * anything; a long group shows its first few rows and "Show all N" puts
 * the rest under them.
 */

import { useState, type MouseEvent, type ReactNode } from 'react';

import { ChevronDownIcon, ChevronRightIcon } from '@/components/ui/icons';

import { RichMessage, useMessages } from '../../../lib/i18n/react';
import { t as translate } from '../../../lib/i18n/runtime';
import { PageBack } from './page-back';
import { WorkList, type CardRow, type TopicRef } from './work-row';
import type { SinceWeek } from './workshop';

/**
 * "Aug 25", with the year where it is not this one: #3293 walks back to the
 * project's start, which for a project over a year old passes a second Aug
 * 25, and a range is an absolute fact only while it names one week.
 */
export function weekDate(ms: number): string {
  const d = new Date(ms);
  const other = d.getUTCFullYear() !== new Date().getUTCFullYear();
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', timeZone: 'UTC', ...(other ? { year: 'numeric' } : {}),
  });
}

/**
 * "Aug 25 – Aug 31" for a window whose `endMs` is the Monday after it
 * (EXCLUSIVE, so the caption names the Sunday before it), and "Sep 14 →
 * now" for the one that has not finished, whose end is the current instant.
 */
export function weekRange(startMs: number, endMs: number, live?: boolean): string {
  if (live) return translate('project:since.week.rangeLive', { start: weekDate(startMs) });
  return translate('project:since.week.range', { start: weekDate(startMs), end: weekDate(endMs - 86400000) });
}

/** A week's name: "This week", "Last week", or its dates. */
export function weekName(week: Pick<SinceWeek, 'title' | 'key' | 'startMs' | 'endMs'>): string {
  if (week.title) return week.title;
  if (week.key === 'lastWeek') return translate('project:weeks.lastWeek');
  return weekRange(week.startMs, week.endMs);
}

/** What other people did in a week since your last visit: the week row's "N new". */
export function weekFresh(week: Pick<SinceWeek, 'fresh'>): CardRow[] {
  return week.fresh.filter((r) => !(r.brief && r.brief.mine));
}

/** How many changes went live in the week, where the server can stand behind it. */
function weekLive(week: SinceWeek): { count: number; partial: boolean } | null {
  if (!week.counts || !week.counts.closed) return null;
  return { count: week.counts.closed, partial: !!week.counts.partial };
}

export interface WeekGroup {
  key: 'new' | 'votes' | 'live' | 'requests' | 'worked';
  title: string;
  rows: CardRow[];
}

/**
 * A week's page, grouped: what other people did since your last visit
 * first, then everything else by where it is. A request made in the week
 * is a new request, whoever has picked it up since; work on an older one
 * is the week's work. Empty groups are left out.
 */
export function weekGroups(week: SinceWeek): WeekGroup[] {
  const fresh = weekFresh(week);
  const freshKeys = new Set(fresh.map((r) => r.key));
  const groups: WeekGroup[] = [
    { key: 'new', title: translate('project:weekPage.group.new'), rows: fresh },
    { key: 'votes', title: translate('project:weekPage.group.votes'), rows: [] },
    { key: 'live', title: translate('project:weekPage.group.live'), rows: [] },
    { key: 'requests', title: translate('project:weekPage.group.requests'), rows: [] },
    { key: 'worked', title: translate('project:weekPage.group.worked'), rows: [] },
  ];
  const by = (k: WeekGroup['key']) => groups.find((g) => g.key === k)!;
  for (const r of [...week.fresh, ...week.seen]) {
    if (freshKeys.has(r.key) || !r.brief) continue;
    const b = r.brief;
    if (b.stage === 'vote' && b.kind !== 'request') by('votes').rows.push(r);
    else if (b.stage === 'live') by('live').rows.push(r);
    else if (b.kind === 'request' && b.at >= week.startMs && b.at < week.endMs + 1) by('requests').rows.push(r);
    else by('worked').rows.push(r);
  }
  return groups.filter((g) => g.rows.length);
}

/** How many rows a group shows before its "Show all N". */
export const WEEK_GROUP_FIRST = 5;

function Group({ group, slug, openKey, onOpen }: {
  group: WeekGroup;
  slug: string;
  openKey: string | null;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
}): ReactNode {
  const t = useMessages('project');
  const [all, setAll] = useState(false);
  const extra = group.rows.length - WEEK_GROUP_FIRST;
  return (
    <section className="dev-ws-strip" data-ws-week-group={group.key}>
      <div className="dev-ws-head">
        <span className="dev-ws-head-title">{group.title}</span>
        <span className="dev-ws-head-n">{group.rows.length}</span>
      </div>
      <WorkList rows={all ? group.rows : group.rows.slice(0, WEEK_GROUP_FIRST)} slug={slug} openKey={openKey} onOpen={onOpen} />
      {extra > 0 && !all ? (
        <button type="button" className="dev-ws-reveal touch-target-32" data-ws-week-group-more="" onClick={() => setAll(true)}>
          <ChevronDownIcon className="dev-ws-reveal-chev" aria-hidden="true" />
          {t('project:weekPage.group.showAll', { count: group.rows.length })}
        </button>
      ) : null}
    </section>
  );
}

/** A week's own page inside the Workshop tab, with the way back. */
export function WeekPage({ week, slug, openKey, onOpen, onBack }: {
  week: SinceWeek;
  slug: string;
  openKey: string | null;
  onOpen: (event: MouseEvent<HTMLAnchorElement>, ref: TopicRef) => void;
  onBack: () => void;
}): ReactNode {
  const t = useMessages('project');
  const live = weekLive(week);
  const groups = weekGroups(week);
  const liveBold = [<b className="dev-ws-week-live" />];
  const start = weekDate(week.startMs);
  const end = weekDate(week.endMs - 86400000);
  return (
    <div className="dev-ws-weekpage" data-ws-week-page={week.key}>
      <PageBack label={t('project:weekPage.back')} title={weekName(week)} onBack={onBack} />
      <section className="dev-ws-strip" data-ws-week-top="">
        <p className="dev-ws-week-meta">
          {!live ? weekRange(week.startMs, week.endMs, week.live) : week.live ? (
            <RichMessage
              id={live.partial ? 'project:weekPage.meta.nowLiveAtLeast' : 'project:weekPage.meta.nowLive'}
              values={{ start, count: live.count }}
              components={liveBold}
            />
          ) : (
            <RichMessage
              id={live.partial ? 'project:weekPage.meta.rangeLiveAtLeast' : 'project:weekPage.meta.rangeLive'}
              values={{ start, end, count: live.count }}
              components={liveBold}
            />
          )}
        </p>
        {week.line ? <p className="dev-ws-week-lead" data-ws-week-line="">{week.line}</p> : null}
        {!groups.length ? <p className="dev-ws-none">{t('project:weekPage.none')}</p> : null}
      </section>
      {groups.map((g) => <Group key={g.key} group={g} slug={slug} openKey={openKey} onOpen={onOpen} />)}
    </div>
  );
}

/** One week, as one row of the Week by week list. */
export function WeekRow({ week, onOpen }: { week: SinceWeek; onOpen: () => void }): ReactNode {
  const t = useMessages('project');
  const live = weekLive(week);
  const fresh = weekFresh(week).length;
  const name = weekName(week);
  const dated = !week.title && week.key !== 'lastWeek';
  return (
    <button type="button" className="dev-ws-week" data-ws-week={week.key} onClick={onOpen}>
      <span className="dev-ws-week-main">
        <span className="dev-ws-week-head">
          <b>{name}</b>
          {dated ? null : <span>{weekRange(week.startMs, week.endMs, week.live)}</span>}
          {fresh ? <span className="dev-ws-week-fresh">{t('project:weeks.row.fresh', { count: fresh })}</span> : null}
        </span>
        {week.line ? <span className="dev-ws-week-line">{week.line}</span> : null}
      </span>
      {live ? (
        <span className="dev-ws-week-n">
          <RichMessage
            id={live.partial ? 'project:weeks.row.liveAtLeast' : 'project:weeks.row.live'}
            values={{ count: live.count }}
            components={[<b />]}
          />
        </span>
      ) : null}
      <ChevronRightIcon className="dev-ws-wrow-chev" aria-hidden="true" />
    </button>
  );
}

/** How many weeks the list opens with, and how many each "Show earlier weeks" adds. */
export const WEEKS_FIRST = 2;
export const WEEKS_STEP = 4;
