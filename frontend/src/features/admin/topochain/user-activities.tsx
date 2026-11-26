'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { eventOptions, fetchAllEvents, fetchJson, send } from './api.ts';
import { fmtActivityAt } from '../activity-at.ts';
import { BTN } from './tokens.ts';
import {
  EmptyState, ErrorState, Field, Figures, FormActions, FormError, FormGrid, Input, List, LoadMore,
  Options, Panel, ScreenHeader, Select, Skeleton, TabPanel, Tabs, Textarea, Toolbar, fmt,
  isoToLocalInput, localInputToIso,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';

// User activities — full CRUD, JSON import, and the totals panel with its
// refresh-totals action.
//
// ── React-owned (#1120 slice 30) ──────────────────────────────────────
//
// Seventh screen through the portal seam. The interesting piece is the
// activity form's DEPENDENT SELECT: the challenge list belongs to the chosen
// event, and `activity_type` is derived from the chosen challenge's template
// category. The innerHTML version wrote the challenge options with a nested
// `chSel.innerHTML = items.map(...)`, parked each challenge's category in a
// `data-category` attribute, and read it back at save time out of
// `selectedOptions[0].dataset` — the DOM was the only place that mapping
// lived. Here the challenge list is state and the category is looked up from
// it, so the attribute round-trip is gone.
//
// One thing that is NOT this screen's to decide: `activity_type` is
// overridden server-side from the challenge's template category whatever the
// client submits. The value is still sent, because the API expects the field;
// the help text under Metadata says so, and this screen must not grow logic
// that pretends otherwise.
//
// Ids are like-for-like — `admin-topo-act-*`.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

type Activity = {
  id: number;
  user_id: number;
  user?: { id: number; display_name?: string | null; email?: string | null } | null;
  season_event_id: number;
  event?: { name?: string } | null;
  challenge_id: number;
  challenge?: { goal?: string } | null;
  activity_type: string;
  points: number;
  activity_at?: string | null;
  activity_time_precision?: 'day' | 'instant' | null;
  description?: string | null;
  metadata?: unknown;
};

type Challenge = {
  id: number;
  activity_type?: { category?: string } | null;
  card_preview?: { goal?: string } | null;
};

type SeasonEvent = { id: number; name: string };

const COLUMNS: Column<Activity>[] = [
  {
    label: 'User',
    primary: true,
    cell: (a) => a.user?.display_name || a.user?.email || a.user_id,
  },
  {
    label: 'Event',
    cell: (a) => a.event?.name || a.season_event_id,
    tdClass: 'text-xs text-zinc-500 dark:text-zinc-400',
  },
  { label: 'Challenge', cell: (a) => a.challenge?.goal || '—', tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
  { label: 'Type', cell: (a) => a.activity_type, tdClass: 'text-xs' },
  { label: 'Points', cell: (a) => a.points, tdClass: 'font-mono text-end', thClass: 'text-end' },
  { label: 'At', cell: (a) => fmtActivityAt(a.activity_at, a.activity_time_precision, fmt), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
];

function ActivityForm({ id, events, onClose, onSaved }: {
  id: number | null;
  events: SeasonEvent[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [loaded, setLoaded] = useState(id == null);
  const [userId, setUserId] = useState('');
  const [eventId, setEventId] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [points, setPoints] = useState('');
  const [activityAt, setActivityAt] = useState('');
  const [description, setDescription] = useState('');
  const [metadata, setMetadata] = useState('');
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Edit fetches the single row: the index payload is a summary and the form
  // needs the full record (metadata included).
  useEffect(() => {
    if (id == null) return;
    (async () => {
      const { ok, data } = await fetchJson(`/api/v4/admin/user-activities/${encodeURIComponent(id)}`);
      if (!alive.current) return;
      const a: Activity | null = ok && data?.success ? data.data : null;
      if (a) {
        setUserId(String(a.user_id ?? ''));
        setEventId(String(a.season_event_id ?? ''));
        setChallengeId(String(a.challenge_id ?? ''));
        setPoints(String(a.points ?? ''));
        setActivityAt(isoToLocalInput(a.activity_at));
        setDescription(a.description || '');
        setMetadata(a.metadata ? JSON.stringify(a.metadata) : '');
      }
      setLoaded(true);
    })();
  }, [id]);

  // The challenge list belongs to the chosen event. Refetched whenever it
  // changes; the selection is cleared unless the event did not actually move
  // (the edit path sets both at once).
  useEffect(() => {
    if (!eventId) { setChallenges([]); return undefined; }
    let cancelled = false;
    (async () => {
      const { ok, data } = await fetchJson(
        `/api/v4/admin/season-events/${encodeURIComponent(eventId)}/challenges`);
      if (cancelled || !alive.current) return;
      setChallenges(ok && data?.success ? data.data : []);
    })();
    return () => { cancelled = true; };
  }, [eventId]);

  const save = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    const chosen = challenges.find((c) => String(c.id) === String(challengeId));
    if (!chosen) { setError('Choose an event and a challenge.'); return; }
    let parsedMeta: unknown = null;
    const raw = metadata.trim();
    if (raw) {
      try { parsedMeta = JSON.parse(raw); } catch { setError('Metadata must be valid JSON.'); return; }
    }
    const body = {
      user_id: Number(userId),
      season_event_id: Number(eventId),
      challenge_id: Number(chosen.id),
      // Sent because the API expects the field; it is overridden server-side
      // from the challenge's template category whatever is submitted.
      activity_type: chosen.activity_type?.category || 'community_contribution',
      points: Number(points),
      activity_at: localInputToIso(activityAt),
      description: description.trim() || null,
      metadata: parsedMeta,
    };
    const url = id == null
      ? '/api/v4/admin/user-activities'
      : `/api/v4/admin/user-activities/${encodeURIComponent(id)}`;
    const { ok, data } = await send(id == null ? 'POST' : 'PUT', url, body);
    if (!ok || !data?.success) { setError((data && data.error) || 'Save failed.'); return; }
    onSaved();
  }, [challenges, challengeId, metadata, userId, eventId, points, activityAt, description,
    id, onSaved]);

  return (
    <Panel
      title={id == null ? 'New activity' : `Edit activity #${id}`}
      subtitle="Who did what, in which event, and what it scored."
      onClose={onClose}
      closeLabel="Close the activity form"
      footer={<FormActions onSave={save} onCancel={onClose} saveLabel="Save activity" />}
    >
      {!loaded ? <Skeleton rows={3} /> : (
        <>
          <FormGrid>
            <Field label="User id *" htmlFor="admin-topo-act-f-user_id">
              <Input
                id="admin-topo-act-f-user_id"
                type="number"
                min={1}
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
              />
            </Field>
            <Field label="Event *" htmlFor="admin-topo-act-f-event">
              <Select
                id="admin-topo-act-f-event"
                value={eventId}
                onChange={(e) => { setEventId(e.target.value); setChallengeId(''); }}
              >
                <Options options={eventOptions(events)} blank="Choose an event…" />
              </Select>
            </Field>
            <Field
              label="Challenge (loads after picking an event) *"
              htmlFor="admin-topo-act-f-challenge"
            >
              <Select
                id="admin-topo-act-f-challenge"
                value={challengeId}
                onChange={(e) => setChallengeId(e.target.value)}
              >
                {!eventId ? <option value="">Choose an event first…</option> : null}
                {challenges.map((c) => (
                  <option key={c.id} value={c.id} data-category={c.activity_type?.category || ''}>
                    {c.card_preview?.goal || `challenge #${c.id}`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Points *" htmlFor="admin-topo-act-f-points">
              <Input
                id="admin-topo-act-f-points"
                type="number"
                step="0.01"
                value={points}
                onChange={(e) => setPoints(e.target.value)}
              />
            </Field>
            <Field label="Activity at *" htmlFor="admin-topo-act-f-activity_at">
              <Input
                id="admin-topo-act-f-activity_at"
                type="datetime-local"
                value={activityAt}
                onChange={(e) => setActivityAt(e.target.value)}
              />
            </Field>
          </FormGrid>
          <div className="grid grid-cols-1 gap-4 mt-4">
            <Field label="Description" htmlFor="admin-topo-act-f-description">
              <Textarea
                id="admin-topo-act-f-description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <Field
              label="Metadata (JSON, optional)"
              htmlFor="admin-topo-act-f-metadata"
              help="activity_type is derived automatically from the selected challenge’s template category (the API overrides whatever is submitted)."
            >
              <Textarea
                id="admin-topo-act-f-metadata"
                rows={3}
                value={metadata}
                onChange={(e) => setMetadata(e.target.value)}
              />
            </Field>
          </div>
          <FormError message={error} />
        </>
      )}
    </Panel>
  );
}

const IMPORT_PLACEHOLDER = '[\n  {"user_id":1,"season_event_id":1,"challenge_id":1,'
  + '"activity_type":"community_contribution","points":10,'
  + '"activity_at":"2026-01-01T00:00:00.000Z"}\n]';

function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [json, setJson] = useState(IMPORT_PLACEHOLDER);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; errors: string[] } | null>(null);

  const run = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    let activities: unknown;
    try {
      activities = JSON.parse(json);
      if (!Array.isArray(activities) || !activities.length) throw new Error('empty');
    } catch {
      setError('Paste a valid, non-empty JSON array of activity rows.');
      return;
    }
    const { ok, data } = await send('POST', '/api/v4/admin/user-activities/import', { activities });
    if (!ok || !data?.success) { setError((data && data.error) || 'Import failed.'); return; }
    setResult({ imported: data.data.imported_count, errors: data.data.errors || [] });
    onImported();
  }, [json, onImported]);

  return (
    <Panel
      title="Import activities"
      subtitle="Paste a JSON array of activity rows."
      onClose={onClose}
      closeLabel="Close the import panel"
      footer={(
        <>
          <button id="admin-topo-act-imp-go" type="button" className={BTN.primary} onClick={run}>
            Import
          </button>
          <button id="admin-topo-act-imp-cancel" type="button" className={BTN.secondary} onClick={onClose}>
            Cancel
          </button>
        </>
      )}
    >
      <Field label="activities JSON *" htmlFor="admin-topo-act-imp-json">
        <Textarea
          id="admin-topo-act-imp-json"
          rows={8}
          value={json}
          onChange={(e) => setJson(e.target.value)}
        />
      </Field>
      <FormError message={error} />
      <div id="admin-topo-act-imp-result" className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {result ? (
          <>
            {`Imported ${result.imported}.`}
            {result.errors.map((e, i) => <div key={i}>{e}</div>)}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

type Totals = {
  grand_total: { total_points: number; total_activities: number; unique_users: number };
  user_totals: {
    user: { id: number; display_name?: string | null; email?: string | null };
    total_points: number;
    total_activities: number;
  }[];
  type_totals: {
    activity_type: string; count: number; total_points: number; unique_users: number;
  }[];
};

type UserTotal = Totals['user_totals'][number];
type TypeTotal = Totals['type_totals'][number];

const NUM = { tdClass: 'font-mono text-end', thClass: 'text-end' };

const USER_TOTAL_COLUMNS: Column<UserTotal>[] = [
  { label: 'User', primary: true, cell: (t) => t.user.display_name || t.user.email || t.user.id },
  { label: 'Points', cell: (t) => t.total_points, ...NUM },
  { label: 'Count', cell: (t) => t.total_activities, ...NUM },
];

const TYPE_TOTAL_COLUMNS: Column<TypeTotal>[] = [
  { label: 'Type', primary: true, cell: (t) => t.activity_type },
  { label: 'Count', cell: (t) => t.count, ...NUM },
  { label: 'Points', cell: (t) => t.total_points, ...NUM },
  { label: 'Users', cell: (t) => t.unique_users, ...NUM },
];

// The totals are the screen's second tab (26 Nov 2026). They were a panel a
// header button opened over the list; `onClose` is kept for a caller that
// still shows them that way, and the tab passes none.
function TotalsPanel({ events, onClose }: { events: SeasonEvent[]; onClose?: () => void }) {
  const write = canWrite();
  const [eventId, setEventId] = useState('');
  const [totals, setTotals] = useState<Totals | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const params = eventId ? `?season_event_id=${encodeURIComponent(eventId)}` : '';
    const { ok, data, status } = await fetchJson(`/api/v4/admin/user-activities/totals${params}`);
    if (!alive.current) return;
    if (ok && data?.success) { setTotals(data.data); setError(null); return; }
    setTotals(null);
    setError({ status, message: (data && data.error) || null });
  }, [eventId]);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    if (!canWrite()) return;
    if (!eventId) {
      topo()._alert('Choose a specific event to refresh (only available for ended events).');
      return;
    }
    const { ok, data } = await send('POST', '/api/v4/admin/user-activities/refresh-totals',
      { season_event_id: parseInt(eventId, 10) });
    if (ok && data?.success) { topo()._alert(data.message || 'Refreshed.'); load(); }
    else topo()._alert((data && data.error) || 'Refresh failed.');
  }, [eventId, load]);

  return (
    <Panel
      title="Activity totals"
      subtitle="Points and counts, by user and by type."
      onClose={onClose}
      closeLabel="Close the totals panel"
    >
      <Toolbar>
        <div className="min-w-[14rem] sm:w-64">
          <Select
            id="admin-topo-act-tot-event"
            aria-label="Event"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
          >
            <Options options={eventOptions(events)} blank="All events" />
          </Select>
        </div>
        {write ? (
          <button
            id="admin-topo-act-tot-refresh"
            type="button"
            className={BTN.secondarySm}
            onClick={refresh}
          >
            Refresh totals (ended events)
          </button>
        ) : null}
      </Toolbar>
      <div id="admin-topo-act-tot-body">
        {error ? (
          <ErrorState
            title="Couldn't load totals"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {!error && !totals ? <Skeleton rows={4} /> : null}
        {totals ? (
          <>
            <Figures
              items={[
                { key: 'points', label: 'Points', value: String(totals.grand_total.total_points), tone: 'sky' },
                { key: 'activities', label: 'Activities', value: String(totals.grand_total.total_activities), tone: 'green' },
                { key: 'users', label: 'Users', value: String(totals.grand_total.unique_users), tone: 'yellow' },
              ]}
            />
            <div className="mt-4 grid grid-cols-1 gap-5 md:grid-cols-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500 mb-1">
                  By user (top 50)
                </div>
                <List
                  items={totals.user_totals.slice(0, 50)}
                  rowKey={(t) => t.user.id}
                  columns={USER_TOTAL_COLUMNS}
                />
              </div>
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-500 mb-1">
                  By type
                </div>
                <List
                  items={totals.type_totals}
                  rowKey={(t) => t.activity_type}
                  columns={TYPE_TOTAL_COLUMNS}
                />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

// Which of the two panels the one `#admin-topo-act-form` host is showing.
// The innerHTML version had the same rule implicitly — each opener overwrote
// the host — and needed `_acts.editingId` on the side to remember which.
// The totals were a third; they are the Totals tab now.
type OpenPanel =
  | { kind: 'none' }
  | { kind: 'form'; id: number | null }
  | { kind: 'import' };

type ActivitiesTab = 'list' | 'totals';
const ACT_TABS_ID = 'admin-topo-act-tabs';

function UserActivitiesScreen() {
  const write = canWrite();
  const [tab, setTab] = useState<ActivitiesTab>('list');
  const [items, setItems] = useState<Activity[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [events, setEvents] = useState<SeasonEvent[]>([]);
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<OpenPanel>({ kind: 'none' });
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const list = await fetchAllEvents();
      if (alive.current) setEvents(list);
    })();
  }, []);

  const fetchPage = useCallback((p: number) => {
    const params = new URLSearchParams({ page: String(p), per_page: '20' });
    if (search) params.set('search', search);
    return fetchJson(`/api/v4/admin/user-activities?${params}`);
  }, [search]);

  // The list goes on as its foot comes into view (ui.tsx `LoadMore`, as the
  // waitlist's queue does, 26 Nov 2026). How far it has read is kept here, so
  // a save or a delete reads every page reached again and the reader stays
  // where they were. A changed search starts over; this effect is declared
  // before the one that loads, so it runs first.
  const reach = useRef(1);
  const reading = useRef(false);
  useEffect(() => { reach.current = 1; }, [search]);

  const load = useCallback(async () => {
    let rows: Activity[] = [];
    let last: PageMeta | null = null;
    for (let p = 1; p <= reach.current; p += 1) {
      const res = await fetchPage(p);
      if (!alive.current) return;
      if (!(res.ok && res.data?.success)) {
        setItems([]);
        setMeta(null);
        setError({ status: res.status, message: (res.data && res.data.error) || null });
        return;
      }
      rows = rows.concat(res.data.data);
      last = res.data.meta || null;
      // The list got shorter than what was reached: stop at its end.
      if (last && p >= last.total_pages) {
        reach.current = Math.max(1, Math.min(reach.current, last.total_pages));
        break;
      }
    }
    setItems(rows);
    setMeta(last);
    setError(null);
  }, [fetchPage]);

  const hasMore = !!meta && meta.page < meta.total_pages;
  const more = useCallback(async () => {
    if (!hasMore || reading.current) return;
    reading.current = true;
    const next = reach.current + 1;
    const res = await fetchPage(next);
    reading.current = false;
    if (!alive.current || !(res.ok && res.data?.success)) return;
    // The search changed while it was on its way: these rows are not the list's.
    if (reach.current + 1 !== next) return;
    reach.current = next;
    setItems((prev) => {
      const have = new Set((prev || []).map((a) => a.id));
      return (prev || []).concat((res.data.data as Activity[]).filter((a) => !have.has(a.id)));
    });
    setMeta(res.data.meta || null);
  }, [fetchPage, hasMore]);

  useEffect(() => { load(); }, [load]);

  const commitSearch = useCallback((raw: string) => {
    const next = raw.trim();
    setSearch((current) => (current === next ? current : next));
  }, []);

  const remove = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Delete this activity?',
      confirmLabel: 'Delete',
      danger: true,
      message: 'This cannot be undone.',
    });
    if (!ok) return;
    const res = await send('DELETE', `/api/v4/admin/user-activities/${encodeURIComponent(id)}`);
    if (res.ok && res.data?.success) load();
    else topo()._alert((res.data && res.data.error) || 'Delete failed.');
  }, [load]);

  const close = useCallback(() => setOpen({ kind: 'none' }), []);
  // The form and the import panel open over the list, so their buttons in the
  // header bring the list's tab up with them.
  const openOverList = useCallback((next: OpenPanel) => {
    setTab('list');
    setOpen(next);
  }, []);

  const filtered = !!search;

  return (
    <>
      <ScreenHeader
        title="User activities"
        subtitle="Everything users have recorded against a challenge, and the points it scored."
        actions={write ? (
          <>
            <button
              id="admin-topo-act-new"
              type="button"
              className={BTN.primarySm}
              onClick={() => openOverList({ kind: 'form', id: null })}
            >
              New activity
            </button>
            <button
              id="admin-topo-act-import"
              type="button"
              className={BTN.secondarySm}
              onClick={() => openOverList({ kind: 'import' })}
            >
              Import JSON…
            </button>
          </>
        ) : null}
      />
      <Tabs<ActivitiesTab>
        id={ACT_TABS_ID}
        label="User activities"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'list', label: 'Activities' },
          { key: 'totals', label: 'Totals', id: 'admin-topo-act-totals' },
        ]}
      />
      <TabPanel tabsId={ACT_TABS_ID} tab="list" active={tab === 'list'}>
        <div id="admin-topo-act-form">
          {open.kind === 'form' && write ? (
            <ActivityForm
              key={String(open.id)}
              id={open.id}
              events={events}
              onClose={close}
              onSaved={() => { close(); load(); }}
            />
          ) : null}
          {open.kind === 'import' && write ? (
            <ImportPanel onClose={close} onImported={load} />
          ) : null}
        </div>
        <Toolbar>
          {/* Commits on blur or Enter, not per keystroke: a paged server
              query, same rule as the other search boxes in this console. */}
          <div className="min-w-[14rem] flex-1">
            <Input
              id="admin-topo-act-search"
              type="text"
              placeholder="Search user…"
              aria-label="Search activities by user"
              defaultValue={search}
              onBlur={(e) => commitSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch((e.target as HTMLInputElement).value);
              }}
            />
          </div>
        </Toolbar>
        <div id="admin-topo-act-table">
          {items === null ? <Skeleton rows={4} /> : null}
          {error ? (
            <ErrorState
              title="Couldn't load user activities"
              status={error.status}
              message={error.message}
              onRetry={load}
            />
          ) : null}
          {items !== null && !error && !items.length ? (
            <EmptyState
              title={filtered ? 'No activities match these filters' : 'No activities yet'}
              body={filtered
                ? 'Clear the search box to see every activity.'
                : 'Activities are recorded when users complete challenges. You can also add one by hand.'}
              action={!filtered && write ? (
                <button
                  id="admin-topo-act-empty-new"
                  type="button"
                  className={BTN.primarySm}
                  onClick={() => setOpen({ kind: 'form', id: null })}
                >
                  New activity
                </button>
              ) : null}
            />
          ) : null}
          {items !== null && !error && items.length ? (
            <>
              <List
                items={items}
                rowKey={(a) => a.id}
                columns={COLUMNS}
                actions={write ? (a) => (
                  <>
                    <button
                      data-edit-act={a.id}
                      type="button"
                      className={BTN.row}
                      onClick={() => setOpen({ kind: 'form', id: a.id })}
                    >
                      Edit
                    </button>
                    <button
                      data-delete-act={a.id}
                      type="button"
                      className={BTN.rowDanger}
                      onClick={() => remove(a.id)}
                    >
                      Delete
                    </button>
                  </>
                ) : undefined}
              />
              {meta ? (
                <LoadMore shown={items.length} total={meta.total} hasMore={hasMore} onMore={more} noun="activities" />
              ) : null}
            </>
          ) : null}
        </div>
      </TabPanel>
      {/* Read when the tab is first opened, as it was when Totals was a
          button that opened a panel. */}
      <TabPanel tabsId={ACT_TABS_ID} tab="totals" active={tab === 'totals'} lazy>
        <TotalsPanel events={events} />
      </TabPanel>
    </>
  );
}

export { UserActivitiesScreen };
