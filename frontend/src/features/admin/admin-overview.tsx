'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { needsYouSentence, pinnedSections } from './admin-workspace.js';
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
//
// ── Admin home (#6456) ──
//
// On a desktop this is the console's Home tab: a heading with one sentence
// saying whether anything needs you, the three tiles and their detail as
// before, then Pinned (the sections admins open most) and All sections, the
// whole menu as cards grouped as the top bar groups them. Every card opens
// its section through AdminConsole.goTo, the chassis's one way in. On a
// phone's level 1 this renders into #admin-mobile-overview above the
// chassis's own section menu, so there it is the tiles alone, as before.

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

function OverviewSection({ compact }: { compact?: boolean }) {
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

  const ops = (
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
        {!data ? <p className={AdminUI.loading}>Loading…</p> : null}
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
          <p className={MUTED_SM}>All clear: no stuck apps, no orphan workers, no LLM spend recorded today.</p>
        ) : null}
      </div>
    </div>
  );

  if (compact) return ops;

  const consoleApi = (window as any).AdminConsole;
  const visible: Section[] = consoleApi?._visibleSections?.() || [];
  const pinned: Section[] = pinnedSections(visible);
  const groups: Array<{ name: string; items: Section[] }> = (consoleApi?._groupedSections?.() || [])
    .map((g: { name: string; items: Section[] }) => ({ ...g, items: g.items.filter((x) => x.key !== 'overview') }))
    .filter((g: { items: Section[] }) => g.items.length);
  const sentence = needsYouSentence(data);
  const needs = (stuck.length + orphans.length) > 0;

  return (
    <div id="admin-home" className="space-y-10 pb-4">
      <header>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">Admin home</h1>
        <p id="admin-home-status" className={`mt-1 text-sm ${needs ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {sentence || 'Checking what needs you…'}
        </p>
      </header>
      {ops}
      {pinned.length ? (
        <section aria-labelledby="admin-home-pinned-title">
          <h2 id="admin-home-pinned-title" className={HOME_LABEL}>Pinned</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pinned.map((x) => (
              <SectionCard key={x.key} section={x} large />
            ))}
          </div>
        </section>
      ) : null}
      <section aria-labelledby="admin-home-all-title">
        <h2 id="admin-home-all-title" className={HOME_LABEL}>All sections</h2>
        <div className="space-y-8">
          {groups.map((g) => (
            <div key={g.name} data-admin-home-group={g.name}>
              <h3 className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-3">{g.name}</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                {g.items.map((x) => <SectionCard key={x.key} section={x} />)}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

interface Section { key: string; label: string; group?: string }

const HOME_LABEL = 'text-xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-4';

// One card per section, a real <button> carrying data-admin-section like
// every other way into a section. Its glyph is the chassis's own NAV_ICONS
// entry: a static string in this bundle, never anything a server sent.
function SectionCard({ section, large }: { section: Section; large?: boolean }) {
  const icon = (window as any).AdminConsole?.NAV_ICONS?.[section.key] || '';
  return (
    <button
      type="button"
      data-admin-section={section.key}
      onClick={() => (window as any).AdminConsole?.goTo?.(section.key)}
      className={`${AdminUI.card} flex items-center gap-4 w-full text-start ${large ? 'p-5' : 'px-4 py-3'} transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500`}
    >
      <span className={`flex items-center justify-center shrink-0 rounded-xl bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 ${large ? 'w-11 h-11' : 'w-9 h-9'}`}
        dangerouslySetInnerHTML={{ __html: icon }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{section.label}</span>
        {large && section.group ? <span className="block text-xs text-zinc-500 dark:text-zinc-400">{section.group}</span> : null}
      </span>
    </button>
  );
}

let host: Element | null = null;

const AdminOverview = {
  render(el: Element) {
    host = el;
    // The phone's level 1 hands over #admin-mobile-overview, a sub-host above
    // the chassis's own menu: the tiles alone there (see the note above).
    mountLegacyPortal(el, <OverviewSection compact={el.id === 'admin-mobile-overview'} />);
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
