'use strict';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { eventOptions, fetchAllEvents, fetchAllSeasons, fetchJson, seasonOptions } from './api.ts';
import { openAccountDetail } from './onchain-accounts.tsx';
import { BTN } from './tokens.ts';
import {
  Badge, EmptyState, ErrorState, Figures, Input, List, LoadMore, Options, ScreenHeader, Segmented,
  Select, Skeleton, Toolbar, fmt,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';

// Delegations — a READ-ONLY surface over GET /api/v4/admin/delegations
// (+ /stats and /:account/history). The mobile app is the delegation actor
// (it reconciles its local state against the backend flag), so this screen
// deliberately has no mutation controls: an admin write here would desync
// phones. The backing table is a HISTORY — one list row per account (its
// latest period, with a period count), each expanding into that account's
// full period timeline.
//
// ── React-owned (#1120 slice 31) ──────────────────────────────────────
//
// Eighth screen through the portal seam, and it also REPAIRS a seam the
// previous slice broke. "View account" jumps to the Onchain accounts screen
// and opens its dialog there — that screen owns `#admin-topo-oa-detail`, and
// rendering a second copy here would duplicate a static id. The jump used to
// call `AdminTopochain._openAccountDetail`, which left the module when
// Onchain accounts became React in slice 29, so the button threw. It goes
// through that module's exported `openAccountDetail` now, and the contract
// has a test.
//
// The expand-one-row-at-a-time rule is unchanged, and it is deliberate: the
// timeline is rendered by `extra()`, so opening a second account's history
// closes the first and the table stays scannable. What changes is why —
// the innerHTML version re-rendered the WHOLE list on every toggle because
// `extra()` was computed at render time; here it is one piece of state that
// only the matching row reads.
//
// Ids are like-for-like — `admin-topo-dlg-*` and the `data-dlg-party`
// attributes two declared checks select on.

type Delegator = {
  user_id: number;
  username?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
};

type Delegation = {
  account: string;
  onchain_account_id?: number | null;
  delegator?: Delegator | null;
  delegated: boolean;
  started_at?: string | null;
  ended_at?: string | null;
  period_count: number;
};

type Period = { delegated: boolean; started_at?: string | null; ended_at?: string | null };

type Stats = {
  delegated_accounts: number;
  ended_accounts: number;
  orphaned_accounts: number;
  total_periods: number;
};

type Season = { id: number; name: string };
type SeasonEvent = { id: number; name: string; season_id: number | string };

// ── Delegation row parties ─────────────────────────────────────────────
//
// A delegation always has two parties — the account owner handing their stake
// over, and the platform's block-production node receiving it — and each row
// names both so "who delegated to whom" is one glance, not a click into the
// account detail.
//
// Built from INLINE elements only (span/img, never div/p): the list's card
// variant renders the primary cell inside a <p>, and a block element there
// would make the parser close the paragraph mid-chip.

function PartyChip(
  { party, avatar, title, sub }: { party: string; avatar: ReactNode; title: ReactNode; sub?: ReactNode },
) {
  return (
    <span className="inline-flex items-start gap-2 text-start" data-dlg-party={party}>
      {avatar}
      <span className="inline-flex min-w-0 flex-col">
        <span className="text-sm font-medium leading-5">{title}</span>
        {sub ? (
          <span className="text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">{sub}</span>
        ) : null}
      </span>
    </span>
  );
}

function Avatar({ user }: { user: Delegator | null }) {
  if (user && user.avatar_url) {
    return (
      <img
        src={user.avatar_url}
        alt=""
        className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-zinc-100 object-cover dark:bg-zinc-800"
      />
    );
  }
  // Initial-letter fallback (the platform's avatar idiom): violet for a
  // resolved user, zinc for the two no-claimant states.
  const name = user ? (user.display_name || user.username || '') : '';
  const tone = user
    ? 'bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300'
    : 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400';
  return (
    <span className={`mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${tone}`}>
      {(name[0] || '?').toUpperCase()}
    </span>
  );
}

function Delegator({ d }: { d: Delegation }) {
  const address = <span className="font-mono break-all">{d.account}</span>;
  const u = d.delegator;
  if (u) {
    return (
      <PartyChip
        party="delegator"
        avatar={<Avatar user={u} />}
        title={(
          <>
            {u.display_name || u.username || `user #${u.user_id}`}
            <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">
              {` user #${u.user_id}`}
            </span>
          </>
        )}
        sub={address}
      />
    );
  }
  // No current claimant: the account row exists but nobody claimed it, or the
  // account vanished from onchain_accounts entirely (no FK ties a period to
  // it — the API's own header note).
  return (
    <PartyChip
      party="delegator"
      avatar={<Avatar user={null} />}
      title={(
        <span className="font-normal text-zinc-500 dark:text-zinc-400">
          {d.onchain_account_id != null ? 'Unclaimed account' : 'Account not on file'}
        </span>
      )}
      sub={address}
    />
  );
}

function Delegatee() {
  return (
    <PartyChip
      party="delegatee"
      avatar={(
        <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-violet-600 text-[11px] font-semibold text-white">
          P
        </span>
      )}
      title="Platform node"
      sub="Block-production server"
    />
  );
}

// One account's period timeline. Fetched when its row expands, and unmounted
// with the row — so a stale response can never land in a different account's
// block, which the innerHTML version needed an `_dlg.expanded === account`
// re-check to guarantee.
function History({ account }: { account: string }) {
  const [periods, setPeriods] = useState<Period[] | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const { ok, data, status } = await fetchJson(
        `/api/v4/admin/delegations/${encodeURIComponent(account)}/history`);
      if (!alive.current) return;
      if (ok && data?.success) { setPeriods(data.data); return; }
      setError({ status, message: (data && data.error) || null });
    })();
  }, [account]);

  if (error) {
    return (
      <ErrorState
        title="Couldn't load this account's history"
        status={error.status}
        message={error.message}
      />
    );
  }
  if (!periods) return <Skeleton rows={2} />;
  if (!periods.length) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        No periods recorded for this account.
      </p>
    );
  }
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Delegation history, newest first
      </p>
      <ul className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800">
        {periods.map((p, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 py-1.5">
            {p.delegated
              ? <Badge label="Delegated" tone="mint" />
              : <Badge label="Ended" tone="zinc" />}
            <span className="text-xs text-zinc-600 dark:text-zinc-300">{fmt(p.started_at)}</span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">→</span>
            <span className="text-xs text-zinc-600 dark:text-zinc-300">
              {p.ended_at ? fmt(p.ended_at) : 'now'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DelegationsScreen() {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [events, setEvents] = useState<SeasonEvent[]>([]);
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [seasonFilter, setSeasonFilter] = useState('');
  const [eventFilter, setEventFilter] = useState('');
  const [items, setItems] = useState<Delegation[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  useEffect(() => {
    (async () => {
      const [s, e] = await Promise.all([fetchAllSeasons(), fetchAllEvents()]);
      if (!alive.current) return;
      setSeasons(s);
      setEvents(e);
    })();
  }, []);

  // The account-level summary strip. Unaffected by the list filters on
  // purpose — it answers "how is delegation doing overall" while the list
  // answers "show me these accounts"; a failed load leaves the strip empty
  // rather than blocking the table beneath it.
  useEffect(() => {
    (async () => {
      const { ok, data } = await fetchJson('/api/v4/admin/delegations/stats');
      if (!alive.current) return;
      setStats(ok && data?.success ? data.data : null);
    })();
  }, []);

  const fetchPage = useCallback((p: number) => {
    const params = new URLSearchParams({ page: String(p), per_page: '50' });
    if (status) params.set('status', status);
    if (search) params.set('search', search);
    if (seasonFilter) params.set('season_id', seasonFilter);
    if (eventFilter) params.set('season_event_id', eventFilter);
    return fetchJson(`/api/v4/admin/delegations?${params}`);
  }, [status, search, seasonFilter, eventFilter]);

  // The list goes on as you read down it (26 Nov 2026), so how far it has
  // read is kept here and not in a page number. A changed filter starts
  // over: this effect is declared before the one that loads, so it runs
  // first. `asked` is the query on screen now, so rows that come back for an
  // older one are dropped.
  const reach = useRef(1);
  const reading = useRef(false);
  const asked = useRef(fetchPage);
  asked.current = fetchPage;
  useEffect(() => { reach.current = 1; }, [fetchPage]);

  // Everything reached so far, read again from the first page.
  const load = useCallback(async () => {
    let rows: Delegation[] = [];
    let last: PageMeta | null = null;
    for (let p = 1; p <= reach.current; p += 1) {
      const res = await fetchPage(p);
      if (!alive.current || asked.current !== fetchPage) return;
      if (!(res.ok && res.data?.success)) {
        setExpanded(null);
        setItems([]);
        setMeta(null);
        setError({ status: res.status, message: (res.data && res.data.error) || null });
        return;
      }
      rows = rows.concat(res.data.data);
      last = res.data.meta || null;
      // The list got shorter than what was reached: stop at its end.
      if (last && p >= last.total_pages) { reach.current = Math.max(1, Math.min(reach.current, last.total_pages)); break; }
    }
    // A fresh list invalidates whichever timeline was open.
    setExpanded(null);
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
    if (!alive.current || asked.current !== fetchPage) return;
    if (!(res.ok && res.data?.success) || reach.current + 1 !== next) return;
    reach.current = next;
    // An open timeline stays open: its row is still on screen.
    setItems((prev) => {
      const have = new Set((prev || []).map((d) => d.account));
      return (prev || []).concat((res.data.data as Delegation[]).filter((d) => !have.has(d.account)));
    });
    setMeta(res.data.meta || null);
  }, [fetchPage, hasMore]);

  useEffect(() => { load(); }, [load]);

  const eventChoices = useMemo(
    () => (seasonFilter
      ? events.filter((ev) => String(ev.season_id) === String(seasonFilter))
      : events),
    [events, seasonFilter],
  );

  const onSeason = useCallback((next: string) => {
    setSeasonFilter(next);
    // An event choice from another season no longer makes sense — drop it
    // rather than sending a contradictory filter pair.
    setEventFilter((current) => {
      if (!current || !next) return current;
      const ev = events.find((x) => String(x.id) === String(current));
      return !ev || String(ev.season_id) !== String(next) ? '' : current;
    });
  }, [events]);

  const commitSearch = useCallback((raw: string) => {
    const next = raw.trim();
    setSearch((current) => (current === next ? current : next));
  }, []);

  // Jumps to the Onchain accounts screen and opens the dialog there. That
  // screen owns `#admin-topo-oa-detail`; rendering a second copy here would
  // duplicate a static id.
  const viewAccount = useCallback((id: number) => {
    const console_ = (window as any).AdminConsole;
    if (console_ && console_.isOpen()) console_.setSection('onchain-accounts');
    openAccountDetail(id);
  }, []);

  const columns: Column<Delegation>[] = [
    { label: 'Delegator', primary: true, cell: (d) => <Delegator d={d} /> },
    // Structurally constant BY THE MODEL, not decoration: every period in
    // this table is the account's stake handed to the platform's own
    // block-production node (there is no per-row delegate target in the
    // data), and naming the receiving party in the row is what lets an admin
    // read "who delegated to whom" without knowing that convention.
    { label: 'Delegatee', cell: () => <Delegatee /> },
    {
      label: 'Status',
      cell: (d) => (d.delegated
        ? <Badge label="Delegated" tone="mint" />
        : <Badge label="Ended" tone="zinc" />),
    },
    { label: 'Since', cell: (d) => fmt(d.started_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
    { label: 'Ended', cell: (d) => fmt(d.ended_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
    {
      label: 'Periods',
      cell: (d) => d.period_count,
      tdClass: 'tabular-nums text-end text-xs text-zinc-500 dark:text-zinc-400',
      thClass: 'text-end',
    },
  ];

  const filtered = !!(status || search || seasonFilter || eventFilter);

  return (
    <>
      <ScreenHeader
        title="Delegations"
        subtitle="Who delegated stake to the platform node, one row per testnet account. Every period is kept. Expand a row for that account’s history."
      />
      {/* The dashboard's own tiles, so a figure looks the same on every
          screen. Nothing is drawn until the figures arrive, and nothing at
          all if they could not be read. */}
      <div id="admin-topo-dlg-stats">
        {stats ? (
          <Figures
            items={[
              { key: 'delegated', label: 'Delegated now', value: stats.delegated_accounts, tone: 'green' },
              { key: 'ended', label: 'Ended', value: stats.ended_accounts },
              {
                key: 'orphaned',
                label: 'Account not on file',
                value: stats.orphaned_accounts,
                tone: stats.orphaned_accounts ? 'yellow' : 'sky',
              },
              { key: 'periods', label: 'Periods recorded', value: stats.total_periods },
            ]}
          />
        ) : null}
      </div>
      {/* The search and the filters are the list's, so they sit in the bar
          over it and not in the header (26 Nov 2026). */}
      <Toolbar>
        <div className="min-w-[14rem] flex-1">
          {/* Commits on blur or Enter, not per keystroke: a paged server
              query, same rule as the Onchain accounts search. */}
          <Input
            id="admin-topo-dlg-search"
            type="text"
            placeholder="Search account address…"
            aria-label="Search delegations by account address"
            defaultValue={search}
            onBlur={(e) => commitSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitSearch((e.target as HTMLInputElement).value);
            }}
          />
        </div>
        <div className="w-full sm:w-48">
          <label className="sr-only" htmlFor="admin-topo-dlg-season-filter">Filter by season</label>
          <Select
            id="admin-topo-dlg-season-filter"
            value={seasonFilter}
            onChange={(e) => onSeason(e.target.value)}
          >
            <Options options={seasonOptions(seasons)} blank="All seasons" />
          </Select>
        </div>
        <div className="w-full sm:w-48">
          <label className="sr-only" htmlFor="admin-topo-dlg-event-filter">Filter by event</label>
          <Select
            id="admin-topo-dlg-event-filter"
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
          >
            <Options options={eventOptions(eventChoices)} blank="All events" />
          </Select>
        </div>
        {/* Three short choices, all in view, where a select hid them. The
            values are the select's own: '' (all), 'delegated', 'ended'. */}
        <Segmented
          id="admin-topo-dlg-status"
          label="Filter by delegation status"
          value={status}
          options={[
            { value: '', label: 'All', title: 'All statuses' },
            { value: 'delegated', label: 'Delegated' },
            { value: 'ended', label: 'Ended' },
          ]}
          onChange={setStatus}
        />
      </Toolbar>
      <div id="admin-topo-dlg-table">
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load delegations"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState
            title={filtered ? 'No delegations match these filters' : 'No delegation periods yet'}
            body={filtered
              ? 'Clear the search box and the status/season/event filters to see every account.'
              : 'A row appears the first time a phone delegates its stake to the server.'}
          />
        ) : null}
        {items !== null && !error && items.length ? (
          <>
            <List
              items={items}
              rowKey={(d) => d.account}
              columns={columns}
              // The join is LEFT (no FK ties a period to onchain_accounts), so
              // only rows whose account still exists get a way into the
              // account detail dialog. History is always offered — one period
              // is still a history, and the timeline names the states in full.
              actions={(d) => (
                <>
                  {d.onchain_account_id != null ? (
                    <button
                      data-dlg-acct={d.onchain_account_id}
                      type="button"
                      className={BTN.row}
                      onClick={() => viewAccount(d.onchain_account_id as number)}
                    >
                      View account
                    </button>
                  ) : null}
                  <button
                    data-dlg-history={d.account}
                    type="button"
                    className={BTN.row}
                    aria-expanded={expanded === d.account ? 'true' : 'false'}
                    onClick={() => setExpanded((c) => (c === d.account ? null : d.account))}
                  >
                    {expanded === d.account ? 'Hide history' : 'History'}
                  </button>
                </>
              )}
              extra={(d) => (expanded === d.account ? <History account={d.account} /> : null)}
            />
            {meta ? (
              <LoadMore shown={items.length} total={meta.total} hasMore={hasMore} onMore={more} noun="accounts" />
            ) : null}
          </>
        ) : null}
      </div>
    </>
  );
}

export { DelegationsScreen };
