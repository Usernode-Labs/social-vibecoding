'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { eventOptions, fetchAllEvents, fetchJson, send } from './api.ts';
import { BTN } from './tokens.ts';
import {
  CheckField, EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, Input, List,
  Options, Pager, Panel, ScreenHeader, Select, Skeleton, Textarea,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';

// Programme users — full CRUD, toggle-exclude-podium, CSV import and CSV
// export. `accept_logs` lives here too (the mobile-logs API gap: no admin
// endpoint lists per-user log payloads, so the one related capability is
// surfaced as a field on this form rather than as a dead "Mobile logs" tab).
//
// NOT a screen of its own. Since #1179 it renders INSIDE the console's Users
// section — one Users menu entry, both user surfaces — below the platform
// accounts card.
//
// ── React-owned (#1120 slice 35) ──────────────────────────────────────
//
// The last innerHTML surface in the admin console, and the one that closes
// the AGENTS.md legacy-host seam it was the example of:
// `#admin-users-programme` was a div admin-users.tsx rendered once with a
// constant className and never looked inside, because admin-topochain.js
// filled it. It is a child component now, so the host is gone, the
// `except: ['#admin-users-programme']` exemption in
// scripts/audit-react-ownership.mjs goes with it, and the whole Users section
// is one React tree.
//
// Two things worth keeping in view:
//
//   - THE TYPED DELETE. This DELETE has no server-side confirmation body
//     param at all (only a self-delete guard and a last-full-admin guard) and
//     it targets the SHARED platform users table — it can remove a real
//     login, including another admin, not just a programme row. The admin
//     must type the user's own displayed identifier exactly before the real
//     Delete button enables.
//   - The confirm block is layout-neutral (no <tr>/<td>): the shared list
//     renders it as a full-width row under the table row AND inside the card
//     on a phone.
//
// Ids are like-for-like — `admin-topo-u-*`.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

type User = {
  id: number;
  email?: string | null;
  telegram?: string | null;
  discord?: string | null;
  display_name?: string | null;
  exclude_podium?: boolean;
  accept_logs?: boolean;
  events?: { id: number; name?: string }[];
};

type SeasonEvent = { id: number; name: string };

const ident = (u: User) => u.email || u.telegram || u.discord || `user #${u.id}`;

function DeleteConfirm({ user, onCancel, onConfirm }: {
  user: User;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const expected = ident(user);
  const [typed, setTyped] = useState('');
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-4">
      <p className="text-xs text-red-700 dark:text-red-300 mb-3">
        {'This permanently deletes '}
        <strong>{expected}</strong>
        {' from the platform users table — this can be ANY platform user, including real logins '}
        {'and other admins, not just a user of this programme. Type '}
        <code>{expected}</code>
        {' exactly to confirm.'}
      </p>
      <input
        data-typed-check={user.id}
        data-expect={expected}
        type="text"
        aria-label="Type the identifier to confirm deletion"
        className="w-full rounded-lg bg-white dark:bg-zinc-900 border border-red-300 dark:border-red-800 px-3 py-2 text-xs font-mono min-h-[44px] sm:min-h-[36px] focus:outline-none focus:ring-2 focus:ring-red-500 sm:max-w-sm"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          data-confirm-delete-u={user.id}
          type="button"
          disabled={typed !== expected}
          className={BTN.dangerSm}
          onClick={onConfirm}
        >
          Delete permanently
        </button>
        <button
          data-cancel-delete-u={user.id}
          type="button"
          className={BTN.secondarySm}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function UserForm({ id, events, onClose, onSaved }: {
  id: number | null;
  events: SeasonEvent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(id == null);
  const [email, setEmail] = useState('');
  const [telegram, setTelegram] = useState('');
  const [discord, setDiscord] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [acceptLogs, setAcceptLogs] = useState(true);
  const [enrolled, setEnrolled] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (id == null) return;
    (async () => {
      const { ok, data } = await fetchJson(`/api/v4/admin/users/${encodeURIComponent(id)}`);
      if (!alive.current) return;
      const u: User | null = ok && data?.success ? data.data : null;
      if (u) {
        setEmail(u.email || '');
        setTelegram(u.telegram || '');
        setDiscord(u.discord || '');
        setDisplayName(u.display_name || '');
        setAcceptLogs(!!u.accept_logs);
        setEnrolled((u.events || []).map((e) => String(e.id)));
      }
      setLoaded(true);
    })();
  }, [id]);

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    const body = {
      email: email.trim() || null,
      telegram: telegram.trim() || null,
      discord: discord.trim() || null,
      display_name: displayName.trim() || null,
      accept_logs: acceptLogs,
      season_event_ids: enrolled.map((v) => parseInt(v, 10)),
    };
    if (!body.email && !body.telegram && !body.discord) {
      setError('At least one identifier (email, telegram, or discord) is required.');
      return;
    }
    const url = id == null
      ? '/api/v4/admin/users'
      : `/api/v4/admin/users/${encodeURIComponent(id)}`;
    const { ok, data } = await send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [email, telegram, discord, displayName, acceptLogs, enrolled, id, onSaved]);

  return (
    <Panel
      title={id == null ? 'New user' : `Edit user #${id}`}
      subtitle="At least one identifier is required. Enrolment is set here too."
      onClose={onClose}
      closeLabel="Close the user form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save user" />}
    >
      {!loaded ? <Skeleton rows={3} /> : (
        <>
          <FormGrid>
            <Field label="Email" htmlFor="admin-topo-u-f-email">
              <Input id="admin-topo-u-f-email" type="text" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Telegram" htmlFor="admin-topo-u-f-telegram">
              <Input id="admin-topo-u-f-telegram" type="text" value={telegram} onChange={(e) => setTelegram(e.target.value)} />
            </Field>
            <Field label="Discord" htmlFor="admin-topo-u-f-discord">
              <Input id="admin-topo-u-f-discord" type="text" value={discord} onChange={(e) => setDiscord(e.target.value)} />
            </Field>
            <Field label="Display name" htmlFor="admin-topo-u-f-display_name">
              <Input id="admin-topo-u-f-display_name" type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
          </FormGrid>
          <div className="mt-4 border-t border-zinc-200 dark:border-zinc-800 pt-3">
            <CheckField
              id="admin-topo-u-f-accept_logs"
              label="Accept logs"
              help="Mobile log opt-out lives here — no separate log-payload viewer exists; see Task 15 notes."
              checked={acceptLogs}
              onChange={setAcceptLogs}
            />
          </div>
          <div className="mt-4">
            <Field
              label="Events (ctrl/cmd-click to select multiple)"
              htmlFor="admin-topo-u-f-events"
            >
              <Select
                id="admin-topo-u-f-events"
                multiple
                size={5}
                value={enrolled}
                onChange={(e) => setEnrolled(
                  [...e.target.selectedOptions].map((o) => o.value),
                )}
              >
                <Options options={events.map((ev) => ({ value: ev.id, label: `${ev.name} (#${ev.id})` }))} />
              </Select>
            </Field>
          </div>
          <FormError message={error} />
        </>
      )}
    </Panel>
  );
}

function ImportPanel({ events, onClose, onImported }: {
  events: SeasonEvent[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [eventId, setEventId] = useState('');
  const [rows, setRows] = useState('');
  const [link, setLink] = useState(false);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);

  const run = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    if (!eventId) { setError('Choose an event.'); return; }
    const participants = rows.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [email, username] = line.split(',').map((s) => (s || '').trim());
      return { email, username };
    });
    if (!participants.length) { setError('Add at least one user row.'); return; }
    const body: Record<string, unknown> = {
      season_event_id: parseInt(eventId, 10),
      participants,
      link_accounts: link,
    };
    if (min.trim() !== '') body.min_balance = Number(min.trim());
    if (max.trim() !== '') body.max_balance = Number(max.trim());
    const { ok, data } = await send('POST', '/api/v4/admin/users/import-csv', body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Import failed.'); return; }
    setResult(data.data);
    onImported();
  }, [eventId, rows, link, min, max, onImported]);

  return (
    <Panel
      title="Import users"
      subtitle="CSV-style, one user per line."
      onClose={onClose}
      closeLabel="Close the import panel"
      footer={(
        <>
          <button id="admin-topo-u-imp-go" type="button" className={BTN.primary} onClick={run}>Import</button>
          <button id="admin-topo-u-imp-cancel" type="button" className={BTN.secondary} onClick={onClose}>Cancel</button>
        </>
      )}
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label="Event *" htmlFor="admin-topo-u-imp-event">
          <Select id="admin-topo-u-imp-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <Options options={eventOptions(events)} blank="Choose an event…" />
          </Select>
        </Field>
        <Field
          label={'Users — one "email,username" per line *'}
          htmlFor="admin-topo-u-imp-rows"
          help="username here maps to the Discord handle column, per the import API."
        >
          <Textarea id="admin-topo-u-imp-rows" rows={8} value={rows} onChange={(e) => setRows(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 border-t border-zinc-200 dark:border-zinc-800 pt-3">
        <CheckField
          id="admin-topo-u-imp-link"
          label="Link onchain accounts too"
          checked={link}
          onChange={setLink}
        />
      </div>
      <div className="mt-3">
        <FormGrid>
          <Field label="Min balance" htmlFor="admin-topo-u-imp-min">
            <Input id="admin-topo-u-imp-min" type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} />
          </Field>
          <Field label="Max balance" htmlFor="admin-topo-u-imp-max">
            <Input id="admin-topo-u-imp-max" type="number" min={0} value={max} onChange={(e) => setMax(e.target.value)} />
          </Field>
        </FormGrid>
      </div>
      <FormError message={error} />
      <div id="admin-topo-u-imp-result" className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {result ? (
          <>
            {`Created ${result.created_count}, linked ${result.linked_count}, `
              + `added to event ${result.added_to_phase_count}, `
              + `already enrolled ${result.already_in_phase_count}, `
              + `skipped ${result.skipped_count}.`}
            {(result.errors || []).map((e: string, i: number) => <div key={i}>{e}</div>)}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

// Export users for one event. Was a window.prompt() listing "id: name" pairs
// the operator had to read and retype — an inline panel with a real <select>
// now, rendered into the same slot the New/Import forms use so only one of
// the three is ever open.
function ExportPanel({ events, loaded, onClose }: {
  events: SeasonEvent[];
  loaded: boolean;
  onClose: () => void;
}) {
  const [eventId, setEventId] = useState('');
  useEffect(() => {
    if (!eventId && events.length) setEventId(String(events[0].id));
  }, [events, eventId]);

  if (!loaded) return <Panel title="Export users as CSV"><Skeleton rows={2} /></Panel>;
  if (!events.length) {
    return (
      <Panel title="Export users as CSV" onClose={onClose} closeLabel="Close the export panel">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          There is no event to export users for yet.
        </p>
      </Panel>
    );
  }
  return (
    <Panel
      title="Export users as CSV"
      subtitle="Downloads every user enrolled in the selected event."
      onClose={onClose}
      closeLabel="Close the export panel"
      footer={(
        <>
          <button
            id="admin-topo-u-exp-go"
            type="button"
            className={BTN.primary}
            onClick={() => {
              const id = parseInt(eventId, 10);
              if (!Number.isInteger(id) || id <= 0) return;
              // Same-origin, server-generated path built from a numeric id we
              // just fetched ourselves (never attacker-controlled) —
              // navigation, not a Blob, since this is a streamed CSV
              // attachment.
              window.location.href = `/api/v4/admin/users/export-csv/${encodeURIComponent(id)}`;
            }}
          >
            Download CSV
          </button>
          <button id="admin-topo-u-exp-cancel" type="button" className={BTN.secondary} onClick={onClose}>
            Cancel
          </button>
        </>
      )}
    >
      <Field label="Event" htmlFor="admin-topo-u-exp-event">
        <Select id="admin-topo-u-exp-event" value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <Options options={events.map((e) => ({ value: e.id, label: `${e.name} (#${e.id})` }))} />
        </Select>
      </Field>
    </Panel>
  );
}

type OpenPanel =
  | { kind: 'none' }
  | { kind: 'form'; id: number | null }
  | { kind: 'import' }
  | { kind: 'export' };

function ProgrammeUsers() {
  const write = canWrite();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<User[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [open, setOpen] = useState<OpenPanel>({ kind: 'none' });
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [events, setEvents] = useState<SeasonEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const list = await fetchAllEvents();
      if (!alive.current) return;
      setEvents(list);
      setEventsLoaded(true);
    })();
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: '50' });
    if (search) params.set('search', search);
    const res = await fetchJson(`/api/v4/admin/users?${params}`);
    if (!alive.current) return;
    if (res.ok && res.data?.success) {
      setItems(res.data.data);
      setMeta(res.data.meta || null);
      setError(null);
      return;
    }
    setItems([]);
    setMeta(null);
    setError({ status: res.status, message: (res.data && res.data.error) || null });
  }, [page, search]);

  useEffect(() => { load(); }, [load]);

  const commitSearch = useCallback((raw: string) => {
    const next = raw.trim();
    setSearch((current) => (current === next ? current : next));
    setPage(1);
  }, []);

  const togglePodium = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const { ok, data } = await send(
      'PATCH', `/api/v4/admin/users/${encodeURIComponent(id)}/toggle-exclude-podium`);
    if (ok && data?.success) { load(); return; }
    topo()._alert((data && data.error) || 'Update failed.');
  }, [load]);

  const remove = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const res = await send('DELETE', `/api/v4/admin/users/${encodeURIComponent(id)}`);
    setDeleteConfirm(null);
    if (res.ok && res.data?.success) { load(); return; }
    topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  const columns: Column<User>[] = [
    { label: 'User', primary: true, cell: (u) => u.display_name || ident(u) },
    { label: 'Email', cell: (u) => u.email || '—', tdClass: 'text-xs text-zinc-500' },
    { label: 'Telegram', cell: (u) => u.telegram || '—', tdClass: 'text-xs text-zinc-500' },
    { label: 'Discord', cell: (u) => u.discord || '—', tdClass: 'text-xs text-zinc-500' },
    {
      label: 'Podium',
      cell: (u) => (u.exclude_podium
        ? <span className="text-amber-600 dark:text-amber-400">excluded</span>
        : '—'),
    },
    { label: 'Accept logs', cell: (u) => (u.accept_logs ? 'yes' : 'no') },
  ];

  const close = useCallback(() => setOpen({ kind: 'none' }), []);

  return (
    <>
      <ScreenHeader
        title="Programme users"
        subtitle="Everyone enrolled in an event, and their podium and log settings."
        actions={(
          <>
            {/* Commits on blur or Enter, not per keystroke — a paged server
                query, same rule as the other search boxes in this console. */}
            <Input
              id="admin-topo-u-search"
              type="text"
              placeholder="Search email/telegram/discord/name…"
              aria-label="Search users"
              className="sm:w-64"
              defaultValue={search}
              onBlur={(e) => commitSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch((e.target as HTMLInputElement).value);
              }}
            />
            {write ? (
              <button
                id="admin-topo-u-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setOpen({ kind: 'form', id: null })}
              >
                New user
              </button>
            ) : null}
            {write ? (
              <button
                id="admin-topo-u-import"
                type="button"
                className={BTN.secondarySm}
                onClick={() => setOpen({ kind: 'import' })}
              >
                Import CSV…
              </button>
            ) : null}
            <button
              id="admin-topo-u-export"
              type="button"
              className={BTN.secondarySm}
              onClick={() => setOpen({ kind: 'export' })}
            >
              Export CSV…
            </button>
          </>
        )}
      />
      <div id="admin-topo-u-form">
        {open.kind === 'form' && write ? (
          <UserForm
            key={String(open.id)}
            id={open.id}
            events={events}
            onClose={close}
            onSaved={() => { close(); load(); }}
          />
        ) : null}
        {open.kind === 'import' && write ? (
          <ImportPanel events={events} onClose={close} onImported={load} />
        ) : null}
        {open.kind === 'export' ? (
          <ExportPanel events={events} loaded={eventsLoaded} onClose={close} />
        ) : null}
      </div>
      <div id="admin-topo-u-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load users"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title={search ? 'No users match that search' : 'No users yet'}
            body={search
              ? 'Clear the search box to see everyone.'
              : 'Users appear here once they join an event, or you can add one directly.'}
            action={!search && write ? (
              <button
                id="admin-topo-u-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setOpen({ kind: 'form', id: null })}
              >
                New user
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <>
            <List
              items={items}
              rowKey={(u) => u.id}
              columns={columns}
              actions={write ? (u) => (
                <>
                  <button
                    data-toggle-podium={u.id}
                    type="button"
                    className={BTN.row}
                    onClick={() => togglePodium(u.id)}
                  >
                    Toggle podium
                  </button>
                  <button
                    data-edit-u={u.id}
                    type="button"
                    className={BTN.row}
                    onClick={() => setOpen({ kind: 'form', id: u.id })}
                  >
                    Edit
                  </button>
                  <button
                    data-delete-u={u.id}
                    data-identifier={ident(u)}
                    type="button"
                    className={BTN.rowDanger}
                    onClick={() => setDeleteConfirm(u.id)}
                  >
                    Delete
                  </button>
                </>
              ) : undefined}
              // The typed-identifier confirm rides along as the row's extra
              // block, so it lands directly under the row in the table AND
              // inside the card on a phone.
              extra={(u) => (deleteConfirm === u.id ? (
                <DeleteConfirm
                  user={u}
                  onCancel={() => setDeleteConfirm(null)}
                  onConfirm={() => remove(u.id)}
                />
              ) : null)}
              rowClass={(u) => (deleteConfirm === u.id ? 'bg-red-50 dark:bg-red-950/30' : '')}
            />
            <Pager meta={meta} onPage={setPage} />
          </>
        ) : null}
      </div>
    </>
  );
}

export { ProgrammeUsers };
