'use strict';

import { useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Welcome messages (#admin/welcome-dm): somebody let in gets a group
// conversation with the people chosen here, opened by a message from the
// first of them (src/services/welcome-dm.js).
//
// PERMISSIONS: visible to any admin; the fields and Save are gated on
// AdminConsole.canWrite() (canAdminWrite). The server enforces the same on
// PUT /api/admin/welcome-dm.
//
// `members` is edited as one comma-separated line of usernames and sent as
// a list; the server resolves each to an account and refuses a name it
// cannot find, so what is saved is always people who exist.

type Tone = 'ok' | 'err';
interface Status { text: string; tone: Tone }

interface Member { id: number; username: string | null; active: boolean }
interface RecentRow {
  userId: number; username: string; status: 'pending' | 'sent' | 'skipped' | 'failed';
  enqueuedAt: string; processedAt: string | null; conversationId: number | null;
  detail: string | null; attempts: number; waitingForUsername?: boolean;
}
interface Payload {
  enabled: boolean; members: Member[]; title: string; message: string;
  defaults: { title: string; message: string };
  limits: { title: number; message: number; members: number };
  updatedAt: string | null; updatedBy: string | null;
  pending: number; sent: number; recent: RecentRow[];
}

const LABEL = 'text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400';
const HELP = 'text-xs text-zinc-500 dark:text-zinc-400 mt-1';
const PREVIEW_NAME = 'newcomer';

const STATUS_BADGE: Record<RecentRow['status'], string> = {
  sent: AdminUI.badge.success,
  pending: AdminUI.badge.warn,
  skipped: AdminUI.badge.default,
  failed: AdminUI.badge.destructive,
};
const STATUS_LABEL: Record<RecentRow['status'], string> = {
  sent: 'Sent', pending: 'Waiting', skipped: 'Not sent', failed: 'Failed',
};
const DETAIL_TEXT: Record<string, string> = {
  expired: 'Waited too long to be sent.',
  left: 'They lost access or deleted their account first.',
  no_one_to_send: 'Nobody in the list could send it.',
  group_closed: 'The group was closed before the message went out.',
  group_refused: 'The group could not be opened.',
};

function membersLine(members: Member[]): string {
  return members.filter((m) => m.username).map((m) => `@${m.username}`).join(', ');
}

function parseMembers(raw: string): string[] {
  return raw.split(/[\s,]+/).map((s) => s.trim().replace(/^@/, '')).filter(Boolean);
}

function render(template: string): string {
  return template.split('{username}').join(PREVIEW_NAME);
}

function when(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

function detailFor(row: RecentRow): string {
  if (row.status === 'pending') {
    if (row.detail) return `Retrying: ${row.detail}`;
    return row.waitingForUsername ? 'Sent once they have picked a username.' : 'Sending within a minute.';
  }
  if (!row.detail) return '';
  return DETAIL_TEXT[row.detail] || row.detail;
}

// The settings form, once the payload is in. Its own component so the
// fields seed from the payload in their first render: the section never
// shows an editable field that has not read what is saved.
function WelcomeDmForm({ data, canWrite, onSaved }: {
  data: Payload; canWrite: boolean; onSaved: (next: Payload) => void;
}) {
  const [enabled, setEnabled] = useState(!!data.enabled);
  const [members, setMembers] = useState(membersLine(data.members || []));
  const [title, setTitle] = useState(data.title || '');
  const [message, setMessage] = useState(data.message || '');
  const [status, setStatus] = useState<Status | null>(null);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const save = async () => {
    setStatus(null);
    setSaving(true);
    try {
      const res = await fetch('/api/admin/welcome-dm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: parseMembers(members), title, message, enabled }),
      });
      const next = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(next.error || `Save failed (${res.status})`);
      if (!alive.current) return;
      setEnabled(!!next.enabled);
      setMembers(membersLine(next.members || []));
      setTitle(next.title || '');
      setMessage(next.message || '');
      onSaved(next);
      setStatus({
        text: next.enabled
          ? 'Saved. Everyone let in from now on gets this message.'
          : 'Saved. Nobody is sent a welcome message while this is off.',
        tone: 'ok',
      });
    } catch (err: any) {
      if (alive.current) setStatus({ text: err.message, tone: 'err' });
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const dis = !canWrite || saving;
  const inactive = (data.members || []).filter((m) => !m.active);
  let source = '';
  if (data.updatedAt) {
    const who = data.updatedBy ? ` by @${data.updatedBy}` : '';
    source = `Last changed${who} on ${String(data.updatedAt).slice(0, 10)}.`;
  }

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm text-zinc-900 dark:text-zinc-100" htmlFor="admin-welcome-dm-enabled">
        <input
          id="admin-welcome-dm-enabled" type="checkbox"
          className="h-4 w-4 rounded border-zinc-600 bg-zinc-800 text-violet-700 focus:ring-violet-500 dark:text-violet-400"
          checked={enabled} disabled={dis}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <span>Send a welcome message to everyone who joins</span>
      </label>
      <label className="block" htmlFor="admin-welcome-dm-members">
        <span className={LABEL}>People in the group</span>
        <input
          id="admin-welcome-dm-members" type="text" autoComplete="off" spellCheck={false}
          className={`${AdminUI.input} mt-1 disabled:opacity-60`}
          placeholder="@you, @teammate" disabled={dis}
          value={members} onChange={(e) => setMembers(e.target.value)}
        />
        <p className={HELP}>
          Usernames, separated by commas, up to {data.limits.members}. The first sends the
          message and owns the group.
        </p>
        {inactive.length ? (
          <p id="admin-welcome-dm-inactive" className="text-xs mt-1 text-amber-700 dark:text-amber-400">
            {inactive.length === 1 ? 'One person here' : `${inactive.length} people here`} can no
            longer use the platform and will be left out of new groups.
          </p>
        ) : null}
      </label>
      <label className="block" htmlFor="admin-welcome-dm-title">
        <span className={LABEL}>Group name</span>
        <input
          id="admin-welcome-dm-title" type="text" maxLength={data.limits.title}
          className={`${AdminUI.input} mt-1 disabled:opacity-60`}
          placeholder={data.defaults.title} disabled={dis}
          value={title} onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="block" htmlFor="admin-welcome-dm-message">
        <span className={LABEL}>First message</span>
        <textarea
          id="admin-welcome-dm-message" rows={4} maxLength={data.limits.message}
          className={`${AdminUI.textarea} mt-1 disabled:opacity-60`}
          placeholder={data.defaults.message} disabled={dis}
          value={message} onChange={(e) => setMessage(e.target.value)}
        />
        <p className={HELP}>
          {'{username}'} in the name or the message becomes the new person’s username.
        </p>
      </label>
      <div id="admin-welcome-dm-preview" className="rounded-xl bg-zinc-50 dark:bg-zinc-800/60 p-3">
        <p className={LABEL}>Preview</p>
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 mt-1">
          {render(title || data.defaults.title)}
        </p>
        <p className="text-sm text-zinc-700 dark:text-zinc-300 mt-1 whitespace-pre-wrap">
          {render(message || data.defaults.message)}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="admin-welcome-dm-source" className="text-xs text-zinc-500 dark:text-zinc-400">{source}</p>
        {canWrite ? (
          <button id="admin-welcome-dm-save" type="button" className={AdminUI.btn.primary}
            disabled={saving} onClick={save}>Save</button>
        ) : null}
      </div>
      <p id="admin-welcome-dm-status" className={status
        ? `text-xs ${status.tone === 'err' ? 'text-red-400' : 'text-green-800 dark:text-green-400'}`
        : 'text-xs hidden'}>
        {status ? status.text : ''}
      </p>
    </div>
  );
}

function RecentlyWelcomed({ data }: { data: Payload }) {
  return (
    <div id="admin-welcome-dm-recent" className={`${AdminUI.card} p-4`}>
      <div className={AdminUI.cardHeader}>
        <h2 className={AdminUI.cardTitle}>Recently welcomed</h2>
        <span id="admin-welcome-dm-counts" className="text-xs text-zinc-500 dark:text-zinc-400">
          {data.sent} sent · {data.pending} waiting
        </span>
      </div>
      {data.recent.length ? (
        <div className={AdminUI.tableWrap}>
          <table className={AdminUI.table} id="admin-welcome-dm-table">
            <thead className={AdminUI.thead}>
              <tr>
                <th className={AdminUI.th}>Person</th>
                <th className={AdminUI.th}>Status</th>
                <th className={AdminUI.th}>Joined</th>
                <th className={AdminUI.th}>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((row) => (
                <tr key={row.userId} className={AdminUI.trHover} data-welcome-user={row.userId}>
                  <td className={AdminUI.td}>@{row.username}</td>
                  <td className={AdminUI.td}>
                    <span className={STATUS_BADGE[row.status]}>{STATUS_LABEL[row.status]}</span>
                  </td>
                  <td className={`${AdminUI.td} text-xs text-zinc-500 dark:text-zinc-400`}>{when(row.enqueuedAt)}</td>
                  <td className={`${AdminUI.td} text-xs text-zinc-500 dark:text-zinc-400`}>{detailFor(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p id="admin-welcome-dm-empty" className={AdminUI.muted}>
          Nobody has been welcomed yet. People let in while this is on appear here.
        </p>
      )}
    </div>
  );
}

function WelcomeDmSection({ initial = null }: { initial?: Payload | null }) {
  const console_ = () => (window as any).AdminConsole;
  const canWrite = !!console_()?.canWrite();
  const [data, setData] = useState<Payload | null>(initial);
  const [loadFailed, setLoadFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { data: next } = await console_().fetchJson('/api/admin/welcome-dm');
      if (!alive.current) return;
      if (next && typeof next === 'object') setData(next);
      else setLoadFailed(true);
    })();
  }, []);

  return (
    <div id="admin-welcome-dm" className="space-y-4">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Welcome messages</h2>
          {data ? (
            <span id="admin-welcome-dm-state" className={data.enabled ? AdminUI.badge.success : AdminUI.badge.default}>
              {data.enabled ? 'On' : 'Off'}
            </span>
          ) : null}
        </div>
        <p id="admin-welcome-dm-intro" className={`${AdminUI.muted} mb-4`}>
          When someone is let in to the platform, they get a group conversation with the people
          below, opened by a message from the first of them. Everyone is in the group straight
          away, with nothing to accept, and the new person can leave it like any group. Only
          people let in while this is on are welcomed: switching it on messages nobody who
          joined before.
        </p>
        {data ? (
          <WelcomeDmForm data={data} canWrite={canWrite} onSaved={setData} />
        ) : (
          <p className={AdminUI.loading}>{loadFailed ? 'Could not load the settings.' : 'Loading…'}</p>
        )}
      </div>
      {data ? <RecentlyWelcomed data={data} /> : null}
    </div>
  );
}

let host: Element | null = null;

const AdminWelcomeDm = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <WelcomeDmSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminWelcomeDm = AdminWelcomeDm;

// The components are exported for tests/welcome-dm.test.js, which renders them.
export { AdminWelcomeDm, WelcomeDmSection, WelcomeDmForm, RecentlyWelcomed };
