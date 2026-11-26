'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry — an explicit import inside the
// bundle, rather than the bare global read <script> order used to supply.
import { AdminUI } from './admin-console.js';
import { BTN } from './topochain/tokens.ts';
import { Badge, Figures, List, ScreenHeader } from './topochain/ui.tsx';
import type { Column } from './topochain/ui.tsx';
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

// Per-app outcome → badge. Mirrors the outcome vocabulary in
// src/services/app-rollover.js; an unknown state falls back to the raw
// string so a new outcome shows up rather than disappearing.
//
// `cls` is a tone of the shared `Badge` since 26 Nov 2026, not a class
// string: the status is repeated down the list, so it wears the kit's soft
// tones like every other list. The key keeps its name because
// tests/admin-rollover-surface.test.js names this table's shape.
const NEUTRAL_CHIP = 'zinc';

const ROLLOVER_STATES: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Queued', cls: 'sky' },
  running: { label: 'Rolling over…', cls: 'violet' },
  rolled: { label: 'Done', cls: 'mint' },
  rebuild_requested: { label: 'Rebuild asked of app delivery', cls: NEUTRAL_CHIP },
  skipped_deploying: { label: 'Skipped: deploying', cls: NEUTRAL_CHIP },
  skipped_missing_secrets: { label: 'Skipped: missing secrets', cls: NEUTRAL_CHIP },
  skipped_no_db_password: { label: 'Skipped: no DB role', cls: NEUTRAL_CHIP },
  skipped_deleted: { label: 'Skipped: app gone', cls: NEUTRAL_CHIP },
  failed: { label: 'Failed', cls: 'red' },
};

// The summary line's four states, in the order the paint routine tested
// them. Only the last carries the staging-demo prefix — the other three were
// `textContent` writes, so they never did.
function Summary({ loaded, job, demo }: { loaded: boolean; job: RolloverJob | null; demo: boolean }) {
  // A <span>, not a <p>: this renders INSIDE #admin-rollover-summary, which
  // is already a paragraph.
  if (!loaded) return <span className={AdminUI.loading}>Loading…</span>;
  if (!job) return <>No rollover has run since this platform process started.</>;
  if (!job.total) {
    return <>{job.finishedAt ? 'Finished. No eligible app containers were found.' : 'Starting…'}</>;
  }
  const parts = [`${job.done} of ${job.total} done`];
  if (job.failed) parts.push(`${job.failed} failed`);
  const when = job.finishedAt ? 'Finished' : (job.stale ? 'Stalled' : 'Running');
  return (
    <>
      {demo ? <><span className="text-violet-700 dark:text-violet-400">Staging demo data</span>{' · '}</> : null}
      <span className="font-medium">{when}</span>
      {` · ${parts.join(', ')}`}
      {job.startedBy ? ` · started by ${job.startedBy}` : ''}
    </>
  );
}

// The app's cell: its slug, and what went wrong under it. The row's slug and
// state stay addressable here, as they were on the row itself, since the
// shared `List` owns the row element.
function AppRow({ app }: { app: RolloverApp }) {
  return (
    <span data-rollover-slug={app.slug} data-rollover-state={app.state}>
      <code className="font-mono text-sm">{app.slug}</code>
      {app.error ? <span className="block text-xs text-red-700 mt-0.5 dark:text-red-400">{app.error}</span> : null}
    </span>
  );
}

const ROLLOVER_COLUMNS: Column<RolloverApp>[] = [
  { label: 'App', primary: true, cell: (app) => <AppRow app={app} /> },
  {
    label: 'Took',
    tdClass: 'tabular-nums text-zinc-500 dark:text-zinc-400',
    cell: (app) => (app.ms == null ? '' : `${(app.ms / 1000).toFixed(1)}s`),
  },
  {
    label: 'Status',
    cell: (app) => {
      const chip = ROLLOVER_STATES[app.state] || { label: app.state, cls: NEUTRAL_CHIP };
      return <Badge tone={chip.cls} label={chip.label} />;
    },
  },
];

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
        + 'and only the environment changes, so no new code is shipped. '
        + 'The platform app itself is not touched.',
      confirmLabel: 'Roll over',
    });
    if (!ok) return;
    setStarting(true);
    try {
      const res = await fetch('/api/admin/rollover', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Singleton job: a second press is a no-op, not an error. Refused for
        // another reason (a release rolling out), the server says why.
        (window as any).PlatformUI?.toast?.(data && data.reason && data.reason !== 'running' && data.error
          ? data.error : 'A rollover is already in progress.');
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
    <div>
      <ScreenHeader
        title="Container rollover"
        subtitle="Recreates every running app container so it picks up the environment this platform build hands out. Needed after a platform change to what gets injected into containers. A restart is not enough, because a restarted container keeps the environment it was created with."
        actions={(
          <>
            <button
              id="admin-refresh-rollover"
              type="button"
              className={BTN.secondarySm}
              onClick={() => load()}
            >
              Refresh
            </button>
            {canWrite ? (
              <button
                id="admin-rollover-btn"
                type="button"
                className={BTN.primarySm}
                disabled={running || demo || starting}
                onClick={start}
              >
                {label}
              </button>
            ) : null}
          </>
        )}
      />
      <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
        This re-runs each app&apos;s existing build: it changes the environment and
        nothing else, so no new code is shipped, unlike a per-app redeploy. Each
        app blinks offline for a few seconds as its turn comes up. The platform
        app itself is never touched.
      </p>
      {/* Each figure's value keeps the id it had as a tile. */}
      <Figures
        id="admin-rollover-figures"
        items={[
          {
            key: 'eligible',
            label: 'Eligible apps',
            tone: 'sky',
            value: <span id="admin-rollover-eligible">{eligible == null ? '—' : String(eligible)}</span>,
          },
          {
            key: 'concurrency',
            label: 'At a time',
            tone: 'sky',
            value: (
              <span id="admin-rollover-concurrency">
                {job ? String(job.concurrency) : (concurrency ? String(concurrency) : '—')}
              </span>
            ),
          },
          {
            key: 'failed',
            label: 'Failed',
            tone: !job ? 'sky' : (job.failed ? 'yellow' : 'green'),
            value: <span id="admin-rollover-failed">{job ? String(job.failed) : '—'}</span>,
          },
        ]}
      />
      {canWrite ? null : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          View-only admin: you can watch a rollover, but not start one.
        </p>
      )}
      <p id="admin-rollover-summary" className={`${AdminUI.muted} mt-3`}>
        <Summary loaded={loaded} job={job} demo={demo} />
      </p>
      <div id="admin-rollover-list" className="mt-3">
        {rows.length ? <List items={rows} columns={ROLLOVER_COLUMNS} rowKey={(app) => app.slug} /> : null}
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
  // A job too big for one frame comes as a nudge (`changed`): read it again.
  handleStatus(data: { job?: RolloverJob | null; changed?: boolean } | null) {
    if (!data || !live) return;
    if (data.changed && data.job === undefined) { live.reload(); return; }
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
