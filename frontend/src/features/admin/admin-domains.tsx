'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Domains (#admin/domains, #4405): every custom domain a project has
// claimed, with where it stands (waiting for DNS, getting a certificate,
// live, not working, disabled), when it was verified, when its certificate
// expires and the last error the sweep recorded. Four levers: check again,
// disable (the host stops being served; the project keeps its Homeroom
// address), enable (verified again from the start) and remove.
//
// The rows come from GET /api/admin/domains (services/app-domains.js); the
// levers POST /api/admin/domains/:id/{check,disable,enable} and DELETE.
//
// PERMISSIONS: visible to any admin. Every control is gated on
// AdminConsole.canWrite() here and on requireAdminWrite on the server.

type DomainStatus = 'pending' | 'verified' | 'live' | 'failed' | 'disabled';

interface DomainRow {
  id: number;
  appSlug: string;
  appName: string;
  createdBy: string | null;
  hostname: string;
  status: DomainStatus;
  last_error: string | null;
  checked_at: string | null;
  verified_at: string | null;
  live_at: string | null;
  cert_expires_at: string | null;
  created_at: string | null;
  disabledAt: string | null;
  failureCount: number;
}

interface DomainsPayload {
  domains: DomainRow[];
  sweep: { lastSweepAt: string | null; lastError: string | null; sweepInFlight: boolean } | null;
}

type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

const STATUS_BADGE: Record<DomainStatus, string> = {
  pending: AdminUI.badge.warn,
  verified: AdminUI.badge.secondary,
  live: AdminUI.badge.success,
  failed: AdminUI.badge.destructive,
  disabled: AdminUI.badge.default,
};
const STATUS_LABEL: Record<DomainStatus, string> = {
  pending: 'Waiting for DNS',
  verified: 'Getting a certificate',
  live: 'Live',
  failed: 'Not working',
  disabled: 'Disabled',
};

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString();
}

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 60000) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function StatusLine({ status }: { status: Status | null }) {
  return (
    <p id="admin-domains-status" className={status
      ? `text-xs mt-2 ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
      : 'text-xs mt-2 hidden'}>
      {status ? status.text : ''}
    </p>
  );
}

function DomainRowView({ row, canWrite, onChanged, setStatus }: {
  row: DomainRow;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  setStatus: (s: Status | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const console_ = () => (window as any).AdminConsole;

  const send = async (method: string, action: string, done: string) => {
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/admin/domains/${row.id}${action ? `/${action}` : ''}`, { method });
      const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setStatus({ text: done, tone: 'ok' });
      await onChanged();
    } catch (err: any) {
      setStatus({ text: `Could not do that: ${err.message}`, tone: 'err' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const ok = await console_()._confirm({
      title: `Remove ${row.hostname}?`,
      message: `${row.appName} stops being served at this address. Its Homeroom address keeps working.`,
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    await send('DELETE', '', `Removed ${row.hostname}.`);
  };

  return (
    <tr className={AdminUI.trHover} data-domain-id={row.id}>
      <td className={AdminUI.td}>
        <div className="font-medium text-zinc-900 dark:text-zinc-100 break-all">{row.hostname}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          Added {ago(row.created_at)}{row.createdBy ? ` by @${row.createdBy}` : ''}
        </div>
      </td>
      <td className={AdminUI.td}>
        <div className="text-zinc-900 dark:text-zinc-100">{row.appName}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">{row.appSlug}</div>
      </td>
      <td className={AdminUI.td}>
        <span className={STATUS_BADGE[row.status] || AdminUI.badge.default}>{STATUS_LABEL[row.status] || row.status}</span>
        {row.last_error ? <div className="mt-1 text-xs text-amber-800 dark:text-amber-300 max-w-xs">{row.last_error}</div> : null}
      </td>
      <td className={AdminUI.td}>
        <div className="text-zinc-900 dark:text-zinc-100">{when(row.verified_at) || 'Not yet'}</div>
        <div className="text-xs text-zinc-500 dark:text-zinc-400">Checked {ago(row.checked_at)}</div>
      </td>
      <td className={AdminUI.td}>{when(row.cert_expires_at) || (row.status === 'live' ? 'Unknown' : 'No certificate')}</td>
      {canWrite ? (
        <td className={AdminUI.td}>
          <div className="flex flex-wrap gap-2">
            {row.status !== 'disabled' ? (
              <button type="button" className={AdminUI.btn.outlineSm} disabled={busy}
                onClick={() => send('POST', 'check', `Checked ${row.hostname}.`)}>Check again</button>
            ) : null}
            {row.status === 'disabled' ? (
              <button type="button" className={AdminUI.btn.outlineSm} disabled={busy}
                onClick={() => send('POST', 'enable', `${row.hostname} is being verified again.`)}>Enable</button>
            ) : (
              <button type="button" className={AdminUI.btn.outlineSm} disabled={busy}
                onClick={() => send('POST', 'disable', `${row.hostname} is no longer served.`)}>Disable</button>
            )}
            <button type="button" className={AdminUI.btn.destructiveSm} disabled={busy} onClick={remove}>Remove</button>
          </div>
        </td>
      ) : null}
    </tr>
  );
}

function DomainsSection() {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();

  const [data, setData] = useState<DomainsPayload | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { ok, status: code, data: body } = await console_().fetchJson('/api/admin/domains');
    if (!alive.current) return;
    if (!ok || !body || typeof body !== 'object') {
      setLoadError(code === 0 ? 'Could not reach the server.' : `Could not load the domains (HTTP ${code}).`);
      return;
    }
    setLoadError('');
    setData(body as DomainsPayload);
  }, []);
  useEffect(() => { load(); }, [load]);

  const domains = data?.domains || [];
  const liveCount = domains.filter((d) => d.status === 'live').length;
  const problemCount = domains.filter((d) => d.status === 'failed').length;

  return (
    <div id="admin-domains">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Domains</h2>
          <button id="admin-domains-refresh-btn" type="button" className={AdminUI.btn.outline} onClick={() => load()}>
            Refresh
          </button>
        </div>
        <p className={AdminUI.muted}>
          Every custom domain a project has claimed. A claim is proved by a CNAME to the project&apos;s Homeroom
          address and a TXT record; once both answer, the edge gets a certificate and the address goes live.
          Disabling a domain stops serving it without touching the project.
        </p>
        <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
          {data?.sweep ? `Checked automatically every minute. Last sweep ${ago(data.sweep.lastSweepAt)}.` : ''}
          {liveCount ? ` ${liveCount} live.` : ''}
          {problemCount ? ` ${problemCount} not working.` : ''}
        </p>
        <StatusLine status={status} />
      </div>

      <div className={`${AdminUI.card} p-4 mt-4`}>
        {loadError ? <p className="text-sm text-red-400">{loadError}</p> : null}
        {!loadError && !data ? <p className={AdminUI.loading}>Loading…</p> : null}
        {data ? (
          <div className={AdminUI.tableWrap}>
            <table id="admin-domains-table" className={AdminUI.table}>
              <thead className={AdminUI.thead}>
                <tr>
                  <th className={AdminUI.th}>Domain</th>
                  <th className={AdminUI.th}>Project</th>
                  <th className={AdminUI.th}>Status</th>
                  <th className={AdminUI.th}>Verified</th>
                  <th className={AdminUI.th}>Certificate expires</th>
                  {canWrite ? <th className={AdminUI.th}>Actions</th> : null}
                </tr>
              </thead>
              <tbody id="admin-domains-rows">
                {domains.length === 0 ? (
                  <tr>
                    <td className={`${AdminUI.td} text-zinc-500 dark:text-zinc-400`} colSpan={canWrite ? 6 : 5}>
                      No custom domains yet.
                    </td>
                  </tr>
                ) : domains.map((row) => (
                  <DomainRowView key={row.id} row={row} canWrite={canWrite} onChanged={load} setStatus={setStatus} />
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminDomains = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <DomainsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminDomains = AdminDomains;

export { AdminDomains };
