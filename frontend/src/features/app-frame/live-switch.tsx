/**
 * #4449: the "Preview | Live" switch a first version's thumbnail shows while
 * it is built ("Building it"), top-right of its colour band, for its maker
 * and its members alike, while the Admin setting is on (routes/apps.js
 * firstVersionLiveFields). Preview is #4387's first look; Live is the app
 * itself taking shape (./live-band.tsx, loaded only once Live is shown).
 *
 * LIVE IS THE DEFAULT (newcomer run six, 14 Oct 2026). Preview was, and it
 * stayed chosen after the build had booted the app, so the card kept the
 * picture drawn from the plan while the real app was there one tap away.
 * Live is offered only once its watcher has a frame to show (N6), so from
 * the moment there is one, Live is what the card shows. Somebody who picks
 * either keeps it: the choice is remembered per person and per project, in
 * this browser.
 */

import { useCallback, useState, type ReactNode } from 'react';

import { useMessages } from '../../lib/i18n/react';
import { t as translate } from '../../lib/i18n/runtime';

export type LiveChoice = 'preview' | 'live';

/** What the App tab is told (AppView._firstVersionLive). */
export interface FirstVersionLive {
  slug: string;
  /** Who is watching: the choice is remembered per person. */
  userKey: string;
  /** A screenshot state: a made-up recording, nothing fetched. */
  sample?: boolean;
  /**
   * N7: built (Testing it, Ready to try) with no real screens: the build's
   * last frame stays on the card, with no switch.
   */
  last?: boolean;
}

// v2: per project. v1 was one choice per person for every project, made
// while Preview was the default; it is not read.
const STORE_PREFIX = 'usernode.firstVersionLive.v2.';

export function choiceKey(userKey: string, slug: string): string {
  return `${STORE_PREFIX}${userKey || 'guest'}.${slug}`;
}

/** The choice somebody made for this project, or null for none. */
export function readChoice(userKey: string, slug: string): LiveChoice | null {
  try {
    const v = localStorage.getItem(choiceKey(userKey, slug));
    return v === 'live' || v === 'preview' ? v : null;
  } catch { return null; }
}

export function writeChoice(userKey: string, slug: string, choice: LiveChoice): void {
  try { localStorage.setItem(choiceKey(userKey, slug), choice); } catch { /* private mode: this visit only */ }
}

/**
 * Pure: what the card shows when Live is `offered` (it has frames): the
 * choice made for the project, else Live. Not offered: Preview.
 */
export function shownChoice(offered: boolean, chosen: LiveChoice | null): LiveChoice {
  return offered ? (chosen || 'live') : 'preview';
}

/**
 * The choice for `userKey` on project `slug` (a null key: Live is not
 * offered, Preview). Read for whoever it is offered to, not once when the
 * card first drew: N6 offers Live only once there is a frame to show, and
 * the card stays mounted across the App tab's rechecks, so it is often
 * offered after the card drew, and then it turns to Live. A choice made
 * here holds for the same person on the same project.
 */
export function useLiveChoice(userKey: string | null, slug: string | null): [LiveChoice, (c: LiveChoice) => void] {
  const offered = userKey != null && !!slug;
  const key = offered ? `${userKey} ${slug}` : null;
  const [picked, setPicked] = useState<{ key: string | null; choice: LiveChoice } | null>(null);
  const choice: LiveChoice = picked && picked.key === key
    ? picked.choice
    : shownChoice(offered, offered ? readChoice(userKey as string, slug as string) : null);
  const choose = useCallback((c: LiveChoice) => {
    setPicked({ key, choice: c });
    if (userKey != null && slug) writeChoice(userKey, slug, c);
  }, [key, userKey, slug]);
  return [choice, choose];
}

export type LivePhase = 'starting' | 'live' | 'failed' | 'ended';

/**
 * The Live pill. "Starting the app…" until there is a good frame, then
 * "Live · just updated" / "Live · updated 12 s ago", "A restart failed ·
 * showing the last good screen" while the newest restart did not load, and
 * "Last screen from the build" once the build's watcher has stopped (N7:
 * kept on the card while it is reviewed and tested). Pure.
 */
export function livePill(phase: LivePhase, ageSeconds: number | null): string {
  if (phase === 'starting') return translate('agent:appFrame.live.pill.starting');
  if (phase === 'ended') return translate('agent:appFrame.live.pill.ended');
  if (phase === 'failed') return translate('agent:appFrame.live.pill.failed');
  const age = ageSeconds == null || !Number.isFinite(ageSeconds) ? 0 : Math.max(0, Math.floor(ageSeconds));
  if (age < 5) return translate('agent:appFrame.live.pill.justUpdated');
  if (age < 60) return translate('agent:appFrame.live.pill.updatedSeconds', { count: age });
  return translate('agent:appFrame.live.pill.updatedMinutes', { count: Math.floor(age / 60) });
}

/** The two segments, each with its label's message id. */
const SEGMENTS: Array<{ value: LiveChoice; label: string }> = [
  { value: 'preview', label: 'agent:appFrame.live.switch.preview' },
  { value: 'live', label: 'agent:appFrame.live.switch.live' },
];

export function LiveSwitch({ value, onChange }: { value: LiveChoice; onChange: (c: LiveChoice) => void }): ReactNode {
  const t = useMessages('agent');
  return (
    <div
      role="group"
      aria-label={t('agent:appFrame.live.switch.label')}
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
          {t(s.label)}
        </button>
      ))}
    </div>
  );
}
