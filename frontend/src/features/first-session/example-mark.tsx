/**
 * The drawn marks of the front three examples (./examples.ts `mark`), on
 * their tiles on "What do you want to make?" and in the story's list: the
 * tier list's chart (./tier-chart.tsx), a game board and a checklist
 * (#4403: the game and the organizer were 🎮 and 📋 beside a drawn chart).
 *
 * One set, so each is drawn as the tier chart is: boxes rather than a
 * glyph, at the emoji's size (29 by 30), grey for the items in the pair the
 * chart's items use, and the chart's own tier colours for the few that
 * count, the same in both themes. No colour here is new.
 *
 * The game board is three rows of three squares with three pieces on its
 * diagonal. The checklist is three lines, each after a small box: the first
 * box is filled and ticked (the shell's own check, icons.tsx: a feature
 * file draws no glyph of its own), the other two are outlines.
 */
import { CheckIcon } from '@/components/ui/icons';

import type { ExampleMarkKey } from './examples';
import { TierChart } from './tier-chart';

const CELL = 'h-2 w-2 rounded-[1.5px]';
// The board, row by row: a piece in a tier colour, or an empty square.
const BOARD = [
  'bg-[#ff7f7f]', 'bg-zinc-300 dark:bg-zinc-600', 'bg-zinc-300 dark:bg-zinc-600',
  'bg-zinc-300 dark:bg-zinc-600', 'bg-[#ffdf7f]', 'bg-zinc-300 dark:bg-zinc-600',
  'bg-zinc-300 dark:bg-zinc-600', 'bg-zinc-300 dark:bg-zinc-600', 'bg-[#ff7f7f]',
] as const;

export function GameBoard() {
  return (
    <span data-game-mark="" className="grid h-[30px] w-[29px] grid-cols-3 content-center gap-[2.5px]" aria-hidden="true">
      {BOARD.map((fill, i) => <span key={i} className={`${CELL} ${fill}`} />)}
    </span>
  );
}

const LINE = 'h-1.5 rounded-[1.5px] bg-zinc-300 dark:bg-zinc-600';
const BOX = 'h-[7px] w-[7px] shrink-0 rounded-[2px]';
// The lines after the first, each a little shorter than the row is wide.
const OPEN = ['w-[15px]', 'w-[17px]'] as const;

export function Checklist() {
  return (
    <span data-organizer-mark="" className="flex h-[30px] w-[29px] flex-col" aria-hidden="true">
      <span className="flex h-2.5 items-center gap-[3px]">
        <span className={`${BOX} bg-[#ff7f7f] text-white`}>
          <CheckIcon className="block h-[7px] w-[7px]" strokeWidth="4" />
        </span>
        <span className={`w-[19px] ${LINE}`} />
      </span>
      {OPEN.map((width) => (
        <span key={width} className="flex h-2.5 items-center gap-[3px]">
          <span className={`${BOX} border-[1.5px] border-zinc-300 dark:border-zinc-600`} />
          <span className={`${width} ${LINE}`} />
        </span>
      ))}
    </span>
  );
}

export function ExampleMark({ mark }: { mark: ExampleMarkKey }) {
  if (mark === 'game') return <GameBoard />;
  if (mark === 'organizer') return <Checklist />;
  return <TierChart />;
}
