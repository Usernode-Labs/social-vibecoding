import { useEffect, useRef, useState } from 'react';
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

const LABELS: Record<string,string> = {
  new: 'New', in_review: 'In review', resolved: 'Resolved', dismissed: 'Dismissed',
  app: 'App', user: 'User', app_message: 'App message', conversation_message: 'Private message',
  review: 'Start review', resolve: 'Resolve', dismiss: 'Dismiss', reopen: 'Reopen', note: 'Add internal note',
  hide_message: 'Hide message', restore_message: 'Restore message', suspend_app: 'Suspend app', restore_app: 'Restore app',
  suspend_user: 'Suspend user',
  hide_profile: 'Hide profile', restore_profile: 'Restore profile', restrict_user: 'Restrict participation', restore_user: 'Restore participation',
};
const EFFECTS: Record<string,string> = {
  hide_message: 'Replace this message with “Removed by moderation” and block access to its attachments.',
  restore_message: 'Make the original message and its attachments visible again.',
  suspend_app: 'Remove this app from discovery and block access through Homeroom, including direct app links. Code and data are preserved.',
  restore_app: 'Restore access to this app in Homeroom.',
  suspend_user: 'Hide this user’s public profile and prevent messaging, posting, invitations, voting, coding work and app creation/publishing. Account settings and existing data remain available.',
  hide_profile: 'Hide this user’s public profile. Their account and messages remain.',
  restore_profile: 'Restore this user’s public profile if they have published it.',
  restrict_user: 'Prevent messaging, posting, invitations, voting, coding work and app creation/publishing. Account settings and existing data remain available.',
  restore_user: 'Allow this user to participate again.',
  resolve: 'Close this case and notify its reporters that review is complete. Existing restrictions remain.',
  dismiss: 'Close this case without taking moderation action and notify its reporters that it was dismissed.',
  reopen: 'Return this case to the review queue. Existing restrictions remain.',
};
async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, init); const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Could not load moderation data');
  return body;
}
function Evidence({ value }: { value: any }) {
  return <div className="space-y-2 rounded-lg bg-zinc-100 p-3 dark:bg-zinc-900">
    {value.author ? <p>{`Author: @${value.author}`}</p> : null}
    {value.location ? <p>{`Location: ${value.location}`}</p> : value.conversationId ? <p>{`Conversation #${value.conversationId}`}</p> : null}
    {value.threadType ? <p>{`${value.threadType} discussion #${value.threadRef}`}</p> : null}
    {value.username ? <p>{`User: @${value.username}`}</p> : null}
    {value.name ? <p>{`App: ${value.name} (${value.slug})`}</p> : null}
    {value.deployedVersion ? <p className={AdminUI.muted}>{`Reported version: ${value.deployedVersion}`}</p> : null}
    {value.displayName ? <p>{value.displayName}</p> : null}
    {value.bio ? <p className="whitespace-pre-wrap break-words">{value.bio}</p> : null}
    {typeof value.content === 'string' ? <blockquote className="whitespace-pre-wrap break-words">{value.content || '(No text; see attachments)'}</blockquote> : null}
    {Array.isArray(value.objects) ? value.objects.map((object: any, index: number)=><p key={index}>{`Shared ${object.type || object.objectType || 'item'}: ${object.title || 'Unavailable'}`}</p>) : null}
    {value.createdAt ? <p className={AdminUI.muted}>{`Message sent ${new Date(value.createdAt).toLocaleString()}`}</p> : null}
    {value.legacySnapshotUnavailable ? <p className={AdminUI.muted}>The earlier reporting system did not save profile content.</p> : null}
    {value.legacyStatus ? <p className={AdminUI.muted}>{`Previous review: ${value.legacyStatus}${value.resolvedAt ? ' · '+new Date(value.resolvedAt).toLocaleString() : ''}`}</p> : null}
  </div>;
}
function targetState(t: any) {
  if (!t) return 'Target was removed; retained evidence remains available.';
  if (t.profile_disabled_at && t.participation_restricted_at) return 'User suspended';
  const states = [t.moderation_hidden_at && 'Message hidden', t.moderation_suspended_at && 'App suspended', t.profile_disabled_at && 'Public profile hidden', t.participation_restricted_at && 'Participation restricted'].filter(Boolean);
  return states.length ? states.join(' · ') : 'No active moderation restriction';
}
export function ModerationSection() {
  const [filters,setFilters] = useState({ status: 'new', type: '', reason: '', since: '' });
  const [rows,setRows] = useState<any[]>([]), [next,setNext] = useState<string | null>(null);
  const [selected,setSelected] = useState<number | null>(null), [detail,setDetail] = useState<any>(null);
  const [canWrite,setCanWrite] = useState(false), [error,setError] = useState('');
  const [loading,setLoading] = useState(false), [busy,setBusy] = useState(false), [version,setVersion] = useState(0);
  const [pendingAction,setPendingAction] = useState(''), [reason,setReason] = useState('');
  const seq = useRef(0);
  async function load(before?: string) {
    const run = ++seq.current; setLoading(true); setError('');
    try {
      const q = new URLSearchParams(Object.entries(filters).filter(([,v]) => v));
      if (before) q.set('before',before);
      const data = await request(`/api/admin/moderation?${q}`);
      if (run !== seq.current) return;
      setRows((old) => before ? [...old,...data.cases] : data.cases); setNext(data.next); setCanWrite(data.canWrite);
    } catch (err) { if (run === seq.current) setError((err as Error).message); }
    finally { if (run === seq.current) setLoading(false); }
  }
  useEffect(() => { void load(); return () => { seq.current++; }; }, [filters,version]);
  useEffect(() => { setReason(''); }, [selected]);
  useEffect(() => {
    setDetail(null);
    if (!selected) return;
    const controller = new AbortController();
    request(`/api/admin/moderation/${selected}`, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setDetail(data); }).catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [selected,version]);
  async function loadMore(kind: 'reports' | 'actions') {
    if (!selected || busy) return;
    const caseId = selected;
    setBusy(true); setError('');
    try {
      const data = await request(`/api/admin/moderation/${caseId}?${kind === 'reports' ? 'reportBefore' : 'actionBefore'}=${detail[kind+'Next']}`);
      setDetail((old: any) => old && old.case.id === data.case.id ? { ...old, [kind]: [...old[kind], ...data[kind]], [kind+'Next']: data[kind+'Next'], files: kind === 'reports' ? [...old.files,...data.files] : old.files } : old);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function act(action: string) {
    if (!selected || !detail || !action || !reason.trim() || busy) return;
    if (!(window as any).confirm(`${LABELS[action]}?\n\n${EFFECTS[action] || 'This note is visible only to administrators.'}\n\nReason: ${reason.trim()}`)) return;
    setBusy(true); setPendingAction(action); setError('');
    try {
      await request(`/api/admin/moderation/${selected}/actions`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ action,reason,revision:detail.case.revision }) });
      setVersion(v=>v+1);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); setPendingAction(''); }
  }
  const closed = detail && ['resolved','dismissed'].includes(detail.case.status);
  const target = detail?.target;
  const restriction = detail?.case.target_type === 'app' ? 'suspend_app' : detail?.case.target_type === 'user' ? 'suspend_user' : 'hide_message';
  const completed = !!(restriction === 'suspend_app' ? target?.moderation_suspended_at : restriction === 'suspend_user'
    ? target?.profile_disabled_at && target?.participation_restricted_at : target?.moderation_hidden_at);
  const closingAction = closed ? (detail.case.status === 'resolved' ? 'resolve' : 'dismiss') : detail?.actionTaken ? 'resolve' : 'dismiss';
  const actionRows = detail ? [
    { action: restriction, completed, unavailable: !target ? 'This target no longer exists.' : restriction === 'suspend_app' && target.self_hosted ? 'Homeroom itself cannot be suspended here.' : '' },
    { action: closingAction, completed: !!closed, unavailable: '' },
  ] : [];
  return <div className="space-y-4">
    <h2 className={AdminUI.sectionTitle}>Moderation</h2>
    <p className={AdminUI.muted}>Private reports about apps, messages and users. Reports alone never impose restrictions.</p>
    <div className="grid gap-3 sm:grid-cols-4">
      <label className={AdminUI.label}>Status<select className={AdminUI.select} value={filters.status} onChange={e=>setFilters({...filters,status:e.target.value})}>{['new','in_review','resolved','dismissed','all'].map(k=><option key={k} value={k}>{LABELS[k] || 'All'}</option>)}</select></label>
      <label className={AdminUI.label}>Target<select className={AdminUI.select} value={filters.type} onChange={e=>setFilters({...filters,type:e.target.value})}><option value="">All targets</option>{['app','user','app_message','conversation_message'].map(k=><option key={k} value={k}>{LABELS[k]}</option>)}</select></label>
      <label className={AdminUI.label}>Reason<select className={AdminUI.select} value={filters.reason} onChange={e=>setFilters({...filters,reason:e.target.value})}><option value="">All reasons</option>{['spam','scam','harassment','hate','threats','sexual_content','impersonation','unsafe_avatar','unsafe_content','other'].map(k=><option key={k} value={k}>{k.replace(/_/g,' ')}</option>)}</select></label>
      <label className={AdminUI.label}>Reported since<input className={AdminUI.input} type="date" value={filters.since} onChange={e=>setFilters({...filters,since:e.target.value})}/></label>
    </div>
    {error ? <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error} <button className={AdminUI.btn.link} onClick={()=>setVersion(v=>v+1)}>Refresh</button></p> : null}
    <div className="grid gap-4 lg:grid-cols-2"><div className={`${AdminUI.card} min-w-0 p-4`}>
      {loading ? <p className={AdminUI.loading}>Loading reports…</p> : !rows.length ? <p className={AdminUI.muted}>No reports match these filters.</p> : null}
      <div className="divide-y divide-zinc-200 dark:divide-zinc-800">{rows.map(c=><button key={c.id} type="button" className="block w-full py-3 text-left" aria-pressed={Number(selected)===Number(c.id)} onClick={()=>setSelected(c.id)}><strong className="break-words">{c.target_label}</strong><div className={AdminUI.muted}>{LABELS[c.target_type]} · {c.report_count} reports · {LABELS[c.status]}</div><div className={AdminUI.muted}>{new Date(c.created_at).toLocaleString()} · {(c.reasons || []).join(', ')}</div></button>)}</div>
      {next ? <button className={AdminUI.btn.outlineSm} disabled={loading} onClick={()=>void load(next)}>Load more</button> : null}
    </div><div className={`${AdminUI.card} min-w-0 p-4`}>
      {!selected ? <p className={AdminUI.muted}>Select a report to review its evidence and history.</p> : !detail ? <p className={AdminUI.loading}>Loading case…</p> : <div className="space-y-4">
        <h3 className={`${AdminUI.cardTitle} break-words`}>{detail.case.target_label}</h3>
        <p className={AdminUI.muted}>{`${LABELS[detail.case.status]} · ${targetState(detail.target)}`}</p>
        <p className={AdminUI.muted}>{`Target owner: ${detail.case.target_username ? '@'+detail.case.target_username : 'Deleted user'}`}</p>
        {detail.reports.map((r:any)=><section key={r.id} className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800"><strong>Report #{r.id} · {r.reason.replace(/_/g,' ')}</strong><p className={AdminUI.muted}>From @{r.reporter || 'Deleted user'} · {new Date(r.created_at).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{r.detail}</p>{r.evidence ? <Evidence value={r.evidence}/> : <p className={AdminUI.muted}>Evidence retention period ended.</p>}{detail.files.filter((f:any)=>f.report_id===r.id).map((f:any)=><a key={f.id} className={AdminUI.btn.link} href={`/api/admin/moderation/${selected}/files/${f.id}`} download>{f.filename}</a>)}</section>)}
        {detail.reportsNext ? <button className={AdminUI.btn.outlineSm} disabled={busy} onClick={()=>void loadMore('reports')}>Older reports</button> : null}
        <section aria-label="Moderation actions" className="space-y-3">
          {canWrite && detail.canWrite && !closed ? <label className={`block ${AdminUI.label}`}>Reason<textarea className={AdminUI.textarea} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)}/></label> : null}
          {actionRows.map(row=><div key={row.action} className="space-y-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-3">
              <p className="flex min-w-0 items-center gap-2 font-medium">{row.completed ? <svg role="img" aria-label="Completed" className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6"/></svg> : null}{LABELS[row.action]}</p>
              <button type="button" className={`${row.completed ? AdminUI.btn.outlineSm : AdminUI.btn.primarySm} shrink-0 disabled:cursor-default disabled:opacity-50`} disabled={busy || row.completed || !!row.unavailable || !!closed || !canWrite || !detail.canWrite || !reason.trim()} onClick={()=>void act(row.action)}>{pendingAction === row.action ? 'Saving…' : LABELS[row.action]}</button>
            </div>
            <p className={AdminUI.muted}>{row.unavailable || EFFECTS[row.action]}</p>
          </div>)}
          {!canWrite || !detail.canWrite ? <p className={AdminUI.muted}>View-only access.</p> : null}
        </section>
        <h4 className={AdminUI.cardTitle}>Action history</h4>{detail.actions.map((a:any)=><div key={a.id}><strong>{LABELS[a.action] || a.action}</strong><p className={AdminUI.muted}>@{a.actor || 'Deleted user'} · {new Date(a.created_at).toLocaleString()}</p><p className="whitespace-pre-wrap break-words">{a.reason}</p></div>)}
        {detail.actionsNext ? <button className={AdminUI.btn.outlineSm} disabled={busy} onClick={()=>void loadMore('actions')}>Older actions</button> : null}
      </div>}
    </div></div>
  </div>;
}
let host: Element | null = null;
export const AdminModeration = { render(el:Element) { host=el; mountLegacyPortal(el,<ModerationSection/>); }, destroy() { unmountLegacyPortal(host); host=null; } };
if (typeof window !== 'undefined') (window as any).AdminModeration=AdminModeration;
