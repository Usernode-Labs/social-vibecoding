import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDialog } from '../dialogs/use-dialog';
import * as api from './api';
import type { SharedObjectReference, SharedObjectType } from './types';

interface AppChoice { id: number; slug: string; name: string }

export function ShareItemDialog() {
  const [type, setType] = useState<SharedObjectType>('app');
  const [apps, setApps] = useState<AppChoice[]>([]);
  const [appId, setAppId] = useState<number | null>(null);
  const [itemId, setItemId] = useState('');
  const [version, setVersion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialog = useDialog<SharedObjectReference>('messagesShare', {
    onOpen: (reference) => {
      setType(reference?.type || 'app'); setAppId(reference?.appId || null);
      setItemId(String(reference?.issueNumber || reference?.sessionId || reference?.proposalId || ''));
      setVersion(String(reference?.version || '')); setError('');
    },
  });

  useEffect(() => {
    if (!dialog.isOpen || apps.length) return;
    let alive = true; setLoading(true);
    void api.listApps().then((rows) => { if (alive) setApps(rows); }).catch(() => { if (alive) setError('Couldn’t load your apps.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [apps.length, dialog.isOpen]);

  const app = useMemo(() => apps.find((item) => item.id === appId) || null, [appId, apps]);
  const validId = (value: string) => api.strictId(value);
  const canAttach = !!app && (type === 'app' || !!validId(itemId)) && (type !== 'spec' || !!validId(version));

  function attach() {
    if (!app || !canAttach) return;
    const id = validId(itemId);
    const reference: SharedObjectReference = { type, appId: app.id, appSlug: app.slug };
    if (type === 'issue') reference.issueNumber = id || undefined;
    if (type === 'proposal' || type === 'spec') reference.sessionId = id || undefined;
    if (type === 'governance') reference.proposalId = id || undefined;
    if (type === 'spec') reference.version = validId(version) || undefined;
    window.dispatchEvent(new CustomEvent('usernode:messages-object-selected', { detail: reference }));
    dialog.close();
  }

  return (
    <div ref={dialog.rootRef} id="messages-share-dialog" className="hidden fixed inset-0 z-50 overflow-y-auto overscroll-contain bg-black/60" {...dialog.backdropProps}>
      <div data-modal-backdrop="" className="flex min-h-full items-center justify-center p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-xl p-5 w-full max-w-md shadow-xl">
          <div className="flex items-center justify-between mb-4"><div><h2 className="text-lg font-bold">Share item</h2><p className="text-xs text-zinc-500 dark:text-zinc-400">Access is checked separately for every recipient.</p></div><button type="button" onClick={dialog.close} className="text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 dark:text-zinc-400" aria-label="Close">×</button></div>
          <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Item type</span><select value={type} onChange={(event) => { setType(event.target.value as SharedObjectType); setItemId(''); setVersion(''); }} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"><option value="app">App</option><option value="issue">GitHub-backed issue</option><option value="proposal">Code proposal</option><option value="governance">Governance proposal</option><option value="spec">Exact spec version</option></select></label>
          <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">App</span><select value={appId || ''} disabled={loading} onChange={(event) => setAppId(api.strictId(event.target.value))} className="w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-900 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500"><option value="">{loading ? 'Loading apps…' : 'Choose an app'}</option>{apps.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          {type !== 'app' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">{type === 'issue' ? 'Issue number' : type === 'governance' ? 'Governance proposal ID' : 'Proposal / session ID'}</span><Input inputMode="numeric" pattern="[0-9]*" value={itemId} onChange={(event) => setItemId(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="123" /></label> : null}
          {type === 'spec' ? <label className="block mb-3"><span className="block text-xs font-medium text-zinc-500 dark:text-zinc-400 mb-1">Spec version</span><Input inputMode="numeric" pattern="[0-9]*" value={version} onChange={(event) => setVersion(event.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="1" /></label> : null}
          <p className="text-xs text-zinc-500 dark:text-zinc-400">The server resolves the live title and state. If access is later removed, the card becomes metadata-free and unavailable.</p>
          {error ? <p role="alert" className="mt-3 text-xs text-red-700 dark:text-red-400">{error}</p> : null}
          <div className="mt-5 flex justify-end gap-2"><Button type="button" variant="neutral" ink="neutral" onClick={dialog.close}>Cancel</Button><Button type="button" disabled={!canAttach} onClick={attach}>Attach item</Button></div>
        </div>
      </div>
    </div>
  );
}
