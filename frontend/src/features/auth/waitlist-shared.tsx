/**
 * Shared plumbing for the two waitlist surveys (#1080, step 2 chunk C,
 * screens 5 and 6).
 *
 * `GET /api/public/waitlist/options` is the single source of the chip labels,
 * select contents and country list, so the form and the server's validation
 * cannot disagree. Both screens read it, so the fetch is memoised at module
 * scope exactly as `AuthScreens._optionsPromise` was — one request per
 * document, shared by whichever screen asks first.
 */

import { useCallback, useEffect, useState } from 'react';

/** `GET /api/public/waitlist/options`. Every field is optional by design. */
export interface WaitlistOptions {
  countries?: Record<string, Record<string, string>>;
  discovery_sources?: Record<string, string>;
  discovery_detail_labels?: Record<string, string>;
  group_sizes?: Record<string, string>;
  group_roles?: Record<string, string>;
  group_tools?: Record<string, string>;
  loss_answers?: Record<string, string>;
  loss_kinds?: Record<string, string>;
  max_invites?: number;
}

let optionsPromise: Promise<WaitlistOptions | null> | null = null;

/** The memoised options fetch. Never rejects — a failure resolves to null. */
export function waitlistOptions(): Promise<WaitlistOptions | null> {
  if (!optionsPromise) {
    optionsPromise = fetch('/api/public/waitlist/options')
      .then((r) => (r.ok ? (r.json() as Promise<WaitlistOptions>) : null))
      .catch(() => null);
  }
  return optionsPromise;
}

/**
 * Load the options once per mount. Returns null until they arrive (and stays
 * null if the request failed), which is also the state the prerender pass
 * sees — every options-driven region renders empty, exactly as the
 * hand-written document shipped it.
 */
export function useWaitlistOptions(): WaitlistOptions | null {
  const [options, setOptions] = useState<WaitlistOptions | null>(null);
  useEffect(() => {
    let live = true;
    void waitlistOptions().then((opts) => {
      if (live && opts) setOptions(opts);
    });
    return () => {
      live = false;
    };
  }, []);
  return options;
}

// Chip classes, verbatim from AuthScreens._chipRow — including the trailing
// space on BASE, so a chip's class attribute is byte-identical to the one the
// imperative version produced.
const CHIP_ON =
  'border-violet-500 bg-violet-50 dark:bg-violet-500/10 text-zinc-900 dark:text-white';
const CHIP_OFF =
  'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-300 hover:border-zinc-400 dark:hover:border-zinc-500';
const CHIP_BASE = 'rounded-full border px-3 py-1.5 text-xs cursor-pointer transition-colors ';

interface ChipRowProps {
  /** The host element's id — the chips render inside it, as before. */
  id: string;
  /** `key → label`, straight from the options payload. */
  options: Record<string, string>;
  className?: string;
}

/** Single-select chip row. `null` until something is picked. */
export function ChipRow({
  id,
  options,
  className = 'flex flex-wrap gap-1.5',
  value,
  onChange,
}: ChipRowProps & { value: string | null; onChange: (next: string | null) => void }) {
  return (
    <div id={id} className={className}>
      {Object.entries(options).map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={CHIP_BASE + (value === key ? CHIP_ON : CHIP_OFF)}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Add or drop one key. Pass to a `useState` setter, never to a stale array. */
export function toggleChip(selected: string[], key: string): string[] {
  return selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key];
}

/**
 * Multi-select chip row. Clicking a selected chip removes it.
 *
 * It reports the KEY that was clicked rather than the next array, because
 * `_chipRow` held its selection in a closure variable it re-read on every click:
 * two clicks in one tick each saw the previous one. A `value.filter(…)` computed
 * here would be built from the last render's array, so the second click of a
 * pair would drop the first. The caller applies {@link toggleChip} inside its
 * state updater instead.
 */
export function MultiChipRow({
  id,
  options,
  className = 'flex flex-wrap gap-1.5',
  value,
  onToggle,
}: ChipRowProps & { value: string[]; onToggle: (key: string) => void }) {
  const click = useCallback((key: string) => () => onToggle(key), [onToggle]);
  return (
    <div id={id} className={className}>
      {Object.entries(options).map(([key, label]) => (
        <button
          key={key}
          type="button"
          className={CHIP_BASE + (value.includes(key) ? CHIP_ON : CHIP_OFF)}
          onClick={click(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** `<option>`s for a `key → label` map, in insertion order. */
export function options(map: Record<string, string> | undefined) {
  return Object.entries(map || {}).map(([key, label]) => (
    <option key={key} value={key}>
      {label}
    </option>
  ));
}

/**
 * The status line under either survey's submit. Both screens paint the same
 * three states into a `<p class="text-sm mt-3 …">`, and both start from
 * `hidden text-sm mt-3` — the class attribute the prerendered document has.
 */
export type MsgTone = 'error' | 'ok' | 'warn';

export function msgClass(tone: MsgTone | null): string {
  if (!tone) return 'hidden text-sm mt-3';
  if (tone === 'error') return 'text-sm mt-3 text-red-500 dark:text-red-400';
  if (tone === 'warn') return 'text-sm mt-3 text-amber-600 dark:text-amber-400';
  return 'text-sm mt-3 text-emerald-600 dark:text-emerald-400';
}
