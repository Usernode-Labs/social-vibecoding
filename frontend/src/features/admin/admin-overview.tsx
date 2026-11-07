'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Operations overview — the console's landing section (#admin, #admin/overview).
//
// Three tiles over one /api/admin/overview read: apps wedged in a non-terminal
// creation state, workers whose session is gone, and today's platform LLM
// spend. Below them, what needs attention and who spent the most today
// (#6454, see the dashboard note below). An all-clear renders as a sentence
// rather than an empty list, because "no stuck apps" is the answer an
// operator opened this page for.
//
// PERMISSIONS: any admin, full or view-only. Pure read surface — no mutating
// controls, so no canAdminWrite gate.
//
// ── The first section moved OUT of admin-console.js (#1120 slice 16) ──
//
// The console renders eight sections itself, inline in admin-console.js's
// 3,400 lines, dispatched by a `switch` in `_renderSection` rather than
// through `SECTION_MODULES`. That split is historical: the ten delegated
// modules were extracted when they grew big, and these eight never did.
//
// Converting them in place would mean turning the chassis file into a React
// file, which is a much larger and riskier change than converting a section —
// so the section moves out FIRST, into the same `{ render, destroy }` contract
// every other module already answers to, and the chassis loses a `case`. The
// chassis stays exactly as imperative as it was; the switch shrinks by one
// arm each time this is repeated, and when it empties the chassis is the only
// thing left in that file.
//
// `overview` is also the console's DEFAULT section, so `_renderSection`'s
// `default:` arm dispatches here too — see `_renderModule` there.

interface OverviewData {
  stuckApps?: Array<{ slug: string; dbStatus: string; createdBy?: string; createdAt: string }>;
  orphanWorkers?: Array<{ name: string; appSlug?: string; uptimeSeconds?: number; sessionArchived?: boolean }>;
  llmToday?: { totalSpendCents: number; users?: Array<{ username: string; costCents: number }> };
}

// ── The control room's dashboard (#6454) ───────────────────────────────
//
// The same one read, drawn for somebody who keeps it open all day: three
// headline tiles, then ONE "Needs attention" list that puts stuck apps and
// orphan workers side by side, each with a severity stripe and a jump to the
// section where it is dealt with (Apps & usage for an app, Health & status for
// a worker); nothing here writes. Then today's top spenders with a bar each,
// proportional to the top one, and a jump to Model costs.
//
// It refreshes itself every 30 seconds while it is mounted AND the tab is
// visible (a hidden tab skips the tick and catches up when it is shown
// again). destroy() clears the timer, as does the component's own cleanup:
// leaving Overview must not leave /api/admin/overview polled for the life of
// the tab. Every load also hands the attention count to the desktop rail
// (AdminConsole.setAttention), the only other reader of it.

const REFRESH_MS = 30000;

const TILE = 'rounded-xl bg-zinc-100 dark:bg-zinc-800 p-3';
const TILE_LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const GROUP_LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-2';
const MUTED_SM = 'text-xs text-zinc-500 dark:text-zinc-400';
const ROW = 'flex items-stretch gap-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/60 overflow-hidden';
const FIGURE_CALM = 'text-2xl font-bold mt-1 text-zinc-900 dark:text-zinc-100';
const FIGURE_ALERT = 'text-2xl font-bold mt-1 text-red-700 dark:text-red-300';

// The stripe: red for an app whose creation failed, amber for one still
// "creating" and for a worker with no session behind it.
const STRIPE_RED = 'w-1 shrink-0 bg-red-500 dark:bg-red-400';
const STRIPE_AMBER = 'w-1 shrink-0 bg-amber-500 dark:bg-amber-400';

let timer: ReturnType<typeof setInterval> | null = null;

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

function jump(key: string) {
  (window as any).AdminConsole?.jumpTo?.(key);
}

function age(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}

function uptime(seconds?: number): string {
  const mins = Math.round((seconds || 0) / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function dollars(cents: number): string {
  return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
}

function OverviewSection() {
  const [data, setData] = useState<OverviewData | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // status.gather can take a moment; the tiles show em-dashes until it lands,
  // and only this section blocks — never the whole page.
  const load = useCallback(async () => {
    const { data: payload } = await (window as any).AdminConsole.fetchJson('/api/admin/overview');
    if (!alive.current || !payload || typeof payload !== 'object') return;
    setData(payload);
    setUpdated(new Date());
    const n = (payload.stuckApps || []).length + (payload.orphanWorkers || []).length;
    (window as any).AdminConsole?.setAttention?.(n);
  }, []);

  useEffect(() => {
    load();
    stopTimer();
    timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    // A tab shown again after a hidden stretch catches up at once.
    const onVisible = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const stuck = data?.stuckApps || [];
  const orphans = data?.orphanWorkers || [];
  const llm = data?.llmToday || { totalSpendCents: 0, users: [] };
  const spenders = [...(llm.users || [])]
    .sort((a, b) => (b.costCents || 0) - (a.costCents || 0))
    .slice(0, 5);
  const topCents = spenders.length ? Math.max(1, spenders[0].costCents || 0) : 1;
  const attention = stuck.length + orphans.length;

  return (
    <div id="admin-overview-dashboard" className="space-y-4">
      <div className={`${AdminUI.card} p-4`}>
        <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
          <h2 className={AdminUI.cardTitle}>Operations</h2>
          <div className="flex items-center gap-3">
            <span id="admin-overview-updated" className={MUTED_SM}>
              {updated ? `Updated ${updated.toLocaleTimeString()} · refreshes every 30 s` : 'Refreshes every 30 s'}
            </span>
            <button id="admin-refresh-overview" type="button" className={`${AdminUI.btn.link} text-xs`}
              onClick={load}>Refresh</button>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className={TILE}>
            <div className={TILE_LABEL}>Stuck apps</div>
            <div id="admin-overview-stuck" className={data && stuck.length ? FIGURE_ALERT : FIGURE_CALM}>
              {data ? stuck.length : '—'}
            </div>
          </div>
          <div className={TILE}>
            <div className={TILE_LABEL}>Orphan workers</div>
            <div id="admin-overview-orphan" className={data && orphans.length ? FIGURE_ALERT : FIGURE_CALM}>
              {data ? orphans.length : '—'}
            </div>
          </div>
          <div className={TILE}>
            <div className={TILE_LABEL}>LLM spend today</div>
            <div id="admin-overview-llm" className={FIGURE_CALM}>
              {data ? dollars(llm.totalSpendCents) : '—'}
            </div>
          </div>
        </div>
      </div>

      <div id="admin-overview-details" className="grid grid-cols-1 xl:grid-cols-2 gap-4 text-sm">
        <section id="admin-overview-attention" className={`${AdminUI.card} p-4`}>
          <div className={GROUP_LABEL}>{attention ? `Needs attention · ${attention}` : 'Needs attention'}</div>
          {!data ? <p className={AdminUI.loading}>Loading…</p> : null}
          {data && !attention ? (
            <p id="admin-overview-all-clear" className={AdminUI.muted}>
              All clear: no stuck apps and no orphan workers right now.
            </p>
          ) : null}
          {attention ? (
            <ul className="space-y-1.5">
              {stuck.map((a) => (
                <li key={`app-${a.slug}`} className={ROW} data-attention="app">
                  <span className={a.dbStatus === 'error' ? STRIPE_RED : STRIPE_AMBER} aria-hidden="true"></span>
                  <span className="flex-1 min-w-0 py-2">
                    <span className="block truncate">
                      <span className="font-mono">{a.slug}</span>
                      <span className={MUTED_SM}>{` · app ${a.dbStatus}`}</span>
                    </span>
                    <span className={`block ${MUTED_SM}`}>
                      {`by ${a.createdBy || '—'} · ${age(a.createdAt)} ago`}
                    </span>
                  </span>
                  <span className="flex items-center pe-3">
                    <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => jump('apps')}>
                      Apps & usage
                    </button>
                  </span>
                </li>
              ))}
              {orphans.map((w) => (
                <li key={`worker-${w.name}`} className={ROW} data-attention="worker">
                  <span className={STRIPE_AMBER} aria-hidden="true"></span>
                  <span className="flex-1 min-w-0 py-2">
                    <span className="block truncate">
                      <span className="font-mono">{w.name}</span>
                      <span className={MUTED_SM}>{' · orphan worker'}</span>
                    </span>
                    <span className={`block ${MUTED_SM}`}>
                      {`${w.appSlug ? `app ${w.appSlug}` : 'no app'} · up ${uptime(w.uptimeSeconds)}${
                        w.sessionArchived ? ' · session archived' : ''}`}
                    </span>
                  </span>
                  <span className="flex items-center pe-3">
                    <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => jump('status')}>
                      Health & status
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>

        <section id="admin-overview-spenders" className={`${AdminUI.card} p-4`}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className={TILE_LABEL}>{"Today's top spenders"}</div>
            <button type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => jump('model-costs')}>
              Model costs
            </button>
          </div>
          {data && !spenders.length ? (
            <p className={AdminUI.muted}>No LLM spend recorded today.</p>
          ) : null}
          {spenders.length ? (
            <ul className="space-y-2">
              {spenders.map((u) => (
                <li key={u.username}>
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate">{u.username}</span>
                    <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">{dollars(u.costCents)}</span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800" aria-hidden="true">
                    <div className="h-1.5 rounded-full bg-violet-500"
                      style={{ width: `${Math.max(2, Math.round(((u.costCents || 0) / topCents) * 100))}%` }}></div>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminOverview = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <OverviewSection />);
  },

  destroy() {
    // The 30-second refresh stops here, before the portal goes.
    stopTimer();
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminOverview = AdminOverview;

export { AdminOverview };
