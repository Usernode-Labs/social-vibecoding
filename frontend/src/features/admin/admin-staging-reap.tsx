'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry — an explicit import inside the
// bundle, rather than the bare global read <script> order used to supply.
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Stale previews — the preview half of the container rollover next door. A
// staging preview's environment is fixed when it is BUILT, and previews live
// for weeks, so a platform env change leaves them running happily with stale
// env, which the existing staging-heal sweep cannot see (it only rebuilds
// previews whose container has STOPPED). This shuts them down; the next
// Preview click rebuilds any that someone actually wants. Progress arrives
// on the shell's /ws/events socket as `admin_staging_reap_status` (an
// admin-only broadcast) and GET /api/admin/staging-reap covers first paint
// and WS reconnect. See src/services/staging-reap.js.
//
// ── React-owned (#1120 slice 23) ──────────────────────────────────────
//
// Converted alongside admin-rollover.tsx, and for the same reason it was
// left until last: public/js/app.js routes the WS frame to
// `AdminConsole.handleStagingReapStatus` and calls
// `AdminConsole.loadStagingReap` on socket reconnect. That surface is the
// SHELL's, so it stays where app.js already looks for it — admin-console.js
// keeps thin forwarders and this module publishes `handleStatus` / `reload`
// for them. `live` below is the "am I still on screen?" answer the old
// handlers approximated with `_section === 'staging-reap'` plus a
// getElementById probe, and the eight `_reap*` module globals the paint
// routine read are component state now.
//
// Ids are like-for-like with the innerHTML version: `data-reap-name` /
// `data-reap-state` are addressable for a browser check, and the seven
// `admin-reap-*` ids are what tests/admin-staging-reap-surface.test.js names.

// The page's ?demo=1 rides along on the status read so a staging preview
// renders the demo job (routes/admin.js serves it only behind
// IS_STAGING && ?demo=1) — a preview has no docker socket, so there is
// nothing real for this section to show there. Guarded because this runs at
// module-EVALUATION time and the SSG prerender pass evaluates the module
// graph in Node; an absent flag already meant false in the browser.
const DEMO = typeof window !== 'undefined'
  && new URLSearchParams(location.search).get('demo') === '1';

const console_ = () => (window as any).AdminConsole;

// The mounted section, for the console's WS forwarders to reach. Non-null
// exactly while the section is on screen; see the header note.
let live: { paint: (job: ReapJob | null) => void; reload: () => void } | null = null;

type ReapPreview = {
  name: string;
  slug: string;
  sessionId: number | string;
  state: string;
  classification: string;
  ms?: number | null;
  error?: string | null;
};

type ReapJob = {
  total: number;
  done: number;
  failed: number;
  concurrency: number;
  finishedAt?: string | null;
  stale?: boolean;
  startedBy?: string | null;
  previews?: ReapPreview[];
};

type Automatic = { intervalMs?: number | null; lastRunAt?: string | null; tornDown?: number; failed?: number };

const NEUTRAL_CHIP = 'bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300';

// Per-preview outcome → chip. Mirrors the outcome vocabulary in
// src/services/staging-reap.js; an unknown state falls back to the raw
// string so a new outcome shows up rather than disappearing.
const REAP_STATES: Record<string, { label: string; cls: string }> = {
  pending: { label: 'Queued', cls: NEUTRAL_CHIP },
  running: { label: 'Shutting down…', cls: 'bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300' },
  torn_down: { label: 'Shut down', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
  torn_down_no_db: { label: 'Shut down: database kept', cls: 'bg-green-100 dark:bg-green-950/60 text-green-700 dark:text-green-400' },
  skipped_gone: { label: 'Skipped: already gone', cls: NEUTRAL_CHIP },
  failed: { label: 'Failed', cls: 'bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400' },
};

// Why each preview was picked up. Presentational only — the sweep tears
// down everything it enumerates; this just explains what the admin is
// looking at, and distinguishes "expected leftover of a merged proposal"
// from "the session row is gone entirely".
const REAP_CLASSIFICATIONS: Record<string, string> = {
  merged: 'proposal merged',
  archived: 'proposal abandoned',
  promoted: 'up for a vote',
  merging: 'merging now',
  active: 'session open',
  paused: 'session paused',
  merged_unlinked: 'merged (leaked past teardown)',
  archived_unlinked: 'abandoned (leaked past teardown)',
  promoted_unlinked: 'up for a vote (link lost)',
  no_session_row: 'session no longer exists',
};

// Local class recipes — complete literals, because Tailwind's extractor is a
// regex over this file's source (see the AdminUI note in admin-console.js).
const ReapUI = Object.freeze({
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
  rowSession: 'text-xs text-zinc-500 dark:text-zinc-400 ml-1',
  rowWhy: 'block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5',
  rowError: 'block text-xs text-red-700 mt-0.5 dark:text-red-400',
  rowRight: 'flex items-center gap-2 shrink-0',
  rowSecs: 'text-xs text-zinc-500 dark:text-zinc-400',
});

// "3 minutes ago" for the automatic pass's last run. Kept local and tiny:
// the only consumer is the one line below.
function ago(iso: string): string | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// The background pass's one-line status. Empty before the first load, which
// is the markup the innerHTML version shipped.
function automaticLine(
  automatic: Automatic | null,
  unavailableReason: string | null,
  loaded: boolean,
): string {
  if (!loaded) return '';
  if (unavailableReason === 'kubernetes') {
    return 'Kubernetes stale-preview administration is not implemented yet; normal per-session idle cleanup still applies.';
  }
  if (!automatic || !automatic.intervalMs) return 'The automatic background sweep is switched off.';
  if (!automatic.lastRunAt) {
    const every = Math.round(automatic.intervalMs / 60000);
    return `Automatic sweep runs every ${every} minutes. It hasn't run yet since this platform process started.`;
  }
  const bits = [`Automatic sweep last ran ${ago(automatic.lastRunAt) || 'recently'}`];
  bits.push(`${automatic.tornDown || 0} shut down`);
  if (automatic.failed) bits.push(`${automatic.failed} failed`);
  return `${bits.join(' · ')}.`;
}

function Tile({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div className={ReapUI.tile}>
      <div className={ReapUI.tileLabel}>{label}</div>
      <div id={id} className={ReapUI.tileValue}>{value}</div>
    </div>
  );
}

// The summary line's four states, in the order the paint routine tested
// them. Only the last carries the staging-demo prefix — the other three were
// `textContent` writes, so they never did.
function Summary({ loaded, job, demo }: { loaded: boolean; job: ReapJob | null; demo: boolean }) {
  if (!loaded) return <>Loading…</>;
  if (!job) return <>No sweep has run since this platform process started.</>;
  if (!job.total) {
    return <>{job.finishedAt ? 'Finished. No open previews were found.' : 'Starting…'}</>;
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

function PreviewRow({ preview }: { preview: ReapPreview }) {
  const chip = REAP_STATES[preview.state] || { label: preview.state, cls: NEUTRAL_CHIP };
  const why = REAP_CLASSIFICATIONS[preview.classification] || preview.classification;
  const secs = preview.ms == null ? '' : `${(preview.ms / 1000).toFixed(1)}s`;
  return (
    <div className={ReapUI.row} data-reap-name={preview.name} data-reap-state={preview.state}>
      <span className={ReapUI.rowMain}>
        <code className={ReapUI.rowSlug}>{preview.slug}</code>
        <span className={ReapUI.rowSession}>{`#${preview.sessionId}`}</span>
        <span className={ReapUI.rowWhy}>{why}</span>
        {preview.error ? <span className={ReapUI.rowError}>{preview.error}</span> : null}
      </span>
      <span className={ReapUI.rowRight}>
        {secs ? <span className={ReapUI.rowSecs}>{secs}</span> : null}
        <span className={`text-xs px-2 py-0.5 rounded-full ${chip.cls}`}>{chip.label}</span>
      </span>
    </div>
  );
}

function StalePreviewsSection() {
  const canWrite = !!console_()?.canWrite();
  const [loaded, setLoaded] = useState(false);
  // `open` is every preview (what the button shuts down); `outdated` is the
  // out-of-date subset the automatic pass acts on.
  const [open, setOpen] = useState<number | null>(null);
  const [outdated, setOutdated] = useState<number | null>(null);
  const [automatic, setAutomatic] = useState<Automatic | null>(null);
  const [concurrency, setConcurrency] = useState<number | null>(null);
  const [demo, setDemo] = useState(false);
  // Tracked separately from `demo`: the POST is refused in a preview whether
  // or not the reviewer arrived with ?demo=1.
  const [staging, setStaging] = useState(false);
  const [available, setAvailable] = useState(true);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const [job, setJob] = useState<ReapJob | null>(null);
  const [starting, setStarting] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { data } = await console_().fetchJson(`/api/admin/staging-reap${DEMO ? '?demo=1' : ''}`);
    if (!data || typeof data !== 'object') return;
    // The navigated-away guard, structurally: an unmounted section has no
    // state to set, so the old `_section !== 'staging-reap'` early return is
    // gone.
    if (!alive.current) return;
    // Older payloads carried only `stale` meaning "all previews", so fall
    // back to it for `open`.
    setOpen(typeof data.open === 'number' ? data.open
      : (typeof data.stale === 'number' ? data.stale : null));
    setOutdated(typeof data.stale === 'number' ? data.stale : null);
    setAutomatic(data.automatic || null);
    setConcurrency(data.concurrency || null);
    setDemo(!!data.demo);
    setStaging(!!data.staging);
    setAvailable(data.available !== false);
    setUnavailableReason(data.unavailableReason || null);
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
    // The button takes EVERY open preview, not just the out-of-date ones, so
    // the confirmation counts `open` — saying "4 previews" when it will shut
    // down 6 would be a lie about a fleet-wide action.
    const many = typeof open === 'number'
      ? `${open} preview${open === 1 ? '' : 's'}`
      : 'every open preview';
    const ok = await console_()._confirm({
      title: 'Shut down stale previews?',
      message: `This shuts down ${many}. Anyone who wants one back gets it `
        + 'rebuilt automatically on their next Preview click, with current '
        + "settings. Each preview's throwaway test data is discarded, and "
        + "rebuilding re-runs that proposal's automated checks.",
      confirmLabel: 'Shut down',
    });
    if (!ok) return;
    setStarting(true);
    try {
      const res = await fetch('/api/admin/staging-reap', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Singleton job: a second press is a no-op, not an error.
        (window as any).PlatformUI?.toast?.('A sweep is already in progress.');
        if (data && data.job && alive.current) setJob(data.job);
        return;
      }
      if (!res.ok) {
        console_()._alert((data && data.error) || `Sweep failed to start (HTTP ${res.status})`);
        return;
      }
      (window as any).PlatformUI?.toast?.('Sweep started.');
      if (data && data.job && alive.current) setJob(data.job);
    } catch (err: any) {
      console_()._alert(`Sweep failed to start: ${err.message}`);
    } finally {
      if (alive.current) setStarting(false);
      load();
    }
  }, [open, load]);

  const running = !!(job && !job.finishedAt && !job.stale);
  // A preview has no docker socket, so it cannot manage other previews, and
  // the route refuses the POST there — say so on the button rather than
  // letting a reviewer press it into a 400. Gate on `staging`, not on
  // `demo`: the refusal applies with or without ?demo=1.
  const preview = staging || demo;
  const runtimeUnavailable = available === false;
  const label = starting ? 'Starting…'
    : (preview ? 'Unavailable in previews'
      : (unavailableReason === 'kubernetes'
        ? 'Not yet supported in Kubernetes'
        : (running ? 'Sweep in progress…' : 'Shut down stale previews')));
  const rows = job && job.total ? (job.previews || []) : [];

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>Stale previews</h2>
        <button
          id="admin-refresh-reap"
          type="button"
          className={`${AdminUI.btn.link} text-xs`}
          onClick={() => load()}
        >
          Refresh
        </button>
      </div>
      <p className={ReapUI.lede}>
        Shuts down every proposal preview that is still running. A preview&apos;s
        settings are fixed when it is built, so after a platform change to
        what gets injected into containers, old previews keep running with
        the old settings, typically showing a login screen instead of the
        app. Out-of-date previews are now found and cleaned up
        automatically in the background; this button is the immediate
        version, and takes every preview rather than only the stale ones.
      </p>
      <p className={ReapUI.fine}>
        Nothing is lost that matters: clicking Preview on a proposal rebuilds
        it automatically with current settings, the same way a preview that
        went to sleep does. A preview&apos;s throwaway test data is discarded, and
        rebuilding re-runs that proposal&apos;s automated checks.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <Tile
          id="admin-reap-stale"
          label="Open previews"
          value={open == null ? '—' : String(open)}
        />
        <Tile
          id="admin-reap-outdated"
          label="Out of date"
          value={outdated == null ? '—' : String(outdated)}
        />
        <Tile
          id="admin-reap-concurrency"
          label="At a time"
          value={job ? String(job.concurrency) : (concurrency ? String(concurrency) : '—')}
        />
        <Tile
          id="admin-reap-failed"
          label="Failed"
          value={job ? String(job.failed) : '—'}
        />
      </div>
      <p id="admin-reap-automatic" className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
        {automaticLine(automatic, unavailableReason, loaded)}
      </p>
      {canWrite ? (
        <button
          id="admin-reap-btn"
          type="button"
          className={ReapUI.startBtn}
          disabled={running || preview || runtimeUnavailable || starting}
          onClick={start}
        >
          {label}
        </button>
      ) : (
        <p className={ReapUI.viewOnly}>
          View-only admin: you can watch a sweep, but not start one.
        </p>
      )}
      <p id="admin-reap-summary" className={ReapUI.summary}>
        <Summary loaded={loaded} job={job} demo={demo} />
      </p>
      <div id="admin-reap-list" className="space-y-2 mt-3">
        {rows.map((p) => <PreviewRow key={p.name} preview={p} />)}
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminStagingReap = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <StalePreviewsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },

  // Called by AdminConsole.handleStagingReapStatus, which public/js/app.js's
  // /ws/events onmessage routes `admin_staging_reap_status` frames to. Only
  // the job changes over the socket — the counts and the availability trio
  // come from the GET and are unaffected, which is what the old
  // _paintStagingReap did too.
  handleStatus(data: { job?: ReapJob | null } | null) {
    if (!data || !live) return;
    live.paint(data.job || null);
  },

  // Called by AdminConsole.loadStagingReap on socket reconnect: a dropped
  // socket means missed transitions, so the job is refetched.
  reload() { live?.reload(); },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminStagingReap = AdminStagingReap;

export { AdminStagingReap };
