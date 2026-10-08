'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

// The shared admin class-string registry. Same explicit import as the other
// converted sections (see admin-status.tsx).
import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { INCIDENT_KIND, INCIDENT_OUTCOME } from './admin-homeroom-bot-health';

// Unexpected errors — the Operations section that lists the errors the
// platform is designed never to have (issue #4296). The only kind recorded
// today is a Homeroom bot build interrupted by a deploy or a lost worker
// (services/platform-incidents.js); the bot's Rollout health panel keeps
// its own collapsed list of the same rows and this section gathers them
// with room to grow.
//
// A reading screen: no primary action. The filters, the refresh button and
// the links to the health signals that already exist elsewhere are the only
// controls, and the screen never polls on its own — it reads when opened
// and when refresh is pressed.
//
// The word maps are imported from admin-homeroom-bot-health so the two
// screens say exactly the same words ("Build interrupted", "carried on from
// its plan") instead of copies that can drift.

const KIND_LABELS: Record<string, string> = { ...INCIDENT_KIND };
const OUTCOME_LABELS: Record<string, string> = { ...INCIDENT_OUTCOME };

const RANGES = [7, 14, 30];
const DEFAULT_RANGE = 30;
// The service slices `why` here; the log lists at most this many.
const LIMIT = 200;

interface Incident {
  at: string;
  kind: string;
  app: string | null;
  sessionId: number | null;
  runId: number | null;
  issueNumber: number | null;
  why: string | null;
  outcome: string | null;
}

interface IncidentsPayload {
  days: number;
  kind: string | null;
  total: number;
  items: Incident[];
  byKindByDay: Record<string, Record<string, number>>;
  kinds: string[];
}

// Milliseconds → the UTC day key the counts map is keyed by ('YYYY-MM-DD').
function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The last `n` UTC days, oldest first, as { key, label }.
function lastUtcDays(n: number): { key: string; label: string }[] {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: { key: string; label: string }[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const ms = todayUtc - i * 86400000;
    out.push({
      key: utcDayKey(ms),
      label: new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    });
  }
  return out;
}

function whenLine(at: string): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function CountsTable({ data }: { data: IncidentsPayload }) {
  const days = lastUtcDays(7);
  const kinds = Object.keys(data.byKindByDay).sort();
  return (
    <div className={AdminUI.card}>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Kind</th>
              {days.map((d) => <th key={d.key} className={AdminUI.th}>{d.label}</th>)}
              <th className={AdminUI.th}>Last {data.days} days</th>
            </tr>
          </thead>
          <tbody>
            {kinds.length === 0 ? (
              <tr>
                <td className={AdminUI.td} colSpan={days.length + 2}>
                  <span className={AdminUI.muted}>Nothing logged in this range.</span>
                </td>
              </tr>
            ) : kinds.map((kind) => {
              const perDay = data.byKindByDay[kind] || {};
              const total = Object.values(perDay).reduce((a, b) => a + (Number(b) || 0), 0);
              return (
                <tr key={kind} className={AdminUI.trHover}>
                  <td className={AdminUI.td}>{KIND_LABELS[kind] || kind}</td>
                  {days.map((d) => (
                    // A quiet day shows an empty cell, not a zero.
                    <td key={d.key} className={`${AdminUI.td} mono text-zinc-500 dark:text-zinc-400`}>
                      {perDay[d.key] ? perDay[d.key] : ''}
                    </td>
                  ))}
                  <td className={AdminUI.td}>{total || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function LogTable({ data }: { data: IncidentsPayload }) {
  return (
    <div className={AdminUI.card}>
      <div className={AdminUI.tableWrap}>
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>When</th>
              <th className={AdminUI.th}>Kind</th>
              <th className={AdminUI.th}>App</th>
              <th className={AdminUI.th}>What happened</th>
              <th className={AdminUI.th}>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((it, i) => {
              const name = it.app
                ? `${it.app}${it.issueNumber != null ? ` #${it.issueNumber}` : ''}`
                : '';
              const happened = [
                it.why || '',
                it.runId != null ? `run ${it.runId}` : '',
              ].filter(Boolean).join(' · ');
              return (
                <tr key={i} className={AdminUI.trHover}>
                  <td className={`${AdminUI.td} whitespace-nowrap text-zinc-500 dark:text-zinc-400`}>{whenLine(it.at)}</td>
                  <td className={AdminUI.td}>{KIND_LABELS[it.kind] || it.kind}</td>
                  <td className={AdminUI.td}>
                    {it.app && it.sessionId
                      ? <a className={AdminUI.btn.link} href={`#app/${it.app}/dev/proposals/${it.sessionId}`}>{name}</a>
                      : <span>{name}</span>}
                  </td>
                  <td className={`${AdminUI.td} text-zinc-600 dark:text-zinc-400`}>{happened}</td>
                  <td className={`${AdminUI.td} text-zinc-600 dark:text-zinc-400`}>
                    {it.outcome ? (OUTCOME_LABELS[it.outcome] || it.outcome) : ''}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The health signals that already exist elsewhere, summarised not
// duplicated. Each switches the console to that section, the cross-section
// jump admin-status.tsx draws (data-admin-section + setSection).
function OtherSignals() {
  const go = (key: string) => {
    const c = (window as any).AdminConsole;
    if (c?.setSection) c.setSection(key);
  };
  const links: { key: string; label: string; line: string }[] = [
    { key: 'status', label: 'Health & status', line: 'deploy failures, prod missing, capacity' },
    { key: 'homeroom-bot', label: 'Rollout health', line: "the Homeroom bot's builds and DM answers" },
    { key: 'merges', label: 'Merge debug', line: 'merges and stuck releases' },
  ];
  return (
    <div className={`${AdminUI.card} p-4 text-sm space-y-2`}>
      {links.map((l) => (
        <div key={l.key} className="flex items-center gap-3 flex-wrap">
          <button type="button" data-admin-section={l.key}
            className="text-xs text-violet-700 dark:text-violet-400 hover:text-violet-700 dark:hover:text-violet-300"
            onClick={() => go(l.key)}>
            {`→ ${l.label}`}
          </button>
          <span className="text-zinc-500 dark:text-zinc-400">{l.line}</span>
        </div>
      ))}
    </div>
  );
}

const SECTION_H3 = 'text-sm font-semibold text-zinc-600 dark:text-zinc-400 uppercase tracking-wide';

function IncidentsSection() {
  const [range, setRange] = useState(DEFAULT_RANGE);
  const [kind, setKind] = useState('');
  const [data, setData] = useState<IncidentsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const alive = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    alive.current = true;
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      p.set('days', String(range));
      if (kind) p.set('kind', kind);
      const r = await fetch(`/api/admin/platform-incidents?${p.toString()}`, { headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
    } catch (err: any) {
      setError(err?.message || 'could not read the log');
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [range, kind]);

  useEffect(() => { load(); }, [load]);

  const kindOptions = data?.kinds || [];
  const empty = data && !error && data.items.length === 0;

  return (
    <div id="admin-incidents-root">
      <header className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <h2 className={AdminUI.cardTitle}>Unexpected errors</h2>
        <button type="button" className={AdminUI.btn.outline} onClick={() => load()}>Refresh</button>
      </header>

      <div className="flex items-center gap-3 mb-4 text-sm flex-wrap">
        <label className={AdminUI.label}>
          Kind{' '}
          <select
            className={AdminUI.select}
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All kinds</option>
            {kindOptions.map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k] || k}</option>
            ))}
          </select>
        </label>
        <label className={AdminUI.label}>
          Time range{' '}
          <select
            className={AdminUI.select}
            value={range}
            onChange={(e) => setRange(Number(e.target.value) || DEFAULT_RANGE)}
          >
            {RANGES.map((d) => <option key={d} value={d}>Last {d} days</option>)}
          </select>
        </label>
      </div>

      {loading ? <div className={AdminUI.loading}>Reading the log…</div> : null}

      {!loading && error ? (
        <div className={`${AdminUI.card} p-4 text-sm`}>
          <p className="text-zinc-600 dark:text-zinc-400">Could not read the log ({error}). Press Refresh to try again.</p>
        </div>
      ) : null}

      {!loading && !error && empty ? (
        <div className={`${AdminUI.card} p-4 text-sm`}>
          <p className={AdminUI.muted}>No unexpected errors in the last {range} days.</p>
        </div>
      ) : null}

      {!loading && !error && data && !empty ? (
        <>
          <section className="mb-6">
            <h3 className={`${SECTION_H3} mb-2`}>Counts per kind per day</h3>
            <CountsTable data={data} />
          </section>
          <section className="mb-6">
            <h3 className={`${SECTION_H3} mb-2`}>The log</h3>
            <LogTable data={data} />
            {data.total > data.items.length ? (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                Showing the latest {data.items.length} of {data.total}.
              </p>
            ) : null}
          </section>
        </>
      ) : null}

      {!loading && !error ? (
        <section>
          <h3 className={`${SECTION_H3} mb-2`}>Other signals</h3>
          <OtherSignals />
        </section>
      ) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminIncidents = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <IncidentsSection />);
  },

  // Called by AdminConsole before it swaps this section out. The screen
  // never polls, so the portal unmount is all there is to do — but the seam
  // requires destroy() on every module, so it is here.
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