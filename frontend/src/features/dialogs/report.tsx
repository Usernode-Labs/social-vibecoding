import { useMessages as useUiLanguage } from "../../lib/i18n/react";
import { LocalizedValue, LocalizedDynamic } from "../../lib/i18n/react";
import { t as tr } from "../../lib/i18n/runtime";
import { Message } from "../../lib/i18n/react";
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { DialogCard, DialogRoot } from '@/components/ui/dialog';
import { useDialog } from './use-dialog';

export type ReportTarget = { targetType: 'app' | 'user' | 'app_message' | 'conversation_message'; target: string | number; label: string; userId?: number };
export function openReport(target: ReportTarget) {
  (window as any).UsernodeReact?.dialogs?.report?.open(target);
}
export const REPORT_REASONS = () => ([
  ['spam', tr("core:spam_94a9eac4")], ['scam', tr("core:scam_or_fraud_5f0f908b")], ['harassment', tr("core:harassment_98a7655d")],
  ['hate', tr("core:hate_e562e8ea")], ['threats', tr("core:threats_0631f128")], ['sexual_content', tr("core:sexual_or_unsafe_content_2bf99866")],
  ['impersonation', tr("core:impersonation_05955157")], ['other', tr("core:other_f97e9da0")],
]);
export function ReportDialog() {
  useUiLanguage();
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
        throw new Error(data.error || tr("core:could_not_send_your_report_try_again_97fca689"));
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
      if (!response.ok) throw new Error(data.error || tr("core:could_not_block_try_again_0c8e525b"));
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
      <h2 className="text-lg font-bold"><LocalizedValue render={() => (receipt ? tr("core:report_received_6b10cb5b") : tr("core:report_value1_1613da87", { value1: target?.targetType === 'app' ? tr("core:message_a172cedcae47") : target?.targetType === 'user' ? tr("core:message_04f8996da763") : tr("core:message_ab530a13e459") }))} /></h2>
      <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">{target?.label}</p>
      {receipt ? <div className="mt-4 space-y-4">
        <p role="status"><LocalizedValue render={() => (tr("core:report_value1_received_we_ll_review_it_and_notif_4b3d5a35", { value1: receipt }))} /></p>
        {blockAction?.appSlug ? <p className="text-sm text-zinc-500 dark:text-zinc-400"><Message id="core:blocking_hides_this_app_and_stops_its_notificati_db79ebe6" /></p> : null}
        <div className="flex flex-wrap gap-3">
          {blockAction ? <Button type="button" disabled={busy || blocked} onClick={() => void block()}><LocalizedValue render={() => (blocked ? (blockAction.appSlug ? tr("core:app_blocked_0e3c7373") : tr("core:message_f9756c1de1a7", { username: blockAction.username })) : (blockAction.appSlug ? tr("core:block_app_c73e9312") : tr("core:block_value1_1cff48c9", { value1: blockAction.username })))} /></Button> : null}
          <Button type="button" disabled={busy} onClick={dialog.close}><Message id="core:done_11a6767d" /></Button>
        </div>
      </div> : <form className="mt-4 space-y-4" onSubmit={submit}>
        {target?.targetType === 'conversation_message' ? <p className="text-sm"><Message id="core:moderators_will_receive_this_message_and_its_att_dd40aaeb" /></p> : null}
        <label className="block text-sm font-medium"><Message id="core:reason_f81ab834" /><select required className="mt-1 w-full min-h-[44px] rounded-lg border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value=""><Message id="core:choose_a_reason_f9479b86" /></option>
            {REPORT_REASONS().filter(([key]) => key !== 'impersonation' || target?.targetType === 'user').map(([key,label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium"><LocalizedValue render={() => (reason === 'other' ? tr("core:details_required_f58d5c0c") : tr("core:details_optional_4239d7e4"))} />
          <textarea className="mt-1 w-full rounded-lg border border-zinc-300 bg-white p-2 dark:border-zinc-700 dark:bg-zinc-900" rows={4} maxLength={1000} required={reason === 'other'} ref={detailRef} defaultValue="" onChange={(e) => setDetail(e.target.value)} />
        </label>
        <p className="text-xs text-zinc-500 dark:text-zinc-400"><Message id="core:your_identity_is_visible_to_moderators_not_to_th_1c738f8e" /></p>
        <div className="flex gap-3"><Button type="button" disabled={busy} onClick={dialog.close}><Message id="core:cancel_19766ed6" /></Button><Button type="submit" disabled={busy || !reason || (reason === 'other' && !detail.trim())}><LocalizedValue render={() => (busy ? tr("core:sending_b8ed5279") : tr("core:submit_report_b41fd589"))} /></Button></div>
      </form>}
      {error ? <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p> : null}
      </> : null}
    </DialogCard>
  </DialogRoot>;
}
