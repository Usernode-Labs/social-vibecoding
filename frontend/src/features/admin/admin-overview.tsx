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

const GROUP_LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400 mb-1';
const MUTED_SM = 'text-xs text-zinc-500 dark:text-zinc-400';

// A date nobody can read two ways: "11 Nov 2026", never 11/11/2026.
const DAY = { day: 'numeric', month: 'short', year: 'numeric' } as const;
function dayWords(at?: string | null): string {
  const t = Date.parse(at || '');
  return Number.isNaN(t) ? '—' : new Date(t).toLocaleDateString(undefined, DAY);
}

// The console's own icon for a section, the one its menu row wears. The
// markup is a literal from AdminConsole.NAV_ICONS, never data.
function SectionIcon({ of: key, className }: { of: string; className: string }) {
  const svg = typeof window === 'undefined' ? '' : ((window as any).AdminConsole?.NAV_ICONS?.[key] || '');
  return <span className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}

const goTo = (key: string) => (window as any).AdminConsole?.goTo?.(key);

// A project's status pill: green only while it runs, plain otherwise.
// The console's own badges, as every other section draws a
// status: the dashboard had pills of its own until 26 Nov 2026.
const STATUS_TONE: Record<string, string> = { running: AdminUI.badge.success, failed: AdminUI.badge.destructive, error: AdminUI.badge.destructive };

function OverviewSection({ compact }: { compact?: boolean }) {
  const [data, setData] = useState<OverviewData | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [cases, setCases] = useState<ModerationCase[] | null>(null);
  const [users, setUsers] = useState<RecentUser[] | null>(null);
  const [apps, setApps] = useState<RecentApp[] | null>(null);
  const [growth, setGrowth] = useState<Array<{ wk: string; new_users: number }> | null>(null);
  const [caseCount, setCaseCount] = useState<number | null>(null);
  const [caseOverflow, setCaseOverflow] = useState(false);
  // Which reads failed on the last load, by what they fill. A part that did
  // not load says so; it never stays on "Loading…" and never shows a zero.
  const [failed, setFailed] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // status.gather can take a moment; the tiles show em-dashes until it lands,
  // and only this section blocks — never the whole page.
  const load = useCallback(async () => {
    const fetchJson = (window as any).AdminConsole.fetchJson;
    setBusy(true);
    const [o, a, m, u, c, g] = await Promise.all([
      fetchJson('/api/admin/overview'),
      fetchJson('/api/admin/analytics/overview'),
      fetchJson('/api/admin/moderation?status=new'),
      fetchJson('/api/admin/users'),
      fetchJson('/api/admin/apps-usage?days=30'),
      fetchJson('/api/admin/analytics/growth'),
    ]);
    if (!alive.current) return;
    setBusy(false);
    const missing: string[] = [];
    if (o?.data && typeof o.data === 'object') setData(o.data); else missing.push('platform health');
    if (a?.data) setAnalytics(a.data); else missing.push('the figures');
    if (Array.isArray(m?.data?.cases)) {
      setCases(m.data.cases.slice(0, 3));
      setCaseCount(m.data.next ? 50 : m.data.cases.length);
      setCaseOverflow(!!m.data.next);
      const count = m.data.cases.length;
      const badge = document.querySelector<HTMLElement>('[data-admin-moderation-count]');
      if (badge) { badge.textContent = m.data.next ? `${count}+` : String(count); badge.hidden = count === 0; }
    } else { setCases((was) => was || []); missing.push('the moderation queue'); }
    if (Array.isArray(u?.data)) {
      setUsers(u.data.slice().sort((left: RecentUser, right: RecentUser) =>
        (Date.parse(right.created_at) || 0) - (Date.parse(left.created_at) || 0)).slice(0, 3));
    } else { setUsers((was) => was || []); missing.push('recent members'); }
    if (Array.isArray(c?.data?.apps)) {
      setApps(c.data.apps.slice().sort((left: RecentApp, right: RecentApp) =>
        (Date.parse(right.lastActiveAt || '') || 0) - (Date.parse(left.lastActiveAt || '') || 0)).slice(0, 3));
    } else { setApps((was) => was || []); missing.push('recent projects'); }
    if (Array.isArray(g?.data?.weeks)) setGrowth(g.data.weeks.slice(-8)); else missing.push('the weekly chart');
    setFailed(missing);
  }, []);

  useEffect(() => { load(); }, [load]);

  const stuck = data?.stuckApps || [];
  const orphans = data?.orphanWorkers || [];
  const llm = data?.llmToday || { totalSpendCents: 0, users: [] };
  const spenders = (llm.users || []).slice(0, 5);
  const anyDetail = stuck.length || orphans.length || spenders.length;

  // Platform health: apps wedged while being made, today's AI spend, and
  // workers whose session is gone. The ids are the ones declared checks read.
  const ops = (
    <section className="admin-dashboard-panel admin-ops-panel">
      <div className="admin-dashboard-section-head">
        <div><h2>Platform health</h2><p>Apps stuck while being made, today's AI spend, and workers left running.</p></div>
        <button id="admin-refresh-overview" type="button" onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      </div>
      <div className="admin-ops-tiles">
        <div className="admin-ops-tile">
          <small>Stuck apps</small>
          <strong id="admin-overview-stuck">{data ? stuck.length : '—'}</strong>
        </div>
        <div className="admin-ops-tile">
          <small>AI spend today</small>
          <strong id="admin-overview-llm">{data ? `$${(llm.totalSpendCents / 100).toFixed(2)}` : '—'}</strong>
        </div>
        <div className="admin-ops-tile">
          <small>Workers left running</small>
          <strong id="admin-overview-orphan">{data ? orphans.length : '—'}</strong>
        </div>
      </div>
      <div id="admin-overview-details" className="space-y-3 text-sm">
        {!data && busy ? <p className={AdminUI.loading}>Loading…</p> : null}
        {stuck.length ? (
          <div>
            <div className={GROUP_LABEL}>Stuck apps</div>
            <ul className="admin-ops-rows">
              {stuck.map((a) => (
                <li key={a.slug}>
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
            <div className={GROUP_LABEL}>Workers left running</div>
            <ul className="admin-ops-rows">
              {orphans.map((w) => (
                <li key={w.name}>
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
            <div className={GROUP_LABEL}>Top AI spenders today</div>
            <ul className="admin-ops-rows">
              {spenders.map((u) => (
                <li key={u.username}>
                  <span>{u.username}</span>
                  <span className="text-xs font-mono text-zinc-500 dark:text-zinc-400">{`$${(u.costCents / 100).toFixed(2)}`}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {data && !anyDetail ? (
          <p className="admin-dashboard-muted">All clear: no stuck apps, no workers left running, no AI spend recorded today.</p>
        ) : null}
      </div>
    </section>
  );

  const shortCuts = [
    ['overview', 'Dashboard'], ['reports', 'Moderation'], ['users', 'Users'],
    ['apps', 'Content'], ['analytics', 'Analytics'],
  ];
  const moderation = <section className="admin-dashboard-panel admin-moderation-panel">
    <div className="admin-dashboard-section-head"><h2>Moderation queue</h2><button type="button" data-admin-section="reports" onClick={() => goTo('reports')}>View all →</button></div>
    {cases === null ? <p className={AdminUI.loading}>Loading reports…</p> : cases.length ? <div className="admin-queue-rows">
      {cases.map((item) => <button type="button" className="admin-queue-row" key={item.id} onClick={() => { location.hash = `#admin/reports/${item.id}`; }}>
        <SectionIcon of={item.target_type === 'user' ? 'users' : item.target_type === 'app' ? 'apps' : 'reports'} className="admin-queue-mark" />
        <span className="admin-queue-copy"><strong>{item.target_label || `${item.target_type.replace('_', ' ')} report`}</strong><small>{(item.reasons || []).join(', ').replaceAll('_', ' ') || 'Needs review'} · {item.report_count} {item.report_count === 1 ? 'report' : 'reports'}</small></span>
        <span className="admin-queue-age">{dayWords(item.created_at)}</span><span className="admin-queue-action">Review</span>
      </button>)}
    </div> : <div className="admin-dashboard-empty"><SectionIcon of="status" className="admin-dashboard-empty-mark" /><p>{failed.includes('the moderation queue') ? 'The queue did not load.' : 'Nothing to review. New reports show up here.'}</p></div>}
  </section>;
  const chartValues = (growth || []).map((item) => Number(item.new_users) || 0);
  const chartMax = Math.max(1, ...chartValues);
  const chartPoints = chartValues.map((value, index) => `${chartValues.length < 2 ? 0 : index * 100 / (chartValues.length - 1)},${36 - (value / chartMax) * 31}`).join(' ');
  const chartTotal = chartValues.reduce((sum, value) => sum + value, 0);
  const recentTables = <div className="admin-records-grid">
    <section className="admin-dashboard-panel"><div className="admin-dashboard-section-head"><div><h2>Users</h2><p>Newest accounts</p></div><button type="button" onClick={() => goTo('users')}>View all →</button></div>
      <div className="admin-record-table"><div className="admin-record-head"><span>User</span><span>Joined</span><span>Role</span></div>
        {users === null ? <p className={AdminUI.loading}>Loading users…</p> : users.length ? users.map((u) => <div className="admin-record-row" key={u.id}><span className="admin-record-person"><i>{u.username.slice(0, 1).toUpperCase()}</i><b>@{u.username}</b></span><span>{dayWords(u.created_at)}</span><span><em className={u.is_admin ? AdminUI.badge.warn : AdminUI.badge.default}>{u.is_admin ? 'Admin' : 'Member'}</em></span></div>) : <p className="admin-dashboard-muted">{failed.includes('recent members') ? 'The list did not load.' : 'No accounts yet.'}</p>}
      </div>
    </section>
    <section className="admin-dashboard-panel"><div className="admin-dashboard-section-head"><div><h2>Content</h2><p>Recently active projects</p></div><button type="button" onClick={() => goTo('apps')}>View all →</button></div>
      <div className="admin-record-table"><div className="admin-record-head"><span>Project</span><span>Creator</span><span>Status</span></div>
        {apps === null ? <p className={AdminUI.loading}>Loading projects…</p> : apps.length ? apps.map((app) => <div className="admin-record-row" key={app.slug}><span className="admin-record-person"><SectionIcon of="apps" className="admin-record-mark" /><b>{app.name}</b></span><span>{app.creator ? `@${app.creator}` : '—'}</span><span><em className={STATUS_TONE[app.status || ''] || AdminUI.badge.default}>{app.status || 'unknown'}</em></span></div>) : <p className="admin-dashboard-muted">{failed.includes('recent projects') ? 'The list did not load.' : 'No projects yet.'}</p>}
      </div>
    </section>
  </div>;
  const metrics: Array<[string, number | null | undefined, string, string]> = [
    ['Users', analytics?.users?.total, 'users', 'sky'], ['Projects', analytics?.appsTotal, 'apps', 'green'],
    ['Cases to review', caseCount, 'reports', 'yellow'], ['Active this week', analytics?.wau, 'analytics', 'sky'],
  ];
  const dashboard = <div id="admin-dashboard">
    <header className="admin-dashboard-heading"><div><h1>Admin Dashboard</h1><p>Manage users, content, and community health on Homeroom.</p></div>
      <button type="button" className={`admin-dashboard-refresh ${AdminUI.btn.outline}`} onClick={load} disabled={busy}>{busy ? 'Refreshing…' : 'Refresh'}</button>
    </header>
    <nav className="admin-mobile-shortcuts" aria-label="Admin areas">{shortCuts.map(([key, label]) => <button type="button" key={key} data-admin-section={key} onClick={() => goTo(key)} aria-current={key === 'overview' ? 'page' : undefined}>{label}</button>)}</nav>
    {failed.length ? <p id="admin-dashboard-error" role="alert" className="admin-dashboard-alert">
      <span>{`Some of this page did not load: ${failed.join(', ')}. What is shown is what arrived.`}</span>
      <button type="button" onClick={load} disabled={busy}>Try again</button>
    </p> : null}
    <section className="admin-metric-grid" aria-label="Admin overview">
      {metrics.map(([label, value, key, tone]) => <button type="button" className={`admin-metric-card ${tone}`} data-admin-section={key} onClick={() => goTo(key)} key={label}>
        <SectionIcon of={key} className="admin-metric-icon" />
        <span><strong>{value == null ? '—' : `${Number(value).toLocaleString()}${key === 'reports' && caseOverflow ? '+' : ''}`}</strong><small>{label}</small></span>
      </button>)}
    </section>
    <div className="admin-dashboard-columns">{moderation}<section className="admin-dashboard-panel admin-health-panel"><div className="admin-dashboard-section-head"><div><h2>Community analytics</h2><p>New accounts each week, last eight weeks</p></div><button type="button" data-admin-section="analytics" onClick={() => goTo('analytics')}>View details →</button></div>
      {growth === null ? <p className="admin-dashboard-muted">{failed.includes('the weekly chart') ? 'The chart did not load.' : 'Loading the chart…'}</p> : <div className="admin-analytics-chart" role="img" aria-label={`New accounts by week for the last eight weeks: ${chartValues.join(', ')}`}><svg viewBox="0 0 100 40" preserveAspectRatio="none"><defs><linearGradient id="admin-chart-fade" x1="0" y1="0" x2="0" y2="1"><stop className="admin-chart-fade-top" offset="0" /><stop className="admin-chart-fade-end" offset="1" /></linearGradient></defs><polygon points={`0,40 ${chartPoints} 100,40`} /><polyline points={chartPoints} /></svg><div><span>8 weeks ago</span><span>This week</span></div></div>}
      <div className="admin-health-stat"><span>New accounts in eight weeks</span><strong>{growth === null ? '—' : chartTotal.toLocaleString()}</strong></div>
      <div className="admin-health-stat"><span>Weekly active users</span><strong>{analytics?.wau == null ? '—' : Number(analytics.wau).toLocaleString()}</strong></div>
    </section></div>
    {recentTables}
    {ops}
    <section className="admin-quick-actions"><h2>Quick actions</h2><div>
      {([['reports', `Review queue${caseCount ? ` (${caseCount}${caseOverflow ? '+' : ''})` : ''}`], ['users', 'Manage users'], ['apps', 'Manage content'], ['settings', 'Admin settings']] as Array<[string, string]>)
        .map(([key, label]) => <button type="button" key={key} data-admin-section={key} onClick={() => goTo(key)}><SectionIcon of={key} className="admin-quick-icon" /><span>{label}</span><i aria-hidden="true">›</i></button>)}
    </div></section>
  </div>;

  if (compact) return <div className="admin-mobile-dashboard">{dashboard}</div>;

  return (
    <div id="admin-home" className="pb-4">
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
