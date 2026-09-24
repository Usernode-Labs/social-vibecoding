import { useEffect, useRef, useState } from 'react';
import { DatabaseMigrations } from './database-migrations';
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

type Request = { id: string; target: string; phase: string; reason: string };
type Pool = { id: string; displayName: string; phase: string; acceptingNewApps: boolean; instances?: number;
  capacity: { state: string; message: string; observedAt?: string; ratios?: { cpu: number; memory: number; storage: number } } };
type Inventory = { enabled: boolean; operatorManaged?: boolean; placementEnabled?: boolean; pools?: Pool[]; targets: { id: string; profile: string; displayName?: string }[]; requests: Request[] };
const phases: Record<string, string> = {
  Pending: 'Queued', Provisioning: 'Creating', Ready: 'Ready',
  Blocked: 'Needs attention', RecoveryRequired: 'Recovery required',
};

function DatabaseSection() {
  const [data, setData] = useState<Inventory | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true);
  const canWrite = (window as any).AdminConsole?.canWrite();

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const response = await fetch('/api/admin/database-clusters', { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load database clusters.');
        const body = await response.json();
        if (!controller.signal.aborted) { setData(body); setError(''); }
      } catch {
        if (!controller.signal.aborted) setError('Could not load database clusters.');
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(load, 5000);
      }
    }
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  async function create(target: string) {
    setBusy(target);
    try {
      const response = await fetch('/api/admin/database-clusters', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target }),
      });
      if (!response.ok) throw new Error('Could not request the database cluster.');
      if (alive.current) { setRefresh((value) => value + 1); setError(''); }
    } catch {
      if (alive.current) setError('Could not request the database cluster. You can retry safely.');
    } finally { if (alive.current) setBusy(''); }
  }

  if (data?.operatorManaged) return <><DatabaseMigrations /><section className={`${AdminUI.card} p-4 space-y-4`} aria-label="Database pools">
    <div className={AdminUI.cardHeader}><h2 className={AdminUI.cardTitle}>Database pools</h2>
      <button type="button" className={AdminUI.btn.outline} onClick={() => setRefresh(v => v + 1)}>Refresh</button></div>
    <p className={AdminUI.muted}>Infrastructure operators create and size these shared pools. SV reports their health and capacity.</p>
    {!data.placementEnabled && <p className={AdminUI.muted}>Automatic placement for new apps is not enabled yet. Existing app assignments are preserved.</p>}
    {error && <p role="alert" className={AdminUI.muted}>{error}</p>}
    <div className={AdminUI.tableWrap}><table className={AdminUI.table}>
      <thead className={AdminUI.thead}><tr>{['Pool', 'Status', 'CPU budget used', 'Memory budget used', 'Storage used', 'Capacity'].map(h => <th key={h} className={AdminUI.th}>{h}</th>)}</tr></thead>
      <tbody>{(data.pools || []).map(pool => <tr key={pool.id} className={AdminUI.trHover}>
        <td className={AdminUI.td}>{pool.displayName}<div className={AdminUI.muted}>{pool.instances ?? '—'} instance(s)</div></td>
        <td className={AdminUI.td}>{pool.phase}</td>
        {(['cpu', 'memory', 'storage'] as const).map(key => <td key={key} className={AdminUI.td}>{pool.capacity.ratios ? `${Math.round(pool.capacity.ratios[key] * 100)}%` : '—'}</td>)}
        <td className={AdminUI.td}>{({ available: 'Available', warning: 'Near capacity', full: 'Capacity reached', unknown: 'Unknown' } as Record<string, string>)[pool.capacity.state] || 'Unknown'}</td>
      </tr>)}</tbody></table></div>
    <p className={AdminUI.muted}>CPU and memory use a five-minute average against the reserved budget per instance. Storage shows the fullest instance. These observations do not include new-app reservations or guarantee failover capacity.</p>
    {(data.pools || []).filter(p => p.capacity.state !== 'available' || p.phase !== 'Ready').map(pool => <p role="alert" key={pool.id} className={AdminUI.muted}>{pool.displayName}: {pool.capacity.message}{!pool.acceptingNewApps ? ' Closed to new app assignments.' : ''}</p>)}
    {!data.pools?.length && <p className={AdminUI.muted}>No shared pools registered. An infrastructure operator needs to provision and register a pool.</p>}
  </section></>;

  return <><DatabaseMigrations /><div className={AdminUI.card}>
    <div className={AdminUI.cardHeader}>
      <h2 className={AdminUI.cardTitle}>Database clusters</h2>
      <button type="button" className={AdminUI.btn.outline} onClick={() => setRefresh((value) => value + 1)}>Refresh</button>
    </div>
    {error && <p role="alert" className={AdminUI.muted}>{error}</p>}
    {!data && !error && <p className={AdminUI.loading}>Loading database clusters…</p>}
    {data && !data.enabled && <p className={AdminUI.muted}>Database cluster management is not enabled for this installation.</p>}
    {data?.enabled && <>
      <p className={AdminUI.muted}>Create a configured database cluster. Existing apps keep their current database placement.</p>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}><tr>
            <th className={AdminUI.th}>Cluster</th><th className={AdminUI.th}>Purpose</th>
            <th className={AdminUI.th}>Status</th>{canWrite && <th className={AdminUI.th}>Action</th>}
          </tr></thead>
          <tbody>{data.targets.map((target) => {
            const request = data.requests.find((item) => item.target === target.id);
            return <tr key={target.id} className={AdminUI.trHover}>
              <td className={AdminUI.td}>{target.displayName || target.id}</td><td className={AdminUI.td}>{target.profile === 'retained' ? 'Retained staging' : 'Previews'}</td>
              <td className={AdminUI.td}>{request ? (phases[request.phase] || 'Unknown') : 'Not created'}</td>
              {canWrite && <td className={AdminUI.td}>{!request && <button type="button" className={AdminUI.btn.primary}
                disabled={!!busy} onClick={() => void create(target.id)}>{busy === target.id ? 'Requesting…' : 'Create'}</button>}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>
      {!data.targets.length && <p className={AdminUI.muted}>No database targets have been configured.</p>}
    </>}
  </div></>;
}

let host: Element | null = null;
const AdminDatabases = {
  render(el: Element) { host = el; mountLegacyPortal(el, <DatabaseSection />); },
  destroy() { unmountLegacyPortal(host); host = null; },
};
if (typeof window !== 'undefined') (window as any).AdminDatabases = AdminDatabases;
export { AdminDatabases };
