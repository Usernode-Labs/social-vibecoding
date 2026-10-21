/**
 * The Topochain standings pane — `#topochain-leaderboard-root` (#1191 slice 6,
 * conversion 5, the first of the Leaderboard screen's three panes).
 *
 * The only writer of the DOM below that root. ./topochain-leaderboard.js still
 * owns everything that makes this pane WORK — the four public `/api/v4` reads,
 * the event-context subscription, the staleness guards, the page cursor, the
 * season-vs-event column decision — and hands over two descriptors,
 * `bodyView()` and `drillView()`. This file spells them as markup, class string
 * for class string.
 *
 * ── The table's columns ────────────────────────────────────────────────
 *
 * `view.columns` drives BOTH the header row and every body row, so the season
 * board (which drops "Success rate", #999) cannot skew: a column that is not in
 * that list produces neither a `<th>` nor a `<td>`. The string version spelled
 * the two out separately behind matching `isSeason ? '' : …` conditionals, and
 * tests/standings-screen.test.js counted the tags to catch exactly the case
 * where one of the two was edited and the other was not.
 *
 * ── Initial render ─────────────────────────────────────────────────────
 *
 * `mounted: false` renders NOTHING — not the pane's two hosts, not a loading
 * line. That is the prerender contract: the hand-written shell shipped
 * `#topochain-leaderboard-root` empty, because `_renderShell()` wrote its
 * interior on the section's first open. The SSG pass in
 * frontend/scripts/build-shell.mjs reproduces the empty root, and the store's
 * initial value is what makes it do so.
 */

import { Fragment, type ReactNode } from 'react';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { ActivityRow } from './activity-row';
import { topochainStandingsStore } from './topochain-standings-store.js';

type ColumnKey = 'rank' | 'user' | 'points';

type RowView = {
  index: number;
  rank: string;
  nonPodium: boolean;
  user: string;
  /** No display name: `user` is the "Anonymous" stand-in. */
  anonymous?: boolean;
  points: string;
};

/** #5275: the viewer's own place, pinned above the table. */
type YouView = { rank: string; points: string; count: number };

type NonPodiumToggle = { count: number | null; on: boolean };

type BodyView =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'empty'; message: string }
  | { state: 'none' }
  | { state: 'private'; disclaimer: string | null }
  | {
      state: 'noentries';
      challengeLine: { done: string | null; total: string } | null;
      disclaimer: string | null;
    }
  | {
      // #3887: every scorer on this board is hidden by the default — the
      // filter working, not an empty board. The chip rides along.
      state: 'allexcluded';
      challengeLine: { done: string | null; total: string } | null;
      disclaimer: string | null;
      nonPodiumToggle: NonPodiumToggle | null;
    }
  | {
      state: 'table';
      challengeLine: { done: string | null; total: string } | null;
      disclaimer: string | null;
      isSeason: boolean;
      columns: ColumnKey[];
      headers: Record<ColumnKey, string>;
      rows: RowView[];
      you?: YouView | null;
      nonPodiumToggle: NonPodiumToggle | null;
      pagination: {
        page: number;
        totalPages: number;
        total: number;
        prevDisabled: boolean;
        nextDisabled: boolean;
      } | null;
    };

type Triple = { loading: boolean; error: string | null };

type DrillView = {
  displayName: string;
  /** The shown row the details open under, or null to draw them under the table. */
  index?: number | null;
  /** The row's figures that say something (#5275): blocks, challenge points, success rate. */
  figures?: { key: string; label: string; value: string }[];
  walletAddress: string | null;
  profile: Triple & {
    shown: boolean;
    stats: {
      rank: string;
      totalPoints: string;
      producedBlocks: string;
      clientSuccessRate: string | null;
      canonicalSuccessRate: string | null;
    } | null;
  };
  activities: Triple & { items: { label: string; points: string; at: string | null; precision?: 'day' | 'instant' | null; reason?: string | null }[] | null };
  epoch: Triple & {
    rows: { epoch: string; wonSlots: string; produced: string; successRate: string }[] | null;
  };
};

const controller = () => (window as any).TopochainLeaderboard;

/** Every column's alignment, so the head and the body cannot disagree. */
const ALIGN: Record<ColumnKey, string> = {
  rank: 'text-left',
  user: 'text-left',
  points: 'text-right whitespace-nowrap',
};

const HINT = 'text-sm text-zinc-500 py-8 text-center dark:text-zinc-400';

/**
 * #4869: the card the other Leaderboard panes draw — History's season cards
 * and Your standing are `rounded-2xl bg-white dark:bg-zinc-900`, white on the
 * page ground with no border. The table, its skeleton and the drill-in all
 * sit on it, so Standings stops being the one pane drawn as a bordered grey
 * box.
 */
const CARD = 'rounded-2xl bg-white dark:bg-zinc-900';

/** Row hairline, the one Your standing draws between its own parts. */
const RULE = 'border-t border-zinc-100 dark:border-zinc-800';

/** Figures line up by digit, the way Your standing's rank does, not in mono. */
const FIGURE = 'px-4 py-3 text-[0.9375rem] tabular-nums text-right';

function Disclaimer({ text }: { text: string | null }): ReactNode {
  if (!text) return null;
  return <p id="tc-lb-disclaimer" className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">{text}</p>;
}

/**
 * The #981 cross-link. `_goToChallenges` is still the module's — real hash
 * navigation, so the section switch goes through the router and the shared
 * event selection survives it.
 */
function ChallengeLine(
  { line }: { line: { done: string | null; total: string } | null },
): ReactNode {
  if (!line) return null;
  return (
    <p id="tc-lb-challenge-link" className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
      {/* The tally is the VIEWER's, and a signed-out reader has none — then
          the cross-link stands on its own rather than carrying a zero that
          reads as theirs. "done" is the word Home uses for this same number;
          the two must not drift apart again. */}
      <RichMessage
        id={line.done == null ? 'leaderboard:standings.viewChallenges' : 'leaderboard:standings.challengesDone'}
        values={{ done: line.done, count: Number(line.total) }}
        components={[
          <span className="text-zinc-500 dark:text-zinc-500" />,
          <button
            id="tc-lb-to-challenges"
            className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
            onClick={() => controller()?._goToChallenges()}
          />,
        ]}
      />
      {/* QA 2026-09-24 Q32c: a space after the dot as well as before it,
          inside the span rather than as a whitespace-only child (React
          #418, see notifications-list.tsx). */}
    </p>
  );
}

/**
 * #3887: the chip above the table. Hidden entirely when the board has no
 * podium-excluded user (the descriptor is null); the count in the label is
 * the server's own non_podium_count, and a server old enough to omit that
 * field renders the chip without a number rather than with a wrong one.
 * Class recipe and aria-pressed are the Kudos history chips'
 * (./kudos-pane.tsx) — a filter chip, not a tab.
 */
function NonPodiumChip({ toggle }: { toggle: NonPodiumToggle | null }): ReactNode {
  const t = useMessages('leaderboard');
  if (!toggle) return null;
  const on = toggle.on
    ? 'bg-violet-600 text-white border-violet-600'
    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 '
      + 'border-zinc-200 dark:border-zinc-700 hover:bg-zinc-200 dark:hover:bg-zinc-700';
  return (
    <div className="flex items-center mb-3">
      <button
        type="button"
        id="tc-lb-non-podium-toggle"
        aria-pressed={toggle.on}
        className={`px-3 py-1 text-xs font-medium rounded-full border ${on}`}
        onClick={() => controller()?._toggleNonPodium()}
      >
        {toggle.count == null
          ? t('leaderboard:standings.showNonPodium')
          : t('leaderboard:standings.showNonPodiumCount', { count: toggle.count })}
      </button>
    </div>
  );
}

function Cell({ column, row }: { column: ColumnKey; row: RowView }): ReactNode {
  const t = useMessages('leaderboard');
  // #3887: an included non-podium row reads in the shell's muted ink —
  // the whole row grayed, no opacity trick — so a dimmed figure is never
  // mistaken for a ranked one. The row stays hoverable and tappable as
  // any other; gray is not disabled.
  const ink = row.nonPodium ? ' text-zinc-500 dark:text-zinc-400' : '';
  if (column === 'rank') {
    return <td className="w-14 px-4 py-3 text-[0.9375rem] tabular-nums text-zinc-500 dark:text-zinc-400">{row.rank}</td>;
  }
  if (column === 'user') {
    // `max-w-0 w-full` gives the name the width the rank and the points
    // leave, and a long one ends in "…" instead of pushing the points off
    // a phone's screen (#5275).
    return (
      <td className="max-w-0 w-full px-4 py-3 text-[0.9375rem]">
        <span className="block truncate">
          {row.nonPodium ? (
            <RichMessage
              id="leaderboard:standings.nonPodium"
              values={{ name: row.user }}
              components={[
                <span className="font-medium text-zinc-500 dark:text-zinc-400" />,
                <span
                  className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400"
                  title={t('leaderboard:standings.nonPodiumTip')}
                />,
              ]}
            />
          ) : (
            <span className="font-[650] text-zinc-900 dark:text-zinc-100">{row.user}</span>
          )}
        </span>
      </td>
    );
  }
  return <td className={`${FIGURE} whitespace-nowrap${ink}`}>{row.points}</td>;
}

/**
 * #5275: "You · #22 · 10,823 points", above the table, so the viewer sees
 * their own place without paging to it. Pressing it opens their details,
 * under their row when it is on this page.
 */
function YouLine({ you }: { you: YouView | null | undefined }): ReactNode {
  const t = useMessages('leaderboard');
  if (!you) return null;
  return (
    <button
      type="button"
      id="tc-lb-you"
      className={`${CARD} mb-3 block w-full px-4 py-3 text-left text-[0.9375rem] font-[650] tabular-nums text-zinc-900 dark:text-zinc-100 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-500`}
      onClick={() => controller()?._openViewerRow()}
    >
      {t('leaderboard:standings.you', { rank: you.rank, points: you.points, count: you.count })}
    </button>
  );
}

function StandingsTable(
  { view, drill }: { view: Extract<BodyView, { state: 'table' }>; drill: DrillView | null },
): ReactNode {
  const t = useMessages('leaderboard');
  const openIndex = drill && drill.index != null ? drill.index : null;
  return (
    <div className={`overflow-x-auto ${CARD}`}>
      <table className="w-full">
        {/* The headings read as the rows' subtitles (13px, muted), on the
            card itself rather than on a grey strip of their own. */}
        <thead className="text-[0.8125rem] text-zinc-500 dark:text-zinc-400">
          <tr>
            {view.columns.map((c) => (
              <th key={c} className={`px-4 pt-3 pb-2 font-medium ${ALIGN[c]}`}>{view.headers[c]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* A row stays a table row (no role override, so the cells keep
              their column headers) but takes focus and opens on Enter or
              Space, as the Kudos rows do. The label says what it opens. */}
          {view.rows.map((row) => (
            <Fragment key={row.index}>
              <tr
                className={`tc-lb-row ${RULE} hover:bg-zinc-50 dark:hover:bg-zinc-800/60 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500 focus-visible:bg-zinc-50 dark:focus-visible:bg-zinc-800/60`}
                data-row-index={row.index}
                aria-expanded={openIndex === row.index}
                tabIndex={0}
                aria-label={row.anonymous ? t('leaderboard:standings.openDetailsAnonymous') : t('leaderboard:standings.openDetails', { name: row.user })}
                onClick={() => controller()?._openRowAt(row.index)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    controller()?._openRowAt(row.index);
                  }
                }}
              >
                {view.columns.map((c) => <Cell key={c} column={c} row={row} />)}
              </tr>
              {/* #5275: the row's details open under it, not at the foot of
                  a 25-row table. */}
              {openIndex === row.index && drill ? (
                <tr>
                  <td colSpan={view.columns.length} className="px-4 pb-4">
                    <DrillPanel view={drill} />
                  </td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination(
  { meta }: { meta: Extract<BodyView, { state: 'table' }>['pagination'] },
): ReactNode {
  const t = useMessages('leaderboard');
  if (!meta) return null;
  const btn = 'rounded-full bg-white dark:bg-zinc-900 px-3 py-1 text-xs font-medium disabled:opacity-40';
  return (
    <div className="flex items-center justify-between mt-3 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">
        {t('leaderboard:standings.page', { page: meta.page, pages: meta.totalPages, count: meta.total })}
      </span>
      <div className="flex gap-2">
        <button
          id="tc-lb-prev"
          className={btn}
          disabled={meta.prevDisabled}
          onClick={() => controller()?._prevPage()}
        >
          {t('leaderboard:standings.prev')}
        </button>
        <button
          id="tc-lb-next"
          className={btn}
          disabled={meta.nextDisabled}
          onClick={() => controller()?._nextPage()}
        >
          {t('leaderboard:standings.next')}
        </button>
      </div>
    </div>
  );
}

/**
 * The standings' loading state, at the TABLE's own shape.
 *
 * This was the pane the bare `#leaderboard` address landed on until #2374
 * made Challenges the default, so it was the first thing the screen showed —
 * and it was the word "Loading…" on an otherwise blank panel.
 *
 * The container is the table's own (`rounded-lg` + the hairline), with a
 * header strip in the same `bg-zinc-50` the real `<thead>` uses, so the table
 * arrives INSIDE an outline that is already the right size rather than
 * replacing a line of text.
 *
 * Four columns rather than `view.columns.length`, because the columns are not
 * known until the payload that is still in flight arrives — the one thing a
 * skeleton for this table genuinely cannot predict. Four is what every event
 * type draws at minimum (rank, who, and two figures), and the cells are
 * proportional so a fifth arriving does not shift the row heights.
 */
function StandingsSkeleton(): ReactNode {
  const t = useMessages('leaderboard');
  return (
    <SkeletonGroup
      label={t('leaderboard:standings.loading')}
      className={`overflow-hidden ${CARD}`}
    >
      <div className="px-4 pt-3 pb-2 flex items-center gap-3">
        <Skeleton shape="muted" className="w-8" />
        <Skeleton shape="muted" className="w-20" />
        <Skeleton shape="muted" className="ml-auto w-12" />
        <Skeleton shape="muted" className="w-12" />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className={`${RULE} px-4 py-3 flex items-center gap-3`}
        >
          <Skeleton shape="muted" className="w-4" />
          <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
          <Skeleton shape="muted" className="ml-auto w-10" />
          <Skeleton shape="muted" className="w-14" />
        </div>
      ))}
    </SkeletonGroup>
  );
}

function Body({ view, drill }: { view: BodyView | null; drill: DrillView | null }): ReactNode {
  const t = useMessages('leaderboard');
  if (!view || view.state === 'loading') return <StandingsSkeleton />;
  if (view.state === 'error') {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
        {view.message}
      </div>
    );
  }
  if (view.state === 'empty') return <p className={HINT}>{view.message}</p>;
  if (view.state === 'none') return <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('leaderboard:standings.noData')}</p>;
  if (view.state === 'private') {
    return (
      <>
        <Disclaimer text={view.disclaimer} />
        <p className={HINT}>{t('leaderboard:standings.private')}</p>
      </>
    );
  }
  if (view.state === 'noentries') {
    return (
      <>
        <ChallengeLine line={view.challengeLine} />
        <Disclaimer text={view.disclaimer} />
        {/* data-tc-lb-empty marks the LEGITIMATE no-scores state for the
            dapp.json standings checks: a fresh season has an empty
            leaderboard, and the checks accept "table or this hint" while
            still rejecting the red error state. */}
        <p className={HINT} data-tc-lb-empty="">{t('leaderboard:standings.noEntries')}</p>
      </>
    );
  }
  // #3887: everyone who scored here is hidden by the default. Same
  // neutral-hint contract as noentries (data-tc-lb-empty — the declared
  // check accepts "table or this hint"), but a different sentence, and the
  // chip above it is how the viewer gets the rows back.
  if (view.state === 'allexcluded') {
    return (
      <>
        <ChallengeLine line={view.challengeLine} />
        <Disclaimer text={view.disclaimer} />
        <NonPodiumChip toggle={view.nonPodiumToggle} />
        <p className={HINT} data-tc-lb-empty="">{t('leaderboard:standings.allExcluded')}</p>
      </>
    );
  }
  return (
    <>
      <ChallengeLine line={view.challengeLine} />
      <Disclaimer text={view.disclaimer} />
      <YouLine you={view.you} />
      <NonPodiumChip toggle={view.nonPodiumToggle} />
      <StandingsTable view={view} drill={drill} />
      <Pagination meta={view.pagination} />
    </>
  );
}

function Activities({ view }: { view: DrillView['activities'] }): ReactNode {
  const t = useMessages('leaderboard');
  if (view.loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('leaderboard:drill.activitiesLoading')}</p>;
  if (view.error) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  if (!view.items || !view.items.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('leaderboard:drill.activitiesEmpty')}</p>;
  }
  return (
    <ul className="space-y-1">
      {view.items.map((a, i) => (
        <ActivityRow key={i} text={a.label} points={`+${a.points}`} at={a.at} precision={a.precision} reason={a.reason} />
      ))}
    </ul>
  );
}

function EpochBreakdown({ view }: { view: DrillView['epoch'] }): ReactNode {
  const t = useMessages('leaderboard');
  if (view.loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('leaderboard:drill.epoch.loading')}</p>;
  if (view.error) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  if (!view.rows || !view.rows.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('leaderboard:drill.epoch.empty')}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-zinc-500 dark:text-zinc-400">
          <tr>
            <th className="text-left py-1">{t('leaderboard:drill.epoch.column.epoch')}</th>
            <th className="text-right py-1">{t('leaderboard:drill.epoch.column.wonSlots')}</th>
            <th className="text-right py-1">{t('leaderboard:drill.epoch.column.produced')}</th>
            <th className="text-right py-1">{t('leaderboard:drill.epoch.column.successRate')}</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((e, i) => (
            <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
              <td className="py-1 font-mono">{e.epoch}</td>
              <td className="py-1 font-mono text-right">{e.wonSlots}</td>
              <td className="py-1 font-mono text-right">{e.produced}</td>
              <td className="py-1 font-mono text-right">{`${e.successRate}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProfileStat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <span className="text-zinc-500 dark:text-zinc-400">{label}</span>
      <div className="font-mono">{value}</div>
    </div>
  );
}

function Profile({ view }: { view: DrillView['profile'] }): ReactNode {
  const t = useMessages('leaderboard');
  if (!view.shown) return null;
  let inner: ReactNode;
  if (view.loading) {
    inner = <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('leaderboard:drill.profile.loading')}</p>;
  } else if (view.error) {
    inner = <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  } else if (view.stats) {
    const s = view.stats;
    inner = (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <ProfileStat label={t('leaderboard:drill.profile.rank')} value={s.rank} />
        <ProfileStat label={t('leaderboard:drill.profile.totalPoints')} value={s.totalPoints} />
        <ProfileStat label={t('leaderboard:drill.profile.producedBlocks')} value={s.producedBlocks} />
        <ProfileStat
          label={t('leaderboard:drill.profile.clientRate')}
          value={s.clientSuccessRate == null ? '—' : `${s.clientSuccessRate}%`}
        />
        <ProfileStat
          label={t('leaderboard:drill.profile.canonicalRate')}
          value={s.canonicalSuccessRate == null ? '—' : `${s.canonicalSuccessRate}%`}
        />
      </div>
    );
  } else {
    inner = null;
  }
  return (
    <div className="mb-4">
      <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">{t('leaderboard:drill.profile.heading')}</div>
      {inner}
    </div>
  );
}

/** A row's figures that say something (#5275); nothing at all when none do. */
function Figures({ figures }: { figures: DrillView['figures'] }): ReactNode {
  if (!figures || !figures.length) return null;
  return (
    <div className="mb-4 grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
      {figures.map((f) => <ProfileStat key={f.key} label={f.label} value={f.value} />)}
    </div>
  );
}

/**
 * The details themselves. Drawn under the open row of the table (#5275),
 * or, for the viewer's own row opened from the "You" line while it is on
 * another page, under the table on its own card. Either way the panel is
 * #tc-lb-drill, once.
 */
function DrillPanel({ view }: { view: DrillView }): ReactNode {
  const t = useMessages('leaderboard');
  return (
    <div id="tc-lb-drill">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[1.0625rem] font-bold text-zinc-900 dark:text-zinc-100">
          {view.displayName}
        </h3>
        <button
          id="tc-lb-drill-close"
          className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 text-lg leading-none dark:text-zinc-400"
          aria-label={t('core:common.close')}
          onClick={() => controller()?._closeDrill()}
        >
          ×
        </button>
      </div>
      {view.walletAddress ? (
        <p className="text-xs font-mono text-zinc-500 mb-3 break-all dark:text-zinc-400">{view.walletAddress}</p>
      ) : null}
      <Figures figures={view.figures} />
      <Profile view={view.profile} />
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">{t('leaderboard:drill.activities')}</div>
          <Activities view={view.activities} />
        </div>
        <div>
          <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1">{t('leaderboard:drill.epoch.heading')}</div>
          <EpochBreakdown view={view.epoch} />
        </div>
      </div>
    </div>
  );
}

function Drill({ view, inline }: { view: DrillView | null; inline: boolean }): ReactNode {
  // `hidden` is part of the rendered class string here rather than a legacy
  // `classList` toggle, because this whole subtree is React's — the pane's
  // module no longer touches the node at all.
  if (inline) return null;
  if (!view) return <div id="tc-lb-drill" className="hidden mt-4" />;
  return (
    <div className={`${CARD} mt-4 p-4`}>
      <DrillPanel view={view} />
    </div>
  );
}

export function TopochainStandingsPane(): ReactNode {
  const state = useStoreState(topochainStandingsStore) as {
    mounted: boolean;
    body: BodyView | null;
    drill: DrillView | null;
  };
  // Subscribed: the table's headings and names are read by the controller's views.
  useMessages('leaderboard');
  if (!state.mounted) return null;
  // The details sit inside the table when their row is on it.
  const inline = !!(state.drill && state.drill.index != null
    && state.body && state.body.state === 'table'
    && state.drill.index < state.body.rows.length);
  return (
    <>
      <div id="tc-lb-body"><Body view={state.body} drill={inline ? state.drill : null} /></div>
      <Drill view={state.drill} inline={inline} />
    </>
  );
}
