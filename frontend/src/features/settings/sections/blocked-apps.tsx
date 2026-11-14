import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';
import { useMessages } from '../../../lib/i18n/react';
import { agoStamp } from '../../../lib/timestamp';

type BlockedApp = { slug: string; name: string; created_at?: string | null };

/**
 * One blocked app (#6512): its name, when it was blocked, and Unblock. The
 * date is the product's card form (`agoStamp`: "3d ago", a date from a week
 * on) with the full stamp on hover, and is left out for a row with no stamp.
 */
export function BlockedAppRow({ app, busy, onUnblock }: {
  app: BlockedApp;
  busy: string | null;
  onUnblock: (app: BlockedApp) => void;
}) {
  const t = useMessages('settings');
  const when = agoStamp(app.created_at);
  return <div className="ui-row flex items-center justify-between gap-3 rounded-lg bg-zinc-500/5 p-3">
    <div className="ui-row-tx min-w-0">
      <span className="ui-row-t block break-words">{app.name}</span>
      {when.text ? <time data-role="blocked-at" dateTime={app.created_at ?? undefined} title={when.title} className="mt-0.5 block text-[13px] text-zinc-500 dark:text-zinc-400">{t('settings:blockedApps.blockedAt', { when: when.text })}</time> : null}
    </div>
    <Button type="button" layout="shrink" aria-label={busy === app.slug ? undefined : t('settings:blockedApps.unblockLabel', { app: app.name })} disabled={!!busy} onClick={() => onUnblock(app)}>{busy === app.slug ? t('settings:blockedApps.unblocking') : t('settings:blockedApps.unblock')}</Button>
  </div>;
}
function BlockedAppsList() {
  const t = useMessages('settings');
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
        if (!response.ok) throw new Error(data.error || t('settings:blockedApps.loadFailed'));
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
      if (!response.ok) throw new Error(data.error || t('settings:blockedApps.unblockFailed'));
      setApps(current => current?.filter(row => row.slug !== app.slug) ?? null);
      window.dispatchEvent(new CustomEvent('app-blocks-changed', { detail: data }));
      (window as any).Home?.load?.();
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(null); }
  }
  return <div ref={host} className="ui-card mt-4 space-y-3">
    {apps === null && !error ? <p className="text-sm text-zinc-500">{t('settings:blockedApps.loading')}</p> : null}
    {apps?.length === 0 ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('settings:blockedApps.empty')}</p> : null}
    {apps?.map(app => <BlockedAppRow key={app.slug} app={app} busy={busy} onUnblock={row => void unblock(row)} />)}
    {error ? <div role="alert"><p className="text-sm text-red-700 dark:text-red-400">{error}</p><Button type="button" onClick={() => refresh.current()}>{t('core:common.retry')}</Button></div> : null}
  </div>;
}
// The router owns this static wrapper's visibility; React owns its whole interior.
export function BlockedAppsSection() {
  const t = useMessages('settings');
  return <div data-settings-section="blocked-apps" className="hidden">
    <SectionHeading title={t('settings:blockedApps.title')} blurbClassName="dark:text-zinc-400">{t('settings:blockedApps.intro')}</SectionHeading>
    <BlockedAppsList />
  </div>;
}
