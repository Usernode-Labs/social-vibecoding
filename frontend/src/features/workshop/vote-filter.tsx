/**
 * #6199: the vote-type filter above Needs you.
 *
 * The feed puts the votes that decide FIRST (#5365, the server's
 * `decidingFirst`), and then everything else. A viewer who swiped past the
 * one change their vote decides — to look for its preview, which the
 * cross-project feed does not offer — came back to the next row, an advisory
 * one, and the deciding vote above looked gone. Two things answer that here:
 *
 * - A row's KIND comes from the marks the feed already sends: `advisory`
 *   (the viewer is outside the change's deciders, #4747) and `uncounted` (a
 *   test account's vote, recorded but not counted). Either one makes the
 *   vote advisory; everything else — a plain change, a group decision, a
 *   ballot, the bot's question — decides.
 * - The chips narrow the feed to one kind: All, Votes that decide, Advisory,
 *   each with its count. All is picked whenever Needs you opens (the choice
 *   is not remembered), and the chips show only when the feed holds both
 *   kinds, because one kind alone gives nothing to choose between.
 *
 * They look and behave like the All / Public / Private / Just you chips on
 * All communities (features/workshop/index.tsx's AudienceChips): the same
 * Chip primitive at its `bar` size, selection the solid inversion, a count
 * beside the word, and a zero chip hidden.
 */

import { Chip, ChipRail } from '@/components/ui/chip';

import { useMessages } from '../../lib/i18n/react';
import type { NeedsFeedItem } from './needs-reel';

/** Which chip is pressed above the feed. */
export type VoteFilter = 'all' | 'deciding' | 'advisory';
/** The two kinds a vote falls into. */
export type VoteType = 'deciding' | 'advisory';

/**
 * A feed item's kind: advisory when the server marks it so, either because
 * the viewer is outside the change's deciders or because a test account's
 * vote is recorded but not counted. Everything else decides.
 */
export function itemVoteType(item: NeedsFeedItem): VoteType {
  return item.advisory || item.uncounted ? 'advisory' : 'deciding';
}

/** A Needs you row's kind, from the flags `reelRows` puts on its Yes. */
export function rowVoteType(row: { yes?: { advisory?: boolean; uncounted?: boolean } | null }): VoteType {
  return row.yes && (row.yes.advisory || row.yes.uncounted) ? 'advisory' : 'deciding';
}

/**
 * The list narrowed to the pressed kind, in the order it came. `'all'`
 * returns the very same list, so nothing is copied when the filter is off.
 */
export function filterByVoteType<T>(list: readonly T[], filter: VoteFilter, typeOf: (item: T) => VoteType): T[] {
  return filter === 'all' ? (list as T[]) : list.filter((item) => typeOf(item) === filter);
}

/** How many items each chip shows. */
export function voteTallies<T>(list: readonly T[], typeOf: (item: T) => VoteType): Record<VoteFilter, number> {
  const out: Record<VoteFilter, number> = { all: list.length, deciding: 0, advisory: 0 };
  for (const item of list) out[typeOf(item)] += 1;
  return out;
}

/** Each chip's words, as message ids. */
const CHIP_LABELS: Record<VoteFilter, string> = {
  all: 'communities:needsYou.filter.all',
  deciding: 'communities:needsYou.filter.deciding',
  advisory: 'communities:needsYou.filter.advisory',
};

/** Each chip's accessible name, with its count. */
const CHIP_COUNTS: Record<VoteFilter, string> = {
  all: 'communities:needsYou.filter.allCount',
  deciding: 'communities:needsYou.filter.decidingCount',
  advisory: 'communities:needsYou.filter.advisoryCount',
};

/** The order they are drawn in: All, then the two kinds it splits into. */
const FILTERS: readonly VoteFilter[] = ['all', 'deciding', 'advisory'];

/**
 * The chips. Nothing is drawn unless the feed holds both kinds: a feed of
 * only advisory votes has nothing to narrow to.
 */
export function VoteTypeChips({ tallies, pressed, onPress }: {
  tallies: Record<VoteFilter, number>;
  pressed: VoteFilter;
  onPress: (key: VoteFilter) => void;
}) {
  const t = useMessages('communities');
  if (!(tallies.deciding > 0 && tallies.advisory > 0)) return null;
  return (
    <ChipRail
      className="needs-vote-chips gap-2 pt-0 pb-3"
      role="group"
      aria-label={t('communities:needsYou.filter.label')}
      data-needs-vote-chips=""
    >
      {FILTERS.map((key) => {
        const count = tallies[key];
        return (
          <Chip
            key={key}
            size="bar"
            className={key !== 'all' && !count ? 'hidden' : 'gap-1.5 px-3'}
            selected={pressed === key}
            aria-label={t(CHIP_COUNTS[key], { count })}
            onClick={() => onPress(key)}
            {...{ 'data-needs-vote-chip': key }}
          >
            <span>{t(CHIP_LABELS[key])}</span>
            <span className="tabular-nums opacity-60" aria-hidden="true">{count}</span>
          </Chip>
        );
      })}
    </ChipRail>
  );
}
