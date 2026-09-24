import { useEffect, useState } from 'react';
import { AdminUI } from './admin-console.js';

type Operation = { id: string; binding: string; target: string; phase: string; stage: string; attempt: number; requestedBy: string };
type Binding = { name: string; slug: string; database: string; phase: string; current: { targetId: string; revision: number } };
type Inventory = { enabled: boolean; canWrite: boolean; bindings: Binding[]; targets: { id: string; displayName: string }[]; operations: Operation[] };
type Plan = { id: string; binding: string; slug: string; target: string; expectedRevision: number; from: string; downtime: string; archivesPreviousCopy: boolean };
const endpoint = '/api/admin/database-migrations';

export function DatabaseMigrations() {
  const [data, setData] = useState<Inventory | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch(endpoint, { signal: controller.signal });
        if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to SV to manage database moves.' : 'Migration service unavailable. Existing operations remain recorded.');
        const body = await response.json();
        if (!controller.signal.aborted) { setData(body); setLoadError(''); }
      } catch (e) { if (!controller.signal.aborted) setLoadError((e as Error).message); }
      finally { if (!controller.signal.aborted) timer = setTimeout(load, 3000); }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  async function send(path: string, body: unknown) {
    const response = await fetch(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not submit migration action.');
    return result;
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); setRefresh(r => r + 1); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const label = (id: string) => data?.targets.find(t => t.id === id)?.displayName || id;
  const active = data?.operations.some(o => ['Pending', 'Running', 'NeedsAttention'].includes(o.phase));
  if (data && !data.enabled) return null;
  return <section className={AdminUI.card} aria-label="App database migrations">
    <div className={AdminUI.cardHeader}><h2 className={AdminUI.cardTitle}>Move app databases</h2>
      <a className={AdminUI.btn.outline} href="/database-maintenance" target="_blank" rel="noopener">Open maintenance page</a></div>
    <p className={AdminUI.muted}>Move a selected app to another database cluster. The staging platform and app pause during the move. The maintenance page stays available for progress and recovery.</p>
    {(error || loadError) && <p role="alert" className={AdminUI.muted}>{error || loadError}</p>}
    {!data && !error && <p className={AdminUI.loading}>Loading migrations…</p>}
    {data?.enabled && <>
      <div className={AdminUI.tableWrap}><table className={AdminUI.table}>
        <thead className={AdminUI.thead}><tr><th className={AdminUI.th}>App</th><th className={AdminUI.th}>Current cluster</th><th className={AdminUI.th}>Destination</th><th className={AdminUI.th}>Action</th></tr></thead>
        <tbody>{data.bindings.map(b => <tr key={b.name} className={AdminUI.trHover}>
          <td className={AdminUI.td}>{b.slug}<div className={AdminUI.muted}>{b.phase} · revision {b.current.revision}</div></td>
          <td className={AdminUI.td}>{label(b.current.targetId)}</td>
          <td className={AdminUI.td}><select aria-label={`Destination for ${b.slug}`} className={AdminUI.input}
            disabled={!data.canWrite || busy || !!active || b.phase !== 'Ready'} value={targets[b.name] === b.current.targetId ? '' : targets[b.name] || ''}
            onChange={e => { setTargets(t => ({ ...t, [b.name]: e.target.value })); setPlan(null); }}>
            <option value="">Choose destination</option>
            {data.targets.filter(t => t.id !== b.current.targetId).map(t => <option key={t.id} value={t.id}>{t.displayName}</option>)}
          </select></td>
          <td className={AdminUI.td}><button className={AdminUI.btn.primary} disabled={!data.canWrite || busy || !!active || !targets[b.name] || targets[b.name] === b.current.targetId || b.phase !== 'Ready'}
            onClick={() => void act(async () => { setPlan(await send('/plan', { binding: b.name, target: targets[b.name] })); setConfirmation(''); })}>Review move</button></td>
        </tr>)}</tbody>
      </table></div>
      {plan && <div className={AdminUI.card} role="region" aria-label="Confirm database move">
        <h3 className={AdminUI.cardTitle}>{plan.slug}: {label(plan.from)} → {label(plan.target)}</h3>
        <p className={AdminUI.muted}>{plan.downtime}</p>
        <p className={AdminUI.muted}>{plan.archivesPreviousCopy ? 'The old destination copy will stay fenced under an archive name. Current data will be copied into a fresh database.' : 'Current data will be copied into a fresh database. The source will be retained and fenced after cutover.'}</p>
        <label className={AdminUI.muted}>Type {plan.slug} to confirm planned downtime<input aria-label="Confirm app slug" className={AdminUI.input} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
        <button className={AdminUI.btn.primary} disabled={!data.canWrite || busy || !!active || confirmation !== plan.slug}
          onClick={() => void act(async () => { await send('', { id: plan.id, binding: plan.binding, target: plan.target, expectedRevision: plan.expectedRevision, confirmation }); setPlan(null); })}>Start move</button>
        <button className={AdminUI.btn.outline} disabled={busy} onClick={() => setPlan(null)}>Cancel</button>
      </div>}
      <h3 className={AdminUI.cardTitle}>Migration history</h3>
      {!data.operations.length && <p className={AdminUI.muted}>No moves have been requested from the admin interface yet.</p>}
      {data.operations.map(o => <div key={o.id} className={AdminUI.card}>
        <strong>{data.bindings.find(b => b.name === o.binding)?.slug || o.binding} → {label(o.target)}</strong>
        <p className={AdminUI.muted}>{o.phase} · {o.stage}</p><p className={AdminUI.muted}>{o.id} · requested by admin {o.requestedBy}</p>
        {o.phase === 'NeedsAttention' && data.canWrite && <>
          <p className={AdminUI.muted}>Resume continues the recorded move. Abort is allowed only before cutover, after the copy has stopped; it restores the source and fences the partial destination.</p>
          <button className={AdminUI.btn.primary} disabled={busy} onClick={() => void act(async () => { await send(`/${o.id}/action`, { action: 'resume', attempt: o.attempt }); })}>Resume</button>
          <button className={AdminUI.btn.outline} disabled={busy} onClick={() => {
            if (window.confirm('Abort this move before cutover and restore its source? After cutover, use Resume instead.')) void act(async () => { await send(`/${o.id}/action`, { action: 'abort', attempt: o.attempt }); });
          }}>Abort move</button>
        </>}
      </div>)}
    </>}
  </section>;
}
