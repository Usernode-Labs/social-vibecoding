import { useEffect, useState } from 'react';
import { AdminUI } from './admin-console.js';

export function AccountDeletions() {
  const [rows, setRows] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
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
  return <section className={`${AdminUI.card} mt-6`} aria-label="Deleted account cleanup">
    <div className={AdminUI.cardTitle}>Deleted account cleanup</div>
    <p className="text-xs text-zinc-500 dark:text-zinc-400">Accounts lose access immediately. Provider keys, worker files and private uploads are removed through retryable cleanup.</p>
    <button type="button" className={AdminUI.btn.outlineSm} onClick={() => void load()}>Refresh cleanup status</button>
    {error && <p role="alert">{error}</p>}
    {!rows.length && <p className="text-xs">No account deletions recorded.</p>}
    {rows.map(row => <div key={row.id} className="mt-3 text-xs">
      <span>Deleted user #{row.user_id}: {row.completed_at ? 'Cleanup complete' : row.tasks.some((t: any) => t.state === 'review') ? 'Provider review required' : 'Cleanup pending'}</span>
      {!row.completed_at && <>
        <p>{row.tasks.filter((t: any) => t.state !== 'completed').map((t: any) => `${t.kind}: ${t.state}${t.errorCode ? ' (will retry)' : ''}`).join(', ')}</p>
        {row.tasks.some((t: any) => t.state === 'review') && <p>Verify OpenRouter’s usernode-user-{row.user_id} key using the account-deletion runbook before completing reconciliation.</p>}
        <button type="button" className={AdminUI.btn.outlineSm} disabled={busy} onClick={() => void retry(row.id)}>Retry pending cleanup</button>
      </>}
    </div>)}
  </section>;
}
