/**
 * #4449: the "Preview | Live" switch a first version's thumbnail shows while
 * it is built ("Building it"), top-right of its colour band, for its maker
 * and its members alike, while the Admin setting is on (routes/apps.js
 * firstVersionLiveFields). Preview is #4387's first look, and the default;
 * Live is the app itself taking shape (./live-band.tsx, loaded only once
 * somebody opens it). The choice is remembered per person, in this browser.
 */

import { useCallback, useState, type ReactNode } from 'react';

export type LiveChoice = 'preview' | 'live';

/** What the App tab is told (AppView._firstVersionLive). */
export interface FirstVersionLive {
  slug: string;
  /** Who is watching: the choice is remembered per person. */
  userKey: string;
  /** A screenshot state: a made-up recording, nothing fetched. */
  sample?: boolean;
}

const STORE_PREFIX = 'usernode.firstVersionLive.v1.';

export function choiceKey(userKey: string): string {
  return `${STORE_PREFIX}${userKey || 'guest'}`;
}

/** The remembered choice, Preview unless Live was chosen. */
export function readChoice(userKey: string): LiveChoice {
  try { return localStorage.getItem(choiceKey(userKey)) === 'live' ? 'live' : 'preview'; } catch { return 'preview'; }
}

export function writeChoice(userKey: string, choice: LiveChoice): void {
  try { localStorage.setItem(choiceKey(userKey), choice); } catch { /* private mode: this visit only */ }
}

export function useLiveChoice(userKey: string | null): [LiveChoice, (c: LiveChoice) => void] {
  const [choice, setChoice] = useState<LiveChoice>(() => (userKey != null ? readChoice(userKey) : 'preview'));
  const choose = useCallback((c: LiveChoice) => {
    setChoice(c);
    if (userKey != null) writeChoice(userKey, c);
  }, [userKey]);
  return [choice, choose];
}

export type LivePhase = 'starting' | 'live' | 'failed';

/**
 * The Live pill. "Starting the app…" until there is a good frame, then
 * "Live · just updated" / "Live · updated 12 s ago", and "A restart failed ·
 * showing the last good screen" while the newest restart did not load. Pure.
 */
export function livePill(phase: LivePhase, ageSeconds: number | null): string {
  if (phase === 'starting') return 'Starting the app…';
  if (phase === 'failed') return 'A restart failed · showing the last good screen';
  const age = ageSeconds == null || !Number.isFinite(ageSeconds) ? 0 : Math.max(0, Math.floor(ageSeconds));
  if (age < 5) return 'Live · just updated';
  if (age < 60) return `Live · updated ${age} s ago`;
  return `Live · updated ${Math.floor(age / 60)} min ago`;
}

const SEGMENTS: Array<{ value: LiveChoice; label: string }> = [
  { value: 'preview', label: 'Preview' },
  { value: 'live', label: 'Live' },
];

export function LiveSwitch({ value, onChange }: { value: LiveChoice; onChange: (c: LiveChoice) => void }): ReactNode {
  return (
    <div
      role="group"
      aria-label="What the picture shows"
      data-first-version-live-switch={value}
      className="flex rounded-full bg-black/55 p-0.5 text-[12px] font-semibold leading-4"
    >
      {SEGMENTS.map((s) => (
        <button
          key={s.value}
          type="button"
          aria-pressed={value === s.value}
          data-live-choice={s.value}
          onClick={() => onChange(s.value)}
          className={`min-h-[24px] rounded-full px-2.5 py-1 ${value === s.value ? 'bg-white text-zinc-900' : 'text-white'}`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
