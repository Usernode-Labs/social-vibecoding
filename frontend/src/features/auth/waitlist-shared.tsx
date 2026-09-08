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

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Where this signup stands in the queue, derived server-side from the row's
 * own timestamps. `state` is the one to read: it is ordered most-advanced
 * first, so an admitted row reads as admitted even though it also carries a
 * confirmed_at.
 *
 * Shared vocabulary: `/more/:token` and the confirm-by-code response both
 * derive it from the SAME signupStatus() helper (#1538), so the survey
 * screen and check-my-status can never describe one row differently.
 */
export interface WaitlistStatus {
  state?: 'pending' | 'confirmed' | 'admitted';
  admitted?: boolean;
  confirmed?: boolean;
  has_account?: boolean;
  joined_at?: string | null;
  confirmed_at?: string | null;
  admitted_at?: string | null;
}

/**
 * The three states the pill can be in. Written as WHOLE class strings on
 * purpose: Tailwind's extractor is a regex over source text, so a tint
 * assembled at runtime is a tint that never gets compiled.
 *
 * Shape and scale match the platform's other status pills (the app-details
 * contributor pill, the session-row pills) rather than @/components/ui/chip,
 * which is a `<button aria-pressed>` toggle for a filter rail. This is read-
 * only text, and a node that says "pressed" to a screen reader when nothing
 * can press it is the same category of mistake that component's own doc
 * comment warns about for tabs.
 */
export const QUEUE_PILL = {
  pending: {
    label: 'Waiting for confirmation',
    tint: 'bg-amber-50 dark:bg-amber-900/30 border-amber-200 dark:border-amber-700 text-amber-700 dark:text-amber-300',
    note: 'Click the link in the email we sent, and your answers below move you up.',
  },
  confirmed: {
    label: 'On the waitlist',
    tint: 'bg-violet-50 dark:bg-violet-900/30 border-violet-200 dark:border-violet-700 text-violet-700 dark:text-violet-300',
    note: 'Your address is confirmed. Answering the questions below moves you up.',
  },
  admitted: {
    label: "You're in",
    tint: 'bg-emerald-50 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300',
    note: 'Access is open for you. Check your email for the invite.',
  },
} as const;

/**
 * Rendered on both waitlist surfaces — `#more-status-pill` on the survey
 * screen and `#waitlist-status-pill` on check-my-status (#1538) — so the id
 * is a prop. Two copies of this table is how the same three states start
 * being described in two different ways.
 *
 * The row is always in the markup and always empty in the prerender: the
 * pill's contents arrive with the load effect, so rendering them any earlier
 * would be a hydration mismatch, and a mismatch console.errors, which fails
 * proposal checks. It stays `hidden` until there is something to say, so an
 * unrecognised `state` collapses rather than leaving a gap above the form.
 *
 * A `<span>` rather than @/components/ui/chip: Chip is a `<button
 * aria-pressed>` built for filter toggles, and announcing a read-only status
 * as a pressed button is wrong for anyone on a screen reader. This is the
 * platform's other pill — the same class string browse-detail.tsx uses for an
 * app's state badge.
 *
 * `note` is what to do about the state, and it is the survey screen's only
 * guidance, so it is on by default. Check-my-status passes `note={false}`:
 * that panel already says what this state means and offers the one action
 * there is, so the note would repeat it a line later — and for an admitted
 * reader it would repeat it wrongly, pointing at a mail rather than at the
 * button beside it.
 */
export function StatusPill({
  id,
  status,
  note: showNote = true,
}: { id: string; status: WaitlistStatus | null; note?: boolean }) {
  const key = status?.state;
  const pill = key ? QUEUE_PILL[key] : null;
  const note = !showNote ? null
    : (pill && key === 'admitted' && status?.has_account
      ? 'Access is open and your account is linked. Sign in any time.'
      : pill?.note);
  return (
    <div
      id={id}
      className={`flex flex-wrap items-center gap-x-3 gap-y-1${pill ? '' : ' hidden'}`}
    >
      {pill ? (
        <>
          <span
            className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${pill.tint}`}
          >
            {pill.label}
          </span>
          {note ? (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{note}</span>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** `GET /api/public/waitlist/options`. Every field is optional by design. */
export interface WaitlistOptions {
  /** Flat `alpha2 -> name`, in display order (sorted by English name). */
  countries?: Record<string, string>;
  discovery_sources?: Record<string, string>;
  discovery_detail_labels?: Record<string, string>;
  group_sizes?: Record<string, string>;
  group_roles?: Record<string, string>;
  group_tools?: Record<string, string>;
  loss_answers?: Record<string, string>;
  loss_kinds?: Record<string, string>;
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
/*
 * The widget language's chip: a FILLED neutral at rest, and a solid near-black
 * inversion when selected — not an outline that tints. The reasoning is
 * @/components/ui/chip.tsx's, and these are that component's shape at a
 * smaller size; they are not routed through it because ChipRow and ChipMulti
 * are the shared primitive here and swapping their internals would be a
 * refactor with test surface for no visual difference beyond this restyle.
 *
 * The selection is deliberately NOT the accent. The accent means
 * "actionable/mine"; selection means "this is the one you picked", and
 * colouring both blue collapses the two — the same argument that file makes.
 */
const CHIP_ON =
  'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900';
const CHIP_OFF =
  'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700';
const CHIP_BASE = 'rounded-full px-3 py-1.5 text-xs cursor-pointer transition-colors ';

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
  if (tone === 'error') return 'text-sm mt-3 text-red-700 dark:text-red-400';
  if (tone === 'warn') return 'text-sm mt-3 text-amber-800 dark:text-amber-400';
  return 'text-sm mt-3 text-emerald-700 dark:text-emerald-400';
}

/**
 * Which stage-2 tokens have been answered during THIS page session (#1535).
 *
 * The two screens are siblings, and the offer card on the waitlist screen
 * outlives a trip to the survey and back: confirm, follow "Answer them now",
 * save, press back, and the same card is still inviting you to answer
 * questions you just answered. It has no way to know, because the answers are
 * the other screen's business.
 *
 * So the survey publishes the fact here and the offer card subscribes. A page
 * session is the right lifetime: it is exactly as long as the stale card can
 * survive. A returning visit re-reads the survey from the server anyway, and
 * the offer card is only raised by confirming in-session.
 *
 * The server snapshot is `false` on purpose — the prerendered document knows
 * of no answered token, so the first render must be the "Answer them now"
 * one or hydration mismatches (AGENTS.md).
 */
const answeredTokens = new Set<string>();
const answeredListeners = new Set<() => void>();

export function markSurveyAnswered(token: string | null | undefined): void {
  if (!token || answeredTokens.has(token)) return;
  answeredTokens.add(token);
  answeredListeners.forEach((notify) => notify());
}

export function useSurveyAnswered(token: string | null): boolean {
  return useSyncExternalStore(
    useCallback((notify: () => void) => {
      answeredListeners.add(notify);
      return () => { answeredListeners.delete(notify); };
    }, []),
    () => !!token && answeredTokens.has(token),
    () => false,
  );
}
