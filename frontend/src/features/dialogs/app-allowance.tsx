import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStoreState } from '../../lib/use-store-state';
import { appAllowanceStore, refreshAppAllowance, requestMoreApps } from './app-allowance-store.js';

export interface AppCreationQuota {
  used: number | null;
  limit: number | null;
  remaining: number | null;
}

export function quotaHeadline(quota: AppCreationQuota): string {
  if (quota.limit === null) return quota.used == null ? 'No app limit' : `${quota.used} ${quota.used === 1 ? 'app' : 'apps'} · no limit`;
  if (quota.used == null) return `${quota.limit} app slots`;
  return `${quota.used} of ${quota.limit} app ${quota.limit === 1 ? 'slot' : 'slots'} used`;
}

export function useAppAllowance() {
  const state = useStoreState(appAllowanceStore);
  let quota = state.quota as AppCreationQuota | null;
  // Existing deterministic quota capture: display only; writes use real policy.
  try {
    if (quota && new URLSearchParams(location.search).get('shot') === 'create-quota') {
      quota = { used: 1, limit: 2, remaining: 1 };
    }
  } catch { /* prerender */ }
  const blocked = !!quota && quota.limit !== null && quota.used !== null && quota.used >= quota.limit;
  return { ...state, quota, blocked };
}

export function AppAllowance({ id }: { id?: string }) {
  const { quota, requestedAt, loading, error, blocked } = useAppAllowance();
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState('');
  if (!quota && !loading && !error) return null;
  const request = async () => {
    setBusy(true);
    setRequestError('');
    try { await requestMoreApps(); }
    catch (err: any) { setRequestError(err.message || 'Could not send your request.'); }
    finally { setBusy(false); }
  };
  return (
    <div id={id} className="mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800/60"
      aria-live="polite" data-quota-state={!quota ? 'loading' : blocked ? 'spent' : 'available'}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">App allowance</span>
        <strong className="text-right text-zinc-900 dark:text-zinc-100">{quota ? quotaHeadline(quota) : 'Checking…'}</strong>
      </div>
      {quota ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {quota.limit === null ? 'Admin accounts can create apps without a slot limit.'
          : quota.remaining == null ? 'Current usage is unavailable.'
          : `${quota.remaining} ${quota.remaining === 1 ? 'slot' : 'slots'} available. Creating, importing and forking share this allowance.`}
        {blocked ? ' Request more slots to create another app.' : ''}
      </p> : null}
      {quota && quota.limit !== null ? (
        <div className="mt-2">
          <Button type="button" size="sm" disabled={busy || !!requestedAt} disabledStyle="block" onClick={request}>
            {busy ? 'Sending…' : requestedAt ? 'Request pending' : 'Request more'}
          </Button>
          {requestedAt ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Admins have your request. You’ll be notified when it is reviewed.</p> : null}
        </div>
      ) : null}
      {error || requestError ? <p role="alert" className="mt-2 text-xs text-red-500">{requestError || error}</p> : null}
      {error ? <Button type="button" size="sm" disabled={loading} onClick={() => void refreshAppAllowance()}>Refresh allowance</Button> : null}
    </div>
  );
}
