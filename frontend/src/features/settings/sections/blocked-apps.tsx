import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';

type BlockedApp = { slug: string; name: string };
function BlockedAppsList() {
  const host = useRef<HTMLDivElement>(null);
  const [apps, setApps] = useState<BlockedApp[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    const pane = host.current?.closest('[data-settings-section]');
    let seq = 0;
    async function load() {
      const current = ++seq;
      if (!pane || pane.classList.contains('hidden')) { setApps(null); return; }
      setError('');
      try {
        const response = await fetch('/api/me/app-blocks');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Could not load blocked apps.');
        if (current === seq) setApps(data.apps);
      } catch (err) { if (current === seq) setError((err as Error).message); }
    }
    refresh.current = () => { void load(); };
    const observer = new MutationObserver(() => { void load(); });
    if (pane) observer.observe(pane, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('app-blocks-changed', refresh.current);
    void load();
    return () => { seq++; observer.disconnect(); window.removeEventListener('app-blocks-changed', refresh.current); };
  }, []);
  async function unblock(app: BlockedApp) {
    if (busy) return;
    setBusy(app.slug); setError('');
    try {
      const response = await fetch(`/api/me/app-blocks/${encodeURIComponent(app.slug)}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not unblock this app.');
      setApps(current => current?.filter(row => row.slug !== app.slug) ?? null);
      window.dispatchEvent(new CustomEvent('app-blocks-changed', { detail: data }));
      (window as any).Home?.load?.();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }
  return <div ref={host} className="mt-4 space-y-3">
    {apps === null && !error ? <p className="text-sm text-zinc-500">Loading blocked apps…</p> : null}
    {apps?.length === 0 ? <p className="text-sm text-zinc-500">You haven’t blocked any apps.</p> : null}
    {apps?.map(app => <div key={app.slug} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-500/5 p-3">
      <span className="min-w-0 break-words">{app.name}</span>
      <Button type="button" layout="shrink" disabled={!!busy} onClick={() => void unblock(app)}>{busy === app.slug ? 'Unblocking…' : 'Unblock'}</Button>
    </div>)}
    {error ? <div role="alert"><p className="text-sm text-red-700 dark:text-red-400">{error}</p><Button type="button" onClick={() => refresh.current()}>Retry</Button></div> : null}
  </div>;
}
// The router owns this static wrapper's visibility; React owns its whole interior.
export function BlockedAppsSection() {
  return <div data-settings-section="blocked-apps" className="hidden">
    <SectionHeading title="Blocked apps">Blocked apps are hidden from your app lists and discovery, cannot be opened in Homeroom, and do not send you notifications. Their creators and contributors remain unaffected.</SectionHeading>
    <BlockedAppsList />
  </div>;
}
