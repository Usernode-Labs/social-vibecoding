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
  high: 'text-red-700 dark:text-red-400',
  mid: 'text-amber-800 dark:text-amber-400',
  low: 'text-emerald-700 dark:text-emerald-400',
  byok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-800 dark:text-amber-400',
};

const ROW = 'flex items-center gap-2 flex-wrap rounded-lg bg-zinc-100 dark:bg-zinc-800'
  + ' border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-xs mb-3'
  + ' text-zinc-600 dark:text-zinc-400';

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
