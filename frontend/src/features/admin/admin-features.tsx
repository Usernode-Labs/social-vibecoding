'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
// The console's shared page parts (26 Nov 2026): the header, the bar over the
// list, the list and its badges are the ones every admin page draws with.
import { BTN } from './topochain/tokens.ts';
import {
  Badge, EmptyState, List, ScreenHeader, Segmented, Toolbar,
} from './topochain/ui.tsx';
import type { Column } from './topochain/ui.tsx';

// Submitted features (#admin/features) — the cross-app feature requests users
// filed from inside each app, ported from the retired admin-features.js page.
//
// Ranked by net votes, one row per request, with the app it belongs to and
// its GitHub issue number when one was opened. A request's description is
// behind the row's arrow. "Download CSV" pulls the ENTIRE
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

// The status is repeated down the list, so it wears the soft tones: open is
// still waiting, shipped is done, closed says nothing.
const FEATURES_STATUS_BADGE: Record<string, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'sky' },
  closed: { label: 'Closed', tone: 'zinc' },
  completed: { label: 'Shipped', tone: 'mint' },
};

const FEATURES_STATUSES = ['all', 'open', 'closed', 'completed'] as const;
type FeaturesStatus = typeof FEATURES_STATUSES[number];
const FEATURES_STATUS_LABELS: Record<FeaturesStatus, string> = {
  all: 'All', open: 'Open', closed: 'Closed', completed: 'Shipped',
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
  /** Its place in the ranked page, set when the page arrives. */
  rank?: number;
  [key: string]: any;
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function csvCell(v: any): string {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

const FEATURE_COLUMNS: Column<Feature>[] = [
  { label: 'Rank', cell: (f) => <span className="font-mono text-zinc-500 dark:text-zinc-400">{`#${f.rank}`}</span> },
  { label: 'Feature', primary: true, cell: (f) => <span className="font-semibold">{f.title}</span> },
  {
    label: 'Status',
    cell: (f) => {
      const b = (f.status && FEATURES_STATUS_BADGE[f.status]) || { label: f.status || '—', tone: 'zinc' };
      return <Badge label={b.label} tone={b.tone} />;
    },
  },
  {
    label: 'App',
    cell: (f) => (
      <>
        <span>{f.app_name}</span>
        <span className="ms-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">{f.app_slug}</span>
      </>
    ),
  },
  { label: 'By', cell: (f) => f.created_by_username || '—' },
  { label: 'Filed', cell: (f) => fmtTime(f.created_at) },
  { label: 'GitHub', cell: (f) => (f.github_issue_number ? `GitHub #${f.github_issue_number}` : '') },
  {
    label: 'Votes',
    cell: (f) => (
      <span className="tabular-nums whitespace-nowrap">
        <span className="font-semibold text-green-800 dark:text-green-400">{`▲ ${f.up_count}`}</span>
        <span className="ms-1 text-zinc-500 dark:text-zinc-400">{`▼ ${f.down_count}`}</span>
      </span>
    ),
  },
];

function FeaturesSection() {
  // Default 'all' so an admin lands on the full cross-app list — shipped
  // features carry status='completed', invisible under open/closed (#565).
  const [status, setStatus] = useState<FeaturesStatus>('all');
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
      setFeatures(rows.map((f, i) => ({ ...f, rank: i + 1 })));
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
    <>
      <ScreenHeader
        title="Submitted features"
        subtitle="Feature requests people filed from inside each app, ranked by net votes."
        actions={(
          <>
            <button id="admin-features-refresh" type="button" className={BTN.secondarySm}
              onClick={() => setNonce((n) => n + 1)}>Refresh</button>
            <button id="admin-features-csv" type="button" className={BTN.primarySm}
              disabled={busy} onClick={downloadCsv}>{busy ? 'Preparing…' : 'Download CSV'}</button>
          </>
        )}
      />
      {/* The status filter is the list's, so it sits in the bar over it; the
          header keeps Refresh and the export, which take the whole page
          (26 Nov 2026). */}
      <Toolbar>
        <Segmented<FeaturesStatus>
          id="admin-features-status"
          label="Filter by status"
          value={status}
          options={FEATURES_STATUSES.map((v) => ({ value: v, label: FEATURES_STATUS_LABELS[v] }))}
          onChange={setStatus}
        />
      </Toolbar>
      <p id="admin-features-summary" className="text-xs text-zinc-500 dark:text-zinc-400 mb-3">{summary}</p>
      <div id="admin-features-list">
        {features && features.length ? (
          <List
            items={features}
            columns={FEATURE_COLUMNS}
            rowKey={(f) => f.id}
            details={(f) => (
              <div className="text-xs text-zinc-600 dark:text-zinc-300 whitespace-pre-wrap break-words">
                {f.description || 'No description.'}
              </div>
            )}
          />
        ) : null}
      </div>
      <div id="admin-features-empty" hidden={!empty}>
        <EmptyState title={empty} />
      </div>
    </>
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
