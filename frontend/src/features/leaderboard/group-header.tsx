/**
 * The header over one group of challenge cards: the group's name, and a meta
 * string that says how far through the group the viewer is and when it closes
 * ("1/4 · 3d left", "1/3 · no deadline", "2/2 done").
 *
 * The ITERATION 03 board's group header, SHARED like ./challenge-card.tsx and
 * ./season-progress.tsx. The Challenges tab draws it as a disclosure: the whole
 * translucent row is the tap target, not the chevron, and a finished group
 * starts collapsed. Home draws the same row without a toggle and without a
 * count, because the four cards Home receives are not the whole group.
 *
 * The caller composes `meta` in full; this file adds no separators, so no
 * sibling text nodes need a space between them. The heading arrives in
 * sentence case and is uppercased by CSS, so a screen reader says the words.
 */

import type { ReactNode } from 'react';

import { ChevronDownIcon, ChevronUpIcon } from '@/components/ui/icons';

const ROW = 'flex min-h-[3.25rem] w-full min-w-0 items-center justify-between gap-3 rounded-2xl '
  + 'bg-white/60 px-3.5 text-left dark:bg-white/[0.06]';
const TOGGLE = ' cursor-pointer transition-colors hover:bg-white/80 dark:hover:bg-white/10 '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500';
// The name wins the row's width. At 320px "Season challenges" beside
// "0/2 · no deadline" and the chevron is wider than the row, and the name is
// the part a reader cannot recover from the cards, so the meta truncates
// first. The title still stops at the row, where the name truncates too.
const TITLE = 'flex min-w-0 max-w-full shrink-0 items-center gap-2';
const HEADING = 'min-w-0 truncate text-[0.8125rem] font-semibold uppercase tracking-wide text-zinc-900 dark:text-zinc-100';
const DOT = 'h-2 w-2 shrink-0 rounded-full bg-emerald-500';
const END = 'flex min-w-0 items-center gap-2';
const META = 'min-w-0 truncate text-[0.8125rem] font-medium tabular-nums text-zinc-500 dark:text-zinc-400';
const CHEVRON = 'h-[1.125rem] w-[1.125rem] shrink-0 text-zinc-500 dark:text-zinc-400';

export function GroupHeader({
  heading, meta = null, allDone = false, expanded = true, controlsId, onToggle, className,
}: {
  heading: string;
  meta?: string | null;
  allDone?: boolean;
  /** Only read with `onToggle`. */
  expanded?: boolean;
  /** The id of the element the toggle shows and hides. */
  controlsId?: string;
  /** Present: a disclosure button. Absent: a static row (Home). */
  onToggle?: () => void;
  className?: string;
}): ReactNode {
  const body = (
    <>
      <span className={TITLE}>
        {allDone ? <span aria-hidden="true" className={DOT} /> : null}
        <span className={HEADING}>{heading}</span>
      </span>
      <span className={END}>
        {meta ? <span className={META}>{meta}</span> : null}
        {onToggle
          ? (expanded
            ? <ChevronUpIcon aria-hidden="true" className={CHEVRON} />
            : <ChevronDownIcon aria-hidden="true" className={CHEVRON} />)
          : null}
      </span>
    </>
  );
  return (
    <h3 className={className}>
      {onToggle ? (
        <button
          type="button"
          className={ROW + TOGGLE}
          aria-expanded={expanded}
          aria-controls={controlsId}
          onClick={onToggle}
        >
          {body}
        </button>
      ) : (
        <div className={ROW}>{body}</div>
      )}
    </h3>
  );
}
