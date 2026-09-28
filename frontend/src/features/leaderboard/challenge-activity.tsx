import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type Activity = {
  id: number; points: number; description: string; activityAt: string | null;
  date: string | null; precision: 'date' | 'timestamp'; explanation: string | null;
  proposal: { title: string; href: string } | null;
};

export function activityTime(activity: Pick<Activity, 'precision' | 'date' | 'activityAt'>): string {
  if (activity.precision === 'date') return activity.date ? `${activity.date} (date only)` : 'Date not recorded';
  const date = activity.activityAt ? new Date(activity.activityAt) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(date)
    : 'Time not recorded';
}

export function CountedActivities({ challengeId }: { challengeId: string }) {
  const [items, setItems] = useState<Activity[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  async function load(before: string | null = null) {
    request.current?.abort();
    const active = new AbortController(); request.current = active;
    setLoading(true); setError(null);
    try {
      const response = await fetch(`/api/me/challenges/${encodeURIComponent(challengeId)}/activities`
        + (before ? `?before=${encodeURIComponent(before)}` : ''),
      { credentials: 'same-origin', cache: 'no-store', signal: active.signal });
      if (!response.ok) throw new Error('Could not load your counted activities.');
      const data = await response.json();
      if (active.signal.aborted) return;
      setItems(previous => before ? [...previous, ...data.items] : data.items);
      setNext(data.nextBefore || null);
    } catch (err) {
      if (!active.signal.aborted) setError('Could not load your counted activities. Try again.');
    } finally { if (!active.signal.aborted) setLoading(false); }
  }
  useEffect(() => {
    setItems([]); setNext(null); void load();
    return () => request.current?.abort();
  }, [challengeId]);
  return <section className="border-t border-zinc-200 pt-3.5 dark:border-zinc-800" aria-label="Your counted activities">
    <h3 className="text-sm font-semibold">Your counted activities</h3>
    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Only you can see this list. Credits appear after scoring; activity outside this window or beyond its cap is not listed.</p>
    {items.length ? <ul className="mt-3 space-y-3">{items.map(item => <li key={item.id} className="text-sm">
      <div className="font-medium">{item.proposal && /^#app\/[a-z0-9-]+\/dev\/proposals\/[1-9][0-9]*$/.test(item.proposal.href)
        ? <a href={item.proposal.href} className="text-violet-700 dark:text-violet-400 hover:underline">{item.proposal.title}</a>
        : item.description}</div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{`${item.points.toLocaleString()} points · ${activityTime(item)}`}</p>
      <p className="mt-1 text-zinc-600 dark:text-zinc-400">{item.explanation || 'No grading explanation was recorded for this credit.'}</p>
    </li>)}</ul> : !loading && !error ? <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No counted activities yet.</p> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
    {loading ? <p role="status" className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">Loading counted activities…</p> : null}
    {!loading && (next || error) ? <Button variant="neutral" size="sm" className="mt-3" onClick={() => void load(next)}>{error ? 'Try again' : 'Show more activities'}</Button> : null}
  </section>;
}

type Unlock = { eventId: number; groups: string[]; next: { href: string; title: string } | null };
export function UnlockedChallenges({ view }: { view: Unlock }) {
  const [dismissed, setDismissed] = useState(true);
  const userId = typeof window !== 'undefined' ? (window as any).App?.user?.id : null;
  const key = `challenge-unlock:${userId}:${view.eventId}`;
  useEffect(() => {
    if (!userId) return;
    try { setDismissed(localStorage.getItem(key) === 'dismissed'); }
    catch { setDismissed(false); }
  }, [key, userId]);
  if (dismissed || !userId) return null;
  return <section className="mb-4 rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800" aria-label="Challenges unlocked">
    <h3 className="text-sm font-semibold">More challenges are available</h3>
    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{`Onboarding is complete. You can now explore ${view.groups.join(', ')}.`}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      {view.next ? <a href={view.next.href} className="text-sm font-semibold text-violet-700 dark:text-violet-400">{`Next: ${view.next.title}`}</a> : null}
      <Button variant="neutral" size="sm" onClick={() => {
        setDismissed(true); try { localStorage.setItem(key, 'dismissed'); } catch { /* this visit remains dismissed */ }
      }}>Got it</Button>
    </div>
  </section>;
}

export function PointsExplainer() {
  return <details className="my-3 text-sm text-zinc-600 dark:text-zinc-400">
    <summary className="cursor-pointer font-medium">Points and tokens</summary>
    <p className="mt-2">Points record your challenge rewards and contribute to standings under the season rules.</p>
    <p className="mt-1">Tokens are a separate, provisional allocation from the season pool, subject to the program terms. A point is not a token or a fixed token amount.</p>
  </details>;
}
