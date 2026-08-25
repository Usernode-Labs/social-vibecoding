'use strict';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import {
  eventOptions, fetchAllEvents, fetchAllSeasons, fetchJson, seasonOptions, send,
} from './api.ts';
import { BTN } from './tokens.ts';
import {
  Badge, CloseButton, EmptyState, ErrorState, Field, FormError, FormSection, Input, List,
  Options, Pager, Panel, ScreenHeader, Select, Skeleton, Textarea, fmt,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';
import { AdminUI } from '../admin-console.js';

// Onchain accounts — index / show / import / :id/reset. No create, edit or
// delete singular routes exist per the API surface, and nothing is invented
// here beyond what is documented.
//
// ── React-owned (#1120 slice 29) ──────────────────────────────────────
//
// Sixth screen through the portal seam, and the one where the innerHTML
// version's filter machinery was most of the code. `_acctFiltersHtml()` built
// three <select>s as a string; `_syncAcctFilterOptions()` then rebuilt that
// string into a detached div, pulled each fresh `innerHTML` out of it, wrote
// it over the live select's options and re-set `.value` — because the season
// picker narrows the event picker and both had to survive an options swap.
// Here the event options are a `useMemo` over the chosen season, and the
// three selections are state. Both functions are gone.
//
// The SECRET-KEY rule is carried over exactly, and it is the reason this
// screen has a detail dialog at all: the show route is the ONE place the API
// serves `secret_key`, and only to full admins. The secret stays in this
// component's state until the admin explicitly reveals it — it is never put
// in a data-* attribute, and revealing it swaps a rendered text child, which
// is the React equivalent of the `textContent` write the old code was careful
// to use instead of markup.
//
// Ids are like-for-like — `admin-topo-oa-*`, the three filter selects and the
// `data-acct-show` / `data-reset` hooks included.

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

const MASK = '••••••••••••';

// ── Cross-screen entry point ───────────────────────────────────────────
//
// The Delegations screen's "View account" jumps here and asks for one
// account's dialog: that screen owns no detail host of its own, because
// rendering a second copy would duplicate a static id. It calls
// AdminConsole.setSection('onchain-accounts') and then this.
//
// Two arrival orders have to work. If this screen is already on-screen,
// `live` takes the id immediately. If the section switch has only just
// mounted it, the id is PARKED and the mount effect picks it up — which also
// covers the case where React has not yet run the effect that publishes
// `live`. Losing this seam is silent (a button that throws), so
// tests/topochain-admin-screens.test.js pins both ends of it.
let live: ((id: number) => void) | null = null;
let pending: number | null = null;

export function openAccountDetail(id: number) {
  if (live) live(id);
  else pending = id;
}

type Account = {
  id: number;
  public_key: string;
  secret_key?: string | null;
  address?: string | null;
  identity_uid?: string | null;
  registration_code?: string | null;
  tier?: string | null;
  amount?: number | string | null;
  description?: string | null;
  season_id?: number | null;
  event?: { id: number; name: string } | null;
  user?: {
    id: number; username?: string | null; display_name?: string | null;
    email?: string | null; discord?: string | null;
  } | null;
  is_used?: boolean;
  used_at?: string | null;
  delegated?: boolean;
  delegated_since?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

type Season = { id: number; name: string };
type SeasonEvent = { id: number; name: string; season_id: number | string };

const Mono = ({ value }: { value: unknown }) => (
  value == null || value === ''
    ? <>—</>
    : <span className="font-mono">{String(value)}</span>
);

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-2">
      <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5 text-sm break-all">{children}</dd>
    </div>
  );
}

// The secret is state, not markup: it is held here and rendered as a text
// child only while `shown`. Nothing writes it into an attribute, and closing
// the dialog unmounts it.
function SecretKey({ secret }: { secret: string | null }) {
  const [shown, setShown] = useState(false);
  if (secret == null) {
    return (
      <span className="text-zinc-500 dark:text-zinc-400">Hidden for view-only admins.</span>
    );
  }
  return (
    <>
      <span id="admin-topo-oa-detail-secret" className="font-mono">{shown ? secret : MASK}</span>
      <button
        id="admin-topo-oa-detail-secret-toggle"
        type="button"
        className={`${BTN.row} ml-2`}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? 'Hide' : 'Reveal'}
      </button>
    </>
  );
}

function AccountDetail({ id, seasons, onClose }: {
  id: number;
  seasons: Season[];
  onClose: () => void;
}) {
  const [account, setAccount] = useState<Account | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const { ok, data, status } = await fetchJson(
      `/api/v4/admin/onchain-accounts/${encodeURIComponent(id)}`);
    if (!alive.current) return;
    if (ok && data?.success) { setAccount(data.data); setError(null); return; }
    setError({ status, message: (data && data.error) || null });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const a = account;
  const season = a ? seasons.find((x) => String(x.id) === String(a.season_id)) : null;

  return (
    <div
      id="admin-topo-oa-detail-overlay"
      className={AdminUI.dialogOverlay}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className={`${AdminUI.dialogPanel} max-h-[85vh] overflow-y-auto`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-topo-oa-detail-title"
      >
        <div className="flex items-start justify-between gap-3">
          <h3 id="admin-topo-oa-detail-title" className="text-sm font-semibold">
            {`Onchain account #${id}`}
          </h3>
          <CloseButton
            id="admin-topo-oa-detail-close"
            label="Close the account detail"
            onClick={onClose}
          />
        </div>
        <div id="admin-topo-oa-detail-body" className="mt-2">
          {error ? (
            <ErrorState
              title="Couldn't load the account"
              status={error.status}
              message={error.message}
              onRetry={load}
            />
          ) : null}
          {!error && !a ? <Skeleton rows={3} /> : null}
          {a ? (
            <>
              <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
                <DetailRow label="Public key"><Mono value={a.public_key} /></DetailRow>
                <DetailRow label="Secret key">
                  <SecretKey secret={typeof a.secret_key === 'string' ? a.secret_key : null} />
                </DetailRow>
                <DetailRow label="Address"><Mono value={a.address} /></DetailRow>
                <DetailRow label="Identity UID"><Mono value={a.identity_uid} /></DetailRow>
                <DetailRow label="Registration code"><Mono value={a.registration_code} /></DetailRow>
                <DetailRow label="Tier">{a.tier ?? '—'}</DetailRow>
                <DetailRow label="Amount"><Mono value={a.amount} /></DetailRow>
                <DetailRow label="Description">{a.description || '—'}</DetailRow>
                <DetailRow label="Season">
                  {season ? `${season.name} (#${a.season_id})` : `#${a.season_id}`}
                </DetailRow>
                <DetailRow label="Event">
                  {a.event ? `${a.event.name} (#${a.event.id})` : '— (season-wide)'}
                </DetailRow>
                <DetailRow label="Status">
                  {a.is_used ? (
                    <>
                      <span className="text-amber-800 dark:text-amber-400">used</span>
                      {` · ${fmt(a.used_at)}`}
                    </>
                  ) : <span className="text-green-800 dark:text-green-400">free</span>}
                </DetailRow>
                <DetailRow label="Delegation">
                  {a.delegated ? (
                    <>
                      <Badge label="Delegated" tone="green" />
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        {` since ${fmt(a.delegated_since)}`}
                      </span>
                    </>
                  ) : <span className="text-zinc-500 dark:text-zinc-400">Not delegated</span>}
                </DetailRow>
                <DetailRow label="Created">{fmt(a.created_at)}</DetailRow>
                <DetailRow label="Updated">{fmt(a.updated_at)}</DetailRow>
              </dl>
              <FormSection label="User" />
              {a.user ? (
                <dl className="divide-y divide-zinc-100 dark:divide-zinc-800">
                  <DetailRow label="Username">{a.user.username ?? '—'}</DetailRow>
                  <DetailRow label="Display name">{a.user.display_name ?? '—'}</DetailRow>
                  <DetailRow label="Email"><Mono value={a.user.email} /></DetailRow>
                  <DetailRow label="Discord"><Mono value={a.user.discord} /></DetailRow>
                  <DetailRow label="User id"><Mono value={a.user.id} /></DetailRow>
                </dl>
              ) : (
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  Unassigned — no user has claimed this account.
                </p>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ImportPanel({ onClose, onImported }: { onClose: () => void; onImported: () => void }) {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState('');
  const [rows, setRows] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const list = await fetchAllSeasons();
      if (alive.current) setSeasons(list);
    })();
  }, []);

  const run = useCallback(async () => {
    if (!canWrite()) return;
    setError(null);
    if (!seasonId) { setError('Choose a season.'); return; }
    const accounts = rows.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
      const [amount, identity_uid, address, public_key, secret_key, tier, description] =
        line.split(',').map((v) => (v || '').trim());
      return {
        amount: Number(amount),
        identity_uid,
        address,
        public_key,
        secret_key,
        tier,
        description: description || null,
      };
    });
    if (!accounts.length) { setError('Add at least one account row.'); return; }
    const { ok, data } = await send('POST', '/api/v4/admin/onchain-accounts/import',
      { season_id: parseInt(seasonId, 10), accounts });
    if (!alive.current) return;
    if (!ok || !data?.success) { setError((data && data.error) || 'Import failed.'); return; }
    const r = data.data;
    setResult({ imported: r.imported_count, skipped: r.skipped_count, errors: r.errors || [] });
    onImported();
  }, [seasonId, rows, onImported]);

  return (
    <Panel
      title="Import onchain accounts"
      subtitle="One account per line, into a season’s pool (accounts are per-season; each user can hold one)."
      onClose={onClose}
      closeLabel="Close the import panel"
      footer={(
        <>
          <button id="admin-topo-oa-imp-go" type="button" className={BTN.primary} onClick={run}>
            Import
          </button>
          <button id="admin-topo-oa-imp-cancel" type="button" className={BTN.secondary} onClick={onClose}>
            Cancel
          </button>
        </>
      )}
    >
      <div className="grid grid-cols-1 gap-4">
        <Field label="Season *" htmlFor="admin-topo-oa-imp-season">
          <Select
            id="admin-topo-oa-imp-season"
            value={seasonId}
            onChange={(e) => setSeasonId(e.target.value)}
          >
            <Options options={seasonOptions(seasons)} blank="Choose a season…" />
          </Select>
        </Field>
        <Field
          label={'Accounts — one "amount,identity_uid,address,public_key,secret_key,tier,description" per line *'}
          htmlFor="admin-topo-oa-imp-rows"
          help="registration_code is generated server-side; do not include it."
        >
          <Textarea
            id="admin-topo-oa-imp-rows"
            rows={8}
            value={rows}
            onChange={(e) => setRows(e.target.value)}
          />
        </Field>
      </div>
      <FormError message={error} />
      <div id="admin-topo-oa-imp-result" className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
        {result ? (
          <>
            {`Imported ${result.imported}, skipped ${result.skipped}.`}
            {result.errors.map((e, i) => <div key={i}>{e}</div>)}
          </>
        ) : null}
      </div>
    </Panel>
  );
}

function OnchainAccountsScreen() {
  const write = canWrite();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [events, setEvents] = useState<SeasonEvent[]>([]);
  const [search, setSearch] = useState('');
  const [seasonFilter, setSeasonFilter] = useState('');
  const [eventFilter, setEventFilter] = useState('');
  const [delegatedFilter, setDelegatedFilter] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<Account[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [importing, setImporting] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  // Publish this screen's dialog opener for the cross-screen jump above, and
  // take whatever was parked while it was not mounted.
  useEffect(() => {
    live = setDetailId;
    if (pending != null) { setDetailId(pending); pending = null; }
    return () => { live = null; };
  }, []);

  useEffect(() => {
    (async () => {
      const [s, e] = await Promise.all([fetchAllSeasons(), fetchAllEvents()]);
      if (!alive.current) return;
      setSeasons(s);
      setEvents(e);
    })();
  }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: '50' });
    if (search) params.set('search', search);
    if (seasonFilter) params.set('season_id', seasonFilter);
    if (eventFilter) params.set('season_event_id', eventFilter);
    if (delegatedFilter) params.set('delegated', delegatedFilter);
    const res = await fetchJson(`/api/v4/admin/onchain-accounts?${params}`);
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
  }, [page, search, seasonFilter, eventFilter, delegatedFilter]);

  useEffect(() => { load(); }, [load]);

  // A chosen season narrows the event options to that season's events.
  const eventChoices = useMemo(
    () => (seasonFilter
      ? events.filter((ev) => String(ev.season_id) === String(seasonFilter))
      : events),
    [events, seasonFilter],
  );

  const onSeason = useCallback((next: string) => {
    setSeasonFilter(next);
    // An event choice that belongs to another season no longer makes sense
    // under the new season — drop it rather than sending a contradictory
    // filter pair.
    setEventFilter((current) => {
      if (!current || !next) return current;
      const ev = events.find((x) => String(x.id) === String(current));
      return !ev || String(ev.season_id) !== String(next) ? '' : current;
    });
    setPage(1);
  }, [events]);

  const commitSearch = useCallback((raw: string) => {
    const next = raw.trim();
    setSearch((current) => (current === next ? current : next));
    setPage(1);
  }, []);

  const reset = useCallback(async (id: number) => {
    if (!canWrite()) return;
    const ok = await topo()._confirm({
      title: 'Reset this account?',
      message: 'Clears the current user’s claim (user_id, is_used, used_at) so the account becomes assignable again. The registration code itself is kept.',
      confirmLabel: 'Reset',
    });
    if (!ok) return;
    const res = await send('POST', `/api/v4/admin/onchain-accounts/${encodeURIComponent(id)}/reset`);
    if (res.ok && res.data?.success) load();
    else topo()._alert((res.data && res.data.error) || 'Reset failed.');
  }, [load]);

  const columns: Column<Account>[] = [
    {
      label: 'Public key',
      primary: true,
      // The whole cell is the way into the detail dialog — a real button (not
      // a row click handler) so it exists identically in the table and card
      // layouts and is keyboard-reachable.
      cell: (a) => (
        <button
          data-acct-show={a.id}
          type="button"
          className="text-left break-all underline decoration-dotted underline-offset-2 hover:text-violet-600 dark:hover:text-violet-400 rounded touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
          aria-haspopup="dialog"
          onClick={() => setDetailId(a.id)}
        >
          {a.public_key}
        </button>
      ),
      tdClass: 'text-xs font-mono',
    },
    { label: 'Tier', cell: (a) => a.tier, tdClass: 'text-zinc-500 dark:text-zinc-400' },
    { label: 'Amount', cell: (a) => a.amount, tdClass: 'font-mono text-right', thClass: 'text-right' },
    { label: 'Event', cell: (a) => (a.event ? a.event.name : '—'), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
    {
      label: 'Status',
      cell: (a) => (a.is_used
        ? <span className="text-amber-800 dark:text-amber-400">used</span>
        : <span className="text-green-800 dark:text-green-400">free</span>),
    },
    {
      label: 'Delegation',
      cell: (a) => (a.delegated
        ? <Badge label="Delegated" tone="green" />
        : <span className="text-zinc-500 dark:text-zinc-400">—</span>),
    },
    { label: 'User', cell: (a) => (a.user ? a.user.username : '—'), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
  ];

  const filtered = !!(search || seasonFilter || eventFilter || delegatedFilter);

  return (
    <>
      <ScreenHeader
        title="Onchain accounts"
        subtitle="Accounts linked to users, with their identity and balances. Click a public key for the full detail."
        actions={(
          <>
            <label className="sr-only" htmlFor="admin-topo-oa-season-filter">Filter by season</label>
            <Select
              id="admin-topo-oa-season-filter"
              value={seasonFilter}
              onChange={(e) => onSeason(e.target.value)}
            >
              <Options options={seasonOptions(seasons)} blank="All seasons" />
            </Select>
            <label className="sr-only" htmlFor="admin-topo-oa-event-filter">Filter by event</label>
            <Select
              id="admin-topo-oa-event-filter"
              value={eventFilter}
              onChange={(e) => { setEventFilter(e.target.value); setPage(1); }}
            >
              <Options options={eventOptions(eventChoices)} blank="All events" />
            </Select>
            <label className="sr-only" htmlFor="admin-topo-oa-delegated-filter">
              Filter by delegation
            </label>
            <Select
              id="admin-topo-oa-delegated-filter"
              value={delegatedFilter}
              onChange={(e) => { setDelegatedFilter(e.target.value); setPage(1); }}
            >
              <Options
                options={[
                  { value: 'true', label: 'Delegated' },
                  { value: 'false', label: 'Not delegated' },
                ]}
                blank="Delegation: any"
              />
            </Select>
            {/* Commits on blur or Enter, NOT on every keystroke. React's
                `onChange` is the DOM `input` event, but the innerHTML version
                listened for `change` — and this search is a paged server
                query, so per-keystroke would be one request per character
                against the admin API. The field stays uncontrolled so typing
                is never interrupted by a re-render. */}
            <Input
              id="admin-topo-oa-search"
              type="text"
              placeholder="Search public key/identity/code…"
              aria-label="Search onchain accounts"
              className="sm:w-64"
              defaultValue={search}
              onBlur={(e) => commitSearch(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitSearch((e.target as HTMLInputElement).value);
              }}
            />
            {write ? (
              <button
                id="admin-topo-oa-import"
                type="button"
                className={BTN.primarySm}
                onClick={() => setImporting(true)}
              >
                Import…
              </button>
            ) : null}
          </>
        )}
      />
      <div id="admin-topo-oa-form">
        {importing && write ? (
          <ImportPanel onClose={() => setImporting(false)} onImported={load} />
        ) : null}
      </div>
      <div id="admin-topo-oa-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load onchain accounts"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title={filtered ? 'No accounts match these filters' : 'No onchain accounts yet'}
            body={filtered
              ? 'Clear the search box and the season/event/delegation filters to see every account.'
              : 'Import a batch of accounts to hand out registration codes for an event.'}
            action={!filtered && write ? (
              <button
                id="admin-topo-oa-empty-import"
                type="button"
                className={BTN.primarySm}
                onClick={() => setImporting(true)}
              >
                Import accounts
              </button>
            ) : null}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <>
            <List
              items={items}
              rowKey={(a) => a.id}
              columns={columns}
              actions={write ? (a) => (a.is_used ? (
                <button
                  data-reset={a.id}
                  type="button"
                  className={BTN.rowWarn}
                  onClick={() => reset(a.id)}
                >
                  Reset
                </button>
              ) : null) : undefined}
            />
            <Pager meta={meta} onPage={setPage} />
          </>
        ) : null}
      </div>
      <div id="admin-topo-oa-detail">
        {detailId != null ? (
          <AccountDetail id={detailId} seasons={seasons} onClose={() => setDetailId(null)} />
        ) : null}
      </div>
    </>
  );
}

export { OnchainAccountsScreen };
