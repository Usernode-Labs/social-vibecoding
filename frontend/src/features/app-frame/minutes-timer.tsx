/**
 * #6463: the "Use apps for N minutes" challenge's timer, a small pill in the
 * corner of the running app.
 *
 * Shown only while the viewer has an open minutes challenge they have not
 * finished and the app being used counts toward it (one they did not make):
 * GET /api/v4/me/minutes-challenge?app=<slug>, read when the app opens and
 * again whenever an upload of its time is acknowledged
 * (`sv:app-activity-recorded`). Between those reads the pill adds the time
 * the collector has credited and the server does not hold yet
 * (appActivity.onEngagement's `pendingMs`), so it counts up second by second
 * with exactly the accounting that is uploaded: never wall time, and nothing
 * while the app is idle, hidden or loading. It never goes backwards within
 * one open, so the moment between an acknowledgement and the re-read (the
 * pending time gone, the server's count not yet back) cannot dip it.
 *
 * Three states: counting, "Paused" (no fresh input, or the app off screen),
 * and "N minutes ✓", which links to the challenge's page. Its × hides it until
 * the next app is opened. The initial render is nothing (the prerendered
 * document carries no pill), and everything it shows comes from effects.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ProgressRing } from '@/components/ui/progress-ring';
import { CheckIcon, XIcon } from '@/components/ui/icons';

import { useMessages } from '../../lib/i18n/react';
import { appActivity } from './app-activity.js';

export type MinutesChallenge = {
  challengeId: number;
  eventId: number;
  seconds: number;
  targetSeconds: number;
  weekly?: boolean;
  counts: boolean;
};

export type TimerView =
  | { kind: 'none' }
  | { kind: 'counting' | 'paused'; elapsed: string; target: string; pct: number }
  | { kind: 'done'; minutes: number; href: string };

// "3:05" from milliseconds; whole seconds, minutes unpadded.
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// What the pill shows, from the challenge as last read, the time shown so
// far in this open (`shownMs`, for the never-backwards rule) and the
// collector's report. `eligible` is decided once per open: a challenge
// already at its target when the app opened shows no timer.
export function timerView({
  challenge, eligible, hidden, pendingMs, engaged, shownMs,
}: {
  challenge: MinutesChallenge | null;
  eligible: boolean;
  hidden: boolean;
  pendingMs: number;
  engaged: boolean;
  shownMs: number;
}): { view: TimerView; shownMs: number } {
  if (!challenge || !eligible || hidden || !challenge.counts) return { view: { kind: 'none' }, shownMs };
  const targetMs = Math.max(1, Number(challenge.targetSeconds) || 0) * 1000;
  const now = Math.max(shownMs, (Math.max(0, Number(challenge.seconds) || 0) * 1000) + Math.max(0, pendingMs || 0));
  if (now >= targetMs) {
    return {
      view: {
        kind: 'done',
        minutes: Math.round(targetMs / 60000),
        href: `#leaderboard/challenges/${Number(challenge.eventId)}/${Number(challenge.challengeId)}`,
      },
      shownMs: now,
    };
  }
  return {
    view: {
      kind: engaged ? 'counting' : 'paused',
      elapsed: clock(now),
      target: clock(targetMs),
      pct: Math.round((now / targetMs) * 100),
    },
    shownMs: now,
  };
}

const PILL = 'pointer-events-auto absolute top-3 end-3 z-10 flex items-center gap-1.5 rounded-full '
  + 'bg-zinc-900/85 py-1 ps-1 pe-1 text-[0.8125rem] font-semibold leading-5 text-white shadow-lg '
  + 'backdrop-blur-sm';
const PILL_TEXT = 'tabular-nums';
const PILL_PAUSED = 'text-[0.75rem] font-medium text-zinc-300';
const PILL_CLOSE = 'flex h-7 w-7 items-center justify-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white';
const PILL_DONE = 'flex items-center gap-1.5 ps-2 hover:underline';

// The pill alone, for a view: what the container renders and what the test
// renders.
export function MinutesTimerPill({ view, onClose }: { view: TimerView; onClose: () => void }): ReactNode {
  const t = useMessages('agent');
  if (view.kind === 'none') return null;
  const close = (
    <button type="button" className={PILL_CLOSE} aria-label={t('agent:appFrame.minutes.close')} onClick={onClose}>
      <XIcon className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
  if (view.kind === 'done') {
    return (
      <div data-minutes-timer="done" className={PILL}>
        <a href={view.href} className={PILL_DONE}>
          <CheckIcon className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          <span>{t('agent:appFrame.minutes.done', { count: view.minutes })}</span>
        </a>
        {close}
      </div>
    );
  }
  const label = t('agent:appFrame.minutes.progress', { elapsed: view.elapsed, target: view.target });
  return (
    <div data-minutes-timer={view.kind} className={PILL}>
      <ProgressRing
        pct={view.pct}
        title={label}
        className="h-6 w-6"
        trackClassName="stroke-white/25 dark:stroke-white/25"
        arcClassName="stroke-violet-400"
      />
      <span className={PILL_TEXT}>{label}</span>
      {view.kind === 'paused' ? <span className={PILL_PAUSED}>{t('agent:appFrame.minutes.paused')}</span> : null}
      {close}
    </div>
  );
}

async function readChallenge(slug: string): Promise<MinutesChallenge | null> {
  const res = await fetch(`/api/v4/me/minutes-challenge?app=${encodeURIComponent(slug)}`, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const c = body && (body.data ? body.data.challenge : body.challenge);
  if (!c || typeof c !== 'object') return null;
  const targetSeconds = Number(c.targetSeconds);
  if (!Number.isFinite(targetSeconds) || targetSeconds <= 0) return null;
  return {
    challengeId: Number(c.challengeId),
    eventId: Number(c.eventId),
    seconds: Math.max(0, Number(c.seconds) || 0),
    targetSeconds,
    weekly: c.weekly === true,
    counts: c.counts === true,
  };
}

// The container: one per live app frame host, given the slug of the app on
// screen (null when none is).
export function MinutesTimer({ slug }: { slug: string | null }): ReactNode {
  const [challenge, setChallenge] = useState<MinutesChallenge | null>(null);
  const [eligible, setEligible] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [engagement, setEngagement] = useState({ pendingMs: 0, engaged: false });
  const shown = useRef(0);

  useEffect(() => {
    setChallenge(null);
    setEligible(false);
    setHidden(false);
    setEngagement({ pendingMs: 0, engaged: false });
    shown.current = 0;
    if (!slug) return undefined;
    let alive = true;
    let first = true;
    const load = () => {
      readChallenge(slug).then((c) => {
        if (!alive) return;
        if (first) {
          first = false;
          setEligible(!!c && c.counts && c.seconds < c.targetSeconds);
        }
        setChallenge(c);
      }).catch(() => { /* no timer is the quiet answer */ });
    };
    load();
    const onRecorded = () => load();
    document.addEventListener('sv:app-activity-recorded', onRecorded);
    const stop = appActivity.onEngagement(slug, (e: { pendingMs: number; engaged: boolean }) => {
      if (alive) setEngagement({ pendingMs: e.pendingMs, engaged: e.engaged });
    });
    return () => {
      alive = false;
      document.removeEventListener('sv:app-activity-recorded', onRecorded);
      stop();
    };
  }, [slug]);

  const { view, shownMs } = timerView({
    challenge, eligible, hidden, pendingMs: engagement.pendingMs, engaged: engagement.engaged, shownMs: shown.current,
  });
  shown.current = shownMs;
  return <MinutesTimerPill view={view} onClose={() => setHidden(true)} />;
}
