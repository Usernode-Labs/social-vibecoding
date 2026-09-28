import { useEffect, useState } from 'react';
import { AdminUI } from './admin-console.js';

const base = '/api/admin/database-migrations/batches';
type Move = { operation: string; slug: string; from: { targetId: string }; to: { targetId: string }; databaseBytes: number };
type Plan = { id: string | null; moves: Move[]; kept: { slug: string; target: string }[] };
type Batch = { id: string; phase: string; attempt: number; plan: Plan; progress: { stage?: string; children?: Record<string, string> } };
type Data = { inventoryError?: string; enabled: boolean; canWrite: boolean;
  apps: { name: string; slug: string; phase: string; current?: { targetId: string }; bytes?: number }[];
  targets: { id: string; displayName: string }[]; batches: Batch[] };

function ScopePicker({ label, options, selected, disabled, onChange }: {
  label: string; options: { id: string; label: string }[]; selected: string[]; disabled: boolean; onChange: (ids: string[]) => void;
}) {
  return <fieldset disabled={disabled} className="min-w-0 space-y-3">
    <legend className={AdminUI.cardTitle}>{label}</legend>
    <select aria-label={`Add ${label.toLowerCase()}`} className={AdminUI.input} value="" onChange={e => onChange([...selected, e.target.value])}>
      <option value="">Add to scope…</option>
      {options.filter(o => !selected.includes(o.id)).map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
    <div className="flex flex-wrap gap-2">
      {selected.map(id => <button type="button" key={id} className={AdminUI.btn.outline}
        aria-label={`Remove ${options.find(o => o.id === id)?.label || id}`} onClick={() => onChange(selected.filter(s => s !== id))}>
        {options.find(o => o.id === id)?.label || id} <span aria-hidden="true">×</span>
      </button>)}
      {!selected.length && <p className={AdminUI.muted}>None selected</p>}
    </div>
    <div className="flex gap-3">
      <button type="button" className={AdminUI.btn.outline} onClick={() => onChange(options.map(o => o.id))}>Add all</button>
      <button type="button" className={AdminUI.btn.outline} disabled={!selected.length} onClick={() => onChange([])}>Clear</button>
    </div>
  </fieldset>;
}

export function DatabaseBatches() {
  const [data, setData] = useState<Data | null>(null);
  const [apps, setApps] = useState<string[]>([]), [targets, setTargets] = useState<string[]>([]);
  const [custom, setCustom] = useState(false), [plan, setPlan] = useState<Plan | null>(null);
  const [confirmation, setConfirmation] = useState(''), [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false), [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const c = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await fetch(base, { signal: c.signal });
        if (!r.ok) throw Error('Bulk migration service unavailable');
        const d = await r.json();
        if (!c.signal.aborted) { setData(d); setLoadError(''); }
      } catch (e) { if (!c.signal.aborted) setLoadError((e as Error).message); }
      finally { if (!c.signal.aborted) timer = setTimeout(load, 5000); }
    };
    void load(); return () => { c.abort(); clearTimeout(timer); };
  }, [refresh]);
  async function send(path: string, body: unknown) {
    setBusy(true); setError('');
    try {
      const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const d = await r.json();
      if (!r.ok) throw Error(d.error || 'Migration request failed');
      setRefresh(v => v + 1); return d;
    } catch (e) { setError((e as Error).message); return null; }
    finally { setBusy(false); }
  }
  async function suggest(body: unknown) {
    setPlan(null); setConfirmation('');
    const result = await send('/plan', body);
    if (result) setPlan(result);
  }
  const label = (id: string) => id === 'central' ? 'Central database' : data?.targets.find(t => t.id === id)?.displayName || id;
  const active = !!data?.batches.some(b => ['Pending', 'Running', 'NeedsAttention'].includes(b.phase));
  const ready = data?.apps.filter(a => a.phase === 'Ready') || [];
  const disabled = !data?.canWrite || busy || active || !!loadError || !!data?.inventoryError;
  const customValid = apps.length > 0 && apps.length <= 20 && targets.length > 0
    && apps.every(id => ready.some(a => a.name === id)) && targets.every(id => data?.targets.some(t => t.id === id));
  const history = data?.batches.filter(b => b.phase !== 'Planned') || [];
  if (data && !data.enabled) return null;
  return <section className={`${AdminUI.card} p-4 mb-4 space-y-4`} aria-label="Bulk database migration" aria-busy={busy}>
    <h2 className={AdminUI.cardTitle}>Distribute app databases</h2>
    <p className={AdminUI.muted}>Suggest a placement across shared pools using current capacity, database sizes and reserved demand. Newly added pools are included automatically.</p>
    {(error || loadError || data?.inventoryError) && <p role="alert" className={AdminUI.muted}>{error || loadError || data?.inventoryError}</p>}
    {!data && !loadError && <p className={AdminUI.loading}>Loading database distribution…</p>}
    {data && <>
      <p className={AdminUI.muted}>{ready.length} ready apps · {data.targets.length} accepting pools · up to 20 apps per batch</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={AdminUI.btn.primary} disabled={disabled || !ready.length || !data.targets.length || ready.length > 20}
          onClick={() => void suggest({ mode: 'balanced' })}>{busy ? 'Working…' : 'Suggest distribution'}</button>
        <button type="button" className={AdminUI.btn.outline} disabled={disabled} aria-expanded={custom} aria-controls="database-distribution-scope"
          onClick={() => { setCustom(v => !v); setPlan(null); }}>{custom ? 'Hide custom scope' : 'Customize scope'}</button>
      </div>
      <p className={AdminUI.muted}>Suggestions do not move databases. Review the changes before starting a maintenance batch.</p>
      {ready.length > 20 && <p className={AdminUI.muted}>Choose up to 20 apps in a custom scope to review the next batch.</p>}
      {active && <p role="status" className={AdminUI.muted}>Finish or recover the active migration batch before planning another distribution.</p>}
      {!data.canWrite && <p className={AdminUI.muted}>Read-only access. A full administrator can review and start a distribution.</p>}
      {custom && <div id="database-distribution-scope" className="space-y-4">
        <div className="grid gap-6 md:grid-cols-2">
          <ScopePicker label="Apps" options={ready.map(a => ({ id: a.name, label: a.slug }))} selected={apps} disabled={disabled} onChange={ids => { setApps(ids); setPlan(null); }} />
          <ScopePicker label="Pools" options={data.targets.map(t => ({ id: t.id, label: t.displayName }))} selected={targets} disabled={disabled} onChange={ids => { setTargets(ids); setPlan(null); }} />
        </div>
        <button type="button" className={AdminUI.btn.outline} disabled={disabled || !customValid} onClick={() => void suggest({ apps, targets })}>Review custom distribution</button>
      </div>}
      <div className={AdminUI.tableWrap}><table className={AdminUI.table} aria-label="Current app placement">
        <thead className={AdminUI.thead}><tr>{['App', 'Current pool', 'Database size', 'Status'].map(h => <th key={h} className={AdminUI.th}>{h}</th>)}</tr></thead>
        <tbody>{data.apps.map(a => <tr key={a.name} className={AdminUI.trHover}>
          <td className={`${AdminUI.td} break-words`}>{a.slug}</td><td className={AdminUI.td}>{a.current ? label(a.current.targetId) : 'Unavailable'}</td>
          <td className={AdminUI.td}>{a.bytes == null ? '—' : `${(a.bytes / 1048576).toFixed(1)} MiB`}</td><td className={AdminUI.td}>{a.phase}</td>
        </tr>)}</tbody>
      </table></div>
      {!data.apps.length && !data.inventoryError && <p className={AdminUI.muted}>No apps are registered for migration.</p>}
      {!data.targets.length && <p className={AdminUI.muted}>An operator needs to register and open a shared pool before distribution can be planned.</p>}
    </>}
    {plan && <div role="region" aria-label="Confirm bulk migration" className="space-y-4 border-t pt-4">
      <h3 className={AdminUI.cardTitle}>{plan.moves.length ? 'Proposed distribution' : 'No moves needed'}</h3>
      <p role="status" className={AdminUI.muted}>{plan.moves.length ? `${plan.moves.length} apps to move · ${plan.kept.length} stay in place` : 'The selected apps already fit the suggested distribution.'}</p>
      <div className={AdminUI.tableWrap}><table className={AdminUI.table} aria-label="Proposed app placement">
        <thead className={AdminUI.thead}><tr>{['App', 'Current pool', 'Proposed pool', 'Action'].map(h => <th key={h} className={AdminUI.th}>{h}</th>)}</tr></thead>
        <tbody>{plan.moves.map(m => <tr key={m.operation} className={AdminUI.trHover}>
          <td className={AdminUI.td}>{m.slug}</td><td className={AdminUI.td}>{label(m.from.targetId)}</td><td className={AdminUI.td}>{label(m.to.targetId)}</td><td className={AdminUI.td}>Move · {(m.databaseBytes / 1048576).toFixed(1)} MiB</td>
        </tr>)}{plan.kept.map(k => <tr key={k.slug} className={AdminUI.trHover}>
          <td className={AdminUI.td}>{k.slug}</td><td className={AdminUI.td}>{label(k.target)}</td><td className={AdminUI.td}>{label(k.target)}</td><td className={AdminUI.td}>Stay</td>
        </tr>)}</tbody>
      </table></div>
      {!!plan.moves.length && plan.id && <>
        <p className={AdminUI.muted}>Starting pauses the platform once and moves apps sequentially. Verified source databases are deleted after cutover. Completed moves are kept if a later move stops.</p>
        <label className={`${AdminUI.muted} block`}>Type {plan.id} to confirm downtime and source deletion
          <input aria-label="Confirm batch ID" className={AdminUI.input} disabled={disabled} value={confirmation} onChange={e => setConfirmation(e.target.value)} />
        </label>
        <button type="button" className={`${AdminUI.btn.primary} mr-3`} disabled={disabled || confirmation !== plan.id} onClick={async () => { if (await send('/' + plan.id + '/start', { confirmation })) setPlan(null); }}>Start batch</button>
      </>}
      <button type="button" className={AdminUI.btn.outline} disabled={busy} onClick={() => setPlan(null)}>Close review</button>
    </div>}
    {!!history.length && <details className="space-y-3" open={active || undefined}><summary className={`${AdminUI.cardTitle} cursor-pointer`}>Batch history ({history.length})</summary>
      {history.map(b => <div className="border-t pt-3 space-y-2" key={b.id}>
        <strong className="break-all">{b.id}</strong><p>{b.phase} · {b.progress.stage || 'Queued'}</p>
        {b.plan.moves.map(m => <p className={AdminUI.muted} key={m.operation}>{m.slug} → {label(m.to.targetId)} · {b.progress.children?.[m.operation] || 'Pending'}</p>)}
        {b.phase === 'NeedsAttention' && data?.canWrite && <div className="flex flex-wrap gap-3">
          <button type="button" disabled={busy} className={AdminUI.btn.primary} onClick={() => void send('/' + b.id + '/action', { action: 'resume', attempt: b.attempt })}>Resume batch</button>
          <button type="button" disabled={busy} className={AdminUI.btn.outline} onClick={() => { if (window.confirm('Cancel pending moves? The current move must be safely aborted or completed; already completed moves remain in place.')) void send('/' + b.id + '/action', { action: 'cancel', attempt: b.attempt }); }}>Cancel remaining moves</button>
        </div>}
      </div>)}
    </details>}
  </section>;
}
