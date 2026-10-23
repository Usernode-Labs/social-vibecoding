'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Compliance (#admin/compliance, #5634): every action of the compliance
// plan with its status, what the scan found, and the history of both. The
// data is GET /api/admin/compliance (src/services/compliance.js); a status
// is saved by POST /api/admin/compliance/items/:code/status, an item's
// history is GET /api/admin/compliance/items/:code, and Scan now is
// POST /api/admin/compliance/scan.
//
// PERMISSIONS: every admin reads the page; saving a status and Scan now
// are requireAdminWrite, so a view-only admin sees no form and no button.
//
// A status is set by hand. The scan never changes it: an item a check
// fails on shows both, and the server lists it first.
//
// Notes, usernames and project names come from the API and are rendered as
// text children; nothing here is an anchor.

export type Status = 'todo' | 'partial' | 'done';
export type CheckState = 'pass' | 'fail' | 'error';

export interface Failing { slug: string; name: string | null; reason: string }

export interface CheckResult {
  key: string;
  label: string;
  state: CheckState;
  summary: string;
  checked: number | null;
  failed: number | null;
  failing: Failing[];
}

export interface Item {
  code: string;
  area: string;
  title: string;
  issue: number;
  priority: string;
  status: Status;
  note: string | null;
  setBy: string | null;
  setAt: string | null;
  fromPlan: boolean;
  checks: CheckResult[];
  attention: boolean;
  automatic: boolean;
}

export interface Scan { id: number; startedAt: string | null; finishedAt: string | null; results: CheckResult[] }

export interface Report {
  areas: { key: string; label: string }[];
  scanIntervalDays: number;
  checks: { key: string; label: string; items: string[] }[];
  items: Item[];
  counts: Record<Status, number>;
  attention: number;
  scans: Scan[];
  scanClock: { nextDueAt: string | null; inFlight: boolean; lastError: string | null } | null;
}

export interface History {
  code: string;
  start: Status;
  startNote: string | null;
  changes: { id: number; status: Status; note: string | null; at: string | null; by: string | null }[];
  scans: { scanId: number; at: string | null; key: string; label: string; state: CheckState; summary: string }[];
}

export const NOTE_MAX = 1000;

export const STATUS_LABEL: Record<Status, string> = { todo: 'To do', partial: 'Partly done', done: 'Done' };

const STATUS_BADGE: Record<Status, string> = {
  todo: AdminUI.badge.outline,
  partial: AdminUI.badge.warn,
  done: AdminUI.badge.default,
};

const REASON_LABEL: Record<string, string> = {
  missing: 'no LICENSE file',
  unreadable: 'repository could not be read',
  not_on_github: 'not on GitHub',
  app_unsupported: 'has no deletion handler',
  app_refused: 'refused the request',
  app_rejected: 'rejected the request',
  app_unreachable: 'could not be reached',
};

export function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Who set the status shown, in one line: the plan's starting value, or the
// admin and the day.
export function setLine(item: Pick<Item, 'fromPlan' | 'setBy' | 'setAt'>): string {
  if (item.fromPlan) return 'Starting value from the plan';
  const by = item.setBy || 'a deleted account';
  return `Set by ${by}, ${fmtDate(item.setAt)}`;
}

// A check's result in a few words: "6 of 129 projects fail" for a
// per-project check, else passing / failing / could not run.
export function checkBadgeText(c: Pick<CheckResult, 'state' | 'checked' | 'failed'>): string {
  if (c.state === 'error') return 'Scan: could not finish';
  if (c.checked !== null && c.failed !== null && c.checked > 0 && c.state === 'fail') {
    return `Scan: ${c.failed} of ${c.checked} ${c.checked === 1 ? 'project fails' : 'projects fail'}`;
  }
  return c.state === 'pass' ? 'Scan: passing' : 'Scan: failing';
}

function checkBadgeClass(state: CheckState): string {
  if (state === 'fail') return AdminUI.badge.destructive;
  if (state === 'error') return AdminUI.badge.warn;
  return AdminUI.badge.success;
}

// The line under the heading: when the last scan finished and when the
// next is due.
export function scanLine(report: Pick<Report, 'scans' | 'scanClock' | 'scanIntervalDays'>): string {
  const last = report.scans[0];
  const parts = [last ? `Last scan ${fmtDate(last.finishedAt)}` : 'No scan yet'];
  if (report.scanClock?.inFlight) parts.push('a scan is running');
  else if (report.scanClock?.nextDueAt) parts.push(`next ${fmtDate(report.scanClock.nextDueAt)}`);
  parts.push(`every ${report.scanIntervalDays === 1 ? 'day' : `${report.scanIntervalDays} days`}`);
  return parts.join(' · ');
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: any }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* non-JSON error page */ }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

function FailingList({ failing }: { failing: Failing[] }) {
  if (!failing.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-300">
      {failing.map((f) => (
        <li key={`${f.slug}:${f.reason}`} className="break-words">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{f.name || f.slug}</span>
          {f.name ? <span className="text-zinc-500 dark:text-zinc-400">{` (${f.slug})`}</span> : null}
          {` · ${REASON_LABEL[f.reason] || f.reason}`}
        </li>
      ))}
    </ul>
  );
}

function StatusForm({ item, onSaved }: { item: Item; onSaved: (r: Report) => void }) {
  // The form opens on the item's current status, and its current note is
  // the note field's placeholder: saving with the field empty keeps it.
  const [status, setStatus] = useState<Status>(item.status);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const { ok, data } = await postJson(`/api/admin/compliance/items/${encodeURIComponent(item.code)}/status`, {
      status, note: note.trim() || null,
    });
    if (!alive.current) return;
    setBusy(false);
    if (!ok || !data || !Array.isArray(data.items)) {
      setMsg({ text: (data && data.error) || 'The status was not saved.', ok: false });
      return;
    }
    setNote('');
    setMsg({ text: 'Saved.', ok: true });
    onSaved(data as Report);
  };

  const id = `admin-compliance-${item.code}`;
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-[12rem_1fr] gap-2">
        <div>
          <label htmlFor={`${id}-status`} className={AdminUI.label}>Status</label>
          <select id={`${id}-status`} className={`${AdminUI.select} mt-1`} value={status}
            onChange={(e) => setStatus(e.target.value as Status)}>
            {(['todo', 'partial', 'done'] as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor={`${id}-note`} className={AdminUI.label}>Note</label>
          <textarea id={`${id}-note`} className={`${AdminUI.textarea} mt-1`} maxLength={NOTE_MAX}
            placeholder={item.note || 'What was done, and where the proof is'}
            value={note} onChange={(e) => setNote(e.target.value)} />
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Left empty, the note stays as it is.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={AdminUI.btn.primarySm} disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save status'}
        </button>
        {msg ? (
          <span className={msg.ok
            ? 'text-xs text-emerald-700 dark:text-emerald-400'
            : 'text-xs text-red-700 dark:text-red-400'}>{msg.text}</span>
        ) : null}
      </div>
    </div>
  );
}

function ItemHistory({ code }: { code: string }) {
  const [history, setHistory] = useState<History | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    (window as any).AdminConsole.fetchJson(`/api/admin/compliance/items/${encodeURIComponent(code)}`)
      .then(({ data }: { data: any }) => {
        if (!alive) return;
        if (data && Array.isArray(data.changes)) setHistory(data as History);
        else setFailed(true);
      });
    return () => { alive = false; };
  }, [code]);

  if (failed) return <p className="text-xs text-red-700 dark:text-red-400">Couldn’t load the history.</p>;
  if (!history) return <p className={AdminUI.loading}>Loading history…</p>;
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Status history</div>
        <ul className="mt-1 space-y-1 text-xs text-zinc-700 dark:text-zinc-300">
          {history.changes.map((c) => (
            <li key={c.id} className="break-words">
              <span className="font-medium">{STATUS_LABEL[c.status]}</span>
              {` · ${fmtDate(c.at)} · ${c.by || 'a deleted account'}`}
              {c.note ? <span className="block text-zinc-500 dark:text-zinc-400">{c.note}</span> : null}
            </li>
          ))}
          <li className="text-zinc-500 dark:text-zinc-400">
            {`${STATUS_LABEL[history.start]} · starting value from the plan`}
          </li>
        </ul>
      </div>
      {history.scans.length ? (
        <div>
          <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Scan history</div>
          <ul className="mt-1 space-y-1 text-xs text-zinc-700 dark:text-zinc-300">
            {history.scans.map((s) => (
              <li key={`${s.scanId}:${s.key}`} className="break-words">
                <span className={checkBadgeClass(s.state)}>{s.state === 'pass' ? 'Pass' : s.state === 'fail' ? 'Fail' : 'Error'}</span>
                {` ${fmtDate(s.at)} · ${s.summary}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ItemRow({ item, canWrite, onSaved }: { item: Item; canWrite: boolean; onSaved: (r: Report) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${AdminUI.card} p-4`} data-compliance-item={item.code}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-zinc-500 dark:text-zinc-400">{item.code}</span>
            <span className={AdminUI.badge.outline}>{item.priority}</span>
            <span className={STATUS_BADGE[item.status]}>{STATUS_LABEL[item.status]}</span>
            {item.checks.map((c) => (
              <span key={c.key} className={checkBadgeClass(c.state)} title={c.summary}>{checkBadgeText(c)}</span>
            ))}
          </div>
          <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mt-1 break-words">{item.title}</div>
          <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {`${setLine(item)} · request #${item.issue}`}
          </div>
          {item.note ? <p className="text-xs text-zinc-600 dark:text-zinc-300 mt-1 break-words">{item.note}</p> : null}
        </div>
        <button type="button" className={`${AdminUI.btn.link} text-xs px-1 py-1 shrink-0`}
          aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Details'}
        </button>
      </div>
      {open ? (
        <div className="mt-3 pt-3 border-t border-zinc-100 dark:border-zinc-800 space-y-4">
          {item.checks.map((c) => (
            <div key={c.key}>
              <div className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{c.label}</div>
              <p className="text-xs text-zinc-600 dark:text-zinc-300">{c.summary}</p>
              <FailingList failing={c.failing} />
            </div>
          ))}
          {canWrite ? <StatusForm item={item} onSaved={onSaved} /> : null}
          <ItemHistory code={item.code} />
        </div>
      ) : null}
    </div>
  );
}

function ScanHistory({ report }: { report: Report }) {
  if (!report.scans.length) return null;
  return (
    <div className={`${AdminUI.card} p-4`}>
      <h3 className={AdminUI.cardTitle}>Scan history</h3>
      <div className="mt-3 overflow-x-auto">
        <table className={AdminUI.table}>
          <thead className={AdminUI.thead}>
            <tr>
              <th className={AdminUI.th}>Scan</th>
              {report.checks.map((c) => <th key={c.key} className={AdminUI.th} title={c.label}>{c.items.join(', ')}</th>)}
            </tr>
          </thead>
          <tbody>
            {report.scans.map((s) => (
              <tr key={s.id} className={AdminUI.trHover}>
                <td className={AdminUI.td}>{fmtDate(s.finishedAt)}</td>
                {report.checks.map((c) => {
                  const r = s.results.find((x) => x.key === c.key);
                  return (
                    <td key={c.key} className={AdminUI.td}>
                      {r ? <span className={checkBadgeClass(r.state)} title={r.summary}>{checkBadgeText(r).replace('Scan: ', '')}</span> : '·'}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'ready'; report: Report };

function ComplianceSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [area, setArea] = useState('');
  const [scanning, setScanning] = useState(false);
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(async () => {
    const { data } = await (window as any).AdminConsole.fetchJson('/api/admin/compliance');
    if (!alive.current) return;
    if (!data || !Array.isArray(data.items)) {
      setLoad({ kind: 'error', error: 'Couldn’t load the compliance report. Try Refresh.' });
      return;
    }
    setLoad({ kind: 'ready', report: data as Report });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const scanNow = async () => {
    setScanning(true);
    setStatus(null);
    const { ok, status: http, data } = await postJson('/api/admin/compliance/scan', {});
    if (!alive.current) return;
    setScanning(false);
    if (!ok || !data || !Array.isArray(data.items)) {
      setStatus({ text: (data && data.error) || 'The scan did not run.', ok: false });
      return;
    }
    setLoad({ kind: 'ready', report: data as Report });
    if (http === 202) setStatus({ text: 'Still scanning. Its results will show here when it ends.', ok: true });
    else if (data.scanError) setStatus({ text: `The scan stopped early: ${data.scanError}`, ok: false });
    else setStatus({ text: 'Scan finished.', ok: true });
  };

  const report = load.kind === 'ready' ? load.report : null;
  const items = report ? report.items.filter((i) => !area || i.area === area) : [];

  return (
    <div id="admin-compliance-panel" className="space-y-4">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Compliance</h2>
          <button id="admin-compliance-refresh" type="button" className={`${AdminUI.btn.link} text-xs px-1 py-1`}
            onClick={() => { setStatus(null); refresh(); }}>Refresh</button>
        </div>
        <p className={AdminUI.cardDescription}>
          Every action of the compliance plan. An admin sets each status by hand; the scan checks what a machine can
          and never changes a status. An item a scan fails on is listed first.
        </p>
        {load.kind === 'loading' ? <p className={`${AdminUI.loading} mt-3`}>Loading…</p> : null}
        {load.kind === 'error' ? <p className="text-sm text-red-700 dark:text-red-400 mt-3">{load.error}</p> : null}
        {report ? (
          <div className="mt-4 space-y-3">
            <div id="admin-compliance-counts" className="flex flex-wrap items-center gap-2">
              <span className={STATUS_BADGE.done}>{`${report.counts.done} done`}</span>
              <span className={STATUS_BADGE.partial}>{`${report.counts.partial} partly done`}</span>
              <span className={STATUS_BADGE.todo}>{`${report.counts.todo} to do`}</span>
              {report.attention ? (
                <span className={AdminUI.badge.destructive}>
                  {`${report.attention} ${report.attention === 1 ? 'item fails' : 'items fail'} the latest scan`}
                </span>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span id="admin-compliance-scan-line" className="text-sm text-zinc-900 dark:text-zinc-100">{scanLine(report)}</span>
              {canWrite ? (
                <button id="admin-compliance-scan" type="button" className={AdminUI.btn.outlineSm}
                  disabled={scanning} onClick={scanNow}>
                  {scanning ? 'Scanning…' : 'Scan now'}
                </button>
              ) : null}
              {status ? (
                <span className={status.ok
                  ? 'text-xs text-emerald-700 dark:text-emerald-400'
                  : 'text-xs text-red-700 dark:text-red-400'}>{status.text}</span>
              ) : null}
            </div>
            <div className="max-w-xs">
              <label htmlFor="admin-compliance-area" className={AdminUI.label}>Area</label>
              <select id="admin-compliance-area" className={`${AdminUI.select} mt-1`} value={area}
                onChange={(e) => setArea(e.target.value)}>
                <option value="">All areas</option>
                {report.areas.map((a) => <option key={a.key} value={a.key}>{`${a.key} · ${a.label}`}</option>)}
              </select>
            </div>
          </div>
        ) : null}
      </div>

      {report ? (
        <div id="admin-compliance-list" className="space-y-2">
          {items.map((i) => (
            <ItemRow key={i.code} item={i} canWrite={canWrite}
              onSaved={(r) => { if (alive.current) setLoad({ kind: 'ready', report: r }); }} />
          ))}
        </div>
      ) : null}

      {report ? <ScanHistory report={report} /> : null}
    </div>
  );
}

let host: Element | null = null;

const AdminCompliance = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <ComplianceSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminCompliance = AdminCompliance;

export { AdminCompliance };
