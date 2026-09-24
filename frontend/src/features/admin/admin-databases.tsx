import { useEffect, useRef, useState } from 'react';
import { DatabaseMigrations } from './database-migrations';
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

type Request = { id: string; target: string; phase: string; reason: string };
type Inventory = { enabled: boolean; targets: { id: string; profile: string; displayName?: string }[]; requests: Request[] };
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
