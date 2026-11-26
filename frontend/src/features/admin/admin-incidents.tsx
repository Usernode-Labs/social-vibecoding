'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { BTN } from './topochain/tokens.ts';
import {
  Badge, Figures, List, ScreenHeader, Segmented, Select, TABLE, TabPanel, Tabs, Toolbar,
} from './topochain/ui.tsx';
import type { Column, Figure } from './topochain/ui.tsx';
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
//
// Drawn from the shared admin kit (26 Nov 2026), so this page's header,
// figures, filters, tabs and table are the ones every other page has. The
// events are the first tab, because they are what a person comes to read;
// the counts per day are the second.

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

// `short` is the word on the toggle; `label` is the full wording, which its
// tooltip and the summary line carry.
const RANGES: { days: number; label: string; short: string }[] = [
  { days: 1, label: 'Last 24 hours', short: '24 hours' },
  { days: 7, label: 'Last 7 days', short: '7 days' },
  { days: 30, label: 'Last 30 days', short: '30 days' },
];

const TABS_ID = 'admin-incidents-tabs';
type IncidentsTab = 'events' | 'days';

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
  if (i.sessionId != null) return { href: `#app/${slug}/dev/proposals/${i.sessionId}`, label: `Session ${i.sessionId}` };
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

// One event, one row. The row's kind and outcome stay addressable on the
// first cell, as they were on the list item.
const INCIDENT_COLUMNS: Column<IncidentRow>[] = [
  {
    label: 'Kind',
    primary: true,
    cell: (i) => (
      <span data-kind={i.kind} data-outcome={i.outcome || ''}>
        <Badge tone="amber" label={kindLabel(i.kind)} />
      </span>
    ),
  },
  {
    label: 'What happened',
    tdClass: 'break-words',
    cell: (i) => i.why || 'No detail recorded.',
  },
  {
    label: 'App',
    cell: (i) => (i.app ? <span className="font-mono text-xs">{i.app}</span> : 'No app'),
  },
  {
    label: 'Where',
    cell: (i) => {
      const link = incidentLink(i);
      if (!link && i.runId == null) return '';
      return (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {link ? <a className={AdminUI.btn.link} href={link.href}>{link.label}</a> : null}
          {i.runId != null ? <span>{`Bot run ${i.runId}`}</span> : null}
        </span>
      );
    },
  },
  {
    label: 'Outcome',
    cell: (i) => {
      const outcome = outcomeLabel(i.outcome);
      return outcome ? `Outcome: ${outcome}` : '';
    },
  },
  {
    label: 'When',
    tdClass: 'whitespace-nowrap tabular-nums text-zinc-500 dark:text-zinc-400',
    cell: (i) => when(i.at),
  },
];

// A pivot (a column per kind), which `List` cannot draw, so it is written by
// hand with the shared table classes.
function DailyCounts({ daily }: { daily: IncidentsPayload['daily'] }) {
  const { kinds, rows } = dailyTable(daily);
  if (!rows.length) return null;
  return (
    <div className={TABLE.wrap}>
      <table className={TABLE.table} id="admin-incidents-daily">
        <thead className={TABLE.thead}>
          <tr>
            <th className={TABLE.th}>Day (UTC)</th>
            {kinds.map((k) => <th key={k} className={TABLE.th}>{kindLabel(k)}</th>)}
            <th className={TABLE.th}>Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day} className={TABLE.tr} data-day={r.day}>
              <td className={TABLE.td}>{dayLabel(r.day)}</td>
              {kinds.map((k) => <td key={k} className={`${TABLE.td} tabular-nums`}>{r.counts[k] || 0}</td>)}
              <td className={`${TABLE.td} tabular-nums font-semibold`}>{r.total}</td>
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
  const [tab, setTab] = useState<IncidentsTab>('events');
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

  // Counts this read already carries: the total, then the kinds that
  // happened most. A kind's figure is a door to its rows.
  const figures: Figure[] = [
    { key: 'total', label: `Unexpected events, ${range}`, value: data ? total.toLocaleString() : null, tone: 'yellow' },
    ...[...kinds].sort((a, b) => b.n - a.n).slice(0, 3).map((k): Figure => ({
      key: `kind-${k.kind}`,
      label: kindLabel(k.kind),
      value: k.n.toLocaleString(),
      tone: 'sky',
      title: `Show only ${kindLabel(k.kind)}`,
      onClick: () => { setKind(k.kind); setTab('events'); },
    })),
  ];

  return (
    <div id="admin-incidents">
      <ScreenHeader
        title="Unexpected events"
        subtitle="Things the platform is designed never to do, such as a Homeroom bot build cut short by a deploy or a lost worker. Each one is logged here when it happens."
        actions={(
          <button id="admin-incidents-refresh" type="button" className={BTN.secondarySm} onClick={() => load()}>
            Refresh
          </button>
        )}
      />
      <p className={`${AdminUI.muted} mb-2`} id="admin-incidents-alerts">
        {alerts
          ? `Full admins get a digest at ${String(alerts.digestHourUtc).padStart(2, '0')}:00 UTC of the day before, only when there was something, and an alert straight away when one kind happens ${alerts.hourlyThreshold} times within an hour (at most once an hour per kind).`
          : ''}
      </p>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" id="admin-incidents-links">
        <span className={AdminUI.muted}>Other health signals:</span>
        <a className={AdminUI.btn.link} href="#admin/status">Health &amp; status</a>
        <a className={AdminUI.btn.link} href="#admin/homeroom-bot">Rollout health</a>
      </div>

      <Figures id="admin-incidents-figures" items={figures} />

      {/* The filters narrow both tabs, so their bar sits over the tabs. */}
      <Toolbar>
        <div className="min-w-[12rem] flex-1 sm:max-w-xs">
          <Select id="admin-incidents-kind" aria-label="Kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {kindChoices.map((k) => <option key={k.kind} value={k.kind}>{`${kindLabel(k.kind)} (${k.n})`}</option>)}
          </Select>
        </div>
        <div className="min-w-[12rem] flex-1 sm:max-w-xs">
          <Select id="admin-incidents-app" aria-label="App" value={app} onChange={(e) => setApp(e.target.value)}>
            <option value="">All apps</option>
            {appChoices.map((slug) => <option key={slug} value={slug}>{slug}</option>)}
          </Select>
        </div>
        <Segmented
          id="admin-incidents-days"
          label="Time range"
          value={String(days)}
          options={RANGES.map((r) => ({ value: String(r.days), label: r.short, title: r.label }))}
          onChange={(next) => setDays(Number(next))}
        />
      </Toolbar>

      <p className={`${AdminUI.muted} mb-3`} id="admin-incidents-summary" data-count={total}
        data-state={failed ? 'failed' : (data ? 'ready' : 'loading')}>
        {failed ? 'Could not read unexpected events. Try Refresh.'
          : !data ? <span className={AdminUI.loading}>Loading…</span>
            : total ? `${plural(total, 'unexpected event')} in the ${range}${total > items.length ? `, the latest ${items.length} listed` : ''}.`
              : `No unexpected events in the ${range}.`}
      </p>

      <Tabs<IncidentsTab>
        id={TABS_ID}
        label="Unexpected events"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'events', label: 'Events' },
          { key: 'days', label: 'By day' },
        ]}
      />
      <TabPanel tabsId={TABS_ID} tab="events" active={tab === 'events'}>
        {items.length ? (
          <div id="admin-incidents-list">
            <List items={items} columns={INCIDENT_COLUMNS} rowKey={(i, n) => `${i.at}-${n}`} />
          </div>
        ) : null}
      </TabPanel>
      <TabPanel tabsId={TABS_ID} tab="days" active={tab === 'days'}>
        {data ? <DailyCounts daily={data.daily} /> : null}
      </TabPanel>
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
