'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
// The shared admin kit (26 Nov 2026): header, figures, tabs, bar, list and
// badges are the same parts every other admin page is drawn with.
import {
  Badge, EmptyState, Figures, List, ScreenHeader, Segmented, TABLE, TabPanel, Tabs, Toolbar,
} from './topochain/ui.tsx';
import type { Column, Figure } from './topochain/ui.tsx';

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

// A status is repeated down the list, so it takes the kit's soft tones:
// waiting, needs attention, done.
const STATUS_TONE: Record<Status, string> = { todo: 'sky', partial: 'amber', done: 'mint' };

const STATUSES: Status[] = ['todo', 'partial', 'done'];

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

function checkTone(state: CheckState): string {
  if (state === 'fail') return 'red';
  if (state === 'error') return 'amber';
  return 'mint';
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
          {/* Three short choices, all in view, where a select hid two of them. */}
          <div className={AdminUI.label}>Status</div>
          <div className="mt-1">
            <Segmented<Status>
              id={`${id}-status`}
              label="Status"
              value={status}
              options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
              onChange={setStatus}
            />
          </div>
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
                <Badge tone={checkTone(s.state)} label={s.state === 'pass' ? 'Pass' : s.state === 'fail' ? 'Fail' : 'Error'} />
                {` ${fmtDate(s.at)} · ${s.summary}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// The list's columns. The first one titles a row's card on a phone, where
// it is drawn inside a paragraph, so it holds spans only.
const ITEM_COLUMNS: Column<Item>[] = [
  {
    label: 'Action',
    primary: true,
    cell: (item) => (
      <span className="block min-w-0" data-compliance-item={item.code}>
        <span className="block text-xs font-semibold text-zinc-500 dark:text-zinc-400">{item.code}</span>
        <span className="block text-sm font-medium text-zinc-900 dark:text-zinc-100 break-words">{item.title}</span>
        {item.note ? <span className="block text-xs font-normal text-zinc-600 dark:text-zinc-300 mt-1 break-words">{item.note}</span> : null}
      </span>
    ),
  },
  { label: 'Priority', cell: (item) => <Badge tone="zinc" label={item.priority} /> },
  { label: 'Status', cell: (item) => <Badge tone={STATUS_TONE[item.status]} label={STATUS_LABEL[item.status]} /> },
  {
    label: 'Scan',
    cell: (item) => (
      <span className="inline-flex flex-wrap items-center gap-1">
        {item.checks.map((c) => (
          <span key={c.key} title={c.summary}><Badge tone={checkTone(c.state)} label={checkBadgeText(c)} /></span>
        ))}
      </span>
    ),
  },
  {
    label: 'Set',
    cell: (item) => (
      <span className="text-xs text-zinc-500 dark:text-zinc-400">{`${setLine(item)} · request #${item.issue}`}</span>
    ),
  },
];

// What a row's arrow opens: what each check found, the status form for an
// admin who may write, and the item's history.
function ItemDetails({ item, canWrite, onSaved }: { item: Item; canWrite: boolean; onSaved: (r: Report) => void }) {
  return (
    <div className="space-y-4">
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
  );
}

// A pivot (a scan down, a check across), so it is written out with the
// kit's table classes: the kit's list draws plain records.
function ScanHistory({ report }: { report: Report }) {
  if (!report.scans.length) return <EmptyState title="No scan yet" />;
  return (
    <div className={TABLE.wrap}>
      <table className={TABLE.table}>
        <thead className={TABLE.thead}>
          <tr>
            <th className={TABLE.th}>Scan</th>
            {report.checks.map((c) => <th key={c.key} className={TABLE.th} title={c.label}>{c.items.join(', ')}</th>)}
          </tr>
        </thead>
        <tbody>
          {report.scans.map((s) => (
            <tr key={s.id} className={TABLE.tr}>
              <td className={TABLE.td}>{fmtDate(s.finishedAt)}</td>
              {report.checks.map((c) => {
                const r = s.results.find((x) => x.key === c.key);
                return (
                  <td key={c.key} className={TABLE.td}>
                    {r ? (
                      <span title={r.summary}>
                        <Badge tone={checkTone(r.state)} label={checkBadgeText(r).replace('Scan: ', '')} />
                      </span>
                    ) : '·'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type ComplianceTab = 'actions' | 'scans';
const TABS_ID = 'admin-compliance-tabs';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; error: string }
  | { kind: 'ready'; report: Report };

function ComplianceSection() {
  const canWrite = !!(window as any).AdminConsole?.canWrite();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [area, setArea] = useState('');
  const [tab, setTab] = useState<ComplianceTab>('actions');
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

  const onSaved = (r: Report) => { if (alive.current) setLoad({ kind: 'ready', report: r }); };
  // Counts the report already carries.
  const figures: Figure[] = report ? [
    { key: 'done', label: 'Done', value: report.counts.done.toLocaleString(), tone: 'green' },
    { key: 'partial', label: 'Partly done', value: report.counts.partial.toLocaleString(), tone: 'yellow' },
    { key: 'todo', label: 'To do', value: report.counts.todo.toLocaleString(), tone: 'sky' },
    ...(report.attention ? [{
      key: 'attention',
      label: report.attention === 1 ? 'Item fails the latest scan' : 'Items fail the latest scan',
      value: report.attention.toLocaleString(),
      tone: 'yellow' as const,
    }] : []),
  ] : [];

  return (
    <div id="admin-compliance-panel">
      <ScreenHeader
        title="Compliance"
        subtitle="Every action of the compliance plan. An admin sets each status by hand; the scan checks what a machine can and never changes a status. An item a scan fails on is listed first."
        actions={(
          <>
            <button id="admin-compliance-refresh" type="button" className={AdminUI.btn.outlineSm}
              onClick={() => { setStatus(null); refresh(); }}>Refresh</button>
            {report && canWrite ? (
              <button id="admin-compliance-scan" type="button" className={AdminUI.btn.primarySm}
                disabled={scanning} onClick={scanNow}>
                {scanning ? 'Scanning…' : 'Scan now'}
              </button>
            ) : null}
          </>
        )}
      />
      {load.kind === 'loading' ? <p className={AdminUI.loading}>Loading…</p> : null}
      {load.kind === 'error' ? <p className="text-sm text-red-700 dark:text-red-400">{load.error}</p> : null}
      {report ? (
        <>
          <Figures id="admin-compliance-counts" items={figures} />
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <span id="admin-compliance-scan-line" className="text-sm text-zinc-900 dark:text-zinc-100">{scanLine(report)}</span>
            {status ? (
              <span className={status.ok
                ? 'text-xs text-emerald-700 dark:text-emerald-400'
                : 'text-xs text-red-700 dark:text-red-400'}>{status.text}</span>
            ) : null}
          </div>
          {/* Two jobs: the plan's actions, and the log of what each scan found. */}
          <Tabs<ComplianceTab>
            id={TABS_ID}
            label="Compliance"
            value={tab}
            onChange={setTab}
            tabs={[
              { key: 'actions', label: 'Actions' },
              { key: 'scans', label: 'Scan history' },
            ]}
          />
          <TabPanel tabsId={TABS_ID} tab="actions" active={tab === 'actions'}>
            {/* The areas come from the report and are more than four, so the
                filter stays a select. */}
            <Toolbar>
              <label htmlFor="admin-compliance-area" className={AdminUI.label}>Area</label>
              <div className="w-64 max-w-full">
                <select id="admin-compliance-area" className={AdminUI.select} value={area}
                  onChange={(e) => setArea(e.target.value)}>
                  <option value="">All areas</option>
                  {report.areas.map((a) => <option key={a.key} value={a.key}>{`${a.key} · ${a.label}`}</option>)}
                </select>
              </div>
            </Toolbar>
            <div id="admin-compliance-list">
              <List<Item>
                items={items}
                columns={ITEM_COLUMNS}
                rowKey={(i) => i.code}
                details={(i) => <ItemDetails item={i} canWrite={canWrite} onSaved={onSaved} />}
              />
            </div>
          </TabPanel>
          <TabPanel tabsId={TABS_ID} tab="scans" active={tab === 'scans'}>
            <ScanHistory report={report} />
          </TabPanel>
        </>
      ) : null}
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
