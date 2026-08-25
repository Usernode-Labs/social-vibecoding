'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Operations overview — the console's landing section (#admin, #admin/overview).
//
// Three tiles over one /api/admin/overview read: apps wedged in a non-terminal
// creation state, today's platform LLM spend, and workers whose session is
// gone. Below them, the detail for whichever of the three is non-empty. An
// all-clear renders as a sentence rather than three empty lists, because "no
// stuck apps" is the answer an operator opened this page for.
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

const TILE = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3';
const TILE_LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const GROUP_LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1';
const ROW = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2 rounded bg-zinc-100 dark:bg-zinc-800';
const MUTED_SM = 'text-xs text-zinc-500 dark:text-zinc-400';

function OverviewSection() {
  const [data, setData] = useState<OverviewData | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // status.gather can take a moment; the tiles show em-dashes until it lands,
  // and only this section blocks — never the whole page.
  const load = useCallback(async () => {
    const { data: payload } = await (window as any).AdminConsole.fetchJson('/api/admin/overview');
    if (!alive.current || !payload || typeof payload !== 'object') return;
    setData(payload);
  }, []);

  useEffect(() => { load(); }, [load]);

  const stuck = data?.stuckApps || [];
  const orphans = data?.orphanWorkers || [];
  const llm = data?.llmToday || { totalSpendCents: 0, users: [] };
  const spenders = (llm.users || []).slice(0, 5);
  const anyDetail = stuck.length || orphans.length || spenders.length;

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>Operations</h2>
        <button id="admin-refresh-overview" type="button" className={`${AdminUI.btn.link} text-xs`}
          onClick={load}>Refresh</button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <div className={TILE}>
          <div className={TILE_LABEL}>Stuck apps</div>
          <div id="admin-overview-stuck" className="text-2xl font-bold mt-1">{data ? stuck.length : '—'}</div>
        </div>
        <div className={TILE}>
          <div className={TILE_LABEL}>LLM spend today</div>
          <div id="admin-overview-llm" className="text-2xl font-bold mt-1">
            {data ? `$${(llm.totalSpendCents / 100).toFixed(2)}` : '—'}
          </div>
        </div>
        <div className={TILE}>
          <div className={TILE_LABEL}>Orphan workers</div>
          <div id="admin-overview-orphan" className="text-2xl font-bold mt-1">{data ? orphans.length : '—'}</div>
        </div>
      </div>
      <div id="admin-overview-details" className="space-y-3 text-sm">
        {!data ? <p className={MUTED_SM}>Loading…</p> : null}
        {stuck.length ? (
          <div>
            <div className={GROUP_LABEL}>Stuck apps</div>
            <ul className="space-y-1">
              {stuck.map((a) => (
                <li key={a.slug} className={ROW}>
                  <span>
                    <span className="font-mono">{a.slug}</span>
                    <span className={MUTED_SM}>{` (${a.dbStatus}, by ${a.createdBy || '—'})`}</span>
                  </span>
                  <span className={MUTED_SM}>{new Date(a.createdAt).toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {orphans.length ? (
          <div>
            <div className={GROUP_LABEL}>Orphan workers</div>
            <ul className="space-y-1">
              {orphans.map((w) => (
                <li key={w.name} className={ROW}>
                  <span>
                    <span className="font-mono">{w.name}</span>
                    <span className={MUTED_SM}>
                      {` ${w.appSlug ? `app ${w.appSlug}` : 'no app'} · up ${Math.round((w.uptimeSeconds || 0) / 60)}m${
                        w.sessionArchived ? ' · session archived' : ''}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {spenders.length ? (
          <div>
            <div className={GROUP_LABEL}>Top LLM spenders today</div>
            <ul className="space-y-1">
              {spenders.map((u) => (
                <li key={u.username} className="flex items-center justify-between gap-3 p-2 rounded bg-zinc-100 dark:bg-zinc-800">
                  <span>{u.username}</span>
                  <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">{`$${(u.costCents / 100).toFixed(2)}`}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {data && !anyDetail ? (
          <p className={MUTED_SM}>All clear — no stuck apps, no orphan workers, no LLM spend recorded today.</p>
        ) : null}
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
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminOverview = AdminOverview;

export { AdminOverview };
