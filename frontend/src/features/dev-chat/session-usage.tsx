import { useEffect, useState } from 'react';

type Usage = {
  totalCents: number; chatCents: number; claudeCents: number; openRouterCents: number;
  pendingOrUnpriced: boolean;
};
const dollars = (cents: number) => `$${(cents / 100).toFixed(3)}`;

export function UsageDisclosure({ usage }: { usage: Usage }) {
  const [open, setOpen] = useState(false);
  return <span className="ml-2 inline-block align-top text-xs text-zinc-500 dark:text-zinc-400">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="underline underline-offset-2">
      {usage.totalCents > 0 ? `Recorded session ~${dollars(usage.totalCents)}` : 'No session usage recorded yet'}
    </button>
    {open ? <span className="mt-1 block max-w-sm font-sans">
      <span className="block">{`Chat ~${dollars(usage.chatCents)} · Claude coding ~${dollars(usage.claudeCents)} · OpenRouter coding ~${dollars(usage.openRouterCents)}`}</span>
      <span className="mt-1 block">Recorded model usage at list prices, including platform-funded and personal-key calls. Your remaining credit allowance is shown separately.</span>
      <span className="mt-1 block">Older records may be incomplete. Local agent subscriptions and usage not reported to Homeroom are outside this figure.</span>
      {usage.pendingOrUnpriced ? <span className="mt-1 block">Some calls are still pending or have no recorded price.</span> : null}
    </span> : null}
  </span>;
}

/** A keyed mount prevents a slower previous session's response painting this one. */
export function SessionUsage({ sessionId }: { sessionId: number }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    let request: AbortController | null = null;
    let loading = false;
    let unavailable = false;
    const load = async () => {
      if (loading || unavailable || document.visibilityState === 'hidden') return;
      const host = document.getElementById('dc-budget');
      if (!host?.getClientRects().length) return;
      loading = true;
      const abort = new AbortController();
      request = abort;
      const timeout = setTimeout(() => abort.abort(), 10000);
      try {
        const response = await fetch(`/api/sessions/${sessionId}/usage`, {
          credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        });
        if (disposed) return;
        if (response.status === 401 || response.status === 404) {
          unavailable = true; setUsage(null); setError(false); return;
        }
        if (!response.ok) throw new Error('Usage unavailable');
        const data = await response.json();
        if (!disposed && !abort.signal.aborted) { setUsage(data.usage); setError(false); }
      } catch {
        if (!disposed) setError(true);
      } finally { clearTimeout(timeout); loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 15000);
    document.addEventListener('visibilitychange', load);
    return () => {
      disposed = true; request?.abort(); clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [sessionId, retry]);
  return <>{usage ? <UsageDisclosure usage={usage} /> : null}{error ? <button type="button"
    className="ml-2 text-xs text-zinc-500 underline dark:text-zinc-400" onClick={() => setRetry(value => value + 1)}>
    Refresh session usage
  </button> : null}</>;
}
