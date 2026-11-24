'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import {
  DASHBOARD_DEFAULT_DAYS, DASHBOARD_PERIODS, agoWords, attentionItems, beforeWords, deltaOf,
  needsYouSentence, pinnedSections, quickSections, reasonWords, targetWords,
} from './admin-workspace.js';
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

// ── The dashboard (#7081) ──
//
// The home page reads a second endpoint, GET /api/admin/dashboard
// (src/services/admin-dashboard.js): counts of rows that already exist, for
// a period the admin picks (7, 30 or 90 days), each beside the same count
// for the period before. Every figure on the page is one of those counts or
// one of the three the overview read already gave. Nothing is estimated, and
// a figure that has not arrived is a dash, never a number.
//
// What the page says about them (how a count moved, what needs somebody, how
// long ago) is decided in ./admin-workspace.js, as the tabs and the search
// are, so tests/admin-workspace.test.js holds the rules without a DOM.

interface Pair { now: number; before: number }
interface QueueRow { id: number; targetType: string; label: string; status: string; reports: number; reason: string | null; updatedAt: string }
interface ShippedRow { id: number; title: string | null; appSlug: string; appName: string; mergedAt: string }
interface DashboardData {
  days: number;
  totals: { users: number; apps: number; communities: number };
  period: { newUsers: Pair; newApps: Pair; proposals: Pair; votes: Pair; voters: Pair; shipped: Pair };
  moderation: { open: number; fresh: number; queue: QueueRow[] };
  shipped: ShippedRow[];
}

const count = (n: number) => Number(n || 0).toLocaleString('en-US');
const ARROW = { up: '↑', down: '↓', flat: '→' } as const;
// The registry is never indexed by a computed key (its header says why):
// each member is named once here, and the page picks from these.
const DELTA = { up: AdminUI.delta.up, down: AdminUI.delta.down, flat: AdminUI.delta.flat } as const;
const METRIC = { sky: AdminUI.metric.sky, leaf: AdminUI.metric.leaf, sun: AdminUI.metric.sun, plain: AdminUI.metric.plain } as const;

function Delta({ pair }: { pair: Pair }) {
  const d = deltaOf(pair.now, pair.before);
  return (
    <span className={DELTA[d.dir as 'up' | 'down' | 'flat']}>
      <span aria-hidden="true">{ARROW[d.dir as 'up' | 'down' | 'flat']}</span>{d.text}
    </span>
  );
}

// One figure. `value` is null until its read lands: a dash then, so a tile
// never shows a number it was not given.
// `lead` is what the movement is about when it is not the figure itself: a
// total's tile says "37 new" before "Up 68%", so the arrow is never read as
// the total's.
function Metric({ id, tone, label, value, lead, note, pair, onOpen, opens }: {
  id: string; tone: 'sky' | 'leaf' | 'sun' | 'plain'; label: string; value: number | null;
  lead?: string; note?: string; pair?: Pair | null; onOpen?: () => void; opens?: string;
}) {
  const body = (
    <>
      <div className={AdminUI.metricLabel}>{label}</div>
      <div id={id} className={AdminUI.metricValue}>{value == null ? '—' : count(value)}</div>
      <div className={`${AdminUI.metricNote} flex flex-wrap items-center gap-x-2 gap-y-1`}>
        {lead ? <span className="font-medium text-[color:var(--adm-ink)]">{lead}</span> : null}
        {pair && value != null ? <Delta pair={pair} /> : null}
        {note ? <span>{note}</span> : null}
      </div>
    </>
  );
  if (!onOpen) return <div className={METRIC[tone]}>{body}</div>;
  return (
    <button type="button" onClick={onOpen} aria-label={`${label}: open ${opens}`}
      className={`${METRIC[tone]} block w-full text-start transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500`}>
      {body}
    </button>
  );
}

function OverviewSection({ compact }: { compact?: boolean }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [dashFailed, setDashFailed] = useState(false);
  const [days, setDays] = useState<number>(DASHBOARD_DEFAULT_DAYS);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // status.gather can take a moment; the tiles show em-dashes until it lands,
  // and only this section blocks — never the whole page.
  const load = useCallback(async () => {
    const { data: payload } = await (window as any).AdminConsole.fetchJson('/api/admin/overview');
    if (!alive.current || !payload || typeof payload !== 'object') return;
    setData(payload);
  }, []);

  // The counts, for the period on screen. A newer period's answer wins over
  // an older one still in flight. A failed read says so and offers Retry; the
  // figures it would have filled stay dashes.
  const asked = useRef(0);
  const loadDash = useCallback(async (period: number) => {
    const mine = ++asked.current;
    setDashFailed(false);
    const { ok, data: payload } = await (window as any).AdminConsole.fetchJson(`/api/admin/dashboard?days=${period}`);
    if (!alive.current || mine !== asked.current) return;
    if (!ok || !payload || typeof payload !== 'object' || !payload.period) { setDash(null); setDashFailed(true); return; }
    setDash(payload);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadDash(days); }, [loadDash, days]);

  const stuck = data?.stuckApps || [];
  const orphans = data?.orphanWorkers || [];
  const llm = data?.llmToday || { totalSpendCents: 0, users: [] };
  const spenders = (llm.users || []).slice(0, 5);
  const anyDetail = stuck.length || orphans.length || spenders.length;

  const ops = (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex items-center justify-between mb-3">
        <h2 className={AdminUI.cardTitle}>{compact ? 'Operations' : 'Platform health'}</h2>
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

  const consoleApi = (window as any).AdminConsole;
  const visible: Section[] = consoleApi?._visibleSections?.() || [];
  const canOpen = (key: string) => visible.some((x) => x.key === key);
  const go = (key: string) => () => consoleApi?.goTo?.(key);
  const opener = (key: string) => (canOpen(key) ? go(key) : undefined);
  const labelOf = (key: string) => visible.find((x) => x.key === key)?.label || key;
  const before = beforeWords(dash?.days || days);
  const p = dash?.period || null;

  // The figures: what exists, then what happened in the period.
  const metrics = (
    <div id="admin-dash-metrics" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Metric id="admin-dash-users" tone="sky" label="Accounts" value={dash ? dash.totals.users : null}
        lead={p ? `${count(p.newUsers.now)} new` : undefined} note={p ? before : undefined} pair={p?.newUsers}
        onOpen={opener('users')} opens={labelOf('users')} />
      <Metric id="admin-dash-apps" tone="leaf" label="Projects" value={dash ? dash.totals.apps : null}
        lead={p ? `${count(p.newApps.now)} new` : undefined} note={p ? before : undefined} pair={p?.newApps}
        onOpen={opener('apps')} opens={labelOf('apps')} />
      <Metric id="admin-dash-communities" tone="plain" label="Communities" value={dash ? dash.totals.communities : null}
        note="One for each project today" />
      <Metric id="admin-dash-moderation" tone={dash && dash.moderation.open > 0 ? 'sun' : 'plain'} label="Open moderation cases"
        value={dash ? dash.moderation.open : null}
        note={dash ? (dash.moderation.fresh ? `${count(dash.moderation.fresh)} not looked at yet` : 'None waiting to be looked at') : undefined}
        onOpen={opener('reports')} opens={labelOf('reports')} />
      <Metric id="admin-dash-proposals" tone="plain" label="Changes put to a vote" value={p ? p.proposals.now : null} note={before} pair={p?.proposals} />
      <Metric id="admin-dash-votes" tone="plain" label="Votes cast" value={p ? p.votes.now : null} note={before} pair={p?.votes} />
      <Metric id="admin-dash-voters" tone="plain" label="People who voted" value={p ? p.voters.now : null} note={before} pair={p?.voters} />
      <Metric id="admin-dash-shipped" tone="leaf" label="Changes gone live" value={p ? p.shipped.now : null} note={before} pair={p?.shipped} />
    </div>
  );

  const failed = dashFailed ? (
    <div id="admin-dash-error" role="alert" className={`${AdminUI.card} p-4 flex flex-wrap items-center gap-3`}>
      <p className="flex-1 min-w-0 text-sm text-red-700 dark:text-red-300">The figures could not be loaded. Nothing is shown in their place.</p>
      <button type="button" className={AdminUI.btn.outlineSm} onClick={() => loadDash(days)}>Try again</button>
    </div>
  ) : null;

  const attention = attentionItems(data, dash);
  const TONE = { warn: AdminUI.badge.warn, bad: AdminUI.badge.destructive } as const;
  const attentionCard = (
    <section aria-labelledby="admin-dash-attention-title" className={`${AdminUI.card} p-4`}>
      <h2 id="admin-dash-attention-title" className={AdminUI.cardTitle}>Needs attention</h2>
      {attention == null ? <p className={`${AdminUI.loading} mt-3`}>Loading…</p> : null}
      {attention && !attention.length ? (
        <p id="admin-dash-attention-clear" className="mt-3 flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-400">
          <span className={AdminUI.badge.success}>All clear</span>No open moderation case, stuck project or orphan worker.
        </p>
      ) : null}
      {attention && attention.length ? (
        <ul id="admin-dash-attention" className="mt-1">
          {attention.map((item) => (
            <li key={item.key} className={AdminUI.listRow}>
              <span className={TONE[item.tone as 'warn' | 'bad']}>{item.tone === 'bad' ? 'Problem' : 'Waiting'}</span>
              <span className="flex-1 min-w-0 text-sm font-medium text-zinc-900 dark:text-zinc-100">{item.text}</span>
              {canOpen(item.section) ? (
                <button type="button" className={AdminUI.btn.outlineSm} data-admin-section={item.section} onClick={go(item.section)}>
                  {`Open ${labelOf(item.section)}`}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );

  if (compact) {
    // A phone's level 1, above the section menu: what needs somebody first,
    // then the figures two to a row, then the operations card as before.
    return (
      <div id="admin-dash-phone" className="space-y-4">
        {attentionCard}
        {failed}
        {metrics}
        {ops}
      </div>
    );
  }

  const pinned: Section[] = pinnedSections(visible);
  const quick: Section[] = quickSections(visible);
  const groups: Array<{ name: string; items: Section[] }> = (consoleApi?._groupedSections?.() || [])
    .map((g: { name: string; items: Section[] }) => ({ ...g, items: g.items.filter((x) => x.key !== 'overview') }))
    .filter((g: { items: Section[] }) => g.items.length);
  const sentence = needsYouSentence(data, dash);
  const needs = (stuck.length + orphans.length + (dash?.moderation.open || 0)) > 0;
  const queue = dash?.moderation.queue || [];
  const shipped = dash?.shipped || [];

  return (
    <div id="admin-home" className="space-y-8 pb-4">
      <header className="adm-hero flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className={AdminUI.pageTitle}>Admin home</h1>
          <p id="admin-home-status" className={`mt-1 text-sm ${needs ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-zinc-600 dark:text-zinc-400'}`}>
            {sentence || 'Checking what needs you…'}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-700 dark:text-zinc-300">
          <span>Period</span>
          <select id="admin-dash-period" className={`${AdminUI.select} w-auto min-h-[40px]`} value={days}
            onChange={(e) => setDays(Number(e.target.value))}>
            {DASHBOARD_PERIODS.map((d) => <option key={d} value={d}>{`Last ${d} days`}</option>)}
          </select>
        </label>
      </header>
      {failed}
      {metrics}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {attentionCard}
        <section aria-labelledby="admin-dash-quick-title" className={`${AdminUI.card} p-4`}>
          <h2 id="admin-dash-quick-title" className={AdminUI.cardTitle}>Quick actions</h2>
          <div id="admin-dash-quick" className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2">
            {quick.map((x) => (
              <button key={x.key} type="button" data-admin-section={x.key} onClick={go(x.key)}
                className={`${AdminUI.btn.outline} min-h-[44px] justify-start`}>
                <span aria-hidden="true" className="shrink-0" dangerouslySetInnerHTML={{ __html: consoleApi?.NAV_ICONS?.[x.key] || '' }} />
                <span className="min-w-0 truncate">{x.label}</span>
              </button>
            ))}
          </div>
        </section>
        <section aria-labelledby="admin-dash-queue-title" className={`${AdminUI.card} p-4`}>
          <div className={AdminUI.cardHeader}>
            <h2 id="admin-dash-queue-title" className={AdminUI.cardTitle}>
              Moderation queue
              {dash && dash.moderation.open ? <span className={`${AdminUI.badge.warn} ms-2 align-middle`}>{`${count(dash.moderation.open)} open`}</span> : null}
            </h2>
            {canOpen('reports') ? <button type="button" className={`${AdminUI.btn.link} text-sm`} data-admin-section="reports" onClick={go('reports')}>View all</button> : null}
          </div>
          {!dash && !dashFailed ? <p className={AdminUI.loading}>Loading…</p> : null}
          {dashFailed ? <p className={AdminUI.muted}>Not loaded.</p> : null}
          {dash && !queue.length ? <p id="admin-dash-queue-empty" className={AdminUI.muted}>No open cases. Reports people send appear here.</p> : null}
          {queue.length ? (
            <ul id="admin-dash-queue">
              {queue.map((row) => (
                <li key={row.id} className={AdminUI.listRow}>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.label}</div>
                    <div className={MUTED_SM}>
                      {[targetWords(row.targetType), reasonWords(row.reason), row.reports === 1 ? '1 report' : `${row.reports} reports`, agoWords(row.updatedAt)]
                        .filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <span className={row.status === 'new' ? AdminUI.badge.warn : AdminUI.badge.default}>{row.status === 'new' ? 'New' : 'In review'}</span>
                  {canOpen('reports') ? <button type="button" className={AdminUI.btn.primarySm} onClick={go('reports')}>Review</button> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
        <section aria-labelledby="admin-dash-shipped-title" className={`${AdminUI.card} p-4`}>
          <div className={AdminUI.cardHeader}>
            <h2 id="admin-dash-shipped-title" className={AdminUI.cardTitle}>Recently gone live</h2>
          </div>
          {!dash && !dashFailed ? <p className={AdminUI.loading}>Loading…</p> : null}
          {dashFailed ? <p className={AdminUI.muted}>Not loaded.</p> : null}
          {dash && !shipped.length ? <p id="admin-dash-shipped-empty" className={AdminUI.muted}>No change has gone live yet.</p> : null}
          {shipped.length ? (
            <ul id="admin-dash-shipped-list">
              {shipped.map((row) => (
                <li key={row.id} className={AdminUI.listRow}>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.title || `Change ${row.id}`}</div>
                    <div className={MUTED_SM}>{`${row.appName} · ${agoWords(row.mergedAt)}`}</div>
                  </div>
                  <span className={AdminUI.badge.success}>Live</span>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
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
