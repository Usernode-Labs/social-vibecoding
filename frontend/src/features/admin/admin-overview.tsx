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
interface AnalyticsData { users?: { total?: number }; appsTotal?: number; prs?: { promoted_all_time?: number }; wau?: number }
interface ModerationCase { id: number; target_type: string; target_label?: string; report_count: number; reasons?: string[]; created_at: string }
interface RecentUser { id: number; username: string; is_admin: boolean; created_at: string }
interface RecentApp { slug: string; name: string; creator?: string | null; users?: number; members?: number; status?: string; lastActiveAt?: string | null }

const TILE = 'rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3';
const TILE_LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const GROUP_LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1';
const ROW = 'flex flex-wrap items-center justify-between gap-x-3 gap-y-1 p-2 rounded bg-zinc-100 dark:bg-zinc-800';
const MUTED_SM = 'text-xs text-zinc-500 dark:text-zinc-400';

function OverviewSection({ compact }: { compact?: boolean }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [cases, setCases] = useState<ModerationCase[] | null>(null);
  const [users, setUsers] = useState<RecentUser[] | null>(null);
  const [apps, setApps] = useState<RecentApp[] | null>(null);
  const [growth, setGrowth] = useState<Array<{ wk: string; new_users: number }> | null>(null);
  const [caseCount, setCaseCount] = useState<number | null>(null);
  const [caseOverflow, setCaseOverflow] = useState(false);
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
  useEffect(() => {
    let live = true;
    Promise.all([
      (window as any).AdminConsole.fetchJson('/api/admin/analytics/overview'),
      (window as any).AdminConsole.fetchJson('/api/admin/moderation?status=new'),
      (window as any).AdminConsole.fetchJson('/api/admin/users'),
      (window as any).AdminConsole.fetchJson('/api/admin/apps-usage?days=30'),
      (window as any).AdminConsole.fetchJson('/api/admin/analytics/growth'),
    ]).then(([a, m, u, c, g]) => {
      if (!live) return;
      if (a?.data) setAnalytics(a.data);
      if (m?.data?.cases) setCases(m.data.cases.slice(0, 3));
      if (Array.isArray(m?.data?.cases)) { setCaseCount(m.data.next ? 50 : m.data.cases.length); setCaseOverflow(!!m.data.next); }
      if (Array.isArray(u?.data)) setUsers(u.data.slice(-3).reverse());
      if (Array.isArray(c?.data?.apps)) setApps(c.data.apps.slice().sort((left: RecentApp, right: RecentApp) =>
        Date.parse(right.lastActiveAt || '') - Date.parse(left.lastActiveAt || '')).slice(0, 3));
      if (Array.isArray(g?.data?.weeks)) setGrowth(g.data.weeks.slice(-8));
      const count = m?.data?.cases?.length || 0;
      const badge = document.querySelector<HTMLElement>('[data-admin-moderation-count]');
      if (badge) { badge.textContent = String(count); badge.hidden = count === 0; }
    }).catch(() => { if (live) setCases([]); });
    return () => { live = false; };
  }, []);

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

  const shortCuts = [
    ['overview', 'Overview'], ['reports', 'Moderation'], ['users', 'Users'],
    ['apps', 'Content'], ['analytics', 'Analytics'],
  ];
  const moderation = <section className="admin-dashboard-panel admin-moderation-panel">
    <div className="admin-dashboard-section-head"><h2>Moderation queue</h2><button type="button" data-admin-section="reports" onClick={() => (window as any).AdminConsole?.goTo?.('reports')}>View all →</button></div>
    {cases === null ? <p className={AdminUI.loading}>Loading reports…</p> : cases.length ? <div className="admin-queue-rows">
      {cases.map((item) => <button type="button" className="admin-queue-row" key={item.id} onClick={() => { location.hash = `#admin/reports/${item.id}`; }}>
        <span className="admin-queue-mark">{item.target_type === 'user' ? '♙' : item.target_type === 'app' ? '◇' : '▱'}</span>
        <span className="admin-queue-copy"><strong>{item.target_label || `${item.target_type.replace('_', ' ')} report`}</strong><small>{(item.reasons || []).join(', ').replaceAll('_', ' ') || 'Needs review'} · {item.report_count} {item.report_count === 1 ? 'report' : 'reports'}</small></span>
        <span className="admin-queue-age">{new Date(item.created_at).toLocaleDateString()}</span><span className="admin-queue-action">Review</span>
      </button>)}
    </div> : <p className="admin-dashboard-muted">No new reports to review.</p>}
  </section>;
  const chartValues = (growth || []).map((item) => Number(item.new_users) || 0);
  const chartMax = Math.max(1, ...chartValues);
  const chartPoints = chartValues.map((value, index) => `${chartValues.length < 2 ? 0 : index * 100 / (chartValues.length - 1)},${36 - (value / chartMax) * 31}`).join(' ');
  const recentTables = <div className="admin-records-grid">
    <section className="admin-dashboard-panel"><div className="admin-dashboard-section-head"><div><h2>Users</h2><p>Recent community members</p></div><button type="button" onClick={() => (window as any).AdminConsole?.goTo?.('users')}>View all →</button></div>
      <div className="admin-record-table"><div className="admin-record-head"><span>User</span><span>Joined</span><span>Role</span></div>
        {users === null ? <p className={AdminUI.loading}>Loading users…</p> : users.length ? users.map((u) => <div className="admin-record-row" key={u.id}><span className="admin-record-person"><i>{u.username.slice(0, 1).toUpperCase()}</i><b>@{u.username}</b></span><span>{new Date(u.created_at).toLocaleDateString()}</span><span><em className={u.is_admin ? 'admin-role-admin' : 'admin-role-member'}>{u.is_admin ? 'Admin' : 'Member'}</em></span></div>) : <p className="admin-dashboard-muted">No users to show.</p>}
      </div>
    </section>
    <section className="admin-dashboard-panel"><div className="admin-dashboard-section-head"><div><h2>Content</h2><p>Recently active projects</p></div><button type="button" onClick={() => (window as any).AdminConsole?.goTo?.('apps')}>View all →</button></div>
      <div className="admin-record-table"><div className="admin-record-head"><span>Project</span><span>Creator</span><span>Status</span></div>
        {apps === null ? <p className={AdminUI.loading}>Loading projects…</p> : apps.length ? apps.map((app) => <div className="admin-record-row" key={app.slug}><span className="admin-record-person"><i>◇</i><b>{app.name}</b></span><span>{app.creator ? `@${app.creator}` : '—'}</span><span><em className="admin-role-published">{app.status || 'Active'}</em></span></div>) : <p className="admin-dashboard-muted">No projects to show.</p>}
      </div>
    </section>
  </div>;
  const dashboard = <div id="admin-dashboard">
    <header className="admin-dashboard-heading"><div><h1>Admin Dashboard</h1><p>Manage users, content, and community health on Homeroom.</p></div>
      <label className="admin-dashboard-period">◷ <select aria-label="Analytics period" defaultValue="30"><option value="30">Last 30 days</option><option value="7">Last 7 days</option></select></label>
    </header>
    <nav className="admin-mobile-shortcuts" aria-label="Admin areas">{shortCuts.map(([key, label]) => <button type="button" key={key} data-admin-section={key} onClick={() => (window as any).AdminConsole?.goTo?.(key)} aria-current={key === 'overview' ? 'page' : undefined}>{label}</button>)}</nav>
    <section className="admin-metric-grid" aria-label="Admin overview">
      {[
        ['Users', analytics?.users?.total, 'users', 'sky'], ['Projects', analytics?.appsTotal, 'apps', 'green'],
        ['Cases to review', caseCount, 'reports', 'yellow'], ['Active this week', analytics?.wau, 'analytics', 'sky'],
      ].map(([label, value, key, tone]) => <button type="button" className={`admin-metric-card ${tone}`} data-admin-section={key} onClick={() => (window as any).AdminConsole?.goTo?.(key)} key={label as string}>
        <span className="admin-metric-icon" aria-hidden="true">{label === 'Users' ? '♧' : label === 'Projects' ? '◇' : label === 'New reports' ? '◯' : '⌁'}</span>
        <span><strong>{value == null ? '—' : Number(value).toLocaleString()}</strong><small>{label}</small></span>
      </button>)}
    </section>
    <div className="admin-dashboard-columns">{moderation}<section className="admin-dashboard-panel admin-health-panel"><div className="admin-dashboard-section-head"><h2>Community analytics</h2><button type="button" data-admin-section="analytics" onClick={() => (window as any).AdminConsole?.goTo?.('analytics')}>View details →</button></div>
      <div className="admin-analytics-chart" role="img" aria-label="New users by week for the last eight weeks"><svg viewBox="0 0 100 40" preserveAspectRatio="none"><polygon points={`0,40 ${chartPoints} 100,40`} /><polyline points={chartPoints} /></svg><div><span>8 weeks ago</span><span>This week</span></div></div>
      <div className="admin-health-stat"><span>Weekly active users</span><strong>{analytics?.wau == null ? '—' : Number(analytics.wau).toLocaleString()}</strong></div>
      <button type="button" className="admin-health-refresh" onClick={load}>Refresh overview</button>
    </section></div>
    {recentTables}
    <section className="admin-quick-actions"><h2>Quick actions</h2><div><button type="button" data-admin-section="reports" onClick={() => (window as any).AdminConsole?.goTo?.('reports')}>⚑ <span>Review queue{caseCount ? ` (${caseCount}${caseOverflow ? '+' : ''})` : ''}</span>›</button><button type="button" data-admin-section="users" onClick={() => (window as any).AdminConsole?.goTo?.('users')}>♧ <span>Manage users</span>›</button><button type="button" data-admin-section="apps" onClick={() => (window as any).AdminConsole?.goTo?.('apps')}>◇ <span>Manage content</span>›</button><button type="button" data-admin-section="settings" onClick={() => (window as any).AdminConsole?.goTo?.('settings')}>⚙ <span>Admin settings</span>›</button></div></section>
  </div>;

  if (compact) return <div className="admin-mobile-dashboard">{dashboard}</div>;

  const needs = (stuck.length + orphans.length) > 0;

  return (
    <div id="admin-home" className="space-y-10 pb-4">
      <p id="admin-home-status" className={`admin-dashboard-needs ${needs ? 'is-needs' : ''}`} hidden />
      <div hidden>{ops}</div>
      {dashboard}
    </div>
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
