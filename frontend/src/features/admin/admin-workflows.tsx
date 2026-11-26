'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
// The shared admin kit (26 Nov 2026): header, figures, bar, list and badges
// are the same parts every other admin page is drawn with.
import { BackButton, Badge, Figures, List, ScreenHeader, Toolbar } from './topochain/ui.tsx';
import type { Column, Figure } from './topochain/ui.tsx';

// Workflows: what the workflow machines (src/workflow/) are doing and what
// needs a person. Problems come first: which processes run the workflow,
// an event nobody decides, work nobody takes, a faulted or stalled instance,
// held events, a deadline that did not fire, work that ran out of retries or
// is running long. Below
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
type Runner = { id: string; role: string; release: string | null; host: string | null; state: string; startedAt: string };
type Overview = {
  running: boolean;
  runners?: Runner[];
  actions: Record<string, string[]>;
  counts: { machine: string; state: string; count: number }[];
  problems: {
    flagged: Instance[];
    overdueDeadlines: Instance[];
    work: (Work & { machine: string; key: string })[];
    waiting?: (Instance & { says: string | null })[];
    unclaimed?: { id: string; machine: string; key: string; kind: string; workKey: string; waitedSeconds: number }[];
    pendingOldestSeconds?: number;
  };
};
type Ref = { machine: string; key: string };

// Badge tones. A result or a flag is repeated down a list, so it is one of
// the kit's soft tones, and red or amber only for trouble.
const RESULT_TONE = new Map([
  ['accepted', 'mint'],
  ['rejected', 'zinc'],
  ['replayed', 'zinc'],
  ['faulted', 'red'],
]);
const FLAG_TONE = new Map([['faulted', 'red'], ['stalled', 'amber']]);

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

function Problems({ overview, onOpen }: { overview: Overview; onOpen: (r: Ref) => void }) {
  const p = overview.problems;
  const waiting = p.waiting || [];
  const unclaimed = p.unclaimed || [];
  // An event waiting over two minutes to be decided: no process decides.
  const slow = (p.pendingOldestSeconds || 0) > 120;
  const none = !p.flagged.length && !p.overdueDeadlines.length && !p.work.length && !waiting.length && !unclaimed.length && !slow;
  const runners = overview.runners || [];
  return (
    <div id="admin-wf-problems" className={`${AdminUI.card} p-4 mb-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Needs a person</h2>
      </div>
      <p id="admin-wf-runners" className={`${AdminUI.muted} mb-2`}>
        {runners.length
          ? `Run by ${runners.map((r) => `${r.host || r.id}${r.state === 'draining' ? ' (draining)' : ''}`).join(', ')}`
          : 'No process runs the workflow.'}
      </p>
      {none ? <p className={AdminUI.muted}>Nothing is stuck.</p> : null}
      <ul className="space-y-2">
        {slow ? (
          <li data-wf-problem="pending" className="flex flex-wrap items-center gap-2">
            <Badge tone="red" label="not decided" />
            <span className={AdminUI.muted}>{`An event has waited ${Math.round(p.pendingOldestSeconds || 0)} s to be decided`}</span>
          </li>
        ) : null}
        {unclaimed.map((w) => (
          <li key={`u:${w.id}`} data-wf-problem="unclaimed" className="flex flex-wrap items-center gap-2">
            <Badge tone="red" label="nobody takes it" />
            <code className="text-xs">{`${w.kind} ${w.workKey}`}</code>
            <InstanceLink r={w} onOpen={onOpen} />
            <span className={AdminUI.muted}>{`waited ${Math.round(w.waitedSeconds / 60)} min`}</span>
          </li>
        ))}
        {p.flagged.map((i) => (
          <li key={`f:${i.machine}:${i.key}`} data-wf-problem="flagged" className="flex flex-wrap items-center gap-2">
            <Badge tone={FLAG_TONE.get(i.flag || '') || 'zinc'} label={i.flag} />
            <InstanceLink r={i} onOpen={onOpen} />
            <span className={AdminUI.muted}>
              {i.flagDetail?.message || (i.flagDetail?.attempts ? `${i.flagDetail.attempts} timeouts in a row` : '')}
              {i.heldEvents ? ` · ${i.heldEvents} held` : ''}
            </span>
          </li>
        ))}
        {p.overdueDeadlines.map((i) => (
          <li key={`d:${i.machine}:${i.key}`} data-wf-problem="overdue" className="flex flex-wrap items-center gap-2">
            <Badge tone="amber" label="deadline passed" />
            <InstanceLink r={i} onOpen={onOpen} />
            <span className={AdminUI.muted}>{`due ${when(i.deadlineAt)}`}</span>
          </li>
        ))}
        {p.work.map((w) => (
          <li key={`w:${w.id}`} data-wf-problem="work" className="flex flex-wrap items-center gap-2">
            <Badge
              tone={w.status === 'running' ? 'amber' : 'red'}
              label={w.status === 'running' ? 'running long' : 'out of retries'}
            />
            <code className="text-xs">{`${w.kind} ${w.workKey}`}</code>
            <InstanceLink r={w} onOpen={onOpen} />
            <span className={AdminUI.muted}>{w.lastError?.message || ''}</span>
          </li>
        ))}
        {waiting.map((i) => (
          <li key={`a:${i.machine}:${i.key}`} data-wf-problem="waiting" className="flex flex-wrap items-center gap-2">
            <Badge tone="amber" label={i.state} />
            <InstanceLink r={i} onOpen={onOpen} />
            <span className={AdminUI.muted}>{i.says || ''}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function instanceColumns(onOpen: (r: Ref) => void): Column<Instance>[] {
  return [
    { label: 'Instance', primary: true, cell: (i) => <InstanceLink r={i} onOpen={onOpen} /> },
    {
      label: 'State',
      cell: (i) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <Badge tone="zinc" label={i.state} />
          {i.flag ? <Badge tone={FLAG_TONE.get(i.flag) || 'zinc'} label={i.flag} /> : null}
        </span>
      ),
    },
    { label: 'Updated', cell: (i) => <span className={AdminUI.muted}>{when(i.updatedAt)}</span> },
  ];
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
    <div id="admin-wf-instances">
      <h2 className={`${AdminUI.sectionTitle} mb-3`}>Instances</h2>
      {/* The filter is one button for each machine and state the server
          counted: a list that long and that changeable stays buttons. */}
      <Toolbar>
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
        {filter ? <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => setFilter(null)}>All</button> : null}
      </Toolbar>
      {rows === null ? <p className={AdminUI.loading}>Loading…</p> : null}
      {rows && !rows.length ? <p className={AdminUI.muted}>No instances.</p> : null}
      {rows && rows.length ? (
        <List<Instance>
          items={rows}
          columns={instanceColumns(onOpen)}
          rowKey={(i) => `${i.machine}:${i.key}`}
        />
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
            <Badge tone={RESULT_TONE.get(e.result || '') || 'amber'} label={e.result || e.status} />
            {e.reason ? <code className="text-xs">{e.reason}</code> : null}
            {e.stateBefore ? <span className={AdminUI.muted}>{e.stateBefore === e.stateAfter ? e.stateAfter : `${e.stateBefore} → ${e.stateAfter}`}</span> : null}
            <span className={`${AdminUI.muted} ms-auto`}>{`#${e.id} · ${when(e.processedAt || e.createdAt)}`}</span>
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
      <BackButton onClick={onBack}>Workflows</BackButton>
      <div className={`${AdminUI.card} p-4 mb-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={`${AdminUI.cardTitle} font-mono`}>{`${at.machine} / ${at.key}`}</h2>
          <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => load()}>Refresh</button>
        </div>
        {!detail ? <p className={AdminUI.loading}>Loading…</p> : null}
        {inst ? (
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className={AdminUI.badge.secondary}>{inst.state}</span>
            {inst.flag ? <Badge tone={FLAG_TONE.get(inst.flag) || 'zinc'} label={inst.flag} /> : null}
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
            {actions.includes('AdminRetry') && ['failed', 'settled', 'deferred', 'retiring'].includes(inst.state) ? (
              <button type="button" disabled={busy} className={AdminUI.btn.primarySm}
                onClick={() => act('Retry the preview', ...event('AdminRetry'),
                  'Builds the preview again if nothing serves its head, else runs its checks again (or retries a retirement that did not close).')}>
                Retry preview
              </button>
            ) : null}
            {actions.includes('AdminEnd') && ['preparing', 'checking'].includes(inst.state) ? (
              <button type="button" disabled={busy} className={AdminUI.btn.outlineSm}
                onClick={() => act('End the build or run', ...event('AdminEnd'),
                  'Ends a build or checks run that never answers: it is recorded as an error, and its late result is ignored.')}>
                End build or run
              </button>
            ) : null}
            {actions.includes('AdminRetire') && !['retiring', 'retired', 'detached'].includes(inst.state) ? (
              <button type="button" disabled={busy} className={AdminUI.btn.destructiveSm}
                onClick={() => act('Retire the preview', ...event('AdminRetire'),
                  'Deletes the preview and every database it built, and stops its checks. The next revision builds a new one.')}>
                Retire preview
              </button>
            ) : null}
            {actions.includes('RunNow') && ['waiting', 'running'].includes(inst.state) ? (
              <button type="button" disabled={busy} className={AdminUI.btn.outlineSm}
                onClick={() => act('Run now', ...event('RunNow'),
                  'Runs the scheduled job now (once more right after the run under way, if there is one); its next run is due an interval after.')}>
                Run now
              </button>
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
                  <Badge tone={outcome === 'succeeded' ? 'mint' : (outcome ? 'red' : 'zinc')} label={outcome || w.status} />
                  <span className={AdminUI.muted}>{`${w.attemptCount} attempt${w.attemptCount === 1 ? '' : 's'}`}</span>
                  {w.lastError?.message ? <span className="text-xs text-red-700 dark:text-red-400">{w.lastError.message}</span> : null}
                  {retryable ? (
                    <button type="button" disabled={busy} className={`${AdminUI.btn.outlineSm} ms-auto`}
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
  const header = (
    <ScreenHeader
      title="Workflows"
      subtitle="What the workflow machines are doing, and what needs a person."
    />
  );
  if (!overview) return <>{header}<p className={AdminUI.loading}>Loading…</p></>;
  // Three counts the overview already carries: nothing more is read for them.
  const p = overview.problems;
  const stuck = p.flagged.length + p.overdueDeadlines.length + p.work.length
    + (p.waiting || []).length + (p.unclaimed || []).length + ((p.pendingOldestSeconds || 0) > 120 ? 1 : 0);
  const figures: Figure[] = [
    { key: 'stuck', label: 'Need a person', value: stuck.toLocaleString(), tone: stuck ? 'yellow' : 'green' },
    {
      key: 'instances',
      label: 'Instances',
      value: overview.counts.reduce((sum, c) => sum + (Number(c.count) || 0), 0).toLocaleString(),
      tone: 'sky',
    },
    { key: 'runners', label: 'Processes running it', value: (overview.runners || []).length.toLocaleString(), tone: 'sky' },
  ];
  return (
    <div>
      {header}
      <Figures id="admin-wf-figures" items={figures} />
      {!overview.running ? (
        <p id="admin-wf-off" className={`${AdminUI.muted} mb-4`}>
          The workflow runtime is not running in this process: it did not start (see the log). The bot's builds run unkept until it does. What is recorded is still shown.
        </p>
      ) : null}
      <Problems overview={overview} onOpen={setAt} />
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
