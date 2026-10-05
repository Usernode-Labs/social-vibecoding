import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
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
  if (quota.limit === null) return quota.used == null ? tr("core:no_app_limit_9fd7a6f5") : tr("core:count_apps_no_limit_35ac02ea", { count: quota.used });
  if (quota.used == null) return tr("core:value1_app_slots_c6886501", { value1: quota.limit });
  return tr("core:value1_of_count_app_slots_used_4b21d99d", { value1: quota.used, count: quota.limit });
}

/**
 * Profile's "App slots" row (#3250): the headline, and a pending request for
 * more when there is one. Null until the allowance is known, so the row says
 * what it is for rather than inventing a count.
 */
export function appSlotsLine(quota: AppCreationQuota | null, requestedAt: string | null): string | null {
  if (!quota) return null;
  const headline = quotaHeadline(quota);
  return requestedAt && quota.limit !== null ? tr("core:value1_more_requested_b1f03da0", { value1: headline }) : headline;
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

/**
 * Whether the create dialog's allowance card has anything to say (#23, D7).
 * On every step it read "0 of 2 app slots used" above the question, with a
 * bright "Request more" for somebody who had made nothing yet. Quiet, the
 * card shows only when the allowance matters to what happens next: the
 * server is full or is the nearer limit, the slots are spent or one is left,
 * more were asked for, or the read failed. Never for an unlimited allowance.
 * Profile's "App slots" row still shows the count at any time.
 */
export function allowanceWorthShowing(
  quota: AppCreationQuota | null,
  server: ServerCapacity | null,
  requestedAt: string | null,
  error: string | null | undefined,
): boolean {
  if (error) return true;
  if (server?.full) return true;
  if (!quota || quota.limit === null) return false;
  if (serverBinds(quota, server)) return true;
  if (quota.used !== null && quota.used >= quota.limit) return true;
  if (quota.remaining !== null && quota.remaining <= 1) return true;
  return !!requestedAt;
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

function freeSlots(count: number): string {
  return tr('core:allowance_free_slots', { count });
}
function moreApps(count: number): string {
  return tr('core:allowance_more_apps', { count });
}

/**
 * "Request more" is a secondary act. On the pane (the create dialog) it is
 * the neutral pill, one step off the white card in dark mode as the import
 * check's pill is; the fork dialog's inset keeps the button it had.
 */
const REQUEST_BUTTON = {
  inset: {},
  pane: { variant: 'pillNeutral', ink: 'neutral', className: 'dark:bg-zinc-700 dark:hover:bg-zinc-600' },
} as const;

export function AppAllowance({ id, surface = 'inset', quiet = false }: {
  id?: string;
  surface?: keyof typeof SURFACE;
  /** Only when allowanceWorthShowing says so (the create dialog, #23). */
  quiet?: boolean;
}) {
  useUiLanguage();
  const { quota, server, requestedAt, loading, error, spent, serverFull } = useAppAllowance();
  const binds = !!quota && serverBinds(quota, server);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState('');
  if (!quota && !loading && !error) return null;
  if (quiet && !allowanceWorthShowing(quota, server, requestedAt as string | null, error || requestError)) return null;
  const request = async () => {
    setBusy(true);
    setRequestError('');
    try { await requestMoreApps(); }
    catch (err: any) { setRequestError(err.message || tr("core:could_not_send_your_request_698d8762")); }
    finally { setBusy(false); }
  };
  return (
    <div id={id} className={SURFACE[surface]}
      aria-live="polite"
      data-quota-state={!quota ? 'loading' : serverFull ? 'server-full' : spent ? 'spent' : 'available'}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-zinc-700 dark:text-zinc-200"><Message id="core:app_allowance_aa08e188" /></span>
        <strong className="text-right text-zinc-900 dark:text-zinc-100">
          <LocalizedValue render={() => (!quota ? tr("core:checking_ec963ffc") : serverFull ? tr("core:server_is_full_5dcf7840") : quotaHeadline(quota))} />
        </strong>
      </div>
      {quota && !serverFull ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
        <LocalizedValue render={() => (quota.limit === null ? tr("core:admin_accounts_can_create_apps_without_a_slot_li_508c8cdb")
          : quota.remaining == null ? tr("core:current_usage_is_unavailable_78a480af")
          : tr("core:message_4fa9d295af62", { value1: quota.remaining, count: quota.remaining }))} />
        <LocalizedValue render={() => (spent ? tr("core:request_more_slots_to_create_another_app_d53a57a6") : '')} />
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
          <LocalizedValue render={() => (serverFull
            ? tr("core:message_2774f4bec543", { limit: server.limit, allowance: quota.limit === null ? tr('core:allowance_unlimited') : freeSlots(quota.remaining ?? 0) })
            : tr("core:this_server_has_room_for_value1_limit_value2_d22a3b1c", { value1: moreApps(server.remaining), value2: server.limit }))} />
        </p>
      ) : null}
      {quota && quota.limit !== null && !serverFull ? (
        <div className="mt-2">
          <Button type="button" size="sm" {...REQUEST_BUTTON[surface]} disabled={busy || !!requestedAt} disabledStyle="block" onClick={request}>
            <LocalizedValue render={() => (busy ? tr("core:sending_b8ed5279") : requestedAt ? tr("core:request_pending_bc26ab4d") : tr("core:request_more_339d84f0"))} />
          </Button>
          {requestedAt ? <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400"><Message id="core:admins_have_your_request_you_ll_be_notified_when_68eae4f0" /></p> : null}
        </div>
      ) : null}
      {error || requestError ? <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{requestError || error}</p> : null}
      {error ? <Button type="button" size="sm" disabled={loading} onClick={() => void refreshAppAllowance()}><Message id="core:refresh_allowance_cf0b3e3d" /></Button> : null}
    </div>
  );
}
