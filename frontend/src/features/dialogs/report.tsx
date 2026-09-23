import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { useDialog } from './use-dialog';

export type ReportTarget = { targetType: 'app' | 'user' | 'app_message' | 'conversation_message'; target: string | number; label: string; userId?: number };
export function openReport(target: ReportTarget) {
  (window as any).UsernodeReact?.dialogs?.report?.open(target);
}
export const REPORT_REASONS = [
  ['spam', 'Spam'], ['scam', 'Scam or fraud'], ['harassment', 'Harassment'],
  ['hate', 'Hate'], ['threats', 'Threats'], ['sexual_content', 'Sexual or unsafe content'],
  ['impersonation', 'Impersonation'], ['other', 'Other'],
];
export function ReportDialog() {
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const detailRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const dialog = useDialog<ReportTarget>('report', {
    onOpen(value) { if (detailRef.current) detailRef.current.value = ''; setTarget(value || null); setReason(''); setDetail(''); setError(''); setReceipt(null); setBlocked(false); },
    canClose: () => !busy,
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || busy || !reason || (reason === 'other' && !detail.trim())) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetType: target.targetType, target: target.target, reason, detail }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not send your report. Try again.');
      setReceipt(data.id);
      setTarget(current => current ? {...current, userId: data.blockUserId || current.userId} : current);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function block() {
    if (!target?.userId || busy) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/me/blocks/${target.userId}`, { method: 'PUT' });
      if (!response.ok) throw new Error('Could not block this user. Try again.');
      setBlocked(true);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <DialogRoot id="report-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
    <DialogCard>
      <h2 className="text-lg font-bold">{receipt ? 'Report received' : `Report ${target?.targetType === 'app' ? 'app' : target?.targetType === 'user' ? 'user' : 'message'}`}</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{target?.label}</p>
      {receipt ? <div className="mt-4 space-y-4">
        <p role="status">{`Report #${receipt} received. We’ll review it and notify you when review finishes.`}</p>
        {target?.userId ? <Button type="button" disabled={busy || blocked} onClick={() => void block()}>{blocked ? 'User blocked' : 'Block user'}</Button> : null}
        <Button type="button" disabled={busy} onClick={dialog.close}>Done</Button>
      </div> : <form className="mt-4 space-y-4" onSubmit={submit}>
        {target?.targetType === 'conversation_message' ? <p className="text-sm">Moderators will receive this message and its attachments. Your other private messages are not included.</p> : null}
        <label className="block text-sm font-medium">Reason
          <select required className="mt-1 w-full min-h-[44px] rounded-lg border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose a reason</option>
            {REPORT_REASONS.filter(([key]) => key !== 'impersonation' || target?.targetType === 'user').map(([key,label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">{reason === 'other' ? 'Details (required)' : 'Details (optional)'}
          <textarea className="mt-1 w-full rounded-lg border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900" rows={4} maxLength={1000} required={reason === 'other'} ref={detailRef} defaultValue="" onChange={(e) => setDetail(e.target.value)} />
        </label>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">Your identity is visible to moderators, not to the reported person or app owner.</p>
        <div className="flex gap-3"><Button type="button" disabled={busy} onClick={dialog.close}>Cancel</Button><Button type="submit" disabled={busy || !reason || (reason === 'other' && !detail.trim())}>{busy ? 'Sending…' : 'Submit report'}</Button></div>
      </form>}
      {error ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
    </DialogCard>
  </DialogRoot>;
}
