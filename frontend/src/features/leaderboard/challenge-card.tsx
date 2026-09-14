// The Challenges tab's card parts — ITERATION 03's challenge card, drawn in
// the shell's own tokens rather than the board's.
//
// ── What maps to what ──────────────────────────────────────────────────
//
// The board's cream ground, pastel tiles and hand-picked hexes are not here.
// Its rail blue is the shell accent (`violet-*`, which tailwind.config.js
// remaps to BLUE) at a quarter strength so the label on top stays readable;
// its success green is the emerald every other "completed" mark in the shell
// uses; its reward tan is the amber of the shell's medium-priority chip. No
// hue is added and nothing in tailwind.config.js moved.
//
// ── One card, two surfaces ─────────────────────────────────────────────
//
// `ChallengeCard` below is the whole card, and both places that list
// challenges draw it: the Leaderboard screen's Challenges tab
// (./challenges-pane.tsx) and Home's Challenges block
// (../home/panels/challenges.tsx). They used to be two designs of one thing —
// a white card with a rail here, a tinted card with a count capsule and a
// deadline on Home — and a viewer moving between them read two different
// states for the same challenge. Each surface keeps its own root class
// (`tc-se-card`, `home-challenge-card`) because declared checks and legacy
// hooks select on them; everything inside is this file.
//
// It is not in @/components/ui: it is a domain card, not a primitive.
// `Chip` and `ActionPill` in the ui kit are `aria-pressed` toggle buttons,
// which a reward label is not, so neither is reused.
//
// ── Copy never wraps ───────────────────────────────────────────────────
//
// The rail and the chip share one row, and the row is narrow: a 360px phone
// leaves the card's body about 210px, a 320px phone 170px. Measured at 210px,
// "Done" + "Earned 1,000 pts" and "Started" + "Up to 2,000 pts" fit on one
// line whole with 0.5rem pill padding. Below that no width cap works — a 60%
// cap left "D…" of the state word at 320px — so the row (in
// ./challenges-pane.tsx) is `flex-wrap`: the rail is `flex-auto` from its
// label's own width and the chip `shrink-0` at its own, and when the two do
// not fit side by side the chip moves to a second line. Text itself never
// wraps: each pill is one line, and only a label or reward longer than the
// whole row ends in an ellipsis. The labels are composed short in
// ./topochain-challenges.js (`_stateOf`), because the icon already says which
// state it is.
//
// Every class below is a complete literal: Tailwind's extractor is a regex
// over source text, so a computed class name never compiles.

import type { HTMLAttributes, ReactNode } from 'react';

import { IconTile } from '@/components/ui/icon-tile';
import { CheckIcon } from '@/components/ui/icons';

export type ChallengeState = 'new' | 'progress' | 'done';

const RAIL = 'relative flex h-8 min-w-0 flex-auto items-center gap-1.5 overflow-hidden rounded-lg px-2 '
  + 'text-[0.8125rem] font-medium';
const RAIL_TONE: Record<ChallengeState, string> = {
  new: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  progress: 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100',
  done: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
};
const RAIL_FILL = 'absolute inset-y-0 left-0 bg-violet-500/25';
const RAIL_LABEL = 'relative min-w-0 truncate';

const CHIP = 'flex h-8 max-w-full shrink-0 items-center rounded-lg px-2 text-[0.8125rem] font-medium';
const CHIP_REWARD = 'bg-amber-500/10 text-amber-800 dark:text-amber-300';
const CHIP_EARNED = 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400';


// The three state marks. The board draws an empty ring, a dashed ring and a
// ringed check; the first two are borders rather than glyphs, so the icon
// set gains nothing it would have to keep out of the prerender.
function StateMark({ state }: { state: ChallengeState }): ReactNode {
  if (state === 'done') {
    return (
      <span aria-hidden="true" className="relative flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 border-current">
        <CheckIcon className="h-2.5 w-2.5" strokeWidth="3" />
      </span>
    );
  }
  if (state === 'progress') {
    return (
      <span aria-hidden="true" className="relative h-4 w-4 shrink-0 rounded-full border-2 border-dashed border-violet-600 dark:border-violet-400" />
    );
  }
  return <span aria-hidden="true" className="relative h-4 w-4 shrink-0 rounded-full border-2 border-current" />;
}

// The rail. Always a progressbar to assistive tech; `aria-valuenow` only
// when the fill is a real number — an indeterminate rail says so by leaving
// it out, which is what the ARIA pattern means by indeterminate. An empty
// label draws the bare ring, for a challenge whose progress this screen
// cannot see (block production; see _stateOf).
export function ProgressRail({ state, label, fill, name }: {
  state: ChallengeState;
  label: string;
  fill: number | null;
  name: string;
}): ReactNode {
  const pct = fill == null ? null : Math.round(Math.max(0, Math.min(fill, 1)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : pct}
      // The spoken value is the visible one: a rounded percent says 0% at
      // 1/500 and 100% at 499/500.
      aria-valuetext={label || undefined}
      aria-label={label ? (name ? `${name}: ${label}` : label) : name}
      className={`${RAIL} ${RAIL_TONE[state]}`}
    >
      {state === 'progress' && pct ? <span className={RAIL_FILL} style={{ width: `${pct}%` }} /> : null}
      <StateMark state={state} />
      {label ? <span className={RAIL_LABEL}>{label}</span> : null}
    </div>
  );
}

// The reward, or — on a finished challenge the viewer scored on — what they
// earned. A static label, never a control.
export function RewardChip({ text, earned = false }: { text: string; earned?: boolean }): ReactNode {
  return (
    <span className={`${CHIP} ${earned ? CHIP_EARNED : CHIP_REWARD}`}>
      <span className="min-w-0 truncate">{text}</span>
    </span>
  );
}

// The 5rem artwork tile, a neutral face holding the challenge kind's icon when
// the payload carries one (Home's does, from `challenge_kinds.icon`) and empty
// otherwise, until per-challenge illustrations land. It never holds the
// category: headings name it, and a category word in an 80px square was the
// "ONBOARDIN / G" break on both surfaces.
export function ChallengeTile({ icon = null }: { icon?: string | null }): ReactNode {
  return (
    <IconTile size="xl" aria-hidden="true">
      {icon ? <span className="text-[2.5rem] leading-none">{icon}</span> : null}
    </IconTile>
  );
}

export type ChallengeCardView = {
  goal: string;
  task?: string | null;
  reward: string | null;
  icon?: string | null;
  state: ChallengeState;
  stateLabel: string;
  fill: number | null;
  earned: string | null;
};

const CARD = 'flex items-center gap-3 bg-white dark:bg-zinc-900 rounded-2xl border border-zinc-200 '
  + 'dark:border-zinc-800 p-3 cursor-pointer hover:border-violet-400 dark:hover:border-violet-600 '
  + 'transition-colors';

// The card: tile, goal, one truncating task line, and the rail + reward row.
// The row wraps the chip to a second line when the two pills do not fit (a
// 320px phone); no text in it ever wraps. The task is a visible line, never a
// tooltip — both surfaces are mobile first, and a phone has no hover.
export function ChallengeCard({ view, className, ...rest }: {
  view: ChallengeCardView;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className'>): ReactNode {
  const chip = view.earned || view.reward;
  return (
    <div className={className ? `${className} ${CARD}` : CARD} {...rest}>
      <ChallengeTile icon={view.icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="truncate text-base font-medium text-zinc-900 dark:text-zinc-100">{view.goal}</div>
        {view.task ? (
          <p className="truncate text-[0.8125rem] text-zinc-500 dark:text-zinc-400">{view.task}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          <ProgressRail state={view.state} label={view.stateLabel} fill={view.fill} name={view.goal} />
          {chip ? <RewardChip text={chip} earned={!!view.earned} /> : null}
        </div>
      </div>
    </div>
  );
}
