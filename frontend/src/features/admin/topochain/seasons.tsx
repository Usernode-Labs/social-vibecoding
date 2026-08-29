'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson, send } from './api.ts';
import { BTN, PANEL_CLS } from './tokens.ts';
import {
  Badge, CheckField, EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, Input, List,
  Pager, Panel, ScreenHeader, Skeleton, Textarea, fmt, isoToLocalInput, localInputToIso,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';

// Seasons — full CRUD against /api/v4/admin/seasons, the top tier of
// Season → Season event → Challenge.
//
// Delete is guarded server-side: a season still referenced by events,
// enrollments, onchain accounts or token allocations comes back 409
// `season_in_use` with a message naming what is in the way, which is
// surfaced verbatim rather than second-guessed here.
//
// ── React-owned (#1120 slice 33) ──────────────────────────────────────
//
// Tenth screen through the portal seam. Two things worth naming:
//
//   - The status chip is DERIVED client-side from starts_at/ends_at/is_active
//     rather than asked of the API: the API returns the raw window (there is
//     no server-computed status field) and "is it running right now" is a
//     question about the viewer's clock anyway. `seasonStatus` below is that
//     rule, moved with the screen.
//   - "View events" and "Show in Season events" hand the Season events screen
//     a PRE-SET FILTER rather than a free-text search, because season_id is
//     an exact filter the API does itself. That screen is still the innerHTML
//     one, so the handoff writes `AdminTopochain._se` — its own state — and
//     then jumps. When Season events converts, this becomes an explicit
//     export the way onchain-accounts' openAccountDetail did.
//
// Ids are like-for-like — `admin-topo-sn-*`.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

type Season = {
  id: number;
  name: string;
  description?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  pool_info?: string | null;
  display_order?: number | null;
  is_active: boolean;
  internal?: boolean;
  season_events_count?: number | null;
  users_count?: number | null;
};

type UnassignedEvent = {
  id: number;
  name: string;
  type: string;
  starts_at?: string | null;
  ends_at?: string | null;
};

// Where a season sits relative to now. Derived client-side — see the header.
export function seasonStatus(s: Season): { label: string; tone: string } {
  const now = Date.now();
  const starts = s.starts_at ? new Date(s.starts_at).getTime() : null;
  const ends = s.ends_at ? new Date(s.ends_at).getTime() : null;
  if (!s.is_active) return { label: 'Inactive', tone: 'zinc' };
  if (ends != null && !Number.isNaN(ends) && ends < now) return { label: 'Closed', tone: 'zinc' };
  if (starts != null && !Number.isNaN(starts) && starts > now) return { label: 'Upcoming', tone: 'amber' };
  return { label: 'Running', tone: 'green' };
}

// Hands the Season events screen a pre-set season filter and jumps there.
// `_se` is that (still innerHTML) screen's own state; it reads it on render.
function gotoSeasonEvents(seasonFilter: string) {
  const t = topo();
  if (!t) return;
  t._se.seasonFilter = seasonFilter;
  t._se.page = 1;
  t._se.detailId = null;
  t._gotoSub('season-events');
}

function SeasonForm({ id, onClose, onSaved }: {
  id: number | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(id == null);
  const [name, setName] = useState('');
  const [displayOrder, setDisplayOrder] = useState('0');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [poolInfo, setPoolInfo] = useState('');
  const [description, setDescription] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [internal, setInternal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (id == null) return;
    (async () => {
      const { ok, data } = await fetchJson(`/api/v4/admin/seasons/${encodeURIComponent(id)}`);
      if (!alive.current) return;
      const sn: Season | null = ok && data?.success ? data.data : null;
      if (sn) {
        setName(sn.name || '');
        setDisplayOrder(String(sn.display_order ?? 0));
        setStartsAt(isoToLocalInput(sn.starts_at));
        setEndsAt(isoToLocalInput(sn.ends_at));
        setPoolInfo(sn.pool_info || '');
        setDescription(sn.description || '');
        setIsActive(sn.is_active);
        setInternal(!!sn.internal);
      }
      setLoaded(true);
    })();
  }, [id]);

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    const order = displayOrder.trim();
    const body = {
      name: name.trim(),
      description: description.trim() || null,
      starts_at: localInputToIso(startsAt),
      ends_at: localInputToIso(endsAt),
      pool_info: poolInfo.trim() || null,
      display_order: order === '' ? 0 : Number(order),
      is_active: isActive,
      internal,
    };
    if (!body.name) { setError('Name is required.'); return; }
    if (!body.starts_at || !body.ends_at) { setError('Starts at and ends at are required.'); return; }
    if (new Date(body.ends_at) <= new Date(body.starts_at)) {
      setError('Ends at must be after starts at.');
      return;
    }
    const url = id == null
      ? '/api/v4/admin/seasons'
      : `/api/v4/admin/seasons/${encodeURIComponent(id)}`;
    const { ok, data } = await send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [name, description, startsAt, endsAt, poolInfo, displayOrder, isActive, internal, id, onSaved]);

  return (
    <Panel
      title={id == null ? 'New season' : `Edit season #${id}`}
      subtitle="Name, window and visibility. Season events are attached from the Season events screen."
      onClose={onClose}
      closeLabel="Close the season form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save season" />}
    >
      {!loaded ? <Skeleton rows={3} /> : (
        <>
          <FormGrid>
            <Field label="Name *" htmlFor="admin-topo-sn-f-name">
              <Input
                id="admin-topo-sn-f-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label="Display order"
              htmlFor="admin-topo-sn-f-display_order"
              help="Lowest first in the seasons list."
            >
              <Input
                id="admin-topo-sn-f-display_order"
                type="number"
                value={displayOrder}
                onChange={(e) => setDisplayOrder(e.target.value)}
              />
            </Field>
            <Field label="Starts at *" htmlFor="admin-topo-sn-f-starts_at">
              <Input
                id="admin-topo-sn-f-starts_at"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </Field>
            <Field label="Ends at *" htmlFor="admin-topo-sn-f-ends_at">
              <Input
                id="admin-topo-sn-f-ends_at"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </Field>
            <Field
              label="Pool info"
              htmlFor="admin-topo-sn-f-pool_info"
              help={'Free text shown with the reward pool, e.g. "1,000,000 TOPO".'}
              className="md:col-span-2"
            >
              <Input
                id="admin-topo-sn-f-pool_info"
                type="text"
                value={poolInfo}
                onChange={(e) => setPoolInfo(e.target.value)}
              />
            </Field>
            <Field
              label="Description"
              htmlFor="admin-topo-sn-f-description"
              className="md:col-span-2"
            >
              <Textarea
                id="admin-topo-sn-f-description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
          </FormGrid>
          <fieldset className="mt-5 border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <legend className="sr-only">Visibility</legend>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-300">
              Visibility
            </p>
            <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
              <CheckField
                id="admin-topo-sn-f-is_active"
                label="Active"
                checked={isActive}
                onChange={setIsActive}
              />
              <CheckField
                id="admin-topo-sn-f-internal"
                label="Internal"
                help="Hidden from the public app; for dry runs."
                checked={internal}
                onChange={setInternal}
              />
            </div>
          </fieldset>
          <FormError message={error} />
        </>
      )}
    </Panel>
  );
}

// Events with no season at all are invisible from the seasons list by
// definition, and they are exactly the rows an admin needs to notice (a new
// event nobody linked up yet). One extra request, rendered only when the
// count is non-zero.
function UnassignedEvents({ reloadKey }: { reloadKey: number }) {
  const [events, setEvents] = useState<UnassignedEvent[]>([]);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson(
        '/api/v4/admin/season-events?season_id=none&per_page=100');
      if (!alive.current) return;
      setEvents(ok && data?.success && Array.isArray(data.data) ? data.data : []);
    })();
  }, [reloadKey]);

  if (!events.length) return null;
  return (
    <section className={`${PANEL_CLS} overflow-hidden`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 dark:border-zinc-800 px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Events not assigned to a season</h3>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-300">
            {`${events.length} event${events.length === 1 ? '' : 's'} with no season. Edit one to link it.`}
          </p>
        </div>
        <button
          id="admin-topo-sn-unassigned-go"
          type="button"
          className={BTN.secondarySm}
          onClick={() => gotoSeasonEvents('none')}
        >
          Show in Season events
        </button>
      </header>
      <ul className="px-4 py-2 sm:px-5">
        {events.map((ev) => (
          <li
            key={ev.id}
            className="flex flex-col gap-1 py-2 border-t border-zinc-100 dark:border-zinc-800 first:border-t-0 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-2"
          >
            <span className="text-sm">
              {ev.name}
              <span className="text-xs text-zinc-500 dark:text-zinc-300">{` (${ev.type})`}</span>
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-300">
              {`${fmt(ev.starts_at)} – ${fmt(ev.ends_at)}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SeasonsScreen() {
  const write = canWrite();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Season[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  // Bumped whenever a season is saved or deleted: an unassigned event can
  // become assigned (or a season's events orphaned), so that panel is stale.
  const [unassignedKey, setUnassignedKey] = useState(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: '20' });
    if (search) params.set('search', search);
    const res = await fetchJson(`/api/v4/admin/seasons?${params}`);
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

  const remove = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const confirmed = await topo()._confirm({
      title: 'Delete this season?',
      message: 'Seasons that still have events, enrollments, onchain accounts or token allocations cannot be deleted. Unlink or remove those first. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!confirmed) return;
    const res = await send('DELETE', `/api/v4/admin/seasons/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) { load(); setUnassignedKey((k) => k + 1); return; }
    // The 409 body names exactly what still references the season; show it
    // as-is rather than a generic "Delete failed."
    topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  const columns: Column<Season>[] = [
    { label: 'Name', primary: true, cell: (sn) => sn.name },
    {
      label: 'Status',
      cell: (sn) => {
        const st = seasonStatus(sn);
        return (
          <>
            <Badge label={st.label} tone={st.tone} />
            {/* The separating space is a text child of its own with a
                non-space character-free neighbour on each side, so it is
                written as a one-character string rather than a whitespace-only
                JSX expression, which cannot survive hydration (React #418). */}
            {sn.internal ? <span className="inline"> </span> : null}
            {sn.internal ? <Badge label="Internal" tone="violet" /> : null}
          </>
        );
      },
    },
    { label: 'Starts', cell: (sn) => fmt(sn.starts_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-300' },
    { label: 'Ends', cell: (sn) => fmt(sn.ends_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-300' },
    {
      label: 'Events',
      cell: (sn) => (sn.season_events_count != null ? sn.season_events_count : '—'),
      tdClass: 'text-zinc-500 dark:text-zinc-300',
    },
    {
      label: 'Users',
      cell: (sn) => (sn.users_count != null ? sn.users_count : '—'),
      tdClass: 'text-zinc-500 dark:text-zinc-300',
    },
    { label: 'Order', cell: (sn) => sn.display_order ?? 0, tdClass: 'text-zinc-500 dark:text-zinc-300' },
  ];

  return (
    <>
      <ScreenHeader
        title="Seasons"
        subtitle="The top tier: each season holds season events, which hold challenges."
        actions={(
          <>
            {/* Commits on blur or Enter, not per keystroke — a paged server
                query, same rule as the other search boxes in this console. */}
            <Input
              id="admin-topo-sn-search"
              type="text"
              placeholder="Search name…"
              aria-label="Search seasons"
              className="sm:w-56"
              defaultValue={search}
              onBlur={(e) => commitSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch((e.target as HTMLInputElement).value);
              }}
            />
            {write ? (
              <button
                id="admin-topo-sn-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New season
              </button>
            ) : null}
          </>
        )}
      />
      <div id="admin-topo-sn-form">
        {editing != null && write ? (
          <SeasonForm
            key={String(editing)}
            id={editing === 'new' ? null : editing}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); setUnassignedKey((k) => k + 1); }}
          />
        ) : null}
      </div>
      <div id="admin-topo-sn-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load seasons"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title={search ? 'No seasons match that search' : 'No seasons yet'}
            body={search
              ? 'Clear the search box to see every season.'
              : 'Create the first season, then add season events to it.'}
            action={!search && write ? (
              <button
                id="admin-topo-sn-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New season
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <>
            <List
              items={items}
              rowKey={(sn) => sn.id}
              columns={columns}
              actions={(sn) => (
                <>
                  <button
                    data-season-events={sn.id}
                    type="button"
                    className={BTN.rowPrimary}
                    onClick={() => gotoSeasonEvents(String(sn.id))}
                  >
                    View events
                  </button>
                  {write ? (
                    <button
                      data-edit={sn.id}
                      type="button"
                      className={BTN.row}
                      onClick={() => setEditing(sn.id)}
                    >
                      Edit
                    </button>
                  ) : null}
                  {write ? (
                    <button
                      data-delete={sn.id}
                      type="button"
                      className={BTN.rowDanger}
                      onClick={() => remove(sn.id)}
                    >
                      Delete
                    </button>
                  ) : null}
                </>
              )}
            />
            <Pager meta={meta} onPage={setPage} />
          </>
        ) : null}
      </div>
      <div id="admin-topo-sn-unassigned" className="mt-4">
        <UnassignedEvents reloadKey={unassignedKey} />
      </div>
    </>
  );
}

export { SeasonsScreen };
