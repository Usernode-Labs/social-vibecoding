import { useEffect, useState } from 'react';
import { AdminUI } from './admin-console.js';

// The cleanup log for deleted accounts, at the foot of the Users section.
// Collapsed when every deletion has finished cleaning up, open when one is
// still pending, so the card only takes room when it needs attention.
function stateOf(row: any): { label: string; badge: string } {
  if (row.completed_at) return { label: 'Cleanup complete', badge: AdminUI.badge.success };
  if (row.tasks.some((t: any) => t.state === 'review')) return { label: 'Provider review required', badge: AdminUI.badge.warn };
  return { label: 'Cleanup pending', badge: AdminUI.badge.warn };
}

export function AccountDeletions() {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // null until the operator chooses; until then, open only if something is pending.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  async function load() {
    setError('');
    try {
      const res = await fetch('/api/admin/account-deletions');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load account cleanup.');
      setRows(data.deletions);
    } catch (err: any) { setError(err.message); }
  }
  useEffect(() => { void load(); }, []);
  async function retry(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/account-deletions/${id}/retry`, { method: 'POST' });
      if (!res.ok) throw new Error('Could not retry cleanup.');
      await load();
    } catch (err: any) { setError(err.message); }
    finally { setBusy(false); }
  }
  const list = rows || [];
  const pending = list.filter((r) => !r.completed_at).length;
  const open = expanded == null ? pending > 0 : expanded;
  return <section id="admin-account-deletions" className={`${AdminUI.card} mt-6 p-4`} aria-label="Deleted account cleanup">
    <div className="flex flex-wrap items-center gap-2">
      <h2 className={AdminUI.cardTitle}>Deleted account cleanup</h2>
      {pending ? <span className={AdminUI.badge.warn}>{`${pending} pending`}</span> : null}
      <div className="ml-auto flex items-center gap-2">
        <button type="button" className={AdminUI.btn.outlineSm} onClick={() => void load()}>Refresh cleanup status</button>
        <button type="button" className={AdminUI.btn.outlineSm} aria-expanded={open}
          aria-controls="admin-account-deletions-body" onClick={() => setExpanded(!open)}>{open ? 'Hide' : 'Show'}</button>
      </div>
    </div>
    <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">Accounts lose access immediately. Provider keys, worker files and private uploads are removed through retryable cleanup.</p>
    {error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">{error}</p>}
    {!open && rows && list.length && !pending ? (
      <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">{`${list.length} deleted account${list.length === 1 ? '' : 's'}, all cleaned up.`}</p>
    ) : null}
    {open ? <div id="admin-account-deletions-body" className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">
      {rows && !list.length && <p className="text-xs text-zinc-500 dark:text-zinc-400">No account deletions recorded.</p>}
      {list.map((row) => {
        const st = stateOf(row);
        return <div key={row.id} className="py-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-zinc-900 dark:text-zinc-100">{`Deleted user #${row.user_id}`}</span>
            <span className={st.badge}>{st.label}</span>
          </div>
          {!row.completed_at && <>
            <p className="mt-1 text-zinc-600 dark:text-zinc-300">{row.tasks.filter((t: any) => t.state !== 'completed').map((t: any) => `${t.kind}: ${t.state}${t.errorCode ? ' (will retry)' : ''}`).join(', ')}</p>
            {row.tasks.some((t: any) => t.state === 'review') && <p className="mt-1 text-zinc-600 dark:text-zinc-300">Verify OpenRouter’s usernode-user-{row.user_id} key using the account-deletion runbook before completing reconciliation.</p>}
            <button type="button" className={`${AdminUI.btn.outlineSm} mt-2`} disabled={busy} onClick={() => void retry(row.id)}>Retry pending cleanup</button>
          </>}
        </div>;
      })}
    </div> : null}
  </section>;
}
