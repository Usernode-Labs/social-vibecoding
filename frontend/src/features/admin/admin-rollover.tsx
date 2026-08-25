'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry — an explicit import inside the
// bundle, rather than the bare global read <script> order used to supply.
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Container rollover — recreates every running app container so it picks up
// the environment this platform build hands out. Progress arrives on the
// shell's /ws/events socket as `admin_rollover_status` (an admin-only
// broadcast) and GET /api/admin/rollover covers first paint and WS
// reconnect. See src/services/app-rollover.js for why an env change needs a
// container recreate at all.
//
// ── React-owned (#1120 slice 23) ──────────────────────────────────────
//
// The last two sections the chassis drew itself, and the only two with a
// caller outside the console: public/js/app.js routes the WS frame to
// `AdminConsole.handleRolloverStatus` and calls `AdminConsole.loadRollover`
// on socket reconnect. That surface is the SHELL's, so it stays exactly
// where app.js already looks for it — admin-console.js keeps four thin
// forwarders and this module publishes `handleStatus` / `reload` for them.
//
// What the move retires is the pair of guards those handlers opened with:
// `_section === 'rollover'` and `document.getElementById('admin-rollover-list')`,
// both approximating "am I still on screen?". `live` below is that answer
// structurally — it is non-null exactly while the section is mounted, set
// and cleared by an effect. The five module globals the paint routine read
// (`_rolloverEligible`, `_rolloverConcurrency`, `_rolloverDemo`, plus the
// job) are component state now.
//
// Ids are like-for-like with the innerHTML version, as every conversion in
// this sequence has been: `data-rollover-slug` / `data-rollover-state` are
// addressable for a browser check, and the six `admin-rollover-*` ids are
// what tests/admin-rollover-surface.test.js names.

// The page's ?demo=1 rides along on the status read so a staging preview
// renders the demo job (routes/admin.js serves it only behind
// IS_STAGING && ?demo=1) — the same pass-through the other converted
// sections use. Guarded because this runs at module-EVALUATION time and the
// SSG prerender pass evaluates the module graph in Node; an absent flag
// already meant false in the browser.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

const console_ = () => (window as any).AdminConsole;

// The mounted section, for the console's WS forwarders to reach. Non-null
// exactly while the section is on screen; see the header note.
let live: { paint: (job: RolloverJob | null) => void; reload: () => void } | null = null;

type RolloverApp = {
  slug: string;
  state: string;
  ms?: number | null;
  error?: string | null;
};

type RolloverJob = {
  total: number;
  done: number;
  failed: number;
  concurrency: number;
  finishedAt?: string | null;
  stale?: boolean;
  startedBy?: string | null;
  apps?: RolloverApp[];
};

// Per-app outcome → chip. Mirrors the outcome vocabulary in
// src/services/app-rollover.js; an unknown state falls back to the raw
// string so a new outcome shows up rather than disappearing.
const NEUTRAL_CHIP = 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300';

const ROLLOVER_STATES: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Queued', cls: NEUTRAL_CHIP },
  running: { label: 'Rolling over…', cls: 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300' },
  rolled: { label: 'Done', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
  rebuilt: { label: 'Rebuilt', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
  skipped_deploying: { label: 'Skipped: deploying', cls: NEUTRAL_CHIP },
  skipped_missing_secrets: { label: 'Skipped: missing secrets', cls: NEUTRAL_CHIP },
  skipped_no_db_password: { label: 'Skipped: no DB role', cls: NEUTRAL_CHIP },
  skipped_deleted: { label: 'Skipped: app gone', cls: NEUTRAL_CHIP },
  failed: { label: 'Failed', cls: 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
};

// Local class recipes — complete literals, because Tailwind's extractor is a
// regex over this file's source (see the AdminUI note in admin-console.js).
const RolloverUI = Object.freeze({
  tile: 'rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3',
  tileLabel: 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400',
  tileValue: 'text-2xl font-bold mt-1',
  lede: 'text-sm text-zinc-600 dark:text-zinc-400 mb-2',
  fine: 'text-xs text-zinc-500 dark:text-zinc-400 mb-4',
  viewOnly: 'text-xs text-zinc-500 dark:text-zinc-400',
  startBtn: `${AdminUI.btn.primary} disabled:opacity-50 disabled:hover:bg-violet-600`,
  summary: 'text-sm text-zinc-500 dark:text-zinc-400 mt-3',
  row: 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2.5 rounded-lg bg-zinc-100 dark:bg-zinc-800',
  rowMain: 'flex-1 min-w-0',
  rowSlug: 'font-mono text-sm',
  rowError: 'block text-xs text-red-700 mt-0.5 dark:text-red-400',
  rowRight: 'flex items-center gap-2 shrink-0',
  rowSecs: 'text-xs text-zinc-500 dark:text-zinc-400',
});

function Tile({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className={RolloverUI.tile}>
      <div className={RolloverUI.tileLabel}>{label}</div>
      <div id={id} className={RolloverUI.tileValue}>{value}</div>
    </div>
  );
}

// The summary line's four states, in the order the paint routine tested
// them. Only the last carries the staging-demo prefix — the other three were
// `textContent` writes, so they never did.
function Summary({ loaded, job, demo }: { loaded: boolean; job: RolloverJob | null; demo: boolean }) {
  if (!loaded) return <>Loading…</>;
  if (!job) return <>No rollover has run since this platform process started.</>;
  if (!job.total) {
    return <>{job.finishedAt ? 'Finished. No eligible app containers were found.' : 'Starting…'}</>;
  }
  const parts = [`${job.done} of ${job.total} done`];
  if (job.failed) parts.push(`${job.failed} failed`);
  const when = job.finishedAt ? 'Finished' : (job.stale ? 'Stalled' : 'Running');
  return (
    <>
      {demo ? <><span className="text-violet-700 dark:text-violet-400">Staging demo data</span>{' — '}</> : null}
      <span className="font-medium">{when}</span>
      {`: ${parts.join(', ')}`}
      {job.startedBy ? ` · started by ${job.startedBy}` : ''}
    </>
  );
}

function AppRow({ app }: { app: RolloverApp }) {
  const chip = ROLLOVER_STATES[app.state] || { label: app.state, cls: NEUTRAL_CHIP };
  const secs = app.ms == null ? '' : `${(app.ms / 1000).toFixed(1)}s`;
  return (
    <div className={RolloverUI.row} data-rollover-slug={app.slug} data-rollover-state={app.state}>
      <span className={RolloverUI.rowMain}>
        <code className={RolloverUI.rowSlug}>{app.slug}</code>
        {app.error ? <span className={RolloverUI.rowError}>{app.error}</span> : null}
      </span>
      <span className={RolloverUI.rowRight}>
        {secs ? <span className={RolloverUI.rowSecs}>{secs}</span> : null}
        <span className={`text-xs px-2 py-0.5 rounded-full ${chip.cls}`}>{chip.label}</span>
      </span>
    </div>
  );
}

function RolloverSection() {
  const canWrite = !!console_()?.canWrite();
  const [loaded, setLoaded] = useState(false);
  const [eligible, setEligible] = useState<number | null>(null);
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const [demo, setDemo] = useState(false);
  const [job, setJob] = useState<RolloverJob | null>(null);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await console_().fetchJson(`/api/admin/rollover${DEMO ? '?demo=1' : ''}`);
    if (!data || typeof data !== 'object') return;
    // The navigated-away guard, structurally: an unmounted section has no
    // state to set, so the old `_section !== 'rollover'` early return is gone.
    if (!alive.current) return;
    setEligible(typeof data.eligible === 'number' ? data.eligible : null);
    setConcurrency(data.concurrency || null);
    setDemo(!!data.demo);
    setJob(data.job || null);
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Register with the console's WS forwarders for as long as this section is
  // on screen. A frame that arrives while an admin is anywhere else finds a
  // null `live` and is dropped — the next mount picks the state up from the
  // GET, exactly as before.
  useEffect(() => {
    live = { paint: (next) => { if (alive.current) setJob(next); }, reload: () => { load(); } };
    return () => { live = null; };
  }, [load]);

  const start = useCallback(async () => {
    const many = typeof eligible === 'number'
      ? `${eligible} app container${eligible === 1 ? '' : 's'}`
      : 'every running app container';
    const ok = await console_()._confirm({
      title: 'Roll over all app containers?',
      message: `This recreates ${many} with the environment this platform build injects. `
        + 'Each app is briefly unavailable (a few seconds) as its turn comes up, '
        + 'and only the environment changes; no new code is shipped. '
        + 'The platform app itself is not touched.',
      confirmLabel: 'Roll over',
    });
    if (!ok) return;
    setStarting(true);
    try {
      const res = await fetch('/api/admin/rollover', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Singleton job: a second press is a no-op, not an error.
        (window as any).PlatformUI?.toast?.('A rollover is already in progress.');
        if (data && data.job && alive.current) setJob(data.job);
        return;
      }
      if (!res.ok) {
        console_()._alert((data && data.error) || `Rollover failed to start (HTTP ${res.status})`);
        return;
      }
      (window as any).PlatformUI?.toast?.('Rollover started.');
      if (data && data.job && alive.current) setJob(data.job);
    } catch (err: any) {
      console_()._alert(`Rollover failed to start: ${err.message}`);
    } finally {
      if (alive.current) setStarting(false);
      load();
    }
  }, [eligible, load]);

  const running = !!(job && !job.finishedAt && !job.stale);
  // A staging preview has no production containers to recreate, and the
  // route refuses the POST there — say so on the button rather than letting
  // a reviewer press it into a 400.
  const label = starting ? 'Starting…'
    : (demo ? 'Unavailable in previews'
      : (running ? 'Rollover in progress…' : 'Roll over all app containers'));
  const rows = job && job.total ? (job.apps || []) : [];

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>Container rollover</h2>
        <button
          id="admin-refresh-rollover"
          type="button"
          className={`${AdminUI.btn.link} text-xs`}
          onClick={() => load()}
        >
          Refresh
        </button>
      </div>
      <p className={RolloverUI.lede}>
        Recreates every running app container so it picks up the environment
        this platform build hands out. Needed after a platform change to what
        gets injected into containers. A restart is not enough, because a
        restarted container keeps the environment it was created with.
      </p>
      <p className={RolloverUI.fine}>
        This re-runs each app&apos;s existing build: it changes the environment and
        nothing else. No new code is shipped, unlike a per-app redeploy. Each
        app blinks offline for a few seconds as its turn comes up. The platform
        app itself is never touched.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <Tile
          id="admin-rollover-eligible"
          label="Eligible apps"
          value={eligible == null ? '—' : String(eligible)}
        />
        <Tile
          id="admin-rollover-concurrency"
          label="At a time"
          value={job ? String(job.concurrency) : (concurrency ? String(concurrency) : '—')}
        />
        <Tile
          id="admin-rollover-failed"
          label="Failed"
          value={job ? String(job.failed) : '—'}
        />
      </div>
      {canWrite ? (
        <button
          id="admin-rollover-btn"
          type="button"
          className={RolloverUI.startBtn}
          disabled={running || demo || starting}
          onClick={start}
        >
          {label}
        </button>
      ) : (
        <p className={RolloverUI.viewOnly}>
          View-only admin: you can watch a rollover, but not start one.
        </p>
      )}
      <p id="admin-rollover-summary" className={RolloverUI.summary}>
        <Summary loaded={loaded} job={job} demo={demo} />
      </p>
      <div id="admin-rollover-list" className="space-y-2 mt-3">
        {rows.map((app) => <AppRow key={app.slug} app={app} />)}
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminRollover = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <RolloverSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },

  // Called by AdminConsole.handleRolloverStatus, which public/js/app.js's
  // /ws/events onmessage routes `admin_rollover_status` frames to. Only the
  // job changes over the socket — the eligible/concurrency/demo trio comes
  // from the GET and is unaffected, which is what the old _paintRollover did
  // too.
  handleStatus(data: { job?: RolloverJob | null } | null) {
    if (!data || !live) return;
    live.paint(data.job || null);
  },

  // Called by AdminConsole.loadRollover on socket reconnect: a dropped
  // socket means missed transitions, so the job is refetched.
  reload() { live?.reload(); },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminRollover = AdminRollover;

export { AdminRollover };
