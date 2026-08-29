'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Database export (#admin/db-export) — an unredacted dump of durable platform
// data, behind a two-field confirmation, a per-day cap, no re-entry on every
// run, and an append-only history nobody can clear.
//
// WHY THE BUTTON'S ENABLED STATE COMES FROM THE SERVER: availability is
// decided by GET /api/admin/db-export/status, which returns a `reason` code
// this module maps to copy. The client contains no environment check of its
// own — the server owns that decision (and enforces it on both the ticket and
// the stream route), which is also what keeps this file identical across
// environments as tests/admin-console-page.test.js requires.
//
// The download itself is a two-step ticket, not a fetch: POST the
// confirmation, then NAVIGATE to the returned single-use URL. A Blob would
// hold a multi-hundred-megabyte dump in page memory; navigating gives a real
// streamed download with the browser's own progress UI — and lets the browser
// save the gzip bytes verbatim instead of trying to decode them.
//
// PERMISSIONS: visible to any admin; exporting needs full admin
// (requireAdminWrite on the ticket route), and a view-only admin gets a note
// where the button would be.
//
// ── Fourth section out of the chassis (#1120 slice 19) ────────────────
//
// Same move as the three before it. Two things about this one:
//
//   * The confirm panel used to be shown by removing `hidden` and reset by a
//     `_resetDbExportConfirm` that cleared two input values, re-hid the panel,
//     re-hid the error and re-probed the status. It is one `confirming` flag
//     plus controlled inputs; closing it clears the fields because they are
//     state, not DOM.
//   * `loadDbExportStatus` had to ask the DOM whether the confirm panel was
//     open before deciding the export button's disabled state — "don't
//     re-enable the button out from under an open confirm panel". Both are
//     state here, so the button's disabled expression simply mentions both.
//
// The password field is still cleared the moment its value is spent, and the
// navigation is still `window.location.href` rather than a fetch.

interface Row {
  id: number;
  username: string;
  status?: string;
  db_name?: string;
  ip?: string;
  error?: string;
  denied_reason?: string;
  requested_at?: string;
  started_at?: string;
  finished_at?: string;
  bytes_sent?: number;
}

const DB_EXPORT_REASONS: Record<string, string> = {
  staging: 'Database export is disabled in staging previews.',
  unavailable: 'Database export is unavailable on this deployment.',
  in_progress: 'An export is already in progress. Try again shortly.',
  rate_limited: 'Daily export limit reached. Try again later.',
};

// The two azure badges spell 800/200, not 700/300 — the same call
// admin-merges.tsx documents for the byte-identical `bg-azure-500/20` wash: on
// that wash over the white card azure-700 composites to the weakest ink in the
// set, where every sibling row below reads at the status tier. 800 is the same
// hue a step deeper, and azure-200 is its dark partner, matching the meadow,
// red and amber rows' own light-700/dark-200 pairing.
const DB_EXPORT_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  completed: { label: 'Completed', cls: 'bg-meadow-500/20 text-meadow-700 dark:text-meadow-200' },
  streaming: { label: 'Streaming', cls: 'bg-azure-500/20 text-azure-800 dark:text-azure-200' },
  requested: { label: 'Requested', cls: 'bg-azure-500/20 text-azure-800 dark:text-azure-200' },
  failed: { label: 'Failed', cls: 'bg-red-500/20 text-red-700 dark:text-red-200' },
  cancelled: { label: 'Cancelled', cls: 'bg-amber-500/20 text-amber-800 dark:text-amber-200' },
  interrupted: { label: 'Interrupted', cls: 'bg-amber-500/20 text-amber-800 dark:text-amber-200' },
  denied: { label: 'Denied', cls: 'bg-red-500/20 text-red-700 dark:text-red-200' },
};

function fmtBytes(n: any): string {
  const b = Number(n);
  if (!Number.isFinite(b) || b <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function fmtDuration(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return '—';
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.round(s / 60)} min`;
}

function fmtTime(iso?: string): string {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

const FIELD = 'w-full rounded-lg bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm';
const RED_BTN = 'rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors';

function HistoryRow({ r }: { r: Row }) {
  const b = (r.status && DB_EXPORT_STATUS_BADGE[r.status])
    || { label: r.status || '—', cls: 'bg-zinc-500/20 text-zinc-600 dark:text-zinc-300' };
  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg bg-zinc-100 dark:bg-zinc-800/60 p-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">{r.username}</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${b.cls}`}>{b.label}</span>
          </div>
          <div className="text-xs text-zinc-500 dark:text-zinc-300 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>{fmtTime(r.requested_at)}</span>
            <span className="font-mono">{r.db_name}</span>
            <span title="compressed size downloaded">{fmtBytes(r.bytes_sent)}</span>
            <span>{fmtDuration(r.started_at, r.finished_at)}</span>
            <span>{`from ${r.ip || '—'}`}</span>
            {r.denied_reason ? (
              <span className="text-zinc-500 dark:text-zinc-300">
                {`reason: ${String(r.denied_reason).replace(/_/g, ' ')}`}
              </span>
            ) : null}
          </div>
          {r.error ? <div className="text-xs text-red-700 dark:text-red-200 mt-1 break-words">{r.error}</div> : null}
        </div>
      </div>
    </div>
  );
}

function DbExportSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [status, setStatus] = useState<any>(null);
  const [statusText, setStatusText] = useState<string | null>('Loading…');
  const [history, setHistory] = useState<Row[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const phraseRef = useRef<HTMLInputElement | null>(null);
  const alive = useRef(true);
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  useEffect(() => () => {
    alive.current = false;
    timers.current.forEach(clearTimeout);
  }, []);

  const loadStatus = useCallback(async () => {
    const { status: httpStatus, data } = await (window as any).AdminConsole
      .fetchJson('/api/admin/db-export/status');
    if (!alive.current) return;
    if (httpStatus === 403) { setStatus(null); setStatusText('Admin access required.'); return; }
    if (!data || typeof data !== 'object') {
      setStatus(null);
      setStatusText('Couldn’t read the export status. Try Refresh.');
      return;
    }
    setStatusText(null);
    setStatus(data);
  }, []);

  const loadHistory = useCallback(async () => {
    const { status: httpStatus, data } = await (window as any).AdminConsole
      .fetchJson('/api/admin/db-export/history?limit=25&offset=0');
    if (!alive.current) return;
    if (httpStatus === 403 || !data || typeof data !== 'object') return;
    setHistory(data.exports || []);
  }, []);

  useEffect(() => { loadStatus(); loadHistory(); }, [loadStatus, loadHistory]);
  useEffect(() => { if (confirming) phraseRef.current?.focus(); }, [confirming]);

  const closeConfirm = () => {
    setConfirming(false);
    setPhrase('');
    setPassword('');
    setError(null);
    loadStatus();
  };

  const start = async () => {
    setError(null);
    if (phrase.trim() !== 'EXPORT') { setError('Type EXPORT exactly to confirm.'); return; }
    if (!password) { setError('Your password is required.'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/db-export/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'EXPORT', password }),
      });
      let data: any = null;
      try { data = await res.json(); } catch { /* non-JSON error page */ }
      if (!alive.current) return;
      if (!res.ok || !data || !data.url) {
        setError((data && data.error) || 'Export could not be started.');
        setBusy(false);
        loadHistory();
        return;
      }
      setPassword('');
      // Navigate — do NOT fetch. The response is a streamed attachment and
      // must go straight to the browser's download machinery.
      window.location.href = data.url;
      setBusy(false);
      closeConfirm();
      setGuidanceOpen(true);
      // The navigation doesn't repaint the page, so poll the history a couple
      // of times to pick up the row as it moves to its final state.
      timers.current.push(setTimeout(() => loadHistory(), 3000));
      timers.current.push(setTimeout(() => loadHistory(), 12000));
    } catch {
      if (!alive.current) return;
      setError('Network error. The export was not started.');
      setBusy(false);
    }
  };

  return (
    <div id="admin-db-export-panel" className="space-y-4">
      <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-transparent p-4">
        {/* Two-level ladder, held in BOTH themes: the sweep moved the h2 to
            dark:red-200, byte-identical to the body copy, which collapsed
            this panel's dark ink ladder to one level while light kept two —
            the exact flatten AGENTS.md's dark-mode section records reverting
            at 15 sites. The h2 keeps the solved 700/200 parity pair
            (Lc 80.0 / -80.0); the BODY is the half that differentiates, at
            800/100 — the ramp solves that pair too (90.0 / -89.9, measured
            with the APCA-W3 0.1.9 port) — so body sits one tier above the
            heading in both themes, as it did in light all along. */}
        <h2 className="text-lg font-semibold text-red-700 dark:text-red-200">Database export: handle as a credential</h2>
        <p className="text-sm text-red-800 dark:text-red-100 mt-2">
          This downloads an unredacted copy of durable platform data. Ephemeral mobile push registrations and delivery rows are excluded.
          Anyone holding the file can take over accounts and reach every app&apos;s data.
          It contains:
        </p>
        <ul className="text-sm text-red-800 dark:text-red-100 mt-2 list-disc pl-5 space-y-1">
          <li>every user&apos;s password hash and every currently-valid login session token</li>
          <li>every activation code, used and unused</li>
          <li>every app&apos;s database password, LLM proxy token and file-storage token</li>
          <li>the encrypted blobs for users&apos; own Anthropic API keys and every app&apos;s stored secrets</li>
          <li>every chat message, spec, dev-session transcript, uploaded attachment and screenshot</li>
          <li>all analytics, votes, kudos, bounties and moderation history</li>
        </ul>
        <p className="text-sm text-red-800 dark:text-red-100 mt-3">
          {'It does '}<span className="font-semibold">not</span>
          {' contain the individual apps’ own databases, uploaded app-file bytes (those live in object storage), the chain node’s data, or the platform’s environment file, which matters because the key that decrypts the API-key and app-secret blobs lives only there.'}
        </p>
      </div>

      <div className={`${AdminUI.card} p-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p id="admin-db-export-target" className="text-sm text-zinc-500 dark:text-zinc-300">
            {statusText || (status ? (
              <>
                {'Target database '}<code className="font-mono text-zinc-700 dark:text-zinc-200">{status.dbName || 'unknown'}</code>
                {' · current size '}<span className="font-medium">{fmtBytes(status.dbSizeBytes)}</span>
                <span className="text-zinc-500 dark:text-zinc-300"> (the .sql.gz download is smaller)</span>
                {' · '}
                <span className="text-zinc-500 dark:text-zinc-300">
                  {`${status.remainingToday} of ${status.maxPerDay} exports left today`}
                </span>
              </>
            ) : null)}
          </p>
          <button id="admin-db-export-refresh" type="button" className={`${AdminUI.btn.link} text-xs px-1 py-1`}
            onClick={() => { loadStatus(); loadHistory(); }}>Refresh</button>
        </div>
        <div className="mt-3">
          {canWrite ? (
            <button id="admin-db-export-btn" type="button"
              // The probe decides; the client only renders the decision — and
              // never re-enables the button out from under an open confirm.
              disabled={!status?.available || confirming}
              onClick={() => setConfirming(true)}
              className="rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:hover:bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors">
              Export database</button>
          ) : (
            <span className="inline-block rounded-lg border border-zinc-300 dark:border-zinc-700 px-3 py-2 text-sm text-zinc-500 dark:text-zinc-300">
              Exporting the database requires full admin.</span>
          )}
          <p id="admin-db-export-reason" className="text-xs text-zinc-500 dark:text-zinc-300 mt-2">
            {status && !status.available
              ? (DB_EXPORT_REASONS[status.reason] || 'Database export is currently unavailable.')
              : ''}
          </p>
        </div>

        {/* Inline confirm panel. Both fields are required on every export;
            there is no remember-me and no session-scoped bypass. */}
        <div id="admin-db-export-confirm"
          className={`${confirming ? '' : 'hidden '}mt-4 rounded-lg border border-red-300 dark:border-red-900 bg-white dark:bg-zinc-950 p-4`}>
          <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Confirm the export</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-300 mt-1">
            {'Type '}<code className="font-mono text-red-700 dark:text-red-200">EXPORT</code>
            {' and re-enter your own account password.'}
          </p>
          <div className="mt-3 space-y-2">
            <input id="admin-db-export-phrase" ref={phraseRef} type="text" autoComplete="off" spellCheck={false}
              placeholder="EXPORT" className={`${FIELD} font-mono`}
              value={phrase} onChange={(e) => setPhrase(e.target.value)} />
            <input id="admin-db-export-password" type="password" autoComplete="current-password"
              placeholder="Your password" className={FIELD}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <p id="admin-db-export-error"
            className={`${error ? '' : 'hidden '}text-xs text-red-700 dark:text-red-200 mt-2`}>{error}</p>
          <div className="flex items-center gap-2 mt-3">
            <button id="admin-db-export-go" type="button" className={RED_BTN} disabled={busy} onClick={start}>
              {busy ? 'Exporting…' : 'Download the .sql.gz'}
            </button>
            <button id="admin-db-export-cancel" type="button" onClick={closeConfirm}
              className="rounded-lg border border-zinc-300 dark:border-zinc-700 px-4 py-2 text-sm font-medium text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors">
              Cancel</button>
          </div>
        </div>

        <p className="text-xs text-zinc-500 dark:text-zinc-300 mt-4">
          {'The file is a gzip-compressed plain-SQL dump ('}<code className="font-mono">.sql.gz</code>
          {'), taken with '}<code className="font-mono">--no-owner --no-privileges</code>{'. Restore it with:'}<br />
          <code className="font-mono text-zinc-600 dark:text-zinc-300 break-all">
            {'gunzip -c <file>.sql.gz | psql -v ON_ERROR_STOP=1 -d <target-db>'}
          </code><br />
          {'Read it without unpacking with '}<code className="font-mono">zless</code>
          {' / '}<code className="font-mono">zgrep</code>{'.'}
        </p>
      </div>

      <details id="admin-db-export-guidance" open={guidanceOpen} onToggle={(e) => setGuidanceOpen((e.target as HTMLDetailsElement).open)}
        className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-transparent p-4">
        <summary className="text-sm font-semibold text-amber-800 dark:text-amber-200 cursor-pointer">
          After you download it, and what to do if it leaks
        </summary>
        <ul className="text-sm text-amber-800 dark:text-amber-200 mt-3 list-disc pl-5 space-y-1">
          <li>Treat the file as a live credential: keep it encrypted, never on shared storage, and delete it when you&apos;re done.</li>
          <li>
            {'It is unencrypted in your Downloads folder. Gzip is compression, not protection; cloud backup may sync it and anyone can read it with '}
            <code className="font-mono">zless</code>{'.'}
          </li>
          <li>If it may have been exposed, deletion is not enough. Rotate:</li>
          <li className="list-none pl-4">— the platform JWT secret (invalidates every session; stored API keys and app secrets must be re-entered afterwards)</li>
          <li className="list-none pl-4">— the platform database password</li>
          <li className="list-none pl-4">— every per-app database password, LLM proxy token and storage token</li>
          <li className="list-none pl-4">— invalidate all activation codes, and force a password reset for all users</li>
          <li>Everything in the file stays valid until those rotations happen.</li>
        </ul>
      </details>

      <div className={`${AdminUI.card} p-4`}>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <h3 className="text-base font-semibold">Export history</h3>
          <span className="text-xs text-zinc-500 dark:text-zinc-300">Append-only: cannot be cleared</span>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-300 mb-3">Every attempt, including refused ones, is recorded here permanently.</p>
        <div id="admin-db-export-history" className="space-y-2">
          {(history || []).map((r) => <HistoryRow key={r.id} r={r} />)}
        </div>
        <p id="admin-db-export-history-empty"
          className={`text-sm text-zinc-500 dark:text-zinc-300${history && !history.length ? '' : ' hidden'}`}>
          No exports recorded yet.
        </p>
      </div>
    </div>
  );
}

let host: Element | null = null;

const AdminDbExport = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <DbExportSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminDbExport = AdminDbExport;

export { AdminDbExport };
