/**
 * The AI-credit row in Settings → Anthropic API key, as the only writer
 * below `#drawer-row-ai-budget`. See ./ai-budget-store.ts for the split.
 *
 * The row and its slot are part of the prerendered shell (the section is
 * `features/settings/sections/api-key.tsx`), so this renders the same empty
 * row the hand-written markup shipped until ./ai-credit.js publishes.
 */

import type { ReactNode } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { aiBudgetStore } from './ai-budget-store.js';

export type MeterTone = 'none' | 'dim' | 'high' | 'mid' | 'low' | 'byok' | 'warn';

/** One coloured fragment. `none` renders bare text, with no span of its own. */
export interface MeterRun {
  tone: MeterTone;
  text: string;
}

export interface MeterPart {
  runs: MeterRun[];
  /**
   * `.drawer-meter-part` is `white-space: nowrap`, so a part is what CANNOT
   * break — which is why each "· figure" keeps its separator. `bare` skips
   * the wrapper for the two runs the original left unwrapped.
   */
  bare?: boolean;
  /** `data-credits-remaining` — the hook a declared check aims at. */
  remaining?: boolean;
}

export interface AiBudgetView {
  title: string;
  /** A tone on the meter itself, for the one state that is all one colour. */
  tone?: MeterTone;
  parts: MeterPart[];
}

export interface AiBudgetState {
  view: AiBudgetView | null;
  hidden: boolean;
}

/** Complete literals — see the store's header on why these live here. */
const TONE: Record<MeterTone, string> = {
  none: '',
  dim: 'drawer-meter-dim',
  // The meter's ground is ROW's `bg-zinc-100 dark:bg-zinc-800`, not a card, so
  // these are measured there (APCA-W3 0.1.9, hexes read from
  // tailwind.config.js). The -400 dark halves were WCAG-era: red-400 measured
  // Lc 40.4 on zinc-800 against red-700's 70.3 in light — 29.9 apart, a body
  // ink in one theme and a non-content one in the other. The tuned status
  // ramps solve 700/200 to parity, and it holds on this ground too:
  // red 70.3/77.6 (7.3 apart), amber 80.4/77.9 (2.5 apart).
  high: 'text-red-700 dark:text-red-200',
  mid: 'text-amber-800 dark:text-amber-200',
  // Stock emerald is gone: meadow is the product's one green, and the pair
  // takes the same 700/200 shape its neighbours do. Measured on THIS
  // ground (ROW's zinc-100 / zinc-800), same APCA-W3 0.1.9 port: emerald read
  // Lc 67.2 light and -61.8 dark — both under the body minimum, in a row
  // where the red and amber halves clear it — and meadow-700 / meadow-200
  // read 73.1 / -80.5. The remaining 1.9 to the floor on the light half is
  // the ramp's, not this call site's: 600 is worse (65.7) and 800 would
  // break the 700/200 spelling every other green in the product uses.
  low: 'text-meadow-700 dark:text-meadow-200',
  byok: 'text-meadow-700 dark:text-meadow-200',
  warn: 'text-amber-800 dark:text-amber-200',
};

const ROW = 'flex items-center gap-2 flex-wrap rounded-lg bg-zinc-100 dark:bg-zinc-800'
  + ' border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-3'
  + ' text-zinc-600 dark:text-zinc-300';

function Runs({ part }: { part: MeterPart }): ReactNode {
  return (
    <>
      {part.runs.map((r, i) => (r.tone === 'none'
        ? r.text
        : <span key={i} className={TONE[r.tone]}>{r.text}</span>))}
    </>
  );
}

export function AiBudgetMeter({ view }: { view: AiBudgetState['view'] }): ReactNode {
  if (!view) return null;
  return (
    <span className={view.tone ? `ai-budget-meter drawer-meter ${TONE[view.tone]}` : 'ai-budget-meter drawer-meter'} title={view.title}>
      {view.parts.map((part, i) => {
        // A real space BETWEEN parts, never inside one: the parts are
        // `nowrap`, so this is the only place the value may break.
        const body = part.bare
          ? <Runs key={`p${i}`} part={part} />
          : (
            <span
              key={`p${i}`}
              className="drawer-meter-part"
              {...(part.remaining ? { 'data-credits-remaining': '1' } : null)}
            >
              <Runs part={part} />
            </span>
          );
        return i ? [' ', body] : body;
      })}
    </span>
  );
}

/** The whole row: its own `hidden`, its label, and the slot the meter fills. */
export function AiBudgetRow(): ReactNode {
  const { view, hidden } = useStoreState<AiBudgetState>(aiBudgetStore);
  return (
    <div id="drawer-row-ai-budget" className={hidden ? `${ROW} hidden` : ROW}>
      <span className="font-medium text-zinc-700 dark:text-zinc-300">AI credit</span>
      <span id="ai-budget-slot" className="ml-auto grow min-w-0 text-right">
        <AiBudgetMeter view={view} />
      </span>
    </div>
  );
}
