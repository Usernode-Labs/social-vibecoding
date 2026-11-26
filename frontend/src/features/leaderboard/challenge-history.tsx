/**
 * The Challenges screen's History tab (#6967): what earned the viewer's
 * challenge points, when each credit landed, and why an action did not count.
 *
 * The descriptor is built by ./topochain-challenges.js's `historyView` from
 * the same `_mine` rows the grid and a challenge's "What counted" list read;
 * nothing here decides anything. The screen's one job is reading, so it has
 * no primary action — the only links go to the changes behind the credits.
 *
 * It looks like the Challenges tab: the same summary line and bar, the same
 * small-caps group headings, the same 20px cards, and the same action rows as
 * a challenge page's "What counted" list (./activity-row.tsx). A finished
 * challenge keeps the done card's face and emerald points; one still in
 * progress keeps the same face with grey points. The standard look and the
 * frame looks draw these same cards.
 */

import { useEffect, type ReactNode } from 'react';

import { GroupedList, ListRow, SectionHeader } from '@/components/ui/grouped-list';
import { Skeleton, SkeletonGroup } from '@/components/ui/skeleton';

import { changeHref } from '../../lib/change-href';
import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { ActivityRow, type ActivityTimePrecision } from './activity-row';
import { CHALLENGE_HISTORY_FACE, StateMark } from './challenge-card';
import { MyStanding, myStandingStore, standingView } from './my-standing.js';
import { SeasonProgress, type SeasonProgressView } from './season-progress';

type HistoryCredit = {
  text: string;
  points: number;
  at?: string | null;
  precision?: ActivityTimePrecision | null;
  creditedAt?: string | null;
  change: { slug: string; sessionId: number; prNumber?: number | null } | null;
  reason?: string | null;
  note?: string | null;
};

export type HistoryChallenge = {
  key: string;
  goal: string;
  done: boolean;
  points: string | null;
  credits: HistoryCredit[];
};

export type HistoryView =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'empty'; progress?: SeasonProgressView }
  | {
    kind: 'list';
    progress: SeasonProgressView;
    done: HistoryChallenge[];
    progressGroup: HistoryChallenge[];
  };

// The grid's columns, exactly as the Challenges tab draws them (see
// ./challenges-pane.tsx's GRID): a column is never narrower than 21rem while
// there are two or more, and one full-width column below that.
const GRID = 'grid gap-3 grid-cols-[repeat(auto-fill,minmax(min(21rem,100%),1fr))]';
// Every group heading stands the kit's section gap (24px) clear of what is
// above it. The first one used to sit flush (`pt-0`), as on the Challenges
// tab where it follows the summary; here the How points work card is above
// it, so "Done" sat 12px under that card and read as its footer (phone
// review #108).
const GROUP_HEADING = 'px-1 pt-6 pb-2';
const GRID_ERROR = 'rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 '
  + 'dark:border-red-900 text-red-700 dark:text-red-300 px-4 py-3 text-sm';
const DONE_MARK = 'shrink-0 text-emerald-700 dark:text-emerald-400';
const DONE_POINTS = 'max-w-[55%] shrink-0 truncate text-[0.8125rem] font-medium leading-5 '
  + 'text-emerald-700 dark:text-emerald-400';
const SO_FAR_POINTS = 'max-w-[55%] shrink-0 truncate text-[0.8125rem] font-medium leading-5 '
  + 'text-zinc-500 dark:text-zinc-400';
// Two lines before an ellipsis, as the Challenges tab's card titles (phone
// review #33): "Get 2 proposals accepted (staging…" lost its end beside the
// points.
const CARD_NAME = 'min-w-0 flex-1 line-clamp-2 break-words text-sm font-semibold text-zinc-900 dark:text-zinc-100';

function HistoryCard({ view }: { view: HistoryChallenge }): ReactNode {
  return (
    <div className={CHALLENGE_HISTORY_FACE} data-history-challenge={view.key}>
      <div className="flex min-w-0 items-start gap-2.5">
        {view.done ? <span className={DONE_MARK}><StateMark state="done" /></span> : null}
        <span className={CARD_NAME}>{view.goal}</span>
        {view.points ? (
          <span className={view.done ? DONE_POINTS : SO_FAR_POINTS}>{view.points}</span>
        ) : null}
      </div>
      {view.credits.length ? (
        <ul className="space-y-1">
          {view.credits.map((credit, i) => (
            <ActivityRow
              key={i}
              text={credit.text}
              points={`+${credit.points}`}
              at={credit.at}
              precision={credit.precision}
              reason={credit.reason}
              note={credit.note}
              credited={credit.creditedAt}
              href={credit.change
                ? changeHref(credit.change.slug, credit.change.sessionId, credit.change.prNumber)
                : null}
            />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The loading state, at the summary's and the cards' own geometry, shaped
// like the Challenges tab's placeholder (./challenges-pane.tsx's
// GridSkeleton) so the tab does not jump when the payload lands.
function HistorySkeleton(): ReactNode {
  const t = useMessages('leaderboard');
  return (
    <SkeletonGroup label={t('leaderboard:history.loading')}>
      <div className="flex flex-col gap-2 mb-4">
        <Skeleton className="w-40" />
        <Skeleton shape="muted" className="h-[5px] w-full rounded-full" />
      </div>
      {/*
          The How points work card's own place, so the tab does not jump when
          it lands: a title line and its three sentences, in the standard
          card's geometry.
      */}
      <div className={`${CHALLENGE_HISTORY_FACE} mb-3`} data-history-how-skeleton="">
        <Skeleton className="w-32" />
        <Skeleton shape="muted" className="w-full" />
        <Skeleton shape="muted" className="w-full" />
        <Skeleton shape="muted" className="w-2/3" />
      </div>
      <div className={GRID}>
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className={CHALLENGE_HISTORY_FACE}>
            <div className="flex min-w-0 items-center justify-between gap-2">
              <Skeleton className={i % 2 ? 'w-32' : 'w-40'} />
              <Skeleton shape="muted" className="w-12" />
            </div>
            <Skeleton shape="block" className="h-12 w-full rounded-[0.6875rem]" />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

function Group({ groupKey, heading, cards }: {
  groupKey: string; heading: string; cards: HistoryChallenge[];
}): ReactNode {
  if (!cards.length) return null;
  return (
    <>
      <SectionHeader className={GROUP_HEADING}>{heading}</SectionHeader>
      <div id={`tc-se-history-${groupKey}`} className={GRID}>
        {cards.map((c) => <HistoryCard key={c.key} view={c} />)}
      </div>
    </>
  );
}

export function ChallengeHistory({ view }: { view: HistoryView | null }): ReactNode {
  const t = useMessages('leaderboard');
  // The pending figure is the standing card's; the tab reads it the same way
  // YourStanding does, and only while it is this tab on show.
  useEffect(() => { void MyStanding.load(); }, []);
  const standing = standingView(useStoreState(myStandingStore)) as { pending: string | null } | null;
  // Before the first load there is nothing to say; the pane opens, the fetch
  // starts and the placeholders arrive on the next render. Until then the
  // tab shows its skeleton, so opening History is never a blank pane.
  if (!view) return <HistorySkeleton />;
  if (view.kind === 'loading') return <HistorySkeleton />;
  if (view.kind === 'error') return <div className={GRID_ERROR}>{view.message}</div>;
  if (view.kind === 'empty') {
    return (
      <GroupedList className="mx-0 mt-4" data-history-empty="">
        <ListRow
          chevron={false}
          title={t('leaderboard:history.empty')}
          subtitle={t('leaderboard:history.emptyHint')}
        />
      </GroupedList>
    );
  }
  return (
    <>
      <SeasonProgress id="tc-se-history-summary" view={view.progress} className="mb-1" />
      {standing && standing.pending ? (
        <p
          className="mt-2 mb-1 text-sm font-medium text-zinc-700 dark:text-zinc-300"
          data-history-pending=""
        >
          {standing.pending}
        </p>
      ) : null}
      {/*
          How points work: when they are credited, what makes an action
          qualify, and how long the standings take to catch up. The app's
          standard card (white, 20px corners, one hairline), its title in
          sentence case and its body in the small muted text.
      */}
      <GroupedList className="mx-0 mt-2 mb-1" id="tc-se-history-how" data-history-how="">
        <div className="px-4 py-3.5">
          <p className="mb-2 text-[15px] font-semibold text-zinc-900 dark:text-zinc-100">
            {t('leaderboard:history.how.title')}
          </p>
          <p className="mb-1 text-[13px] text-zinc-500 dark:text-zinc-400">{t('leaderboard:history.how.credited')}</p>
          <p className="mb-1 text-[13px] text-zinc-500 dark:text-zinc-400">{t('leaderboard:history.how.qualifies')}</p>
          <p className="text-[13px] text-zinc-500 dark:text-zinc-400">{t('leaderboard:history.how.standings')}</p>
        </div>
      </GroupedList>
      <Group groupKey="done" heading={t('leaderboard:history.groups.done')} cards={view.done} />
      <Group groupKey="progress" heading={t('leaderboard:history.groups.progress')} cards={view.progressGroup} />
    </>
  );
}
