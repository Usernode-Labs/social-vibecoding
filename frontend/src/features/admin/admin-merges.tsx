'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
import { BTN } from './topochain/tokens.ts';
import {
  Badge, CheckField, EmptyState, Input, List, ScreenHeader, Segmented, Select, Toolbar,
} from './topochain/ui.tsx';
import type { Column } from './topochain/ui.tsx';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Merge debug section of the admin console (#860) — the retired standalone
// /debug page, ported into #admin/merges.
//
// Lists merge / conflict-resolution runs from /api/debug/merge-runs and
// renders each as a collapsible per-run step timeline. Filters, keyset
// paging and the "Live" 3s poll are all carried over. `?demo=1` is still read
// from location.search — in the SPA that is `/?demo=1#admin/merges`, which is
// what dapp.json's rendered checks use. The staging mock rows come from
// stagingMockMergeRuns() in src/routes/debug.js and are unchanged.
// .step-detail / .spin live in public/css/app.css under #admin-merges-root.
//
// PERMISSIONS: admin-only. /api/debug/* has its own inline
// `req.user?.isAdmin` 403 gate (src/routes/debug.js) covering full AND
// view-only admins — diagnostics is a read surface, so no
// canAdminWrite gate.
//
// ── React-owned (#1120 slice 9) ───────────────────────────────────────
//
// Fourth section through the seam admin-e2e.tsx established, and the one with
// the most hand-built DOM: every run card was a `document.createElement` plus
// an `innerHTML` template plus three `querySelector` calls to find its own
// chevron, head and body, plus a `loaded` closure flag and a
// `wireDetailToggles(root)` pass to bind every `.detail-toggle` the step
// template had just written. All of that is two components with local state.
//
// ── One deliberate behaviour change ───────────────────────────────────
//
// With "Live" on, the old list rebuilt itself every 3s — which collapsed
// every expanded run and threw away its loaded steps. Reading a run while
// watching for new ones was not actually possible. The cards are keyed by run
// id now, so a refresh reconciles: new runs appear at the top, the one you
// have open stays open, and its steps are not re-fetched. That is the point
// of the conversion rather than an accident of it, and it is the only
// difference from the previous behaviour on this screen.
//
// ── Drawn from the shared admin kit (26 Nov 2026) ─────────────────────
//
// The runs are the shared `List` now, a run's steps behind its row's arrow
// (`details`), and the filters are one `Toolbar` over it. `List` keeps which
// rows are open by run id, so the behaviour above holds: a Live refresh
// leaves an open run open. Its steps are read once and kept in a cache the
// section owns, because `List` draws an open row twice (the table and the
// phone cards) and unmounts it when it is closed.

// Guarded for the SSG prerender pass, which evaluates this module in Node
// (#1082 chunk E). In the browser this is the same boolean as before.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

function qs(extra?: Record<string, unknown>): string {
  const p = new URLSearchParams();
  if (DEMO) p.set('demo', '1');
  for (const [k, v] of Object.entries(extra || {})) {
    if (v != null && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function getJSON(url: string): Promise<any> {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

interface Run {
  id: number;
  kind?: string;
  status?: string;
  trigger?: string;
  step_count?: number;
  started_at?: string;
  ended_at?: string;
  pr_number?: number;
  pr_title?: string;
  session_id?: number | string;
  app_name?: string;
  app_slug?: string;
}

interface Step {
  phase?: string;
  level?: string;
  message?: string;
  created_at?: string;
  detail?: Record<string, any> | null;
}

interface Filters {
  app: string;
  pr_number: string;
  session_id: string;
  outcome: string;
  kind: string;
}

const EMPTY_FILTERS: Filters = { app: '', pr_number: '', session_id: '', outcome: '', kind: '' };

// ── Outcome badge ───────────────────────────────────────────────────────
// A status repeated down the list, so it wears the shared `Badge`'s soft
// tones: sky while it runs, mint when it ended well, red or amber for trouble.
const BADGES: Record<string, { label: string; tone: string; spin?: boolean }> = {
  running:            { label: 'Running',              tone: 'sky', spin: true },
  merged:             { label: 'Merged',               tone: 'mint' },
  blocked:            { label: 'Blocked',              tone: 'amber' },
  conflict_resolving: { label: 'Conflict: resolving', tone: 'sky', spin: true },
  conflict_failed:    { label: 'Conflict: failed',    tone: 'red' },
  awaiting_github:    { label: 'Awaiting GitHub',      tone: 'zinc' },
  noop:               { label: 'No-op',                tone: 'zinc' },
  error:              { label: 'Error',                tone: 'red' },
  // The proposal's PR is closed on GitHub and couldn't be reopened —
  // terminal, distinct from a conflict.
  pr_closed:          { label: 'PR closed',            tone: 'red' },
  // A kind='checks' run ends on the verdict its suite produced rather than
  // on a merge outcome. ('error' above is shared — a checks run whose
  // container broke reports the same thing a failed merge does.)
  passing:            { label: 'Checks passing',       tone: 'mint' },
  failing:            { label: 'Checks failing',       tone: 'red' },
  skipped:            { label: 'Checks skipped',       tone: 'zinc' },
};

function OutcomeBadge({ status }: { status?: string }) {
  const b = (status && BADGES[status]) || { label: status || '—', tone: 'zinc', spin: false };
  return (
    <Badge
      tone={b.tone}
      label={(
        <>
          {b.spin ? <span className="inline-block w-2 h-2 me-1 rounded-full bg-current spin align-middle" /> : null}
          {b.label}
        </>
      )}
    />
  );
}

const LEVEL_DOT: Record<string, string> = {
  info: 'bg-zinc-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
};
const LEVEL_TEXT: Record<string, string> = {
  error: 'text-red-700 dark:text-red-300',
  warn: 'text-amber-800 dark:text-amber-300',
};
const LEVEL_TEXT_DEFAULT = 'text-zinc-700 dark:text-zinc-200';

function fmtTime(iso?: string): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtDuration(a?: string, b?: string): string {
  if (!a) return '';
  const start = new Date(a).getTime();
  const end = b ? new Date(b).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function StepRow({ s }: { s: Step }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const dot = (s.level && LEVEL_DOT[s.level]) || LEVEL_DOT.info;
  const hasDetail = !!(s.detail && Object.keys(s.detail).length > 0);
  // A kind='checks' step's whole point is its duration — show it on the line
  // rather than only inside the collapsed detail JSON, so scanning a run tells
  // you which phase is the slow one at a glance.
  const ms = s.detail && typeof s.detail.durationMs === 'number' ? s.detail.durationMs : null;
  return (
    <li className="text-sm">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 w-2 h-2 rounded-full ${dot} flex-shrink-0`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 font-mono">{s.phase || ''}</span>
            <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{fmtTime(s.created_at)}</span>
            {ms == null ? null : (
              <span className="text-[10px] font-mono px-1 rounded bg-zinc-200/70 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300">
                {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
          <div className={(s.level && LEVEL_TEXT[s.level]) || LEVEL_TEXT_DEFAULT}>{s.message || ''}</div>
          {hasDetail ? (
            <>
              <button
                type="button"
                className="detail-toggle text-[11px] text-violet-700 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 mt-0.5"
                onClick={() => setDetailOpen((v) => !v)}
              >
                detail
              </button>
              <pre className={`detail-body${detailOpen ? '' : ' hidden'} step-detail mt-1 text-[11px] text-zinc-500 dark:text-zinc-400 bg-zinc-100 dark:bg-zinc-950 rounded p-2 border border-zinc-200 dark:border-zinc-800`}>
                {JSON.stringify(s.detail, null, 2)}
              </pre>
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function runKindLabel(run: Run): string {
  return run.kind === 'conflict_resolution' ? 'conflict resolution'
    : run.kind === 'checks' ? 'checks'
      : 'merge';
}

const RUN_COLUMNS: Column<Run>[] = [
  {
    label: 'Run',
    primary: true,
    cell: (run) => {
      const title = run.pr_title ? ` · ${run.pr_title}` : '';
      const pr = run.pr_number ? `PR #${run.pr_number}` : `session ${run.session_id}`;
      return `${run.app_name || run.app_slug || 'unknown app'} · ${pr}${title}`;
    },
  },
  { label: 'Kind', cell: (run) => runKindLabel(run) },
  // The column's heading says what each is, so the cell is the value alone.
  { label: 'Trigger', cell: (run) => run.trigger || '—' },
  { label: 'Steps', tdClass: 'tabular-nums', cell: (run) => (run.step_count != null ? run.step_count : '') },
  { label: 'Started', tdClass: 'whitespace-nowrap', cell: (run) => fmtTime(run.started_at) },
  { label: 'Took', tdClass: 'whitespace-nowrap tabular-nums', cell: (run) => fmtDuration(run.started_at, run.ended_at) },
  { label: 'Outcome', cell: (run) => <OutcomeBadge status={run.status} /> },
];

// One read of a run's steps, shared by everything that draws them. A failed
// read is kept too, as it was: the error stays until the section is left.
type StepsCache = Map<number, Promise<Step[]>>;

function RunSteps({ run, cache }: { run: Run; cache: StepsCache }) {
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [stepsError, setStepsError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let read = cache.get(run.id);
    if (!read) {
      read = getJSON(`/api/debug/merge-runs/${run.id}${qs()}`).then((data) => data.steps || []);
      cache.set(run.id, read);
    }
    read.then(
      (next) => { if (alive) setSteps(next); },
      (e: any) => { if (alive) setStepsError(String(e && e.message ? e.message : e)); },
    );
    return () => { alive = false; };
  }, [run.id, cache]);

  if (stepsError) return <div className="text-xs text-red-700 dark:text-red-400">Failed to load steps: {stepsError}</div>;
  if (steps == null) return <div className={AdminUI.loading}>Loading steps…</div>;
  if (!steps.length) return <div className="text-xs text-zinc-500 dark:text-zinc-400">No steps recorded.</div>;
  return <ol className="space-y-1.5">{steps.map((s, i) => <StepRow key={i} s={s} />)}</ol>;
}

const OUTCOMES: Array<[string, string]> = [
  ['', 'Any'], ['running', 'Running'], ['merged', 'Merged'], ['blocked', 'Blocked'],
  ['conflict_resolving', 'Conflict: resolving'], ['conflict_failed', 'Conflict: failed'],
  ['awaiting_github', 'Awaiting GitHub'], ['noop', 'No-op'], ['error', 'Error'],
  ['pr_closed', 'PR closed'], ['passing', 'Checks passing'], ['failing', 'Checks failing'],
  ['skipped', 'Checks skipped'],
];

// [value, the word on the toggle, the full wording for its tooltip].
// "Checks (timings)" stays whole on the toggle: a declared check reads it.
const KINDS: Array<[string, string, string]> = [
  ['', 'Any', 'Any kind'], ['merge', 'Merge', 'Merge'],
  ['conflict_resolution', 'Conflict', 'Conflict resolution'],
  // kind='checks' runs are EXCLUDED from the unfiltered list on purpose
  // (several per proposal would bury the merge traces), so this chip is the
  // only way to reach them.
  ['checks', 'Checks (timings)', 'Checks (timings)'],
];

function MergesSection() {
  const [gate, setGate] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [apps, setApps] = useState<Array<{ value: string; label: string }>>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [runs, setRuns] = useState<Run[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);

  const alive = useRef(true);
  const cursor = useRef<Record<string, unknown> | null>(null);
  // The live poll and Refresh both send whatever is in the controls RIGHT
  // NOW — the old code got that by reading the DOM at request time. A ref
  // keeps it without making the interval restart on every keystroke.
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const stepsCache = useRef<StepsCache>(new Map());

  useEffect(() => () => { alive.current = false; }, []);

  const loadFirstPage = useCallback(async () => {
    try {
      const data = await getJSON(`/api/debug/merge-runs${qs(filtersRef.current)}`);
      if (!alive.current) return;
      setRuns(data.runs || []);
      cursor.current = data.nextCursor || null;
      setHasMore(!!data.hasMore);
      setError(null);
    } catch (e: any) {
      if (!alive.current) return;
      setRuns([]);
      setError(String(e && e.message ? e.message : e));
    }
  }, []);

  const loadOlder = useCallback(async () => {
    if (!cursor.current) return;
    try {
      const data = await getJSON(`/api/debug/merge-runs${qs({ ...filtersRef.current, ...cursor.current })}`);
      if (!alive.current) return;
      setRuns((prev) => prev.concat(data.runs || []));
      cursor.current = data.nextCursor || null;
      setHasMore(!!data.hasMore);
    } catch (e) {
      console.error('Load older failed', e);
    }
  }, []);

  // Admin check up front. The /api/debug/* endpoints are independently
  // enforced server-side; this is only for a clean in-section message. We do
  // NOT navigate away on failure — a transient 401 shouldn't bounce an admin,
  // and it keeps the section coherent under headless checks.
  useEffect(() => {
    (async () => {
      let me: any = null;
      try {
        me = await getJSON('/api/auth/me');
      } catch {
        if (alive.current) setGate('Sign in as an admin to view merge logs.');
        return;
      }
      if (!alive.current) return;
      if (!me.user?.isAdmin) {
        setGate('Admins only. This section shows merge & conflict-resolution logs.');
        return;
      }
      setReady(true);
      try {
        const data = await getJSON(`/api/debug/apps${qs()}`);
        if (!alive.current) return;
        setApps((data.apps || []).map((a: any) => ({
          value: a.slug, label: `${a.name || a.slug} (${a.run_count})`,
        })));
      } catch { /* non-fatal — filter just stays "All apps" */ }
      loadFirstPage();
    })();
  }, [loadFirstPage]);

  // The Live poll. Its cleanup is the teardown: destroy() drops the portal,
  // React unmounts, this clears — which is what setLive(false) in the old
  // destroy() was for.
  useEffect(() => {
    if (!live) return undefined;
    const timer = setInterval(loadFirstPage, 3000);
    return () => { clearInterval(timer); };
  }, [live, loadFirstPage]);

  const set = (k: keyof Filters) => (e: { target: { value: string } }) =>
    setFilters((prev) => ({ ...prev, [k]: e.target.value }));

  return (
    <div id="admin-merges-root">
      <ScreenHeader
        title="Merge debug"
        subtitle={ready
          ? 'Step-by-step trace of every PR merge and automatic conflict resolution. Each row is one merge attempt; expand it for the chronological steps.'
          : undefined}
      />
      {gate ? <div id="admin-merges-gate" className="text-zinc-500 dark:text-zinc-400 text-center py-20">{gate}</div> : null}

      {ready ? (
        <main id="admin-merges-content">
          {/* The one bar over the runs: its filters, then what acts on the list. */}
          <Toolbar>
            <div className="min-w-[10rem] flex-1 sm:max-w-xs">
              <Select id="admin-merges-f-app" aria-label="App" value={filters.app} onChange={set('app')}>
                <option value="">All apps</option>
                {apps.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </Select>
            </div>
            <div className="w-28">
              <Input id="admin-merges-f-pr" type="text" inputMode="numeric" aria-label="PR #" placeholder="PR #"
                value={filters.pr_number} onChange={set('pr_number')} />
            </div>
            <div className="w-28">
              <Input id="admin-merges-f-session" type="text" inputMode="numeric" aria-label="Session id" placeholder="Session id"
                value={filters.session_id} onChange={set('session_id')} />
            </div>
            <div className="min-w-[10rem] sm:max-w-[14rem]">
              <Select id="admin-merges-f-outcome" aria-label="Outcome" value={filters.outcome} onChange={set('outcome')}>
                {OUTCOMES.map(([v, l]) => <option key={v} value={v}>{v ? l : 'Any outcome'}</option>)}
              </Select>
            </div>
            <Segmented
              id="admin-merges-f-kind"
              label="Kind"
              value={filters.kind}
              options={KINDS.map(([value, label, title]) => ({ value, label, title }))}
              onChange={(next) => setFilters((prev) => ({ ...prev, kind: next }))}
            />
            <button id="admin-merges-apply" type="button"
              onClick={() => { setLive(false); loadFirstPage(); }}
              className={BTN.primarySm}>Apply</button>
            <button id="admin-merges-refresh" type="button" onClick={loadFirstPage}
              className={BTN.secondarySm}>Refresh</button>
            <CheckField id="admin-merges-live" label="Live" checked={live} onChange={setLive} />
          </Toolbar>

          <div id="admin-merges-runs">
            {error
              ? <div className="text-sm text-red-700 dark:text-red-400">Failed to load: {error}</div>
              : runs.length ? (
                <List
                  items={runs}
                  columns={RUN_COLUMNS}
                  rowKey={(r) => r.id}
                  details={(r) => <RunSteps run={r} cache={stepsCache.current} />}
                />
              ) : null}
          </div>

          {/* Paged by a cursor with no total, so the kit's LoadMore (which
              says "n of total") does not fit; the button stays. */}
          {hasMore ? (
            <div className="flex justify-center py-4">
              <button id="admin-merges-load-older" type="button" onClick={loadOlder}
                className={BTN.secondarySm}>Load older</button>
            </div>
          ) : null}
          {!error && !runs.length ? (
            <div id="admin-merges-empty">
              <EmptyState title="No merge runs match these filters yet." />
            </div>
          ) : null}
        </main>
      ) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminMerges = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <MergesSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminMerges = AdminMerges;

export { AdminMerges };
