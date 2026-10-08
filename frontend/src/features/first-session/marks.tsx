/**
 * The game and organizer marks (./examples.ts `mark`), on their tiles on
 * "What do you want to make?" and in the story's list, beside the tier
 * chart's (./tier-chart.tsx): a gamepad and a checklist in miniature.
 *
 * Drawn in the tier chart's conventions: boxes rather than a glyph, at the
 * size of the emoji they replace (29 by 30), so the 44 by 44 tile centres
 * them exactly as it centred it. The greys are the app's zinc pairs, and the
 * one colour each mark carries is the app's blue accent, so no mark
 * introduces a colour the shell does not already use.
 */

import type { Template } from './examples';
import { TierChart } from './tier-chart';

/** A gamepad face: a rounded body, a direction pad on the left, two buttons on the right. */
export function GameMark() {
  return (
    <span data-game-mark="" className="flex h-[30px] w-[29px] items-center justify-center" aria-hidden="true">
      <span className="flex h-[20px] w-[29px] items-center justify-between rounded-[8px] bg-zinc-200 px-[5px] dark:bg-zinc-700">
        <span className="relative h-[9px] w-[9px]">
          <span className="absolute left-[3px] top-0 h-[9px] w-[3px] rounded-[1.5px] bg-zinc-500 dark:bg-zinc-300" />
          <span className="absolute left-0 top-[3px] h-[3px] w-[9px] rounded-[1.5px] bg-zinc-500 dark:bg-zinc-300" />
        </span>
        <span className="flex items-center gap-[3px]">
          <span className="h-[4px] w-[4px] rounded-full bg-zinc-500 dark:bg-zinc-300" />
          <span className="h-[4px] w-[4px] rounded-full bg-violet-500 dark:bg-violet-400" />
        </span>
      </span>
    </span>
  );
}

/** A checklist in miniature: a sheet of three rows, its first box done. */
export function OrganizerMark() {
  return (
    <span data-organizer-mark="" className="flex h-[30px] w-[29px] items-center justify-center" aria-hidden="true">
      <span className="flex h-[26px] w-[21px] flex-col justify-between rounded-[3px] bg-white py-[4px] px-[3px] shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900">
        {[true, false, false].map((done, row) => (
          <span key={row} className="flex h-[5px] items-center gap-[2px]">
            <span className={`h-[5px] w-[5px] shrink-0 rounded-[1.5px] ${done ? 'bg-violet-500 dark:bg-violet-400' : 'ring-1 ring-inset ring-zinc-400 dark:ring-zinc-500'}`} />
            <span className="h-[2px] flex-1 rounded-[1px] bg-zinc-300 dark:bg-zinc-600" />
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * The mark a template's tile draws: its drawn picture where it has one, else
 * its emoji (which stays what the made project's icon is).
 */
export function TemplateMark({ t }: { t: Template }) {
  if (t.mark === 'chart') return <TierChart />;
  if (t.mark === 'game') return <GameMark />;
  if (t.mark === 'organizer') return <OrganizerMark />;
  return <>{t.emoji}</>;
}
