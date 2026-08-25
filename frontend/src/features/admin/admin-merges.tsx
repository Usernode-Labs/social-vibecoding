'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. This was a bare global read that
// depended on <script> order (admin-console.js loaded first); inside the
// React bundle the dependency is explicit (#1082 chunk E).
import { AdminUI } from './admin-console.js';
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
const BADGES: Record<string, { label: string; cls: string; spin?: boolean }> = {
  running:            { label: 'Running',              cls: 'bg-sky-500/20 text-sky-600 dark:text-sky-300', spin: true },
  merged:             { label: 'Merged',               cls: 'bg-green-500/20 text-green-600 dark:text-green-300' },
  blocked:            { label: 'Blocked',              cls: 'bg-amber-500/20 text-amber-600 dark:text-amber-300' },
  conflict_resolving: { label: 'Conflict — resolving', cls: 'bg-sky-500/20 text-sky-600 dark:text-sky-300', spin: true },
  conflict_failed:    { label: 'Conflict — failed',    cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
  awaiting_github:    { label: 'Awaiting GitHub',      cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' },
  noop:               { label: 'No-op',                cls: 'bg-zinc-500/20 text-zinc-500 dark:text-zinc-400' },
  error:              { label: 'Error',                cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
  // The proposal's PR is closed on GitHub and couldn't be reopened —
  // terminal, distinct from a conflict.
  pr_closed:          { label: 'PR closed',            cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
  // A kind='checks' run ends on the verdict its suite produced rather than
  // on a merge outcome. ('error' above is shared — a checks run whose
  // container broke reports the same thing a failed merge does.)
  passing:            { label: 'Checks passing',       cls: 'bg-green-500/20 text-green-600 dark:text-green-300' },
  failing:            { label: 'Checks failing',       cls: 'bg-red-500/20 text-red-600 dark:text-red-300' },
  skipped:            { label: 'Checks skipped',       cls: 'bg-zinc-500/20 text-zinc-500 dark:text-zinc-400' },
};

function Badge({ status }: { status?: string }) {
  const b = (status && BADGES[status])
    || { label: status || '—', cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300', spin: false };
  return (
    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded ${b.cls}`}>
      {b.spin ? <span className="inline-block w-2 h-2 mr-1 rounded-full bg-current spin align-middle" /> : null}
      {b.label}
    </span>
  );
}

const LEVEL_DOT: Record<string, string> = {
  info: 'bg-zinc-400',
  warn: 'bg-amber-400',
  error: 'bg-red-400',
};
const LEVEL_TEXT: Record<string, string> = {
  error: 'text-red-600 dark:text-red-300',
  warn: 'text-amber-600 dark:text-amber-300',
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
                className="detail-toggle text-[11px] text-violet-500 dark:text-violet-400 hover:text-violet-800 dark:hover:text-violet-300 mt-0.5"
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

function RunCard({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [stepsError, setStepsError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const title = run.pr_title ? ` — ${run.pr_title}` : '';
  const pr = run.pr_number ? `PR #${run.pr_number}` : `session ${run.session_id}`;
  const kindLabel = run.kind === 'conflict_resolution' ? 'conflict resolution'
    : run.kind === 'checks' ? 'checks'
      : 'merge';

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    // Steps are fetched once and kept — the `loaded` closure flag, without
    // the closure.
    if (!next || steps || stepsError) return;
    try {
      const data = await getJSON(`/api/debug/merge-runs/${run.id}${qs()}`);
      if (alive.current) setSteps(data.steps || []);
    } catch (e: any) {
      if (alive.current) setStepsError(String(e && e.message ? e.message : e));
    }
  };

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-50 dark:bg-zinc-900 overflow-hidden">
      <button
        type="button"
        className="run-head w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="chev text-zinc-500 dark:text-zinc-400 transition-transform"
          style={open ? { transform: 'rotate(90deg)' } : undefined}>▶</span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium truncate">
            {`${run.app_name || run.app_slug || 'unknown app'} · ${pr}${title}`}
          </span>
          <span className="block text-xs text-zinc-500 dark:text-zinc-400">
            {`${kindLabel} · trigger: ${run.trigger || '—'} · `}
            {run.step_count != null ? `${run.step_count} steps · ` : ''}
            {`${fmtTime(run.started_at)} · ${fmtDuration(run.started_at, run.ended_at)}`}
          </span>
        </span>
        <Badge status={run.status} />
      </button>
      <div className={`run-body${open ? '' : ' hidden'} border-t border-zinc-200 dark:border-zinc-800 px-4 py-3`}>
        {stepsError
          ? <div className="text-xs text-red-500 dark:text-red-400">Failed to load steps: {stepsError}</div>
          : steps == null
            ? <div className="text-xs text-zinc-500 dark:text-zinc-400">Loading steps…</div>
            : steps.length
              ? <ol className="space-y-1.5">{steps.map((s, i) => <StepRow key={i} s={s} />)}</ol>
              : <div className="text-xs text-zinc-500 dark:text-zinc-400">No steps recorded.</div>}
      </div>
    </div>
  );
}

const SELECT_CLASS = 'mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 '
  + 'rounded px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100';
const SELECT_PLAIN = 'mt-1 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm';
const TEXT_CLASS = 'mt-1 w-24 bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 rounded px-2 py-1 text-sm';

const OUTCOMES: Array<[string, string]> = [
  ['', 'Any'], ['running', 'Running'], ['merged', 'Merged'], ['blocked', 'Blocked'],
  ['conflict_resolving', 'Conflict — resolving'], ['conflict_failed', 'Conflict — failed'],
  ['awaiting_github', 'Awaiting GitHub'], ['noop', 'No-op'], ['error', 'Error'],
  ['pr_closed', 'PR closed'], ['passing', 'Checks passing'], ['failing', 'Checks failing'],
  ['skipped', 'Checks skipped'],
];

const KINDS: Array<[string, string]> = [
  ['', 'Any'], ['merge', 'Merge'], ['conflict_resolution', 'Conflict resolution'],
  // kind='checks' runs are EXCLUDED from the unfiltered list on purpose
  // (several per proposal would bury the merge traces), so this chip is the
  // only way to reach them.
  ['checks', 'Checks (timings)'],
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
        setGate('Admins only — this section shows merge & conflict-resolution logs.');
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
      <h2 className="text-lg font-semibold mb-4">Merge debug</h2>
      {gate ? <div id="admin-merges-gate" className="text-zinc-500 dark:text-zinc-400 text-center py-20">{gate}</div> : null}

      {ready ? (
        <main id="admin-merges-content" className="space-y-4">
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Step-by-step trace of every PR merge and automatic conflict resolution.
            Each row is one merge attempt; expand it for the chronological steps.
          </p>

          {/* Filter bar */}
          <section className={`${AdminUI.card} p-3 flex flex-wrap items-end gap-3`}>
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">App
              <select id="admin-merges-f-app" className={SELECT_CLASS} value={filters.app} onChange={set('app')}>
                <option value="">All apps</option>
                {apps.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">PR #
              <input id="admin-merges-f-pr" type="text" inputMode="numeric" placeholder="any"
                className={TEXT_CLASS} value={filters.pr_number} onChange={set('pr_number')} />
            </label>
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Session id
              <input id="admin-merges-f-session" type="text" inputMode="numeric" placeholder="any"
                className={TEXT_CLASS} value={filters.session_id} onChange={set('session_id')} />
            </label>
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Outcome
              <select id="admin-merges-f-outcome" className={SELECT_PLAIN} value={filters.outcome} onChange={set('outcome')}>
                {OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="flex flex-col text-xs text-zinc-500 dark:text-zinc-400">Kind
              <select id="admin-merges-f-kind" className={SELECT_PLAIN} value={filters.kind} onChange={set('kind')}>
                {KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <button id="admin-merges-apply" type="button"
              onClick={() => { setLive(false); loadFirstPage(); }}
              className="ml-auto px-3 py-1.5 rounded bg-violet-600 hover:bg-violet-700 text-white text-sm">Apply</button>
            <button id="admin-merges-refresh" type="button" onClick={loadFirstPage}
              className="px-3 py-1.5 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Refresh</button>
            <label className="inline-flex items-center gap-2 text-sm text-zinc-500 dark:text-zinc-400 cursor-pointer select-none">
              <input id="admin-merges-live" type="checkbox"
                className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-600 focus:ring-violet-500"
                checked={live} onChange={(e) => setLive(e.target.checked)} />
              <span>Live</span>
            </label>
          </section>

          <div id="admin-merges-runs" className="space-y-2">
            {error
              ? <div className="text-sm text-red-500 dark:text-red-400">Failed to load: {error}</div>
              : runs.map((r) => <RunCard key={r.id} run={r} />)}
          </div>

          <div className="flex justify-center py-4">
            {hasMore ? (
              <button id="admin-merges-load-older" type="button" onClick={loadOlder}
                className="px-4 py-2 rounded bg-zinc-200 dark:bg-zinc-800 hover:bg-zinc-300 dark:hover:bg-zinc-700 text-sm">Load older</button>
            ) : null}
            {!error && !runs.length ? (
              <span id="admin-merges-empty" className="text-zinc-500 dark:text-zinc-400 text-sm">
                No merge runs match these filters yet.
              </span>
            ) : null}
          </div>
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
