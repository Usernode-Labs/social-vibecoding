'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
// The kinds and outcomes said the way Rollout health already says them
// (the words the Unexpected events list under it uses), so the two surfaces
// cannot drift. Same island chunk, so nothing extra is downloaded.
import { INCIDENT_KIND, INCIDENT_OUTCOME } from './admin-homeroom-bot-health';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Unexpected errors (#admin/incidents, Operations): the errors the platform
// should never make, gathered in one reading screen. The rows are
// `platform_incident` events (services/platform-incidents.js) — today only
// a Homeroom bot build a restart or a lost worker cut short (#4210) —
// counted per kind per UTC day, filtered by kind and range, beside the two
// "right now" health signals the platform already stores elsewhere (release
// stalls on apps.release_stall, failed deploys on apps.status/'error').
// Read-only: the filters are the only controls, there is no primary action.
//
// ── React-owned, AdminUI recipes only ─────────────────────────────────
//
// Same shape as admin-staging-reap.tsx: the console hands the section its
// host, this module mounts a portal into it and tears it down on destroy(),
// and data loads in an effect (empty initial render — the markup the
// section ships). No polling: an admin reading an error log refreshes
// their own way.

const console_ = () => (window as any).AdminConsole;

const RANGES: { days: number; label: string }[] = [
  { days: 1, label: 'Last 24 hours' },
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
];

const rangeLabel = (days: number) => (RANGES.find((r) => r.days === days) || RANGES[1]).label;

// Local class recipes — complete literals, because Tailwind's extractor is
// a regex over this file's source (see the AdminUI note in admin-console.js).
const IncidentsUI = Object.freeze({
  cardGap: 'space-y-4',
  filters: 'flex flex-wrap gap-2 mb-4',
  filterField: 'w-auto min-w-40',
  subHead: 'text-sm font-medium text-zinc-700 dark:text-zinc-300 mb-2',
  cellMuted: 'text-xs text-zinc-500 dark:text-zinc-400',
  projectLink: 'font-medium ' + AdminUI.btn.link,
  tableNums: 'tabular-nums',
  overflow: 'text-sm ' + AdminUI.muted + ' mt-2',
});

interface KindCount { kind: string; label: string; n: number }

export interface IncidentItem {
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
  limit: number;
  kinds: KindCount[];
  daily: { day: string; counts: Record<string, number>; total: number }[];
  total: number;
  items: IncidentItem[];
  signals: {
    releaseStalls: { slug: string; since: string | null }[];
    failedDeploys: { slug: string; stage: string | null; at: string | null }[];
  };
}

/** "2026-10-07" as a person reads a day: "Oct 7". Pure. */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** An incident's "when": like Rollout health's lines say it. Pure. */
export function whenLabel(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? ''
    : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The project cell: "page-turners #41", linking to the build's session. */
function Project({ item }: { item: IncidentItem }) {
  if (!item.app) return <span className={IncidentsUI.cellMuted}>–</span>;
  const name = `${item.app}${item.issueNumber != null ? ` #${item.issueNumber}` : ''}`;
  // An in-app hash link to the build's session — a platform route, never an
  // API-supplied URL.
  const href = item.sessionId != null
    ? `#app/${encodeURIComponent(item.app)}/dev/sessions/${item.sessionId}`
    : null;
  return (
    <span>
      {href
        ? <a className={IncidentsUI.projectLink} href={href}>{name}</a>
        : name}
      {item.runId != null
        ? <span className={IncidentsUI.cellMuted}> {item.sessionId != null ? <br /> : null}Session · run {item.runId}</span>
        : null}
    </span>
  );
}

function DailyTable({ payload }: { payload: IncidentsPayload }) {
  const kinds = payload.kinds.length ? payload.kinds : [];
  return (
    <div>
      <h3 className={IncidentsUI.subHead}>By day</h3>
      <div className={`${AdminUI.tableWrap} mb-4`} id="admin-incidents-daily">
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Day</th>
              {kinds.map((k) => <th key={k.kind} className={AdminUI.th}>{k.label}</th>)}
              <th className={AdminUI.th}>Total</th>
            </tr>
          </thead>
          <tbody>
            {payload.daily.map((row) => (
              <tr key={row.day} className={AdminUI.trHover}>
                <td className={AdminUI.td}>{dayLabel(row.day)}</td>
                {kinds.map((k) => (
                  <td key={k.kind} className={`${AdminUI.td} ${IncidentsUI.tableNums}`}>
                    {row.counts[k.kind] || ''}
                  </td>
                ))}
                <td className={`${AdminUI.td} ${IncidentsUI.tableNums}`}>{row.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogTable({ payload }: { payload: IncidentsPayload }) {
  const items = payload.items || [];
  return (
    <div>
      <h3 className={IncidentsUI.subHead}>Log</h3>
      <div className={AdminUI.tableWrap} id="admin-incidents-log">
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>When</th>
              <th className={AdminUI.th}>Kind</th>
              <th className={AdminUI.th}>Project</th>
              <th className={AdminUI.th}>What happened</th>
              <th className={AdminUI.th}>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i, n) => (
              <tr key={`${i.at}-${n}`} className={AdminUI.trHover} data-kind={i.kind}>
                <td className={AdminUI.td}>{whenLabel(i.at)}</td>
                <td className={AdminUI.td}>{INCIDENT_KIND[i.kind] || i.kind}</td>
                <td className={AdminUI.td}><Project item={i} /></td>
                <td className={AdminUI.td}>{i.why || '–'}</td>
                <td className={AdminUI.td}>{i.outcome ? (INCIDENT_OUTCOME[i.outcome] || i.outcome) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {payload.total > items.length ? (
        <p className={IncidentsUI.overflow} id="admin-incidents-more">
          Showing the latest {items.length} of {payload.total}
        </p>
      ) : null}
    </div>
  );
}

/** The "right now" signals, summarized; the details stay where they live. */
function Signals({ payload }: { payload: IncidentsPayload }) {
  const stalls = payload.signals?.releaseStalls || [];
  const failed = payload.signals?.failedDeploys || [];
  const names = (list: { slug: string }[]) => list.map((s) => s.slug).join(', ');
  const goto = (key: string) => () => console_()?.setSection(key);
  return (
    <div className={`${AdminUI.card} p-4`} id="admin-incidents-signals">
      <div className={AdminUI.cardHeader}>
        <h3 className={AdminUI.cardTitle}>Other health signals</h3>
      </div>
      <ul className="text-sm space-y-2">
        <li>
          <button type="button" className={IncidentsUI.projectLink} onClick={goto('status')}>Health &amp; status</button>
          <span className={AdminUI.muted}> · workers, capacity, drift and recent events</span>
        </li>
        <li>
          <button type="button" className={IncidentsUI.projectLink} onClick={goto('homeroom-bot')}>Rollout health</button>
          <span className={AdminUI.muted}> · the bot's figures past their line, and its unexpected events</span>
        </li>
        <li data-signal="release-stalls">
          Stuck going live: <span className="font-medium">{stalls.length}</span>
          {stalls.length ? <span className={AdminUI.muted}> · {names(stalls)}</span> : null}
          {!stalls.length ? <span className={AdminUI.muted}>none right now</span> : null}
        </li>
        <li data-signal="failed-deploys">
          Failed to deploy: <span className="font-medium">{failed.length}</span>
          {failed.length ? <span className={AdminUI.muted}> · {names(failed)}</span> : null}
          {!failed.length ? <span className={AdminUI.muted}>none right now</span> : null}
        </li>
      </ul>
    </div>
  );
}

function IncidentsSection() {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [payload, setPayload] = useState<IncidentsPayload | null>(null);
  // The two filters, both server-truthed: the kind options and the range
  // clamp come back with the payload. Defaults: all kinds, last 7 days.
  const [kind, setKind] = useState('');
  const [days, setDays] = useState(7);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async (nextKind: string, nextDays: number) => {
    const params = new URLSearchParams();
    if (nextKind) params.set('kind', nextKind);
    params.set('days', String(nextDays));
    const { data } = await console_().fetchJson(`/api/admin/incidents?${params.toString()}`);
    if (!alive.current) return;
    if (!data || typeof data !== 'object') {
      setError(true);
      setLoaded(true);
      return;
    }
    setPayload(data as IncidentsPayload);
    setError(false);
    setLoaded(true);
  }, []);

  useEffect(() => { load(kind, days); }, [load, kind, days]);

  const kinds = payload?.kinds || [];
  const effDays = payload?.days ?? days;
  const effKind = payload?.kind ?? (kind || null);
  const effTotal = payload?.total ?? 0;
  const summary = loaded && !error
    ? `${effTotal} in the last ${rangeLabel(effDays).replace(/^Last /, '').toLowerCase()}`
      + `${effKind ? ` · ${INCIDENT_KIND[effKind] || effKind}` : ''}`
    : null;

  return (
    <div className={IncidentsUI.cardGap} id="admin-incidents-root">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Unexpected errors</h2>
          {summary ? <span className={AdminUI.cardDescription} id="admin-incidents-summary">{summary}</span> : null}
        </div>
        <div className={IncidentsUI.filters}>
          <select
            id="admin-incidents-kind"
            className={`${AdminUI.select} ${IncidentsUI.filterField}`}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            aria-label="Filter by kind"
          >
            <option value="">All kinds</option>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>{k.label}</option>
            ))}
          </select>
          <select
            id="admin-incidents-range"
            className={`${AdminUI.select} ${IncidentsUI.filterField}`}
            value={String(days)}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Filter by time range"
          >
            {RANGES.map((r) => <option key={r.days} value={String(r.days)}>{r.label}</option>)}
          </select>
        </div>
        {!loaded ? (
          <p className={AdminUI.loading}>Loading…</p>
        ) : error ? (
          <p className={AdminUI.muted} id="admin-incidents-error">Could not load unexpected errors.</p>
        ) : !payload || !payload.items.length ? (
          <p className={AdminUI.muted} id="admin-incidents-empty">
            No unexpected errors in the last {rangeLabel(effDays).replace(/^Last /, '').toLowerCase()}.
          </p>
        ) : (
          <>
            <DailyTable payload={payload} />
            <LogTable payload={payload} />
          </>
        )}
      </div>
      {loaded && !error && payload ? <Signals payload={payload} /> : null}
    </div>
  );
}

let host: Element | null = null;

const AdminIncidents = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <IncidentsSection />);
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