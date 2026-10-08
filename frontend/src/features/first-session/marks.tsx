/**
 * The three examples' marks (./examples.ts `mark`), on their tiles on "What
 * do you want to make?" and in the story's list: small pictures of the
 * thing, in the tier chart's style (./tier-chart.tsx, the tier list's).
 *
 * Boxes rather than a glyph: each is a picture of the thing, at the size of
 * the emoji it stands in for (29 by 30), in the app's zinc greys with one
 * colour each. The one colour is the same in both themes, the way the tier
 * chart's colours are: the game's buttons in the tier chart's red, the
 * organizer's ticks a soft green.
 */

import { TierChart } from './tier-chart';

export function GameMark() {
  return (
    <span data-game-mark="" className="relative block h-[18px] w-[30px] rounded-[7px] bg-zinc-300 dark:bg-zinc-600" aria-hidden="true">
      {/* The cross, on the left. */}
      <span className="absolute left-[5px] top-[7px] h-[3px] w-[8px] rounded-[1px] bg-zinc-500 dark:bg-zinc-400" />
      <span className="absolute left-[7.5px] top-[4.5px] h-[8px] w-[3px] rounded-[1px] bg-zinc-500 dark:bg-zinc-400" />
      {/* Two buttons, offset diagonally, on the right. */}
      <span className="absolute left-[18px] top-[8px] h-1 w-1 rounded-full bg-[#ff7f7f]" />
      <span className="absolute left-[22px] top-1 h-1 w-1 rounded-full bg-[#ff7f7f]" />
    </span>
  );
}

const TICKS = [true, true, false] as const;
const LINES = ['w-[19px]', 'w-[15px]', 'w-[17px]'] as const;

export function OrganizerMark() {
  return (
    <span data-organizer-mark="" className="flex h-[30px] w-[29px] flex-col" aria-hidden="true">
      {TICKS.map((ticked, row) => (
        <span key={row} className="flex h-2.5 items-center gap-[3px]">
          <span className={`h-[7px] w-[7px] rounded-[2px] ${ticked ? 'bg-[#8fd18f]' : 'bg-zinc-300 dark:bg-zinc-600'}`} />
          <span className={`h-1.5 rounded-[1.5px] bg-zinc-300 dark:bg-zinc-600 ${LINES[row]}`} />
        </span>
      ))}
    </span>
  );
}

/** The drawn mark a template's tile shows, in place of its emoji. */
export function ExampleMark({ mark }: { mark: 'tier' | 'game' | 'organizer' }) {
  if (mark === 'game') return <GameMark />;
  if (mark === 'organizer') return <OrganizerMark />;
  return <TierChart />;
}