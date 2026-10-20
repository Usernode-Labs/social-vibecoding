'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Access review (#admin/access-review, #5133): every account with admin
// rights, what each one can do, and the quarterly review that confirms the
// list is still right. The data is GET /api/admin/access-review and the
// Reviewed button is POST /api/admin/access-review/reviews
// (src/services/admin-access-review.js); docs/ops/admin-access.md is the
// procedure around it.
//
// PERMISSIONS: both routes are requireAdminWrite. A view-only admin gets a
// sentence and no request (the test-accounts section's shape): the list of
// who can take the database away is for the people who can change it.
//
// Usernames and notes come from the API and are rendered as text children;
// nothing here is an anchor.

export interface Capabilities {
  readConsole: boolean;
  sqlConsole: boolean;
  changeThings: boolean;
  databaseExport: boolean;
  personalDataExports: boolean;
  manageAdmins: boolean;
}

export interface AdminRow {
  id: number;
  username: string;
  role: 'admin' | 'view_admin';
  accountCreatedAt: string | null;
  roleSetAt: string | null;
  roleSetBy: string | null;
  lastSignInAt: string | null;
  lastDatabaseExportAt: string | null;
  capabilities: Capabilities;
}

export interface ReviewState {
  lastReviewedAt: string | null;
  lastReviewedBy: string | null;
  note: string | null;
  nextDueAt: string | null;
  overdue: boolean;
}

export interface Report {
  reviewIntervalDays: number;
  admins: AdminRow[];
  counts: { full: number; viewOnly: number };
  review: ReviewState;
}

export const NOTE_MAX = 500;

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// The line under the heading: when the list was last confirmed, and when
// it is next due. A review nobody has done yet is due now.
export function reviewLine(review: ReviewState): { last: string; due: string } {
  if (!review.lastReviewedAt) {
    return { last: 'Never reviewed', due: 'Review due now' };
  }
  const by = review.lastReviewedBy || 'a deleted account';
  return {
    last: `Last reviewed ${fmtDate(review.lastReviewedAt)} by ${by}`,
    due: review.overdue
      ? `Review overdue since ${fmtDate(review.nextDueAt)}`
      : `Next review due ${fmtDate(review.nextDueAt)}`,
  };
}

function YesNo({ on }: { on: boolean }) {
  return <span className={on ? AdminUI.badge.warn : AdminUI.badge.outline}>{on ? 'Yes' : 'No'}</span>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="text-sm text-zinc-900 dark:text-zinc-100 break-words">{value}</div>
    </div>
  );
}

function AdminCard({ a }: { a: AdminRow }) {
  const granted = a.roleSetAt
    ? `${fmtDate(a.roleSetAt)}${a.roleSetBy ? ` by ${a.roleSetBy}` : ''}`
    : 'Not recorded';
  return (
    <div className={`${AdminUI.card} p-4`} data-admin-id={a.id}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="font-medium text-zinc-900 dark:text-zinc-100 break-all">{a.username}</span>
        <span className={a.role === 'admin' ? AdminUI.badge.secondary : AdminUI.badge.default}>
          {a.role === 'admin' ? 'Full admin' : 'View-only admin'}
        </span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
        <Fact label="Role given" value={granted} />
        <Fact label="Last sign-in" value={a.lastSignInAt ? fmtDate(a.lastSignInAt) : 'No live session'} />
        <Fact label="Account made" value={fmtDate(a.accountCreatedAt) || 'Not recorded'} />
        <Fact label="Last database export" value={a.lastDatabaseExportAt ? fmtDate(a.lastDatabaseExportAt) : 'Never'} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-3 text-xs text-zinc-600 dark:text-zinc-300">
        <span className="inline-flex items-center gap-1.5">Export the database <YesNo on={a.capabilities.databaseExport} /></span>
        <span className="inline-flex items-center gap-1.5">CSV exports with personal data <YesNo on={a.capabilities.personalDataExports} /></span>
        <span className="inline-flex items-center gap-1.5">SQL console <YesNo on={a.capabilities.sqlConsole} /></span>
        <span className="inline-flex items-center gap-1.5">Change things <YesNo on={a.capabilities.changeThings} /></span>
      </div>
    </div>
  );
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'ready'; report: Report };

function AccessReviewSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    const { status: httpStatus, data } = await (window as any).AdminConsole
      .fetchJson('/api/admin/access-review');
    if (!alive.current) return;
    if (httpStatus === 403) { setLoad({ kind: 'error', error: 'Full admin access required.' }); return; }
    if (!data || !Array.isArray(data.admins)) {
      setLoad({ kind: 'error', error: 'Couldn’t load the admin list. Try Refresh.' });
      return;
    }
    setLoad({ kind: 'ready', report: data as Report });
  }, []);

  useEffect(() => { if (canWrite) refresh(); }, [canWrite, refresh]);

  const markReviewed = async () => {
    if (load.kind !== 'ready') return;
    const ok = await (window as any).AdminConsole._confirm({
      title: 'Mark the admin list reviewed?',
      message: `You confirm that the ${load.report.admins.length} accounts listed still need the access they have. Remove anyone who does not first, in Users.`,
      confirmLabel: 'Reviewed',
    });
    if (!ok || !alive.current) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch('/api/admin/access-review/reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: note.trim() || null }),
      });
      let data: any = null;
      try { data = await res.json(); } catch { /* non-JSON error page */ }
      if (!alive.current) return;
      if (!res.ok || !data || !Array.isArray(data.admins)) {
        setStatus({ text: (data && data.error) || 'The review was not recorded.', ok: false });
        return;
      }
      setNote('');
      setLoad({ kind: 'ready', report: data as Report });
      setStatus({ text: 'Review recorded.', ok: true });
    } catch {
      if (alive.current) setStatus({ text: 'Network error. The review was not recorded.', ok: false });
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  if (!canWrite) {
    return (
      <div id="admin-access-review-panel" className={`${AdminUI.card} p-4`}>
        <h2 className={AdminUI.cardTitle}>Access review</h2>
        <p className={`${AdminUI.muted} mt-2`}>The access review is for full admins.</p>
      </div>
    );
  }

  const report = load.kind === 'ready' ? load.report : null;
  const line = report ? reviewLine(report.review) : null;

  return (
    <div id="admin-access-review-panel" className="space-y-4">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Access review</h2>
          <button id="admin-access-review-refresh" type="button" className={`${AdminUI.btn.link} text-xs px-1 py-1`}
            onClick={() => { setStatus(null); refresh(); }}>Refresh</button>
        </div>
        <p className={AdminUI.cardDescription}>
          Every account with admin rights and what it can do. Once a quarter, check that each one still needs its access,
          take it away in Users where it does not, then mark the list reviewed.
        </p>
        {load.kind === 'loading' ? <p className={`${AdminUI.loading} mt-3`}>Loading…</p> : null}
        {load.kind === 'error' ? <p className="text-sm text-red-700 dark:text-red-400 mt-3">{load.error}</p> : null}
        {report && line ? (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span id="admin-access-review-last" className="text-sm text-zinc-900 dark:text-zinc-100">{line.last}</span>
              <span id="admin-access-review-due" className={report.review.overdue ? AdminUI.badge.warn : AdminUI.badge.default}>
                {line.due}
              </span>
            </div>
            {report.review.note ? (
              <p className={AdminUI.muted}>{`Note: ${report.review.note}`}</p>
            ) : null}
            <div>
              <label htmlFor="admin-access-review-note" className={AdminUI.label}>Note (optional)</label>
              <textarea id="admin-access-review-note" className={`${AdminUI.textarea} mt-1`} maxLength={NOTE_MAX}
                placeholder="What changed in this review, for example who lost access"
                value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button id="admin-access-review-mark" type="button" className={AdminUI.btn.primary}
                disabled={busy} onClick={markReviewed}>
                {busy ? 'Recording…' : 'Reviewed'}
              </button>
              {status ? (
                <span className={status.ok
                  ? 'text-xs text-emerald-700 dark:text-emerald-400'
                  : 'text-xs text-red-700 dark:text-red-400'}>{status.text}</span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {report ? (
        <div className="space-y-2">
          <p className={AdminUI.muted}>
            {`${report.counts.full} full ${report.counts.full === 1 ? 'admin' : 'admins'}, ${report.counts.viewOnly} view-only.`}
            {' Full admins change things and take exports; every admin can read the console and run the read-only SQL console.'}
          </p>
          <div id="admin-access-review-list" className="space-y-2">
            {report.admins.map((a) => <AdminCard key={a.id} a={a} />)}
          </div>
        </div>
      ) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminAccessReview = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <AccessReviewSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminAccessReview = AdminAccessReview;

export { AdminAccessReview };
