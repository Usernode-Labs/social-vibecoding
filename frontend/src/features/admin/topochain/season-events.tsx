'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchAllSeasons, fetchJson, seasonOptions, send } from './api.ts';
import { EventDetail, publishRoute } from './challenges.tsx';
import { BTN } from './tokens.ts';
import {
  CheckField, EmptyState, ErrorState, Field, FormActions, FormError, FormGrid, Input, List,
  Options, Pager, Panel, ScreenHeader, Select, Skeleton, Textarea, fmt, isoToLocalInput,
  localInputToIso,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';

// Season events — full CRUD. Challenges are managed in the nested detail view
// (Manage button), not a separate top-level screen; that half lives in
// ./challenges.tsx.
//
// ── React-owned (#1120 slice 34) ──────────────────────────────────────
//
// The eleventh and last of admin-topochain.js's screens. Two seams it has to
// keep, both of them shared with code outside this file:
//
//   - THE ADDRESS. `_se.detailId` is what admin-topochain.js's
//     `_readSeasonEventsDeepLink` writes and its `_syncHash` reads, so the
//     detail view is deep-linkable. It stays the router's; this screen seeds
//     its own state from it on mount and publishes back through
//     `publishRoute` whenever the operator navigates.
//   - THE PRE-SET FILTER. The Seasons screen writes `_se.seasonFilter`
//     (a season id, `'none'`, or `''`) before jumping here, because season_id
//     is an exact filter the API applies itself. Seeded on mount, same as the
//     detail id.
//
// Both are read ONCE on mount rather than subscribed to: a jump into this
// screen re-mounts it (the console tears the section down on every switch),
// so there is no live-update case to handle.
//
// Ids are like-for-like — `admin-topo-se-*`.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

type SeasonEvent = {
  id: number;
  name: string;
  season_id?: number | null;
  season?: { name?: string } | null;
  type?: string | null;
  chain_id?: string | null;
  is_active?: boolean;
  internal?: boolean;
  display_leaderboard?: boolean;
  display_disclaimer?: boolean;
  display_activities?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
  score_start_time?: string | null;
  score_end_time?: string | null;
  start_epoch?: number | null;
  end_epoch?: number | null;
  rank_based_on_bp_or_success_rate?: string | null;
  account_inheritance_mode?: string | null;
  account_source_season_event_id?: number | null;
  scoring_formula?: { metrics?: string[]; offchain_weight?: number } | null;
  description?: string | null;
  disclaimer?: string | null;
  users_count?: number | null;
};

type Season = { id: number; name: string };

const RANK_OPTIONS = [
  { value: 'BP', label: 'Blocks produced' },
  { value: 'RATE', label: 'Success rate' },
];

function EventForm({ id, seasons, onClose, onSaved }: {
  id: number | null;
  seasons: Season[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(id == null);
  const [v, setV] = useState<Record<string, string>>({
    type: 'regular',
    rank_basis: 'BP',
    account_inheritance_mode: 'none',
    offchain_weight: '0',
    metrics: '',
  });
  const [flags, setFlags] = useState({
    is_active: true,
    internal: false,
    display_leaderboard: true,
    display_disclaimer: false,
    display_activities: false,
  });
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    if (id == null) return;
    (async () => {
      const { ok, data } = await fetchJson(`/api/v4/admin/season-events/${encodeURIComponent(id)}`);
      if (!alive.current) return;
      const ev: SeasonEvent | null = ok && data?.success ? data.data : null;
      if (ev) {
        const scoring = ev.scoring_formula || {};
        setV({
          name: ev.name || '',
          season_id: ev.season_id == null ? '' : String(ev.season_id),
          type: ev.type || 'regular',
          chain_id: ev.chain_id || '',
          starts_at: isoToLocalInput(ev.starts_at),
          ends_at: isoToLocalInput(ev.ends_at),
          score_start_time: isoToLocalInput(ev.score_start_time),
          score_end_time: isoToLocalInput(ev.score_end_time),
          start_epoch: ev.start_epoch == null ? '' : String(ev.start_epoch),
          end_epoch: ev.end_epoch == null ? '' : String(ev.end_epoch),
          rank_basis: ev.rank_based_on_bp_or_success_rate || 'BP',
          account_inheritance_mode: ev.account_inheritance_mode || 'none',
          account_source_season_event_id: ev.account_source_season_event_id == null
            ? '' : String(ev.account_source_season_event_id),
          offchain_weight: String(scoring.offchain_weight ?? 0),
          metrics: (scoring.metrics || []).join(', '),
          description: ev.description || '',
          disclaimer: ev.disclaimer || '',
        });
        setFlags({
          is_active: !!ev.is_active,
          internal: !!ev.internal,
          display_leaderboard: !!ev.display_leaderboard,
          display_disclaimer: !!ev.display_disclaimer,
          display_activities: !!ev.display_activities,
        });
      }
      setLoaded(true);
    })();
  }, [id]);

  const set = useCallback((k: string, value: string) => setV((s) => ({ ...s, [k]: value })), []);
  const flag = useCallback(
    (k: keyof typeof flags) => (next: boolean) => setFlags((f) => ({ ...f, [k]: next })),
    [],
  );

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    const t = (k: string) => (v[k] || '').trim();
    const num = (k: string) => { const raw = t(k); return raw === '' ? null : Number(raw); };
    const body = {
      name: t('name'),
      season_id: num('season_id'),
      type: v.type,
      chain_id: t('chain_id') || null,
      starts_at: localInputToIso(v.starts_at || ''),
      ends_at: localInputToIso(v.ends_at || ''),
      score_start_time: localInputToIso(v.score_start_time || ''),
      score_end_time: localInputToIso(v.score_end_time || ''),
      start_epoch: num('start_epoch'),
      end_epoch: num('end_epoch'),
      rank_based_on_bp_or_success_rate: v.rank_basis,
      account_inheritance_mode: t('account_inheritance_mode') || 'none',
      account_source_season_event_id: num('account_source_season_event_id'),
      scoring_formula: {
        metrics: (v.metrics || '').split(',').map((s) => s.trim()).filter(Boolean),
        offchain_weight: Number(v.offchain_weight || 0),
      },
      ...flags,
      description: t('description') || null,
      disclaimer: t('disclaimer') || null,
    };
    if (!body.name) { setError('Name is required.'); return; }
    if (!body.starts_at || !body.ends_at) {
      setError('Starts at and ends at are required.');
      return;
    }
    const url = id == null
      ? '/api/v4/admin/season-events'
      : `/api/v4/admin/season-events/${encodeURIComponent(id)}`;
    const { ok, data } = await send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [v, flags, id, onSaved]);

  const fid = (k: string) => `admin-topo-se-f-${k}`;
  const text = (k: string, label: string, help?: string, type = 'text', extra = {}) => (
    <Field key={k} label={label} htmlFor={fid(k)} help={help}>
      <Input id={fid(k)} type={type} value={v[k] || ''} onChange={(e) => set(k, e.target.value)} {...extra} />
    </Field>
  );

  return (
    <Panel
      title={id == null ? 'New event' : `Edit event #${id}`}
      subtitle="Schedule, scoring and what the event shows to users."
      onClose={onClose}
      closeLabel="Close the event form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save event" />}
    >
      {!loaded ? <Skeleton rows={4} /> : (
        <>
          <FormGrid>
            {text('name', 'Name *')}
            <Field
              label="Season"
              htmlFor={fid('season_id')}
              help="Manage the list on the Seasons screen."
            >
              <Select
                id={fid('season_id')}
                value={v.season_id || ''}
                onChange={(e) => set('season_id', e.target.value)}
              >
                <Options options={seasonOptions(seasons)} blank="No season" />
              </Select>
            </Field>
            <Field label="Type" htmlFor={fid('type')}>
              <Select id={fid('type')} value={v.type} onChange={(e) => set('type', e.target.value)}>
                <Options options={[
                  { value: 'regular', label: 'regular' },
                  { value: 'season', label: 'season' },
                ]}
                />
              </Select>
            </Field>
            {text('chain_id', 'Chain id')}
            {text('starts_at', 'Starts at *', undefined, 'datetime-local')}
            {text('ends_at', 'Ends at *', undefined, 'datetime-local')}
            {text('score_start_time', 'Score start time', undefined, 'datetime-local')}
            {text('score_end_time', 'Score end time', undefined, 'datetime-local')}
            {text('start_epoch', 'Start epoch', undefined, 'number', { min: 0 })}
            {text('end_epoch', 'End epoch', undefined, 'number', { min: 0 })}
            <Field label="Rank basis *" htmlFor={fid('rank_basis')}>
              <Select
                id={fid('rank_basis')}
                value={v.rank_basis}
                onChange={(e) => set('rank_basis', e.target.value)}
              >
                <Options options={RANK_OPTIONS} />
              </Select>
            </Field>
            {text('account_inheritance_mode', 'Account inheritance mode')}
            {text('account_source_season_event_id', 'Account source event id', undefined, 'number', { min: 1 })}
            {text('offchain_weight', 'Scoring: offchain weight *', undefined, 'number', { min: 0, step: '0.01' })}
            <Field
              label="Scoring: metrics (comma-separated) *"
              htmlFor={fid('metrics')}
              className="md:col-span-2"
            >
              <Input
                id={fid('metrics')}
                type="text"
                value={v.metrics || ''}
                onChange={(e) => set('metrics', e.target.value)}
              />
            </Field>
          </FormGrid>
          <fieldset className="mt-5 border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <legend className="sr-only">Visibility</legend>
            <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500">
              Visibility
            </p>
            <div className="grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
              <CheckField id={fid('is_active')} label="Active" checked={flags.is_active} onChange={flag('is_active')} />
              <CheckField id={fid('internal')} label="Internal" checked={flags.internal} onChange={flag('internal')} />
              <CheckField id={fid('display_leaderboard')} label="Show leaderboard" checked={flags.display_leaderboard} onChange={flag('display_leaderboard')} />
              <CheckField id={fid('display_disclaimer')} label="Show disclaimer" checked={flags.display_disclaimer} onChange={flag('display_disclaimer')} />
              <CheckField id={fid('display_activities')} label="Show activities" checked={flags.display_activities} onChange={flag('display_activities')} />
            </div>
          </fieldset>
          <div className="grid grid-cols-1 gap-4 mt-5 border-t border-zinc-200 dark:border-zinc-800 pt-4">
            <Field label="Description" htmlFor={fid('description')}>
              <Textarea id={fid('description')} rows={3} value={v.description || ''} onChange={(e) => set('description', e.target.value)} />
            </Field>
            <Field label="Disclaimer" htmlFor={fid('disclaimer')}>
              <Textarea id={fid('disclaimer')} rows={3} value={v.disclaimer || ''} onChange={(e) => set('disclaimer', e.target.value)} />
            </Field>
          </div>
          <FormError message={error} />
        </>
      )}
    </Panel>
  );
}

function EventList({ onManage }: { onManage: (id: number) => void }) {
  const write = canWrite();
  const [seasons, setSeasons] = useState<Season[]>([]);
  // Seeded from the module's state: the Seasons screen writes it before
  // jumping here. '' (all), 'none' (no season), or a season id as a string —
  // the three values the API's own `season_id` param accepts.
  const [seasonFilter, setSeasonFilter] = useState<string>(() => topo()?._se?.seasonFilter || '');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<SeasonEvent[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const list = await fetchAllSeasons();
      if (alive.current) setSeasons(list);
    })();
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: '20' });
    if (search) params.set('search', search);
    if (seasonFilter) params.set('season_id', seasonFilter);
    const res = await fetchJson(`/api/v4/admin/season-events?${params}`);
    if (!alive.current) return;
    if (res.ok && res.data?.success) {
      setItems(res.data.data);
      setMeta(res.data.meta || null);
      setError(null);
      return;
    }
    setItems([]);
    setMeta(null);
    // A failed request and a genuinely empty list used to render the same
    // "No events found." — keep them apart.
    setError({ status: res.status, message: (res.data && res.data.error) || null });
  }, [page, search, seasonFilter]);

  useEffect(() => { load(); }, [load]);

  const commitSearch = useCallback((raw: string) => {
    const next = raw.trim();
    setSearch((current) => (current === next ? current : next));
    setPage(1);
  }, []);

  const remove = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Delete this event?',
      message: 'This permanently removes the event and cascades to its challenges, user activities, onchain accounts and enrollments. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    const res = await send('DELETE', `/api/v4/admin/season-events/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) { load(); return; }
    topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  const columns: Column<SeasonEvent>[] = [
    { label: 'Name', primary: true, cell: (ev) => ev.name },
    {
      label: 'Season',
      // The API sends the joined season object; fall back to the raw id so a
      // row still says something if the join ever comes back empty (e.g. an
      // older cached response).
      cell: (ev) => (ev.season?.name
        ? ev.season.name
        : (ev.season_id != null ? `#${ev.season_id}` : '—')),
      tdClass: 'text-zinc-500 dark:text-zinc-400',
    },
    { label: 'Type', cell: (ev) => ev.type, tdClass: 'text-zinc-500 dark:text-zinc-400' },
    {
      label: 'Active',
      cell: (ev) => (ev.is_active
        ? <span className="text-green-800 dark:text-green-400">yes</span>
        : '—'),
    },
    { label: 'Starts', cell: (ev) => fmt(ev.starts_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
    { label: 'Ends', cell: (ev) => fmt(ev.ends_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
    {
      label: 'Users',
      cell: (ev) => (ev.users_count != null ? ev.users_count : '—'),
      tdClass: 'text-zinc-500 dark:text-zinc-400',
    },
  ];

  const filtered = !!(search || seasonFilter);

  return (
    <>
      <ScreenHeader
        title="Season events"
        subtitle="Every event, its schedule, and the challenges scheduled inside it."
        actions={(
          <>
            <label className="sr-only" htmlFor="admin-topo-se-season-filter">Filter by season</label>
            <Select
              id="admin-topo-se-season-filter"
              value={seasonFilter}
              onChange={(e) => {
                setSeasonFilter(e.target.value);
                if (topo()?._se) topo()._se.seasonFilter = e.target.value;
                setPage(1);
              }}
            >
              <Options
                options={[
                  { value: 'none', label: 'No season' },
                  ...seasonOptions(seasons),
                ]}
                blank="All seasons"
              />
            </Select>
            {/* Commits on blur or Enter, not per keystroke — a paged server
                query, same rule as the other search boxes in this console. */}
            <Input
              id="admin-topo-se-search"
              type="text"
              placeholder="Search name…"
              aria-label="Search season events"
              className="sm:w-56"
              defaultValue={search}
              onBlur={(e) => commitSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch((e.target as HTMLInputElement).value);
              }}
            />
            {write ? (
              <button
                id="admin-topo-se-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New event
              </button>
            ) : null}
          </>
        )}
      />
      <div id="admin-topo-se-form">
        {editing != null && write ? (
          <EventForm
            key={String(editing)}
            id={editing === 'new' ? null : editing}
            seasons={seasons}
            onClose={() => setEditing(null)}
            onSaved={() => { setEditing(null); load(); }}
          />
        ) : null}
      </div>
      <div id="admin-topo-se-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load season events"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title={filtered ? 'No events match these filters' : 'No season events yet'}
            body={filtered
              ? 'Clear the search box and the season filter to see every event.'
              : 'Create the first event to start scheduling challenges.'}
            action={!filtered && write ? (
              <button
                id="admin-topo-se-empty-new"
                type="button"
                className={BTN.primarySm}
                onClick={() => setEditing('new')}
              >
                New event
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <>
            <List
              items={items}
              rowKey={(ev) => ev.id}
              columns={columns}
              actions={(ev) => (
                <>
                  <button
                    data-manage={ev.id}
                    type="button"
                    className={BTN.rowPrimary}
                    onClick={() => onManage(ev.id)}
                  >
                    Manage
                  </button>
                  {write ? (
                    <button
                      data-edit={ev.id}
                      type="button"
                      className={BTN.row}
                      onClick={() => setEditing(ev.id)}
                    >
                      Edit
                    </button>
                  ) : null}
                  {write ? (
                    <button
                      data-delete={ev.id}
                      type="button"
                      className={BTN.rowDanger}
                      onClick={() => remove(ev.id)}
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
    </>
  );
}

// The screen is the list OR one event's detail, never both — the same
// either/or `renderSeasonEvents` opened with. `detailId` is seeded from the
// router's state so a deep link lands on the detail view directly, and every
// change is published back so the address follows.
function SeasonEventsScreen() {
  const [detailId, setDetailId] = useState<number | null>(() => {
    const id = topo()?._se?.detailId;
    return typeof id === 'number' ? id : null;
  });

  if (detailId != null) {
    return (
      <EventDetail
        eventId={detailId}
        onBack={() => {
          setDetailId(null);
          publishRoute({ detailId: null, open: false, templateId: '' });
        }}
      />
    );
  }
  return (
    <EventList
      onManage={(id) => {
        setDetailId(id);
        publishRoute({ detailId: id, open: false, templateId: '' });
      }}
    />
  );
}

export { SeasonEventsScreen };
