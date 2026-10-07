'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { INCIDENT_KIND, INCIDENT_OUTCOME } from './admin-homeroom-bot-health';

// Unexpected events (#admin/incidents, #4296): errors the platform is
// designed never to make, as services/platform-incidents.js records them
// (one `events` row each, event_type 'platform_incident'). PR #4283 began
// the log with the Homeroom bot's interrupted builds and listed the last
// week's under Rollout health; this is the whole log, filtered by kind, app
// and time range, with its counts per kind per day. The full admins also
// hear about it without opening it (services/platform-incident-alerts.js):
// a daily digest, and an alert when one kind piles up within an hour. Both
// figures come back with the read, so the line here says what is true.
//
// Read-only, so view-only admins see all of it. Health & status and the
// Homeroom bot's Rollout health are linked rather than repeated.
//
// Ids are what dapp.json's declared check and
// tests/admin-incidents-section.test.js select on.

const console_ = () => (window as any).AdminConsole;

export interface IncidentRow {
  at: string;
  kind: string;
  app: string | null;
  sessionId: number | null;
  runId: number | null;
  issueNumber: number | null;
  why: string | null;
  outcome: string | null;
}

export interface IncidentsPayload {
  days: number;
  kind: string | null;
  app: string | null;
  total: number;
  items: IncidentRow[];
  daily: { day: string; kind: string; n: number }[];
  kinds: { kind: string; n: number }[];
  apps: string[];
  alerts?: { hourlyThreshold: number; digestHourUtc: number };
}

const RANGES: { days: number; label: string }[] = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

const IncidentUI = Object.freeze({
  filters: 'grid gap-3 sm:grid-cols-3 mb-4',
  filterLabel: `${AdminUI.label} block mb-1`,
  links: 'flex flex-wrap items-center gap-x-4 gap-y-1 text-sm',
  row: 'rounded-xl bg-zinc-100 dark:bg-zinc-800 p-3',
  rowHead: 'flex flex-wrap items-center justify-between gap-2',
  rowWhen: 'text-xs text-zinc-500 dark:text-zinc-400 tabular-nums',
  rowWhat: 'text-sm text-zinc-900 dark:text-zinc-100 mt-1 break-words',
  rowWhere: 'flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-zinc-500 dark:text-zinc-400',
  count: 'tabular-nums',
});

/** What a kind is called on screen. Pure. */
export function kindLabel(kind: string): string {
  return INCIDENT_KIND[kind] || kind.replace(/_/g, ' ');
}

/** What became of an incident, in words. Pure. */
export function outcomeLabel(outcome: string | null): string {
  if (!outcome) return '';
  return INCIDENT_OUTCOME[outcome] || outcome.replace(/_/g, ' ');
}

/** The address an incident's link opens, and what it says; null for none. Pure. */
export function incidentLink(i: IncidentRow): { href: string; label: string } | null {
  if (!i.app) return null;
  const slug = encodeURIComponent(i.app);
  if (i.sessionId != null) return { href: `#app/${slug}/dev/sessions/${i.sessionId}`, label: `Session ${i.sessionId}` };
  if (i.issueNumber != null) return { href: `#app/${slug}/dev/issues/${i.issueNumber}`, label: `Request #${i.issueNumber}` };
  return null;
}

/**
 * The per-day table: one row per UTC day that had any, newest first, one
 * column per kind (most first), and the day's total. Pure.
 */
export function dailyTable(daily: IncidentsPayload['daily']) {
  const totals = new Map<string, number>();
  for (const d of daily) totals.set(d.kind, (totals.get(d.kind) || 0) + d.n);
  const kinds = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k]) => k);
  const byDay = new Map<string, Record<string, number>>();
  for (const d of daily) {
    const row = byDay.get(d.day) || {};
    row[d.kind] = (row[d.kind] || 0) + d.n;
    byDay.set(d.day, row);
  }
  const days = [...byDay.keys()].sort().reverse();
  return {
    kinds,
    rows: days.map((day) => {
      const counts = byDay.get(day) || {};
      return { day, counts, total: kinds.reduce((sum, k) => sum + (counts[k] || 0), 0) };
    }),
  };
}

function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function dayLabel(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : at.toLocaleDateString(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function IncidentItem({ incident }: { incident: IncidentRow }) {
  const link = incidentLink(incident);
  const outcome = outcomeLabel(incident.outcome);
  return (
    <li className={IncidentUI.row} data-kind={incident.kind} data-outcome={incident.outcome || ''}>
      <div className={IncidentUI.rowHead}>
        <span className={AdminUI.badge.warn}>{kindLabel(incident.kind)}</span>
        <span className={IncidentUI.rowWhen}>{when(incident.at)}</span>
      </div>
      <p className={IncidentUI.rowWhat}>{incident.why || 'No detail recorded.'}</p>
      <div className={IncidentUI.rowWhere}>
        {incident.app ? <span className="font-mono">{incident.app}</span> : <span>No app</span>}
        {link ? <a className={AdminUI.btn.link} href={link.href}>{link.label}</a> : null}
        {incident.runId != null ? <span>{`Bot run ${incident.runId}`}</span> : null}
        {outcome ? <span>{`Outcome: ${outcome}`}</span> : null}
      </div>
    </li>
  );
}

function DailyCounts({ daily }: { daily: IncidentsPayload['daily'] }) {
  const { kinds, rows } = dailyTable(daily);
  if (!rows.length) return null;
  return (
    <div className={AdminUI.tableWrap}>
      <table className={AdminUI.table} id="admin-incidents-daily">
        <thead className={AdminUI.thead}>
          <tr>
            <th className={AdminUI.th}>Day (UTC)</th>
            {kinds.map((k) => <th key={k} className={AdminUI.th}>{kindLabel(k)}</th>)}
            <th className={AdminUI.th}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day} className={AdminUI.trHover} data-day={r.day}>
              <td className={AdminUI.td}>{dayLabel(r.day)}</td>
              {kinds.map((k) => <td key={k} className={`${AdminUI.td} ${IncidentUI.count}`}>{r.counts[k] || 0}</td>)}
              <td className={`${AdminUI.td} ${IncidentUI.count} font-semibold`}>{r.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UnexpectedEventsSection() {
  const [days, setDays] = useState(7);
  const [kind, setKind] = useState('');
  const [app, setApp] = useState('');
  const [data, setData] = useState<IncidentsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const q = new URLSearchParams({ days: String(days) });
    if (kind) q.set('kind', kind);
    if (app) q.set('app', app);
    const { data: next } = await console_().fetchJson(`/api/admin/incidents?${q}`);
    // A later filter change, or leaving the section, wins.
    if (mine !== seq.current) return;
    if (!next || typeof next !== 'object' || !Array.isArray(next.items)) { setFailed(true); return; }
    setFailed(false);
    setData(next as IncidentsPayload);
  }, [days, kind, app]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { seq.current += 1; }, []);

  const range = RANGES.find((r) => r.days === days)?.label.toLowerCase() || `last ${days} days`;
  const items = data?.items || [];
  const total = data?.total || 0;
  const alerts = data?.alerts;
  // The filters' choices, plus whatever is picked, so a choice never vanishes
  // from its own menu when the window it came from moves.
  const kinds = data?.kinds || [];
  const kindChoices = kind && !kinds.some((k) => k.kind === kind) ? [...kinds, { kind, n: 0 }] : kinds;
  const apps = data?.apps || [];
  const appChoices = app && !apps.includes(app) ? [...apps, app] : apps;

  return (
    <div className="space-y-4" id="admin-incidents">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Unexpected events</h2>
          <button id="admin-incidents-refresh" type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => load()}>
            Refresh
          </button>
        </div>
        <p className={`${AdminUI.muted} mb-2`}>
          Things the platform is designed never to do, such as a Homeroom bot build cut short by a
          deploy or a lost worker. Each one is logged here when it happens.
        </p>
        <p className={`${AdminUI.muted} mb-3`} id="admin-incidents-alerts">
          {alerts
            ? `Full admins get a digest at ${String(alerts.digestHourUtc).padStart(2, '0')}:00 UTC of the day before, only when there was something, and an alert straight away when one kind happens ${alerts.hourlyThreshold} times within an hour (at most once an hour per kind).`
            : ''}
        </p>
        <div className={IncidentUI.links} id="admin-incidents-links">
          <span className={AdminUI.muted}>Other health signals:</span>
          <a className={AdminUI.btn.link} href="#admin/status">Health &amp; status</a>
          <a className={AdminUI.btn.link} href="#admin/homeroom-bot">Rollout health</a>
        </div>
      </div>

      <div className={`${AdminUI.card} p-4`}>
        <div className={IncidentUI.filters}>
          <div>
            <label className={IncidentUI.filterLabel} htmlFor="admin-incidents-kind">Kind</label>
            <select id="admin-incidents-kind" className={AdminUI.select} value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {kindChoices.map((k) => <option key={k.kind} value={k.kind}>{`${kindLabel(k.kind)} (${k.n})`}</option>)}
            </select>
          </div>
          <div>
            <label className={IncidentUI.filterLabel} htmlFor="admin-incidents-app">App</label>
            <select id="admin-incidents-app" className={AdminUI.select} value={app} onChange={(e) => setApp(e.target.value)}>
              <option value="">All apps</option>
              {appChoices.map((slug) => <option key={slug} value={slug}>{slug}</option>)}
            </select>
          </div>
          <div>
            <label className={IncidentUI.filterLabel} htmlFor="admin-incidents-days">Time range</label>
            <select id="admin-incidents-days" className={AdminUI.select} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {RANGES.map((r) => <option key={r.days} value={String(r.days)}>{r.label}</option>)}
            </select>
          </div>
        </div>

        <p className={`${AdminUI.muted} mb-3`} id="admin-incidents-summary" data-count={total}
          data-state={failed ? 'failed' : (data ? 'ready' : 'loading')}>
          {failed ? 'Could not read unexpected events. Try Refresh.'
            : !data ? <span className={AdminUI.loading}>Loading…</span>
              : total ? `${plural(total, 'unexpected event')} in the ${range}${total > items.length ? `, the latest ${items.length} listed` : ''}.`
                : `No unexpected events in the ${range}.`}
        </p>

        {data ? <DailyCounts daily={data.daily} /> : null}

        {items.length ? (
          <ul className="space-y-2 mt-4" id="admin-incidents-list">
            {items.map((i, n) => <IncidentItem key={`${i.at}-${n}`} incident={i} />)}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminIncidents = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <UnexpectedEventsSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminIncidents = AdminIncidents;

export { AdminIncidents };
