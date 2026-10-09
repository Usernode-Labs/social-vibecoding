'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Workflows: what the workflow machines (src/workflow/) are doing and what
// needs a person. Problems come first: a faulted or stalled instance, held
// events, a deadline that did not fire, work that ran out of retries or is
// running long, and writes to a machine's columns from outside it. Below
// them, the instances by state, and one instance's timeline: every event
// with its source, result, reason and what it emitted, linked to its cause.
// Actions are events on that timeline (routes/admin-workflow.js), never row
// edits, and need a full admin.

const console_ = () => (window as any).AdminConsole;

type Instance = {
  machine: string; key: string; appId: number | null; state: string; data: any; version: number;
  deadlineAt: string | null; flag: string | null; flagDetail: any; updatedAt: string; heldEvents?: number;
};
type WfEvent = {
  id: number; type: string; payload: any; source: any; actor: string | null; requestKey: string;
  causedBy: number | null; status: string; attempts: number; result: string | null; reason: string | null;
  error: any; stateBefore: string | null; stateAfter: string | null; emitted: any; createdAt: string;
  processedAt: string | null; cause: { machine: string; key: string; type: string } | null;
};
type Work = {
  id: string; kind: string; workKey: string; status: string; attemptCount: number; lastError: any;
  result: any; dueAt: string; attempts: { number: number; outcome: string; service_id: string }[];
};
type Guard = { machine: string; flag: string; on: boolean; flagHere: boolean };
type Overview = {
  running: boolean;
  guards?: Guard[];
  actions: Record<string, string[]>;
  counts: { machine: string; state: string; count: number }[];
  problems: {
    flagged: Instance[];
    overdueDeadlines: Instance[];
    work: (Work & { machine: string; key: string })[];
    ownershipViolations: { table_name: string; column_path: string; count: number; last_at: string }[];
    ownershipViolationRows?: Violation[];
  };
};
type Ref = { machine: string; key: string };
type Violation = {
  id: number; table: string; column: string; row: Record<string, unknown> | null;
  application: string | null; query: string | null; createdAt: string;
};

const RESULT_BADGE = new Map([
  ['accepted', AdminUI.badge.success],
  ['rejected', AdminUI.badge.outline],
  ['replayed', AdminUI.badge.default],
  ['faulted', AdminUI.badge.destructive],
]);
const FLAG_BADGE = new Map([['faulted', AdminUI.badge.destructive], ['stalled', AdminUI.badge.warn]]);

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '');

async function post(url: string, body: object) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function InstanceLink({ r, onOpen }: { r: Ref; onOpen: (r: Ref) => void }) {
  return (
    <button type="button" className={`${AdminUI.btn.link} font-mono text-xs`} onClick={() => onOpen(r)}>
      {`${r.machine} / ${r.key}`}
    </button>
  );
}

// A machine's guard left on while its flag is off here: after a rollback,
// legacy writes to the rows it held are logged (or refused) until an admin
// turns it off. A boot with the flag off never does (the flag is per
// process, and another process may still run the machine).
async function turnGuardOff(g: Guard, onChanged: () => void) {
  const what = 'Turn the guard off';
  if (!(await console_()._confirm({ title: what, confirmLabel: what,
    message: `Only once no process runs ${g.machine} (${g.flag} off everywhere): its rows go back to the legacy writers.` }))) return;
  try { await post('/api/admin/workflow/guard-off', { machine: g.machine }); onChanged(); } catch (err: any) {
    console_()._alert(`${what} failed: ${err.message}`);
  }
}

function Problems({ overview, onOpen, onChanged = () => {} }: { overview: Overview; onOpen: (r: Ref) => void; onChanged?: () => void }) {
  const p = overview.problems;
  const stray = (overview.guards || []).filter((g) => g.on && !g.flagHere);
  const canWrite = typeof window !== 'undefined' && !!console_()?.canWrite();
  const none = !p.flagged.length && !p.overdueDeadlines.length && !p.work.length && !p.ownershipViolations.length && !stray.length;
  return (
    <div id="admin-wf-problems" className={`${AdminUI.card} p-4 mb-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Needs a person</h2>
      </div>
      {none ? <p className={AdminUI.muted}>Nothing is stuck.</p> : null}
      <ul className="space-y-2">
        {p.flagged.map((i) => (
          <li key={`f:${i.machine}:${i.key}`} data-wf-problem="flagged" className="flex flex-wrap items-center gap-2">
            <span className={FLAG_BADGE.get(i.flag || '') || AdminUI.badge.default}>{i.flag}</span>
            <InstanceLink r={i} onOpen={onOpen} />
            <span className={AdminUI.muted}>
              {i.flagDetail?.message || (i.flagDetail?.attempts ? `${i.flagDetail.attempts} timeouts in a row` : '')}
              {i.heldEvents ? ` · ${i.heldEvents} held` : ''}
            </span>
          </li>
        ))}
        {p.overdueDeadlines.map((i) => (
          <li key={`d:${i.machine}:${i.key}`} data-wf-problem="overdue" className="flex flex-wrap items-center gap-2">
            <span className={AdminUI.badge.warn}>deadline passed</span>
            <InstanceLink r={i} onOpen={onOpen} />
            <span className={AdminUI.muted}>{`due ${when(i.deadlineAt)}`}</span>
          </li>
        ))}
        {p.work.map((w) => (
          <li key={`w:${w.id}`} data-wf-problem="work" className="flex flex-wrap items-center gap-2">
            <span className={w.status === 'running' ? AdminUI.badge.warn : AdminUI.badge.destructive}>
              {w.status === 'running' ? 'running long' : 'out of retries'}
            </span>
            <code className="text-xs">{`${w.kind} ${w.workKey}`}</code>
            <InstanceLink r={w} onOpen={onOpen} />
            <span className={AdminUI.muted}>{w.lastError?.message || ''}</span>
          </li>
        ))}
        {stray.map((g) => (
          <li key={`g:${g.machine}`} data-wf-problem="guard" className="flex flex-wrap items-center gap-2">
            <span className={AdminUI.badge.warn}>guard on, flag off here</span>
            <code className="text-xs">{g.machine}</code>
            <span className={AdminUI.muted}>{`${g.flag} is off in this process; the rows the machine held are still guarded.`}</span>
            {canWrite ? (
              <button type="button" className={`${AdminUI.btn.outlineSm} ml-auto`} onClick={() => turnGuardOff(g, onChanged)}>
                Turn the guard off
              </button>
            ) : null}
          </li>
        ))}
        {p.ownershipViolations.map((v) => (
          <li key={`o:${v.table_name}.${v.column_path}`} data-wf-problem="ownership">
            <div className="flex flex-wrap items-center gap-2">
              <span className={AdminUI.badge.warn}>written outside its machine</span>
              <code className="text-xs">{`${v.table_name}.${v.column_path}`}</code>
              <span className={AdminUI.muted}>{`${v.count} times, last ${when(v.last_at)}`}</span>
            </div>
            <ViolationRows rows={(p.ownershipViolationRows || []).filter((r) => r.table === v.table_name && r.column === v.column_path)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// The latest writes of one column: which row, from which application
// (the connection's application_name), and the statement that wrote it.
function ViolationRows({ rows }: { rows: Violation[] }) {
  if (!rows.length) return null;
  return (
    <ul className="mt-1 ml-4 space-y-1">
      {rows.map((r) => (
        <li key={r.id} data-wf-violation={r.id} className="text-xs">
          <span className="font-mono">{`row ${r.row ? JSON.stringify(r.row) : '?'}`}</span>
          <span className={AdminUI.muted}>{` by ${r.application || 'an unnamed connection'}, ${when(r.createdAt)}`}</span>
          {r.query ? <code className={`block ${AdminUI.muted} truncate`} title={r.query}>{r.query}</code> : null}
        </li>
      ))}
    </ul>
  );
}

function Instances({ overview, onOpen }: { overview: Overview; onOpen: (r: Ref) => void }) {
  const [filter, setFilter] = useState<{ machine: string; state: string } | null>(null);
  const [rows, setRows] = useState<Instance[] | null>(null);
  useEffect(() => {
    let live = true;
    const q = filter ? `?machine=${encodeURIComponent(filter.machine)}&state=${encodeURIComponent(filter.state)}` : '';
    console_().fetchJson(`/api/admin/workflow/instances${q}`).then(({ data }: any) => {
      if (live) setRows(data?.instances || []);
    });
    return () => { live = false; };
  }, [filter]);
  return (
    <div id="admin-wf-instances" className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Instances</h2>
        {filter ? <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => setFilter(null)}>All</button> : null}
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        {overview.counts.map((c) => (
          <button
            key={`${c.machine}:${c.state}`}
            type="button"
            data-wf-state={c.state}
            className={filter?.machine === c.machine && filter.state === c.state ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
            onClick={() => setFilter({ machine: c.machine, state: c.state })}
          >
            {`${c.machine} · ${c.state} · ${c.count}`}
          </button>
        ))}
      </div>
      {rows === null ? <p className={AdminUI.loading}>Loading…</p> : null}
      {rows && !rows.length ? <p className={AdminUI.muted}>No instances.</p> : null}
      {rows && rows.length ? (
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table}>
            <thead className={AdminUI.thead}>
              <tr><th className={AdminUI.th}>Instance</th><th className={AdminUI.th}>State</th><th className={AdminUI.th}>Updated</th></tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={`${i.machine}:${i.key}`} className={AdminUI.trHover}>
                  <td className={AdminUI.td}><InstanceLink r={i} onOpen={onOpen} /></td>
                  <td className={AdminUI.td}>
                    <span className={AdminUI.badge.default}>{i.state}</span>
                    {i.flag ? <span className={`${FLAG_BADGE.get(i.flag) || AdminUI.badge.default} ml-1`}>{i.flag}</span> : null}
                  </td>
                  <td className={`${AdminUI.td} ${AdminUI.muted}`}>{when(i.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function emittedLine(e: WfEvent): string {
  const x = e.emitted || {};
  if (x.replayOf) return `replay of #${x.replayOf}`;
  const bits = [];
  if (x.writes?.length) bits.push(`wrote ${x.writes.join(', ')}`);
  if (x.work?.length) bits.push(`work ${x.work.map((w: any) => `${w.kind} ${w.key}`).join(', ')}`);
  if (x.messages?.length) bits.push(`sent ${x.messages.map((m: any) => `${m.type} to ${m.key}`).join(', ')}`);
  if (x.timer) bits.push(`timer ${x.timer.type} at ${when(x.timer.at)}`);
  if (x.timer === null) bits.push('timer cleared');
  return bits.join(' · ');
}

function Timeline({ events, onOpen }: { events: WfEvent[]; onOpen: (r: Ref) => void }) {
  return (
    <ol id="admin-wf-timeline" className="space-y-3">
      {events.map((e) => (
        <li key={e.id} data-wf-event={e.id} data-wf-result={e.result || e.status} className={`${AdminUI.separator} pt-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-sm">{e.type}</span>
            <span className={RESULT_BADGE.get(e.result || '') || AdminUI.badge.warn}>{e.result || e.status}</span>
            {e.reason ? <code className="text-xs">{e.reason}</code> : null}
            {e.stateBefore ? <span className={AdminUI.muted}>{e.stateBefore === e.stateAfter ? e.stateAfter : `${e.stateBefore} → ${e.stateAfter}`}</span> : null}
            <span className={`${AdminUI.muted} ml-auto`}>{`#${e.id} · ${when(e.processedAt || e.createdAt)}`}</span>
          </div>
          <div className={`${AdminUI.muted} text-xs mt-1`}>
            {`${e.source?.kind || '?'}${e.source?.name ? ` (${e.source.name})` : ''}${e.actor ? ` · ${e.actor}` : ''} · ${e.requestKey}`}
            {e.attempts ? ` · ${e.attempts} timeout${e.attempts === 1 ? '' : 's'}` : ''}
          </div>
          {e.cause ? (
            <div className="text-xs mt-1">
              {'caused by '}
              <InstanceLink r={e.cause} onOpen={onOpen} />
              {` ${e.cause.type} #${e.causedBy}`}
            </div>
          ) : null}
          {emittedLine(e) ? <div className={`${AdminUI.muted} text-xs mt-1`}>{emittedLine(e)}</div> : null}
          {e.error ? <div className="text-xs mt-1 text-red-700 dark:text-red-400">{e.error.message}</div> : null}
        </li>
      ))}
    </ol>
  );
}

function InstanceView({ at, actions, onOpen, onBack }: {
  at: Ref; actions: string[]; onOpen: (r: Ref) => void; onBack: () => void;
}) {
  const canWrite = !!console_()?.canWrite();
  const [detail, setDetail] = useState<{ instance: Instance | null; events: WfEvent[]; work: Work[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const load = useCallback(async () => {
    const q = `machine=${encodeURIComponent(at.machine)}&key=${encodeURIComponent(at.key)}`;
    const { data } = await console_().fetchJson(`/api/admin/workflow/instance?${q}`);
    if (alive.current) setDetail(data || { instance: null, events: [], work: [] });
  }, [at.machine, at.key]);
  useEffect(() => { setDetail(null); load(); }, [load]);

  const act = useCallback(async (what: string, url: string, body: object, confirm?: string) => {
    if (confirm && !(await console_()._confirm({ title: what, message: confirm, confirmLabel: what }))) return;
    setBusy(true);
    try {
      const out = await post(url, { machine: at.machine, key: at.key, ...body });
      if (out.status === 'rejected') console_()._alert(`${what}: refused (${out.reason})`);
      else if (out.status === 'pending') (window as any).PlatformUI?.toast?.(`${what}: queued`);
    } catch (err: any) {
      console_()._alert(`${what} failed: ${err.message}`);
    } finally {
      if (alive.current) { setBusy(false); load(); }
    }
  }, [at.machine, at.key, load]);

  const inst = detail?.instance;
  const event = (type: string, payload = {}) => ['/api/admin/workflow/event', { type, payload }] as const;
  return (
    <div id="admin-wf-instance">
      <button type="button" className={`${AdminUI.btn.ghost} text-sm mb-3`} onClick={onBack}>← Workflows</button>
      <div className={`${AdminUI.card} p-4 mb-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={`${AdminUI.cardTitle} font-mono`}>{`${at.machine} / ${at.key}`}</h2>
          <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => load()}>Refresh</button>
        </div>
        {!detail ? <p className={AdminUI.loading}>Loading…</p> : null}
        {inst ? (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className={AdminUI.badge.secondary}>{inst.state}</span>
            {inst.flag ? <span className={FLAG_BADGE.get(inst.flag) || AdminUI.badge.default}>{inst.flag}</span> : null}
            <span className={AdminUI.muted}>{`version ${inst.version}${inst.appId ? ` · app ${inst.appId}` : ''}`}</span>
            {inst.deadlineAt ? <span className={AdminUI.muted}>{`· next check ${when(inst.deadlineAt)}`}</span> : null}
          </div>
        ) : null}
        {inst && canWrite ? (
          <div className="flex flex-wrap gap-2">
            {inst.flag === 'faulted' ? (
              <>
                <button type="button" disabled={busy} className={AdminUI.btn.primarySm}
                  onClick={() => act('Retry the faulted event', '/api/admin/workflow/release', { mode: 'retry' })}>
                  Retry faulted event
                </button>
                <button type="button" disabled={busy} className={AdminUI.btn.outlineSm}
                  onClick={() => act('Skip the faulted event', '/api/admin/workflow/release', { mode: 'skip' },
                    'The faulted event stays unapplied and the held events after it run. Use this only when the event should never apply.')}>
                  Skip faulted event
                </button>
              </>
            ) : null}
            {actions.includes('Evaluate') && inst.state === 'open' ? (
              <button type="button" disabled={busy} className={AdminUI.btn.outlineSm}
                onClick={() => act('Re-check now', ...event('Evaluate'))}>Re-check now</button>
            ) : null}
            {actions.includes('RetryDelivery') && inst.state === 'deploy_failed' ? (
              <button type="button" disabled={busy} className={AdminUI.btn.primarySm}
                onClick={() => act('Retry delivery', ...event('RetryDelivery'))}>Retry delivery</button>
            ) : null}
            {actions.includes('AdminApply') && inst.state === 'open' ? (
              <button type="button" disabled={busy} className={AdminUI.btn.destructiveSm}
                onClick={() => act('Apply now', ...event('AdminApply'),
                  'This applies the proposal without the vote it is waiting for, as an admin override.')}>
                Apply now
              </button>
            ) : null}
          </div>
        ) : null}
        {inst && !canWrite ? <p className={AdminUI.muted}>View-only admin: actions need a full admin.</p> : null}
        {inst ? (
          <details className="mt-3">
            <summary className={`${AdminUI.muted} cursor-pointer`}>State data</summary>
            <pre id="admin-wf-data" className="mt-2 text-xs whitespace-pre-wrap break-all">{JSON.stringify(inst.data, null, 2)}</pre>
          </details>
        ) : null}
      </div>

      {detail?.work.length ? (
        <div className={`${AdminUI.card} p-4 mb-4`}>
          <h2 className={`${AdminUI.cardTitle} mb-3`}>Work</h2>
          <ul id="admin-wf-work" className="space-y-2">
            {detail.work.map((w) => {
              const outcome = w.result?.outcome;
              // A failed delivery is retried as a whole (Retry delivery above).
              const retryable = canWrite && actions.includes('RetryFollowup') && w.kind !== 'app.deliver'
                && (outcome === 'failed' || outcome === 'exhausted');
              return (
                <li key={w.id} data-wf-work={w.workKey} className="flex flex-wrap items-center gap-2">
                  <code className="text-xs">{`${w.kind} ${w.workKey}`}</code>
                  <span className={outcome === 'succeeded' ? AdminUI.badge.success
                    : (outcome ? AdminUI.badge.destructive : AdminUI.badge.default)}>{outcome || w.status}</span>
                  <span className={AdminUI.muted}>{`${w.attemptCount} attempt${w.attemptCount === 1 ? '' : 's'}`}</span>
                  {w.lastError?.message ? <span className="text-xs text-red-700 dark:text-red-400">{w.lastError.message}</span> : null}
                  {retryable ? (
                    <button type="button" disabled={busy} className={`${AdminUI.btn.outlineSm} ml-auto`}
                      onClick={() => act('Retry', ...event('RetryFollowup', { workKey: w.workKey }))}>Retry</button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {detail ? (
        <div className={`${AdminUI.card} p-4`}>
          <h2 className={`${AdminUI.cardTitle} mb-3`}>Timeline</h2>
          {detail.events.length ? <Timeline events={detail.events} onOpen={onOpen} /> : <p className={AdminUI.muted}>No events.</p>}
        </div>
      ) : null}
    </div>
  );
}

function WorkflowsSection() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [at, setAt] = useState<Ref | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const load = useCallback(async () => {
    const { data } = await console_().fetchJson('/api/admin/workflow');
    if (alive.current) setOverview(data || null);
  }, []);
  useEffect(() => { if (!at) load(); }, [at, load]);

  if (at) {
    return <InstanceView at={at} actions={overview?.actions?.[at.machine] || []} onOpen={setAt} onBack={() => setAt(null)} />;
  }
  if (!overview) return <p className={AdminUI.loading}>Loading…</p>;
  return (
    <div>
      {!overview.running ? (
        <p id="admin-wf-off" className={`${AdminUI.muted} mb-4`}>
          No workflow runs in this process (WF_GOVERNANCE_ENABLED is off). What is recorded is still shown.
        </p>
      ) : null}
      <Problems overview={overview} onOpen={setAt} onChanged={load} />
      <Instances overview={overview} onOpen={setAt} />
    </div>
  );
}

let host: Element | null = null;

const AdminWorkflows = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <WorkflowsSection />);
  },
  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

if (typeof window !== 'undefined') (window as any).AdminWorkflows = AdminWorkflows;

// The views are exported for tests/admin-workflows.test.js, which renders them.
export { AdminWorkflows, Problems, Timeline };
