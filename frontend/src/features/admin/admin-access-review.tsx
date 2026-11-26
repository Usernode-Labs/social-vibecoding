'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
import { BTN } from './topochain/tokens.ts';
import { Badge, Field, Figures, List, ScreenHeader } from './topochain/ui.tsx';
import type { Column } from './topochain/ui.tsx';

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

// What an account can do. Yes is amber on purpose: each one is a power to
// look at twice in a review.
function YesNo({ on }: { on: boolean }) {
  return <Badge tone={on ? 'amber' : 'zinc'} label={on ? 'Yes' : 'No'} />;
}

function granted(a: AdminRow): string {
  return a.roleSetAt
    ? `${fmtDate(a.roleSetAt)}${a.roleSetBy ? ` by ${a.roleSetBy}` : ''}`
    : 'Not recorded';
}

// One row per admin in the shared list (26 Nov 2026); each was a card of its
// own. data-admin-id sat on the card, and the list draws its own rows, so the
// username carries it.
const FINE = 'text-xs text-zinc-500 dark:text-zinc-400';
const ADMIN_COLUMNS: Column<AdminRow>[] = [
  {
    label: 'Account',
    primary: true,
    cell: (a) => <span data-admin-id={a.id} className="font-medium break-all">{a.username}</span>,
  },
  {
    label: 'Role',
    cell: (a) => (
      <Badge tone={a.role === 'admin' ? 'violet' : 'zinc'} label={a.role === 'admin' ? 'Full admin' : 'View-only admin'} />
    ),
  },
  { label: 'Role given', cell: (a) => granted(a), tdClass: FINE },
  { label: 'Last sign-in', cell: (a) => (a.lastSignInAt ? fmtDate(a.lastSignInAt) : 'No live session'), tdClass: FINE },
  { label: 'Account made', cell: (a) => fmtDate(a.accountCreatedAt) || 'Not recorded', tdClass: FINE },
  { label: 'Last database export', cell: (a) => (a.lastDatabaseExportAt ? fmtDate(a.lastDatabaseExportAt) : 'Never'), tdClass: FINE },
];

// What the role lets the account do, behind the row's arrow: it follows from
// the role, so it is read now and then, not on every row.
function AdminPowers({ a }: { a: AdminRow }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-zinc-600 dark:text-zinc-300">
      <span className="inline-flex items-center gap-1.5">Export the database <YesNo on={a.capabilities.databaseExport} /></span>
      <span className="inline-flex items-center gap-1.5">CSV exports with personal data <YesNo on={a.capabilities.personalDataExports} /></span>
      <span className="inline-flex items-center gap-1.5">SQL console <YesNo on={a.capabilities.sqlConsole} /></span>
      <span className="inline-flex items-center gap-1.5">Change things <YesNo on={a.capabilities.changeThings} /></span>
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
      <div id="admin-access-review-panel">
        <ScreenHeader title="Access review" subtitle="The access review is for full admins." />
      </div>
    );
  }

  const report = load.kind === 'ready' ? load.report : null;
  const line = report ? reviewLine(report.review) : null;

  return (
    <div id="admin-access-review-panel">
      <ScreenHeader
        title="Access review"
        subtitle="Every account with admin rights and what it can do. Once a quarter, check that each one still needs its access, take it away in Users where it does not, then mark the list reviewed."
        actions={(
          <button id="admin-access-review-refresh" type="button" className={BTN.secondarySm}
            onClick={() => { setStatus(null); refresh(); }}>Refresh</button>
        )}
      />
      <Figures
        id="admin-access-review-figures"
        items={[
          { key: 'full', label: 'Full admins', value: report ? report.counts.full.toLocaleString() : null, tone: 'yellow' },
          { key: 'view', label: 'View-only admins', value: report ? report.counts.viewOnly.toLocaleString() : null, tone: 'sky' },
        ]}
      />
      {load.kind === 'loading' ? <p className={AdminUI.loading}>Loading…</p> : null}
      {load.kind === 'error' ? <p className="text-sm text-red-700 dark:text-red-400">{load.error}</p> : null}
      {report && line ? (
        <div className={`${AdminUI.card} p-4 mb-4 space-y-3`}>
          <div className="flex flex-wrap items-center gap-2">
            <span id="admin-access-review-last" className="text-sm text-zinc-900 dark:text-zinc-100">{line.last}</span>
            <span id="admin-access-review-due" className={report.review.overdue ? AdminUI.badge.warn : AdminUI.badge.default}>
              {line.due}
            </span>
          </div>
          {report.review.note ? (
            <p className={AdminUI.muted}>{`Note: ${report.review.note}`}</p>
          ) : null}
          <Field label="Note (optional)" htmlFor="admin-access-review-note">
            <textarea id="admin-access-review-note" className={AdminUI.textarea} maxLength={NOTE_MAX}
              placeholder="What changed in this review, for example who lost access"
              value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
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

      {report ? (
        <>
          <p className={`${AdminUI.muted} mb-3`}>
            Full admins change things and take exports; every admin can read the console and run the read-only SQL console.
          </p>
          <div id="admin-access-review-list">
            <List
              items={report.admins}
              rowKey={(a) => a.id}
              columns={ADMIN_COLUMNS}
              details={(a) => <AdminPowers a={a} />}
            />
          </div>
        </>
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
