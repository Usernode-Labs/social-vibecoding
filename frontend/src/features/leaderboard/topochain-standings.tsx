import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { RichMessage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message, Localized, message as catalogText } from "../../lib/i18n/react";
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

import type { ReactNode } from 'react';

import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { useStoreState } from '../../lib/use-store-state';
import { topochainStandingsStore } from './topochain-standings-store.js';
import { STANDINGS_UPDATE_NOTE } from './my-standing.js';

type ColumnKey = 'rank' | 'user' | 'points' | 'blocks' | 'success';

type RowView = {
  index: number;
  rank: string;
  nonPodium: boolean;
  user: string;
  points: string;
  extra: string;
  blocks: string;
  success: string;
};

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
  activities: Triple & { items: { label: string; points: string }[] | null };
  epoch: Triple & {
    rows: { epoch: string; wonSlots: string; produced: string; successRate: string }[] | null;
  };
};

const controller = () => (window as any).TopochainLeaderboard;

/** Every column's alignment, so the head and the body cannot disagree. */
const ALIGN: Record<ColumnKey, string> = {
  rank: 'text-left',
  user: 'text-left',
  points: 'text-right',
  blocks: 'text-right',
  success: 'text-right',
};

const HINT = 'text-sm text-zinc-500 py-8 text-center dark:text-zinc-400';

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
      <LocalizedValue render={() => (line.done == null ? null : tr("apps:value1_of_value2_challenges_done_54942000", { value1: line.done, value2: line.total }))} />
      {/* QA 2026-09-24 Q32c: a space after the dot as well as before it,
          inside the span rather than as a whitespace-only child (React
          #418, see notifications-list.tsx). */}
      <span className="text-zinc-500 dark:text-zinc-500">{'· '}</span>
      <button
        id="tc-lb-to-challenges"
        className="font-medium text-violet-700 dark:text-violet-400 hover:underline"
        onClick={() => controller()?._goToChallenges()}
      ><Message id="apps:view_challenges_fa7e81e5" /></button>
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
          ? 'Show non-podium users'
          : `Show non-podium users (${toggle.count})`}
      </button>
    </div>
  );
}

function Cell({ column, row }: { column: ColumnKey; row: RowView }): ReactNode {
  // #3887: an included non-podium row reads in the shell's muted ink —
  // the whole row grayed, no opacity trick — so a dimmed figure is never
  // mistaken for a ranked one. The row stays hoverable and tappable as
  // any other; gray is not disabled.
  const ink = row.nonPodium ? ' text-zinc-500 dark:text-zinc-400' : '';
  if (column === 'rank') {
    return <td className={`px-3 py-2 text-sm font-mono text-zinc-500 dark:text-zinc-400${ink}`}>{row.rank}</td>;
  }
  if (column === 'user') {
    return (
      <td className="px-3 py-2 text-sm">
        <span
          className={`font-medium ${row.nonPodium
            ? 'text-zinc-500 dark:text-zinc-400'
            : 'text-zinc-900 dark:text-zinc-100'}`}
        >{row.user}</span>
        {row.nonPodium ? (
          <Localized element={<span
            className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400" title={catalogText("apps:excluded_from_podium_ranking_07f1600c")}
          ><Message id="apps:non_podium_759e30d5" /></span>} messages={{"title":"apps:excluded_from_podium_ranking_07f1600c"}} />
        ) : null}
      </td>
    );
  }
  if (column === 'points') {
    return (
      <td className={`px-3 py-2 text-sm font-mono text-right${ink}`}>
        {row.points}
        <span className="text-zinc-500 dark:text-zinc-400">{` +${row.extra}`}</span>
      </td>
    );
  }
  if (column === 'blocks') {
    return <td className={`px-3 py-2 text-sm font-mono text-right${ink}`}>{row.blocks}</td>;
  }
  return <td className={`px-3 py-2 text-sm font-mono text-right${ink}`}>{`${row.success}%`}</td>;
}

function StandingsTable(
  { view }: { view: Extract<BodyView, { state: 'table' }> },
): ReactNode {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full">
        <thead className="bg-zinc-50 dark:bg-zinc-900 text-[0.9375rem] text-zinc-500 dark:text-zinc-400">
          <tr>
            {view.columns.map((c) => (
              <th key={c} className={`px-3 py-2 ${ALIGN[c]}`}>{view.headers[c]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {/* A row stays a table row (no role override, so the cells keep
              their column headers) but takes focus and opens on Enter or
              Space, as the Kudos rows do. The label says what it opens. */}
          {view.rows.map((row) => (
            <LocalizedDynamic element={<tr
              key={row.index}
              className="tc-lb-row border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet-500 focus-visible:bg-zinc-50 dark:focus-visible:bg-zinc-800/60"
              data-row-index={row.index}
              tabIndex={0}
              aria-label={tr("apps:open_value1_s_details_034e5763", { value1: row.user })}
              onClick={() => controller()?._openRowAt(row.index)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  controller()?._openRowAt(row.index);
                }
              }}
            >
              {view.columns.map((c) => <Cell key={c} column={c} row={row} />)}
            </tr>} resolve={() => ({ get "aria-label"() { return tr("apps:open_value1_s_details_034e5763", { value1: row.user }); } })} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Pagination(
  { meta }: { meta: Extract<BodyView, { state: 'table' }>['pagination'] },
): ReactNode {
  if (!meta) return null;
  const btn = 'rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium disabled:opacity-40';
  return (
    <div className="flex items-center justify-between mt-3 text-sm">
      <span className="text-zinc-500 dark:text-zinc-400">
        <LocalizedValue render={() => (tr("apps:page_value1_of_value2_value3_total_36665061", { value1: meta.page, value2: meta.totalPages, value3: meta.total }))} />
      </span>
      <div className="flex gap-2">
        <button
          id="tc-lb-prev"
          className={btn}
          disabled={meta.prevDisabled}
          onClick={() => controller()?._prevPage()}
        ><Message id="apps:prev_73912999" /></button>
        <button
          id="tc-lb-next"
          className={btn}
          disabled={meta.nextDisabled}
          onClick={() => controller()?._nextPage()}
        ><Message id="apps:next_1ff57a29" /></button>
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
  return (
    <Localized element={<SkeletonGroup label={catalogText("apps:loading_the_standings_4eda8afa")}
      className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
    >
      <div className="bg-zinc-50 dark:bg-zinc-900 px-3 py-2.5 flex items-center gap-3">
        <Skeleton shape="muted" className="w-8" />
        <Skeleton shape="muted" className="w-20" />
        <Skeleton shape="muted" className="ml-auto w-12" />
        <Skeleton shape="muted" className="w-12" />
      </div>
      {Array.from({ length: 6 }, (_, i) => (
        <div
          key={i}
          className="border-t border-zinc-100 dark:border-zinc-800 px-3 py-2.5 flex items-center gap-3"
        >
          <Skeleton shape="muted" className="w-4" />
          <Skeleton className={i % 2 ? 'w-28' : 'w-36'} />
          <Skeleton shape="muted" className="ml-auto w-10" />
          <Skeleton shape="muted" className="w-14" />
        </div>
      ))}
    </SkeletonGroup>} messages={{"label":"apps:loading_the_standings_4eda8afa"}} />
  );
}

function Body({ view }: { view: BodyView | null }): ReactNode {
  if (!view || view.state === 'loading') return <StandingsSkeleton />;
  if (view.state === 'error') {
    return (
      <div className="rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm">
        {view.message}
      </div>
    );
  }
  if (view.state === 'empty') return <p className={HINT}>{view.message}</p>;
  if (view.state === 'none') return <p className="text-sm text-zinc-500 dark:text-zinc-400"><Message id="apps:no_data_5118ec56" /></p>;
  if (view.state === 'private') {
    return (
      <>
        <Disclaimer text={view.disclaimer} />
        <p className={HINT}><Message id="apps:the_leaderboard_for_this_event_isn_t_public_yet_d3810d93" /></p>
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
        <p className={HINT} data-tc-lb-empty=""><RichMessage id="apps:sentence_5724100daa2c" values={{ value1: STANDINGS_UPDATE_NOTE() }} /></p>
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
        <p className={HINT} data-tc-lb-empty="">Everyone with a score on this board is excluded from the ranking.</p>
      </>
    );
  }
  return (
    <>
      <ChallengeLine line={view.challengeLine} />
      <Disclaimer text={view.disclaimer} />
      <NonPodiumChip toggle={view.nonPodiumToggle} />
      <StandingsTable view={view} />
      <Pagination meta={view.pagination} />
    </>
  );
}

function Activities({ view }: { view: DrillView['activities'] }): ReactNode {
  if (view.loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="apps:loading_activities_8d272db6" /></p>;
  if (view.error) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  if (!view.items || !view.items.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="apps:no_activities_recorded_for_this_event_b7f206f1" /></p>;
  }
  return (
    <ul className="space-y-1">
      {view.items.map((a, i) => (
        <li key={i} className="flex items-center justify-between gap-3 text-xs">
          <span className="text-zinc-600 dark:text-zinc-300">{a.label}</span>
          <span className="font-mono text-zinc-500 dark:text-zinc-400">{`+${a.points}`}</span>
        </li>
      ))}
    </ul>
  );
}

function EpochBreakdown({ view }: { view: DrillView['epoch'] }): ReactNode {
  if (view.loading) return <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="apps:loading_epoch_breakdown_38866881" /></p>;
  if (view.error) return <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  if (!view.rows || !view.rows.length) {
    return <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="apps:no_epoch_data_for_this_event_dbf4c6ce" /></p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-zinc-500 dark:text-zinc-400">
          <tr>
            <th className="text-left py-1"><Message id="apps:epoch_fff7a2d7" /></th>
            <th className="text-right py-1"><Message id="apps:won_slots_32dbf5c2" /></th>
            <th className="text-right py-1"><Message id="apps:produced_3b22f22b" /></th>
            <th className="text-right py-1"><Message id="apps:success_rate_49da60f8" /></th>
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
  if (!view.shown) return null;
  let inner: ReactNode;
  if (view.loading) {
    inner = <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="apps:loading_your_profile_dc371220" /></p>;
  } else if (view.error) {
    inner = <p className="text-xs text-zinc-500 dark:text-zinc-400">{view.error}</p>;
  } else if (view.stats) {
    const s = view.stats;
    inner = (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
        <Localized element={<ProfileStat label={catalogText("apps:rank_a4130d7d")} value={s.rank} />} messages={{"label":"apps:rank_a4130d7d"}} />
        <Localized element={<ProfileStat label={catalogText("apps:total_points_82d73caa")} value={s.totalPoints} />} messages={{"label":"apps:total_points_82d73caa"}} />
        <Localized element={<ProfileStat label={catalogText("apps:produced_blocks_4898d66e")} value={s.producedBlocks} />} messages={{"label":"apps:produced_blocks_4898d66e"}} />
        <Localized element={<ProfileStat label={catalogText("apps:client_success_rate_f58196ac")}
          value={s.clientSuccessRate == null ? '—' : `${s.clientSuccessRate}%`}
        />} messages={{"label":"apps:client_success_rate_f58196ac"}} />
        <Localized element={<ProfileStat label={catalogText("apps:canonical_success_rate_56b13819")}
          value={s.canonicalSuccessRate == null ? '—' : `${s.canonicalSuccessRate}%`}
        />} messages={{"label":"apps:canonical_success_rate_56b13819"}} />
      </div>
    );
  } else {
    inner = null;
  }
  return (
    <div className="mb-4">
      <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1"><Message id="apps:your_profile_528d89ad" /></div>
      {inner}
    </div>
  );
}

function Drill({ view }: { view: DrillView | null }): ReactNode {
  // `hidden` is part of the rendered class string here rather than a legacy
  // `classList` toggle, because this whole subtree is React's — the pane's
  // module no longer touches the node at all.
  if (!view) return <div id="tc-lb-drill" className="hidden mt-4" />;
  return (
    <div id="tc-lb-drill" className="mt-4">
      <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {view.displayName}
          </h3>
          <Localized element={<button
            id="tc-lb-drill-close"
            className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 text-lg leading-none dark:text-zinc-400" aria-label={catalogText("apps:close_7d9eb7ac")}
            onClick={() => controller()?._closeDrill()}
          >
            ×
          </button>} messages={{"aria-label":"apps:close_7d9eb7ac"}} />
        </div>
        {view.walletAddress ? (
          <p className="text-xs font-mono text-zinc-500 mb-3 break-all dark:text-zinc-400">{view.walletAddress}</p>
        ) : null}
        <Profile view={view.profile} />
        <div className="grid sm:grid-cols-2 gap-4">
          <div>
            <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1"><Message id="apps:activities_4d0076e6" /></div>
            <Activities view={view.activities} />
          </div>
          <div>
            <div className="text-[0.9375rem] text-zinc-500 dark:text-zinc-400 mb-1"><Message id="apps:epoch_breakdown_0cdc9208" /></div>
            <EpochBreakdown view={view.epoch} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function TopochainStandingsPane(): ReactNode {
  useUiLanguage();
  const state = useStoreState(topochainStandingsStore) as {
    mounted: boolean;
    body: BodyView | null;
    drill: DrillView | null;
  };
  if (!state.mounted) return null;
  return (
    <>
      <div id="tc-lb-body"><Body view={state.body} /></div>
      <Drill view={state.drill} />
    </>
  );
}
