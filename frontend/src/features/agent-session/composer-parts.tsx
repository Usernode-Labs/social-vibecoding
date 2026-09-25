/**
 * The pieces of the agent-session composer's bottom row (#2779 follow-up,
 * the "composer, reworked" design): the model pill and the sheet it opens,
 * the credits pill and the ring it draws around Send, and the files sent
 * with a message as the transcript shows them.
 *
 * None of this is in the prerendered shell: the composer mounts with a
 * conversation, so nothing here has a hydration twin to match.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import { CheckIcon, ChevronRightIcon, XIcon } from '@/components/ui/icons';
import { ProgressHalo } from '@/components/ui/progress-ring';

import type { AiBudgetFigures } from '../header/ai-budget';
import { attachmentUrl, type AgentAttachment } from './api';
import { formatSize } from './attachments';
import { ANTHROPIC_PREFIX, OPENROUTER_PREFIX, type PickerOption } from './model-choice';

// ── Credits ────────────────────────────────────────────────────────────

export type CreditTone = 'green' | 'yellow' | 'red';

export interface CreditView {
  remainingCents: number;
  limitCents: number;
  /** What is left, 0..1. */
  fraction: number;
  tone: CreditTone;
  /** "$38 left", "$4.10 left", "None left". */
  label: string;
  /** For a screen reader and the tooltip: "$38.40 of this week's $50.00 left". */
  description: string;
  weekly: boolean;
  byokCents: number;
}

function dollars(cents: number, exact = false): string {
  if (exact || cents < 1000) return `$${(cents / 100).toFixed(2)}`;
  return `$${Math.floor(cents / 100)}`;
}

/**
 * What the pill and the ring say, from the header's own figures
 * (../header/ai-credit.js). Green while more than 40% of the allowance is
 * left, yellow down to 15%, red below. Nothing for an account with no
 * allowance to spend (locked, unavailable, or no figures yet): the ring would
 * only ever read empty there.
 */
export function creditView(figures: AiBudgetFigures | null | undefined): CreditView | null {
  if (!figures || !(figures.limitCents > 0)) return null;
  if (figures.level === 'locked' || figures.level === 'unavailable') return null;
  const remainingCents = Math.max(0, Math.min(figures.limitCents, Number(figures.remainingCents) || 0));
  const fraction = remainingCents / figures.limitCents;
  const tone: CreditTone = fraction > 0.4 ? 'green' : fraction > 0.15 ? 'yellow' : 'red';
  const window = figures.weekly ? 'this week’s' : 'today’s';
  return {
    remainingCents,
    limitCents: figures.limitCents,
    fraction,
    tone,
    label: remainingCents > 0 ? `${dollars(remainingCents)} left` : 'None left',
    description: `${dollars(remainingCents, true)} of ${window} ${dollars(figures.limitCents, true)} left`,
    weekly: !!figures.weekly,
    byokCents: Number(figures.byokCents) || 0,
  };
}

/** Complete literals: Tailwind reads these from the source. */
const PILL_INK: Record<CreditTone, string> = {
  green: 'text-zinc-900 dark:text-white',
  yellow: 'text-amber-700 dark:text-amber-400',
  red: 'text-red-600 dark:text-red-400',
};
const RING_INK: Record<CreditTone, string> = {
  green: 'text-emerald-500 dark:text-emerald-400',
  yellow: 'text-amber-500 dark:text-amber-400',
  red: 'text-red-500 dark:text-red-400',
};
const RING_STROKE: Record<CreditTone, string> = {
  green: 'stroke-emerald-500 dark:stroke-emerald-400',
  yellow: 'stroke-amber-500 dark:stroke-amber-400',
  red: 'stroke-red-500 dark:stroke-red-400',
};

/** "$38 left" in a gray pill beside Send; it opens the model sheet, which spells it out. */
export function CreditPill({ credit, onOpen }: { credit: CreditView; onOpen: () => void }) {
  return (
    <button
      type="button"
      className={`inline-flex h-8 shrink-0 items-center rounded-full bg-zinc-100 px-3 text-sm font-semibold tabular-nums dark:bg-zinc-700 ${PILL_INK[credit.tone]}`}
      aria-label={`Credits: ${credit.description}`}
      title={credit.description}
      data-agent-session-credits={credit.tone}
      onClick={onOpen}
    >
      {credit.label}
    </button>
  );
}

/**
 * Send, Stop or Save inside a ring of what is left, which empties clockwise
 * from twelve o'clock (@/components/ui/progress-ring.tsx ProgressHalo).
 */
export function CreditRing({ credit, children }: { credit: CreditView | null; children: ReactNode }) {
  if (!credit) return <>{children}</>;
  return (
    <span className="relative inline-flex h-12 w-12 shrink-0 items-center justify-center" data-agent-session-credit-ring={credit.tone}>
      <ProgressHalo fraction={credit.fraction} arcClassName={RING_STROKE[credit.tone]} className="absolute inset-0" />
      {children}
    </span>
  );
}

// ── The model pill and its sheet ────────────────────────────────────────

export function ModelPill({ label, effort = '', disabled, open, onOpen, pillRef }: {
  label: string;
  /** The thinking level, small and muted after the name (#3079); '' shows none. */
  effort?: string;
  disabled: boolean;
  open: boolean;
  onOpen: () => void;
  pillRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <button
      ref={pillRef}
      type="button"
      className="inline-flex h-10 min-w-0 max-w-[12rem] items-center rounded-full bg-zinc-100 px-4 text-[15px] font-medium text-zinc-900 hover:bg-zinc-200 disabled:opacity-60 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={effort ? `Model: ${label}, thinking level ${effort}` : `Model: ${label}`}
      disabled={disabled}
      data-agent-session-model
      onClick={onOpen}
    >
      <span className="truncate">{label}</span>
      {effort ? <span className="ml-1.5 shrink-0 text-xs font-normal text-zinc-500 dark:text-zinc-400" data-agent-session-model-effort>{effort}</span> : null}
    </button>
  );
}

export interface ModelGroup {
  title: string;
  options: PickerOption[];
}

/** The picker's options under the agent that runs them: Claude Code, then Codex. */
export function modelGroups(options: PickerOption[]): ModelGroup[] {
  const claude = options.filter((option) => option.value.startsWith(ANTHROPIC_PREFIX));
  const codex = options.filter((option) => option.value.startsWith(OPENROUTER_PREFIX));
  const other = options.filter((option) => !claude.includes(option) && !codex.includes(option));
  return [
    { title: 'Claude Code', options: claude },
    { title: 'Codex', options: codex },
    { title: 'Other', options: other },
  ].filter((group) => group.options.length);
}

export interface SheetEffort {
  value: string;
  options: PickerOption[];
  onPick: (value: string) => void;
}

/** The sheet's contents, from plain props so a test can draw it. */
export function ModelSheetBody({ groups, value, onPick, effort, credit, onClose, heading = true }: {
  groups: ModelGroup[];
  value: string;
  onPick: (value: string) => void;
  effort: SheetEffort | null;
  credit: CreditView | null;
  onClose: () => void;
  heading?: boolean;
}) {
  const [effortOpen, setEffortOpen] = useState(false);
  const effortLabel = effort ? (effort.options.find((option) => option.value === effort.value)?.label || effort.value) : '';
  const row = 'flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-700/60';
  return (
    <div className="flex flex-col gap-3" data-agent-session-model-sheet>
      {heading ? (
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-zinc-800 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700"
            aria-label="Close"
            onClick={onClose}
          >
            <XIcon className="h-5 w-5" aria-hidden="true" />
          </button>
          <h2 className="mr-[52px] flex-1 text-center text-base font-semibold text-zinc-900 dark:text-zinc-100">Model</h2>
        </div>
      ) : null}
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <p className="px-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{group.title}</p>
          <div className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800">
            {group.options.map((option, index) => {
              const chosen = option.value === value;
              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={chosen}
                  title={option.title || undefined}
                  className={`${row} ${index ? 'border-t border-zinc-100 dark:border-zinc-700' : ''}`}
                  data-agent-session-model-option={option.value}
                  onClick={() => onPick(option.value)}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[15px] font-medium text-zinc-900 dark:text-zinc-100">
                      {option.label}
                      {option.isDefault ? <span className="ml-1.5 text-xs font-normal text-zinc-500 dark:text-zinc-400">default</span> : null}
                    </span>
                    {option.detail ? <span className="text-[13px] text-zinc-500 dark:text-zinc-400">{option.detail}</span> : null}
                  </span>
                  {chosen ? <CheckIcon className="h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {effort ? (
        <div className="overflow-hidden rounded-2xl bg-white dark:bg-zinc-800">
          <button
            type="button"
            className={row}
            aria-expanded={effortOpen}
            data-agent-session-effort
            onClick={() => setEffortOpen((open) => !open)}
          >
            <span className="flex-1 text-[15px] text-zinc-900 dark:text-zinc-100">Thinking level</span>
            <span className="text-[15px] text-zinc-500 dark:text-zinc-400">{effortLabel}</span>
            <ChevronRightIcon className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${effortOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
          {effortOpen ? effort.options.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={option.value === effort.value}
              className={`${row} border-t border-zinc-100 py-2.5 pl-8 dark:border-zinc-700`}
              onClick={() => { effort.onPick(option.value); setEffortOpen(false); }}
            >
              <span className="flex-1 text-[15px] text-zinc-800 dark:text-zinc-200">
                {option.label}
                {option.isDefault ? <span className="ml-1.5 text-xs text-zinc-500 dark:text-zinc-400">default</span> : null}
              </span>
              {option.value === effort.value ? <CheckIcon className="h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden="true" /> : null}
            </button>
          )) : null}
        </div>
      ) : null}
      {credit ? (
        <div className="flex flex-col gap-2 rounded-2xl bg-white px-4 py-3 dark:bg-zinc-800" data-agent-session-sheet-credits>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{credit.weekly ? 'This week’s credits' : 'Today’s credits'}</p>
          <div
            role="meter"
            aria-label="Credits left"
            aria-valuemin={0}
            aria-valuemax={credit.limitCents / 100}
            aria-valuenow={credit.remainingCents / 100}
            className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700"
          >
            <div className={`h-full rounded-full bg-current ${RING_INK[credit.tone]}`} style={{ width: `${Math.round(credit.fraction * 100)}%` }} />
          </div>
          <p className="flex flex-wrap gap-x-3 text-[13px] text-zinc-600 dark:text-zinc-300">
            <span className="flex-1">{credit.description}</span>
            {credit.byokCents > 0 ? <span className="text-zinc-500 dark:text-zinc-400">Your key: {dollars(credit.byokCents, true)} today</span> : null}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function wide(): boolean {
  try { return window.matchMedia('(min-width: 640px)').matches; } catch { return false; }
}

/**
 * The sheet itself: a bottom sheet on a phone, a popover over the pill on a
 * wider screen. Portalled to the page so nothing it sits in can clip it.
 * Escape, the backdrop and a pick close it, and focus goes back to the pill.
 */
export function ModelSheet({ anchor, onClose, children }: {
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement | null>(null);
  const [desktop] = useState(wide);
  const [place, setPlace] = useState<{ left: number; bottom: number; maxHeight: number } | null>(null);

  // Over the whole composer card, not just the pill, so the box stays in
  // view: left-aligned with the pill, as tall as the room above allows.
  useLayoutEffect(() => {
    if (!desktop) return;
    const pill = anchor.current;
    const rect = pill?.getBoundingClientRect();
    if (!rect) return;
    const top = pill?.closest('form')?.getBoundingClientRect().top ?? rect.top;
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - 12 - 352));
    setPlace({
      left,
      bottom: Math.max(12, window.innerHeight - top + 8),
      maxHeight: Math.max(200, Math.min(window.innerHeight * 0.8, top - 20)),
    });
  }, [desktop, anchor]);

  useEffect(() => {
    const pill = anchor.current;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', onKey, true);
    const first = panel.current?.querySelector<HTMLElement>('[aria-pressed="true"], button');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey, true);
      pill?.focus();
    };
  }, [anchor, onClose]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div
        className={desktop ? 'fixed inset-0 z-[70]' : 'fixed inset-0 z-[70] bg-black/40'}
        aria-hidden="true"
        onClick={onClose}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal={desktop ? undefined : true}
        aria-label="Model"
        className={desktop
          ? 'fixed z-[71] w-[22rem] overflow-y-auto rounded-2xl border border-zinc-200 bg-zinc-50 p-2 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900'
          : 'fixed inset-x-0 bottom-0 z-[71] max-h-[85vh] overflow-y-auto rounded-t-[28px] bg-zinc-50 px-4 pb-8 pt-2 dark:bg-zinc-900'}
        style={desktop && place ? { left: place.left, bottom: place.bottom, maxHeight: place.maxHeight } : undefined}
      >
        {desktop ? null : <div className="mx-auto mb-2 h-1.5 w-10 rounded-full bg-zinc-300 dark:bg-zinc-600" aria-hidden="true" />}
        {children}
      </div>
    </>,
    document.body,
  );
}

// ── Files, as sent ──────────────────────────────────────────────────────

/** A sent message's files: images as thumbnails, the rest as chips. Each opens or downloads the file. */
export function SentAttachments({ sessionId, attachments }: { sessionId: number | null; attachments: AgentAttachment[] }) {
  if (!sessionId || !attachments.length) return null;
  return (
    <div className="flex max-w-[85%] flex-wrap items-start justify-end gap-2" data-agent-session-attachments={attachments.length}>
      {attachments.map((att) => {
        const href = attachmentUrl(sessionId, att.id);
        if (att.kind === 'image') {
          return (
            <a key={att.id} href={href} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-700">
              <img src={href} alt={att.filename} loading="lazy" className="h-24 w-24 object-cover" />
            </a>
          );
        }
        return (
          <a
            key={att.id}
            href={href}
            download={att.filename}
            className="flex max-w-[14rem] flex-col rounded-xl bg-zinc-100 px-3 py-2 text-left dark:bg-zinc-800"
          >
            <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{att.filename}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatSize(att.sizeBytes)}</span>
          </a>
        );
      })}
    </div>
  );
}
