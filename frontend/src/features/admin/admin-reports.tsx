import { useEffect, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Private moderation queue. The four source tables retain their own access
// rules and evidence; this screen gives operators one place to review them.
type Kind = 'user' | 'conversation' | 'app' | 'app-message';
type Status = 'pending' | 'resolved' | 'dismissed';
type Row = {
  id: number; kind: Kind; reason: string; detail?: string | null;
  status: Status; created_at: string; resolved_at?: string | null;
  reporter_username?: string | null; reported_username?: string | null;
  profile_username?: string | null; app_slug_snapshot?: string | null;
  app_name_snapshot?: string | null; content_snapshot?: string | null;
  evidence_snapshot?: { threadType?: string | null; threadRef?: number | null; attachments?: Array<{ name?: string }> } | null;
  resolved_by_username?: string | null;
};

const SOURCES: Array<{ kind: Kind; path: string; label: string }> = [
  { kind: 'user', path: '/api/admin/profile-reports', label: 'User' },
  { kind: 'conversation', path: '/api/admin/conversation-reports', label: 'Message' },
  { kind: 'app', path: '/api/admin/app-reports', label: 'Mini-app' },
  { kind: 'app-message', path: '/api/admin/app-message-reports', label: 'App discussion' },
];

function target(row: Row): string {
  if (row.kind === 'user') return `@${row.profile_username || 'deleted account'}`;
  if (row.kind === 'app') return row.app_name_snapshot || row.app_slug_snapshot || 'deleted app';
  if (row.kind === 'app-message') {
    const thread = row.evidence_snapshot?.threadType;
    const ref = row.evidence_snapshot?.threadRef;
    return `${row.app_slug_snapshot || 'deleted app'}${thread && ref ? ` · ${thread} #${ref}` : ' · #general'}`;
  }
  return `@${row.reported_username || 'deleted account'}`;
}

function actionPath(row: Row, action: 'resolve' | 'dismiss'): string {
  const path = SOURCES.find((source) => source.kind === row.kind)?.path;
  return `${path}/${row.id}/${action}`;
}

function ReportsSection() {
  const [status, setStatus] = useState<Status>('pending');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const canWrite = !!(window as any).AdminConsole?.canWrite?.();

  useEffect(() => {
    let live = true;
    setRows(null); setError('');
    Promise.all(SOURCES.map(async (source) => {
      const response = await fetch(`${source.path}?status=${status}`);
      if (!response.ok) throw new Error(`Couldn’t load ${source.label.toLowerCase()} reports.`);
      const data = await response.json();
      return (Array.isArray(data.reports) ? data.reports : []).map((row: Row) => ({ ...row, kind: source.kind }));
    })).then((groups) => {
      if (live) setRows(groups.flat().sort((a, b) =>
        new Date(a.created_at).getTime() - new Date(b.created_at).getTime() || a.id - b.id));
    }).catch((err) => { if (live) setError(err instanceof Error ? err.message : 'Couldn’t load reports.'); });
    return () => { live = false; };
  }, [status]);

  async function act(row: Row, action: 'resolve' | 'dismiss') {
    if (!canWrite || !window.confirm(`${action === 'resolve' ? 'Resolve' : 'Dismiss'} this report? This does not remove content or suspend an account.`)) return;
    const key = `${row.kind}:${row.id}`;
    setBusy(key); setError('');
    try {
      const response = await fetch(actionPath(row, action), { method: 'POST' });
      if (!response.ok) throw new Error(`Couldn’t ${action} this report.`);
      setRows((current) => current?.filter((item) => `${item.kind}:${item.id}` !== key) || []);
    } catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t update this report.'); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className={AdminUI.cardTitle}>Reports</h2>
        <p className={AdminUI.cardDescription}>Private reports about accounts, messages, and mini-apps. Reviewing a report does not take down its target.</p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Report status">
        {(['pending', 'resolved', 'dismissed'] as const).map((value) => (
          <button key={value} type="button" aria-pressed={status === value}
            className={status === value ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
            onClick={() => setStatus(value)}>{value[0].toUpperCase() + value.slice(1)}</button>
        ))}
      </div>
      {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      {rows === null ? <p className={AdminUI.loading}>Loading reports…</p>
        : rows.length === 0 ? <p className={AdminUI.muted}>No {status} reports.</p>
          : rows.map((row) => {
            const key = `${row.kind}:${row.id}`;
            const source = SOURCES.find((item) => item.kind === row.kind);
            return (
              <article key={key} className={`${AdminUI.card} p-4`} data-report-kind={row.kind}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <span className={AdminUI.badge.secondary}>{source?.label}</span>
                    <h3 className="mt-2 font-semibold text-zinc-900 dark:text-zinc-100">{target(row)}</h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{`Reason: ${row.reason} · Reported by @${row.reporter_username || 'deleted account'} · ${new Date(row.created_at).toLocaleString()}`}</p>
                  </div>
                  {status === 'pending' && canWrite ? <div className="flex gap-2">
                    <button type="button" className={AdminUI.btn.primarySm} disabled={busy === key}
                      onClick={() => { void act(row, 'resolve'); }}>Resolve</button>
                    <button type="button" className={AdminUI.btn.outlineSm} disabled={busy === key}
                      onClick={() => { void act(row, 'dismiss'); }}>Dismiss</button>
                  </div> : null}
                </div>
                {row.content_snapshot ? <p className="mt-3 whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-200">{row.content_snapshot}</p> : null}
                {row.evidence_snapshot?.attachments?.length ? <p className={AdminUI.muted}>
                  {`Attachments: ${row.evidence_snapshot.attachments.map((a) => a.name || 'file').join(', ')}`}</p> : null}
                {row.detail ? <p className="mt-2 whitespace-pre-wrap break-words text-sm text-zinc-700 dark:text-zinc-200">{`Reporter note: ${row.detail}`}</p> : null}
                {row.resolved_at ? <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{`${row.status} by @${row.resolved_by_username || 'deleted admin'} · ${new Date(row.resolved_at).toLocaleString()}`}</p> : null}
              </article>
            );
          })}
    </div>
  );
}

let host: Element | null = null;
const AdminReports = {
  render(el: Element) { host = el; mountLegacyPortal(el, <ReportsSection />); },
  destroy() { unmountLegacyPortal(host); host = null; },
};
if (typeof window !== 'undefined') (window as any).AdminReports = AdminReports;

export { AdminReports, ReportsSection };
