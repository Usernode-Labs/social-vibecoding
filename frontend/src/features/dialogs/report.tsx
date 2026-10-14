import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { useMessages } from '../../lib/i18n/react';
import { useDialog } from './use-dialog';

export type ReportTarget = { targetType: 'app' | 'user' | 'app_message' | 'conversation_message'; target: string | number; label: string; userId?: number };
export function openReport(target: ReportTarget) {
  (window as any).UsernodeReact?.dialogs?.report?.open(target);
}
// The second item is a message id (frontend/locales/en/dialogs.json), read
// when the list renders.
export const REPORT_REASONS = [
  ['spam', 'dialogs:report.reason.spam'], ['scam', 'dialogs:report.reason.scam'], ['harassment', 'dialogs:report.reason.harassment'],
  ['hate', 'dialogs:report.reason.hate'], ['threats', 'dialogs:report.reason.threats'], ['sexual_content', 'dialogs:report.reason.sexualContent'],
  ['impersonation', 'dialogs:report.reason.impersonation'], ['other', 'dialogs:report.reason.other'],
];
export function ReportDialog() {
  const t = useMessages('dialogs');
  const [target, setTarget] = useState<ReportTarget | null>(null);
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const detailRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [blockAction, setBlockAction] = useState<{ appSlug?: string; userId?: number; username?: string } | null>(null);
  const dialog = useDialog<ReportTarget>('report', {
    onOpen(value) {
      (window as any).UITelemetry?.screen?.('report_dialog');
      if (detailRef.current) detailRef.current.value = '';
      setTarget(value || null); setReason(''); setDetail(''); setError('');
      setReceipt(null); setBlocked(false); setBlockAction(null);
    },
    canClose: () => !busy,
  });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!target || busy || !reason || (reason === 'other' && !detail.trim())) return;
    setBusy(true); setError('');
    const telemetry = (window as any).UITelemetry;
    const attemptId = telemetry?.attempt?.('content_report_submit', {
      screen: 'report_dialog', timeoutMs: 10_000, abandonOnHide: true,
    });
    let responseReceived = false;
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...telemetry?.contextHeaders?.(attemptId) },
        body: JSON.stringify({ targetType: target.targetType, target: target.target, reason, detail }),
      });
      responseReceived = true;
      const data = await response.json();
      if (!response.ok) {
        telemetry?.outcome?.(attemptId, 'failure', {
          errorCode: telemetry?.errorCodeFor?.(response.status),
        });
        throw new Error(data.error || t('dialogs:report.error.send'));
      }
      telemetry?.outcome?.(attemptId, 'success');
      setReceipt(data.id);
      setBlockAction(target.targetType === 'app'
        ? (data.blockAppSlug ? { appSlug: data.blockAppSlug } : null)
        : (data.blockUserId && data.blockUsername ? { userId: data.blockUserId, username: data.blockUsername } : null));
    } catch (err) {
      telemetry?.outcome?.(attemptId, 'failure', {
        errorCode: responseReceived ? 'invalid_response' : 'network',
      });
      setError((err as Error).message);
    }
    finally { setBusy(false); }
  }
  async function block() {
    if (!blockAction || busy) return;
    setBusy(true); setError('');
    try {
      const path = blockAction.appSlug ? `/api/me/app-blocks/${encodeURIComponent(blockAction.appSlug)}` : `/api/me/blocks/${blockAction.userId}`;
      const response = await fetch(path, { method: 'PUT' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t('dialogs:report.error.block'));
      setBlocked(true);
      if (blockAction.appSlug) {
        window.dispatchEvent(new CustomEvent('app-blocks-changed', { detail: data }));
        const app = (window as any).App;
        if ((window as any).AppView?.appData?.slug === blockAction.appSlug) app?.navigateHome?.();
        (window as any).Home?.load?.();
        (window as any).Notifications?.refresh?.();
      }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <DialogRoot id="report-modal" ref={dialog.rootRef} {...dialog.backdropProps}>
    <DialogCard>
      {target ? <>
      <h2 className="text-lg font-bold">{receipt ? t('dialogs:report.title.received') : target?.targetType === 'app' ? t('dialogs:report.title.app') : target?.targetType === 'user' ? t('dialogs:report.title.user') : t('dialogs:report.title.message')}</h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{target?.label}</p>
      {receipt ? <div className="mt-4 space-y-4">
        <p role="status">{t('dialogs:report.received', { number: receipt })}</p>
        {blockAction?.appSlug ? <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('dialogs:report.blockAppNote')}</p> : null}
        <div className="flex flex-wrap gap-3">
          {blockAction ? <Button type="button" disabled={busy || blocked} onClick={() => void block()}>{blocked ? (blockAction.appSlug ? t('dialogs:report.block.appDone') : t('dialogs:report.block.userDone', { username: blockAction.username })) : (blockAction.appSlug ? t('dialogs:report.block.app') : t('dialogs:report.block.user', { username: blockAction.username }))}</Button> : null}
          <Button type="button" disabled={busy} onClick={dialog.close}>{t('core:common.done')}</Button>
        </div>
      </div> : <form className="mt-4 space-y-4" onSubmit={submit}>
        {target?.targetType === 'conversation_message' ? <p className="text-sm">{t('dialogs:report.privateMessageNote')}</p> : null}
        <label className="block text-sm font-medium">{t('dialogs:report.reason.label')}
          <select required className="mt-1 w-full min-h-[44px] rounded-lg border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">{t('dialogs:report.reason.choose')}</option>
            {REPORT_REASONS.filter(([key]) => key !== 'impersonation' || target?.targetType === 'user').map(([key,label]) => <option key={key} value={key}>{t(label)}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">{reason === 'other' ? t('dialogs:report.details.required') : t('dialogs:report.details.optional')}
          <textarea className="mt-1 w-full rounded-lg border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900" rows={4} maxLength={1000} required={reason === 'other'} ref={detailRef} defaultValue="" onChange={(e) => setDetail(e.target.value)} />
        </label>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('dialogs:report.identityNote')}</p>
        <div className="flex gap-3"><Button type="button" disabled={busy} onClick={dialog.close}>{t('core:common.cancel')}</Button><Button type="submit" disabled={busy || !reason || (reason === 'other' && !detail.trim())}>{busy ? t('dialogs:report.sending') : t('dialogs:report.submit')}</Button></div>
      </form>}
      {error ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      </> : null}
    </DialogCard>
  </DialogRoot>;
}
