'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Submitted features (#admin/features) — the cross-app feature requests users
// filed from inside each app, ported from the retired admin-features.js page.
//
// Ranked by net votes, one card per request, with the app it belongs to and
// its GitHub issue number when one was opened. "Download CSV" pulls the ENTIRE
// filtered set rather than the visible page, by looping the offset parameter.
//
// PERMISSIONS: any admin, full or view-only. Read surface — the filter and
// the export are the only controls, and neither mutates.
//
// ── Fifth section out of the chassis (#1120 slice 20) ─────────────────
//
// Same move as the four before it. The CSV export stays a Blob on purpose and
// is the one place in the console where that is right: it is assembled in
// memory from paged JSON the client already holds, so there is nothing to
// stream and no ticket to issue. (The database export next door is the
// opposite case, and its header says why.)
//
// What changes is the summary line. It was one `<p>` written by
// `summary.textContent` from four different places — "Loading…", an access
// error, a read error, and two shapes of count — plus a fifth from the CSV
// path on failure. One piece of state with five values now, so the line
// cannot end up saying "Loading…" after a failure the way it could when each
// writer was responsible for clearing the last one's message.

const FEATURES_PAGE = 200;   // the endpoint caps limit at 200; also the CSV page size

const FEATURES_CSV_FIELDS = [
  'id', 'app_id', 'app_slug', 'app_name', 'title', 'description',
  'kind', 'status', 'github_issue_number', 'created_at',
  'created_by', 'created_by_username', 'up_count', 'down_count',
];

const FEATURES_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'bg-meadow-500/20 text-meadow-700 dark:text-meadow-200' },
  closed: { label: 'Closed', cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' },
  // 800/200 on the `bg-azure-500/20` wash, the same call admin-merges.tsx and
  // admin-db-export.tsx document for the identical wash: 700 composites to the
  // weakest ink in a set whose other two rows read at the status tier.
  completed: { label: 'Shipped', cls: 'bg-azure-500/20 text-azure-800 dark:text-azure-200' },
};

interface Feature {
  id: number;
  title: string;
  description?: string;
  status?: string;
  app_name?: string;
  app_slug?: string;
  created_by_username?: string;
  created_at?: string;
  github_issue_number?: number;
  up_count?: number;
  down_count?: number;
  [key: string]: any;
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function csvCell(v: any): string {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

function FeatureCard({ f, rank }: { f: Feature; rank: number }) {
  const b = (f.status && FEATURES_STATUS_BADGE[f.status])
    || { label: f.status || '—', cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' };
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 p-4">
      <div className="flex items-start gap-3">
        <div className="text-zinc-500 dark:text-zinc-300 font-mono text-sm pt-0.5 w-8 shrink-0">{`#${rank}`}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold">{f.title}</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${b.cls}`}>{b.label}</span>
          </div>
          {f.description ? (
            <div className="text-sm text-zinc-500 dark:text-zinc-300 mt-1 whitespace-pre-wrap break-words">{f.description}</div>
          ) : null}
          <div className="text-xs text-zinc-500 dark:text-zinc-300 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-azure-800 dark:text-azure-200">{f.app_name}</span>
            <span className="text-zinc-500 dark:text-zinc-300">{f.app_slug}</span>
            <span>{`by ${f.created_by_username || '—'}`}</span>
            <span>{fmtTime(f.created_at)}</span>
            {f.github_issue_number
              ? <span className="text-xs text-zinc-500 dark:text-zinc-300">{`GitHub #${f.github_issue_number}`}</span>
              : null}
          </div>
        </div>
        <div className="text-right text-sm shrink-0">
          <div className="text-meadow-700 dark:text-meadow-200 font-semibold">{`▲ ${f.up_count}`}</div>
          <div className="text-zinc-500 dark:text-zinc-300">{`▼ ${f.down_count}`}</div>
        </div>
      </div>
    </div>
  );
}

function FeaturesSection() {
  // Default 'all' so an admin lands on the full cross-app list — shipped
  // features carry status='completed', invisible under open/closed (#565).
  const [status, setStatus] = useState('all');
  const [features, setFeatures] = useState<Feature[] | null>(null);
  const [summary, setSummary] = useState('');
  const [empty, setEmpty] = useState('');
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      setFeatures(null);
      setEmpty('');
      setSummary('Loading…');
      const { status: httpStatus, data } = await (window as any).AdminConsole.fetchJson(
        `/api/admin/submitted-features?status=${encodeURIComponent(status)}&limit=${FEATURES_PAGE}&offset=0`);
      if (!alive.current) return;
      if (httpStatus === 403) { setSummary('Admin access required.'); return; }
      if (!data || typeof data !== 'object') {
        setSummary('Couldn’t load submitted features. Try Refresh.');
        return;
      }
      const rows: Feature[] = data.features || [];
      const total = typeof data.total === 'number' ? data.total : rows.length;
      if (!rows.length) {
        setSummary('');
        setEmpty(status === 'all'
          ? 'No submitted features yet.'
          : 'No submitted features match this filter. Try the “All” status.');
        return;
      }
      setFeatures(rows);
      setSummary(total > rows.length
        ? `Showing the top ${rows.length} of ${total}. Use Download CSV for the full list.`
        : `${total} feature${total === 1 ? '' : 's'}.`);
    })();
  }, [status, nonce]);

  const downloadCsv = async () => {
    setBusy(true);
    try {
      // Pull the ENTIRE filtered set (looping the offset param), not just the
      // visible page. Hard iteration cap guards a non-advancing page.
      const all: Feature[] = [];
      let offset = 0;
      let total = Infinity;
      for (let guard = 0; guard < 10000 && all.length < total; guard += 1) {
        // eslint-disable-next-line no-await-in-loop
        const { ok, data } = await (window as any).AdminConsole.fetchJson(
          `/api/admin/submitted-features?status=${encodeURIComponent(status)}&limit=${FEATURES_PAGE}&offset=${offset}`);
        if (!ok || !data) throw new Error('export failed');
        const batch: Feature[] = data.features || [];
        if (typeof data.total === 'number') total = data.total;
        if (!batch.length) break;
        all.push(...batch);
        offset += FEATURES_PAGE;
        if (batch.length < FEATURES_PAGE) break;
      }
      const lines = [FEATURES_CSV_FIELDS.map(csvCell).join(',')];
      for (const r of all) lines.push(FEATURES_CSV_FIELDS.map((k) => csvCell(r[k])).join(','));
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `submitted-features-${status}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      if (alive.current) setSummary('CSV export failed. Try again.');
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  return (
    <div className={`${AdminUI.card} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <h2 className={AdminUI.cardTitle}>Submitted features</h2>
        <div className="flex items-center gap-2">
          <select id="admin-features-status" value={status} onChange={(e) => setStatus(e.target.value)}
            className="rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 px-2 py-1 text-xs">
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="closed">Closed</option>
            <option value="completed">Shipped</option>
          </select>
          <button id="admin-features-refresh" type="button" className={`${AdminUI.btn.link} text-xs px-1 py-1`}
            onClick={() => setNonce((n) => n + 1)}>Refresh</button>
          <button id="admin-features-csv" type="button" className={AdminUI.btn.primarySm}
            disabled={busy} onClick={downloadCsv}>{busy ? 'Preparing…' : 'Download CSV'}</button>
        </div>
      </div>
      <p id="admin-features-summary" className="text-xs text-zinc-500 dark:text-zinc-300 mb-3">{summary}</p>
      <div id="admin-features-list" className="space-y-3">
        {(features || []).map((f, i) => <FeatureCard key={f.id} f={f} rank={i + 1} />)}
      </div>
      <p id="admin-features-empty"
        className={`text-sm text-zinc-500 dark:text-zinc-300${empty ? '' : ' hidden'}`}>{empty}</p>
    </div>
  );
}

let host: Element | null = null;

const AdminFeatures = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <FeaturesSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminFeatures = AdminFeatures;

export { AdminFeatures };
