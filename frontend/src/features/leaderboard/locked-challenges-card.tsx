/**
 * The challenges setup still hides, as one placeholder: a dashed card the size
 * of a challenge card with a hatched lock tile and one fact, how many there
 * are ("6 challenges locked") and what opens them ("Finish setup to unlock").
 * Nothing about them is shown, because the server does not send them until
 * setup is finished; it sends only the count. The second line is the unlock
 * note, so a surface that draws this card does not repeat the note beneath.
 *
 * SHARED like ./challenge-card.tsx: the Challenges tab draws it after the
 * Setup group and Home's block after its setup cards. It draws nothing for a
 * count below one, so a payload without the count simply has no placeholder.
 *
 * The corners follow the card's: the outer 24px of `rounded-3xl`, and the tile
 * 11px, which is the outer radius less the 12px padding and the 1px border.
 */

import type { ReactNode } from 'react';

import { LockIcon } from '@/components/ui/icons';

const CARD = 'flex min-h-[6.5rem] items-center gap-3 rounded-3xl border border-dashed border-zinc-300 '
  + 'bg-white/40 p-3 dark:border-zinc-700 dark:bg-white/[0.03]';
const TILE = 'flex h-20 w-20 shrink-0 items-center justify-center rounded-[0.6875rem] text-zinc-500 dark:text-zinc-400 '
  + 'bg-[repeating-linear-gradient(135deg,rgb(24_24_27/0.05)_0_6px,rgb(24_24_27/0.02)_6px_12px)] '
  + 'dark:bg-[repeating-linear-gradient(135deg,rgb(255_255_255/0.07)_0_6px,rgb(255_255_255/0.03)_6px_12px)]';
const TEXT = 'flex min-w-0 flex-col';
const TITLE = 'truncate text-base font-medium leading-6 text-zinc-600 dark:text-zinc-300';
const HINT = 'truncate text-[0.8125rem] leading-5 text-zinc-500 dark:text-zinc-400';

export function LockedChallengesCard({ count, className }: { count: number; className?: string }): ReactNode {
  const n = Math.floor(Number(count) || 0);
  if (n < 1) return null;
  return (
    <div className={className ? `${className} ${CARD}` : CARD}>
      <div aria-hidden="true" className={TILE}>
        <LockIcon className="h-[1.625rem] w-[1.625rem]" />
      </div>
      <div className={TEXT}>
        <p className={TITLE}>{n === 1 ? '1 challenge locked' : `${n} challenges locked`}</p>
        <p className={HINT}>Finish setup to unlock</p>
      </div>
    </div>
  );
}
