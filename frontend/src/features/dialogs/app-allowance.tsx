import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useStoreState } from '../../lib/use-store-state';
import { appAllowanceStore, refreshAppAllowance, requestMoreApps } from './app-allowance-store.js';

export interface AppCreationQuota {
  used: number | null;
  limit: number | null;
  remaining: number | null;
}

/** The server-wide MAX_APPS cap as the viewer meets it (QA 2026-09-24 Q33b). */
export interface ServerCapacity {
  used: number;
  limit: number;
  remaining: number;
  full: boolean;
}

export function quotaHeadline(quota: AppCreationQuota): string {
  if (quota.limit === null) return quota.used == null ? 'No app limit' : `${quota.used} ${quota.used === 1 ? 'app' : 'apps'} · no limit`;
  if (quota.used == null) return `${quota.limit} app slots`;
  return `${quota.used} of ${quota.limit} app ${quota.limit === 1 ? 'slot' : 'slots'} used`;
}

/**
 * Is the SERVER the limit this viewer runs into first? Only when it is does
 * the panel talk about it: a server with 40 free places says nothing to
 * someone with 2 slots of their own.
 */
export function serverBinds(quota: AppCreationQuota | null, server: ServerCapacity | null): boolean {
  if (!server) return false;
  if (server.full) return true;
  return quota?.remaining == null || server.remaining < quota.remaining;
}

export function useAppAllowance() {
  const state = useStoreState(appAllowanceStore);
  let quota = state.quota as AppCreationQuota | null;
  let server = state.server as ServerCapacity | null;
  // Existing deterministic quota capture: display only; writes use real policy.
  // Both shots pin the whole panel, server line included, so what they show
  // does not depend on how many apps the server they run against holds.
  try {
    const shot = new URLSearchParams(location.search).get('shot');
    if (quota && shot === 'create-quota') {
      quota = { used: 1, limit: 2, remaining: 1 };
      server = null;
    }
    if (quota && shot === 'create-server-full') {
      quota = { used: 0, limit: 2, remaining: 2 };
      server = { used: 50, limit: 50, remaining: 0, full: true };
    }
  } catch { /* prerender */ }
  const spent = !!quota && quota.limit !== null && quota.used !== null && quota.used >= quota.limit;
  // QA 2026-09-24 Q33b: a full server blocks creation exactly as a spent
  // allowance does, so the dialog says so up front instead of at Create.
  const serverFull = !!server?.full;
  const blocked = spent || serverFull;
  return { ...state, quota, server, spent, serverFull, blocked };
}

/**
 * The panel's two surfaces. `inset` is the bordered block the fork dialog's
 * white card still uses. `pane` is the create dialog's (#1910): that dialog
 * sits on the grey pane ground, where a bordered grey inset reads as a hole,
 * so the allowance becomes one of the white cards floating on it, in the
 * same recipe as its field cards.
 */
const SURFACE = {
  inset: 'mb-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800/60',
  pane: 'mb-4 rounded-2xl bg-white dark:bg-zinc-800 px-4 py-3',
} as const;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function AppAllowance({ id, surface = 'inset' }: { id?: string; surface?: keyof typeof SURFACE }) {
  const { quota, server, requestedAt, loading, error, spent, serverFull } = useAppAllowance();
  const binds = !!quota && serverBinds(quota, server);
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
    <div id={id} className={SURFACE[surface]}
      aria-live="polite"
      data-quota-state={!quota ? 'loading' : serverFull ? 'server-full' : spent ? 'spent' : 'available'}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-200">App allowance</span>
        <strong className="text-right text-zinc-900 dark:text-zinc-100">
          {!quota ? 'Checking…' : serverFull ? 'Server is full' : quotaHeadline(quota)}
        </strong>
      </div>
      {quota && !serverFull ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        {quota.limit === null ? 'Admin accounts can create apps without a slot limit.'
          : quota.remaining == null ? 'Current usage is unavailable.'
          : `${quota.remaining} ${quota.remaining === 1 ? 'slot' : 'slots'} available. Creating, importing and forking share this allowance.`}
        {spent ? ' Request more slots to create another app.' : ''}
      </p> : null}
      {/*
          QA 2026-09-24 Q33b: the server-wide cap, when it is the limit this
          viewer meets first. Full, it replaces the slot sentence (slots do
          not matter while no one can create) and the Request button (more
          slots would not help); nearly full, it follows the slot sentence.
          The same words the write route refuses with, so the dialog and the
          429 never disagree.
      */}
      {quota && binds && server ? (
        <p id={id ? `${id}-server` : undefined} data-server-full={serverFull ? 'true' : 'false'}
          className={serverFull ? 'mt-1 text-xs text-red-700 dark:text-red-400' : 'mt-1 text-xs text-zinc-500 dark:text-zinc-400'}>
          {serverFull
            ? `This server is at its app limit (${server.limit}). Ask an admin to remove an app or raise the limit. `
              + `Your own allowance: ${quota.limit === null ? 'no limit' : `${plural(quota.remaining ?? 0, 'slot', 'slots')} free`}.`
            : `This server has room for ${plural(server.remaining, 'more app', 'more apps')} (limit ${server.limit}).`}
        </p>
      ) : null}
      {quota && quota.limit !== null && !serverFull ? (
        <div className="mt-2">
          <Button type="button" size="sm" disabled={busy || !!requestedAt} disabledStyle="block" onClick={request}>
            {busy ? 'Sending…' : requestedAt ? 'Request pending' : 'Request more'}
          </Button>
          {requestedAt ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Admins have your request. You’ll be notified when it is reviewed.</p> : null}
        </div>
      ) : null}
      {error || requestError ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{requestError || error}</p> : null}
      {error ? <Button type="button" size="sm" disabled={loading} onClick={() => void refreshAppAllowance()}>Refresh allowance</Button> : null}
    </div>
  );
}
