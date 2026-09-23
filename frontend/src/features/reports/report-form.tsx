import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';

export type ReportKind = 'app' | 'message' | 'user';

const REASONS: Record<ReportKind, Array<[string, string]>> = {
  app: [['spam', 'Spam'], ['harassment', 'Harassment'], ['unsafe_content', 'Unsafe content'], ['impersonation', 'Impersonation'], ['other', 'Other']],
  message: [['spam', 'Spam'], ['harassment', 'Harassment'], ['threats', 'Threats'], ['hate', 'Hate'], ['sexual_content', 'Sexual content'], ['other', 'Other']],
  user: [['spam', 'Spam'], ['harassment', 'Harassment'], ['impersonation', 'Impersonation'], ['unsafe_avatar', 'Unsafe avatar'], ['other', 'Other']],
};

export async function submitReport(path: string, reason: string, detail: string): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason, detail: detail.trim().slice(0, 500) }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body?.error === 'string' ? body.error : 'Couldn’t submit this report.');
  }
}

export function ReportForm({ kind, onSubmit, onCancel }: {
  kind: ReportKind;
  onSubmit: (reason: string, detail: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState(REASONS[kind][0][0]);
  const [detail, setDetail] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  async function send(event: FormEvent) {
    event.preventDefault();
    if (busy || done) return;
    setBusy(true); setError('');
    try { await onSubmit(reason, detail); setDone(true); }
    catch (err) { setError(err instanceof Error ? err.message : 'Couldn’t submit this report.'); }
    finally { setBusy(false); }
  }

  return (
    <form className="mt-3 rounded-xl border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      onSubmit={(event) => { void send(event); }} aria-label={`Report ${kind}`}>
      {done ? <p role="status" className="text-emerald-700 dark:text-emerald-400">Report received. An admin will review it.</p> : (
        <>
          <label className="block font-medium">Reason
            <select className="mt-1 block w-full rounded-lg border border-zinc-300 bg-transparent p-2 dark:border-zinc-700"
              value={reason} onChange={(event) => setReason(event.target.value)}>
              {REASONS[kind].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="mt-3 block font-medium">Details <span className="font-normal text-zinc-500">(optional)</span>
            <textarea className="mt-1 block w-full rounded-lg border border-zinc-300 bg-transparent p-2 dark:border-zinc-700"
              rows={2} maxLength={500} value={detail} onChange={(event) => setDetail(event.target.value)} />
          </label>
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">Reports are private. Sending one does not hide the content.</p>
          {error ? <p role="alert" className="mt-2 text-red-700 dark:text-red-400">{error}</p> : null}
        </>
      )}
      <div className="mt-3 flex gap-2">
        {!done ? <Button type="submit" disabled={busy} size="narrow" className="disabled:opacity-60">
          {busy ? 'Sending…' : 'Send report'}
        </Button> : null}
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-zinc-600 dark:text-zinc-300">{done ? 'Close' : 'Cancel'}</button>
      </div>
    </form>
  );
}
