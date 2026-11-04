/**
 * #6221 (3 Nov 2026): a plan card's fold-out, "Before and after · N
 * changes". It starts closed. Opened, each numbered change of the plan shows
 * its line and its own crop, before above after, at a readable size: the box
 * the plan named for it (../../lib/spec-html.ts specChangeCrops), never the
 * whole screen shrunk to a fifth. A change that is on one side only says
 * "Not there before" or "Gone after" on the other. The frames are the
 * plan's sandboxed, script-free ones (`sandbox=""`); nothing is measured in
 * them.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ChevronDownIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { specChangeCrops, type SpecChangeCrop } from '../../lib/spec-html';

// A crop is drawn at most this much of its real size, and no taller than this.
const MAX_SCALE = 0.9;
const MAX_HEIGHT = 240;
// The badge a numbered line and its crop share (bot-plan-view.tsx LINE_BADGE).
const BADGE = 'mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color:var(--state-ok)] text-[11px] font-bold leading-5 text-white';

function CropSide({ crop, side, label }: { crop: SpecChangeCrop; side: 'before' | 'after'; label: string }): ReactNode {
  const t = useMessages('messages');
  const box = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const fit = () => { if (el.clientWidth > 0) setWidth(el.clientWidth); };
    fit();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, []);
  const { screen } = crop;
  const [x, y, w, h] = screen.focus || [0, 0, screen.width, Math.min(screen.height, 400)];
  const scale = width ? Math.min(MAX_SCALE, width / w) : 0;
  const height = scale ? Math.max(48, Math.min(MAX_HEIGHT, Math.round(h * scale))) : 0;
  if (crop.missing === side) {
    return (
      <div className="flex h-11 w-full items-center justify-center rounded-lg text-[13px] text-zinc-500 shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:text-zinc-400" data-plan-crop-missing={side}>
        {side === 'before' ? t('messages:bot.plan.crops.notBefore') : t('messages:bot.plan.crops.goneAfter')}
      </div>
    );
  }
  return (
    <div ref={box} className="relative w-full overflow-hidden rounded-lg bg-white shadow-[inset_0_0_0_1px_var(--app-sheet-line)] dark:bg-zinc-900"
      style={{ height: height || 120 }} role="img" aria-label={label} data-plan-crop={side}>
      {scale ? (
        <iframe
          sandbox=""
          referrerPolicy="no-referrer"
          tabIndex={-1}
          aria-hidden="true"
          title={label}
          srcDoc={side === 'before' ? screen.before : screen.after}
          className="pointer-events-none absolute start-0 top-0 origin-top-left border-0"
          style={{ width: screen.width, height: screen.height, transform: `scale(${scale}) translate(${-x}px, ${-y}px)` }}
        />
      ) : null}
    </div>
  );
}

/**
 * #6269, pure: whether the lines above the fold-out are the crops' own
 * numbered changes. Only then does the fold-out count them; beside the
 * older unnumbered lines a count would name changes that are not showing.
 */
export function planCropsNumbered(crops: Array<{ n: number }>, lines: Array<{ n: number | null }>): boolean {
  return lines.length === crops.length
    && lines.every((line) => Number.isInteger(line.n))
    && crops.every((crop) => lines.some((line) => line.n === crop.n));
}

/**
 * The fold-out, from the plan's HTML; nothing when it drew no numbered
 * change. #6269: "Before and after · N changes" only when the card's lines
 * are the changes' own numbered lines; beside anything else (the older
 * unnumbered lines) it says "Before and after" with no count, so the count
 * never names lines that are not showing.
 */
export function PlanCrops({ html, lines = [] }: {
  html: string | null;
  lines?: Array<{ n: number | null }>;
}): ReactNode {
  const t = useMessages('messages');
  // Parsed after mount: the first render (a prerender's, a hydration's) has none.
  const [crops, setCrops] = useState<SpecChangeCrop[]>([]);
  useEffect(() => { setCrops(html ? specChangeCrops(html) : []); }, [html]);
  if (!crops.length) return null;
  const numbered = planCropsNumbered(crops, lines);
  return (
    <details className="mt-1 shadow-[inset_0_1px_0_var(--app-sheet-line)]" data-plan-crops={crops.length}>
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between text-[0.9375rem] font-semibold text-violet-700 dark:text-violet-300 [&::-webkit-details-marker]:hidden">
        <span>{numbered
          ? t('messages:bot.plan.crops.summary', { count: crops.length })
          : t('messages:bot.plan.crops.summaryPlain')}</span>
        <ChevronDownIcon className="h-4 w-4" aria-hidden="true" />
      </summary>
      <ol className="mb-2 flex flex-col">
        {crops.map((crop, i) => (
          <li key={crop.n} className={i === 0 ? 'flex flex-col gap-2 py-3' : 'flex flex-col gap-2 py-3 shadow-[inset_0_1px_0_var(--app-sheet-line)]'} data-plan-crop-change={crop.n}>
            <div className="flex gap-2 text-[0.9375rem] leading-[22px] text-zinc-900 dark:text-zinc-100">
              <span aria-hidden="true" className={BADGE}>{crop.n}</span>
              <span className="min-w-0 flex-1">{crop.text}</span>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t('messages:bot.plan.crops.before')}</span>
              <CropSide crop={crop} side="before" label={t('messages:bot.plan.crops.beforeLabel', { number: String(crop.n) })} />
              <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t('messages:bot.plan.crops.after')}</span>
              <CropSide crop={crop} side="after" label={t('messages:bot.plan.crops.afterLabel', { number: String(crop.n) })} />
            </div>
          </li>
        ))}
      </ol>
    </details>
  );
}
