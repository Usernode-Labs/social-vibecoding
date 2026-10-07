'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { fetchJson, send } from './api.ts';
import { countryLabel } from './countries.ts';
import { BTN } from './tokens.ts';
import {
  Badge, CheckField, EmptyState, ErrorState, Field, FormError, Input, List, Pager, Panel, ScreenHeader,
  Select, Skeleton, Textarea, fmt,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';
import { useWaitlistOptions } from '../../auth/waitlist-shared.tsx';
import type { WaitlistOptions } from '../../auth/waitlist-shared.tsx';

// Waitlist — the platform waitlist (email-keyed queue, admitted one row at a
// time) and the block-producer queue (users who asked to produce blocks),
// stacked on one screen.
//
// ── What "release" was, and why it is "Admit" now (#1544) ──────────────
//
// Both queues used to call their action "Release", which is the name of the
// SERVER route and of nothing a person does. Feedback said so plainly: "not
// clear what release means". The two actions are not even the same kind of
// thing — one lets somebody into the platform, the other hands a phone its
// block-producer key — so one word for both could only ever be vague.
//
// The wording is the only thing that moved. `POST …/:id/release`, the
// `released_at` column, the `?status=released` filter value and the
// `waitlist_released` mail kind are all untouched: renaming a route to match
// a label is how a deploy breaks a bookmark, and the label is what the
// feedback was about. The filter's OPTION reads "Admitted" while still
// sending `status=released`.
//
// ── React-owned (#1120 slice 28) ──────────────────────────────────────
//
// Fifth screen through the portal seam, and the first with a PAGER — two of
// them, over two independently filtered lists that share one screen. The
// innerHTML version kept a `_waitlist` and a `_bpq` module global apiece
// (page, perPage, status, items, meta, error), repainted each table by id,
// and re-wired the pager's two buttons after every repaint because the markup
// they lived in had just been replaced. Both lists are one <Queue> component
// here, instantiated twice; the pager wiring is a prop.
//
// The survey-answers block keeps its rule verbatim: a signup's `made_url` is
// rendered as SELECTABLE TEXT, never an anchor. esc() alone would not stop a
// `javascript:` scheme, and no admin screen in this module renders an
// API-supplied URL as a clickable href.
//
// Ids are like-for-like — `admin-topo-wl-*` and `admin-topo-bpq-*`, including
// the two status selects and the `data-release-wl` / `data-release-bp` hooks.
// The sort select and the Export CSV button are the additions, and they
// follow the same naming, as do the search box (`admin-topo-wl-search`) and
// the batch-admit tool (`admin-topo-wl-batch*`) that came after them.

const STATUSES = ['pending', 'released', 'all'] as const;
type Status = typeof STATUSES[number];

// The labels an admin reads, per queue. The VALUES are the server's and do
// not move: `pending` / `released` are what `?status=` accepts, so these maps
// are presentation only. The two queues need different words because the two
// actions do different things to different subjects.
const WL_STATUS_LABELS: Record<Status, string> = {
  pending: 'Waiting',
  released: 'Admitted',
  all: 'All',
};
const BP_STATUS_LABELS: Record<Status, string> = {
  pending: 'Waiting',
  released: 'Enabled',
  all: 'All',
};

// A second, optional narrowing on the waitlist queue: rows whose address is
// proved, and rows that brought somebody in. Both are FILTERS an admin
// chooses, not an automatic ranking — nothing on this screen reorders the
// queue by itself.
const ONLY = ['any', 'confirmed', 'invited'] as const;
type Only = typeof ONLY[number];
const ONLY_LABELS: Record<Only, string> = {
  any: 'Everyone',
  confirmed: 'Confirmed address only',
  invited: 'Brought someone in',
};

// The queue's order, as a lens the admin picks rather than a ranking the
// screen applies. `waiting` is the default and sends NO `sort` param, which
// is the server's own FIFO ordering (pending first, oldest signup first).
// `answered` asks the server for its coarse "filled more in" ordering, which
// is explicitly not a score — see services/waitlist-signals.js.
const SORTS = ['waiting', 'answered'] as const;
type Sort = typeof SORTS[number];
const SORT_LABELS: Record<Sort, string> = {
  waiting: 'Longest waiting',
  answered: 'Most answered',
};

const topo = () => (window as any).AdminTopochain;
const canWrite = () => !!topo()?.canWrite();

type WaitlistRow = {
  id: number;
  /** A phone join (#4223) has no address; it is named by its account. */
  email: string | null;
  /** At most the last 4 digits of a phone row's verified number. */
  phone_last4?: string | null;
  confirmed_at?: string | null;
  submitted_at?: string | null;
  released_at?: string | null;
  linked_username?: string | null;
  has_platform_access?: boolean;
  answers?: Answers | null;
  /** Who used this row's invite link to sign up, if anyone. */
  invited_by?: number | null;
  invited_by_email?: string | null;
  /** The one "you're in" mail admitting sends, if a delivery was recorded. */
  invite_email?: { status?: string | null; created_at?: string | null; error?: string | null } | null;
  /** Facts about what this signup did. Deliberately carries no score. */
  signals?: {
    confirmed: boolean;
    verified: string[];
    sections: string[];
    /**
     * How many survey sections EXIST, alongside how many were answered. The
     * denominator used to be typed in here and had drifted a section behind
     * the server, so the column claimed "6/6 answered" for a row that had
     * answered six of seven.
     */
    sections_total?: number;
    invited: number;
  };
};

type BpRow = {
  id: number;
  username?: string | null;
  display_name?: string | null;
  email?: string | null;
  bp_requested_at?: string | null;
  bp_released_at?: string | null;
};

type Answers = {
  made_url?: string;
  made_note?: string;
  country?: string;
  city?: string;
  discovery?: { source?: string; detail?: string };
  referrer_handle?: string;
  group?: { name?: string; size?: string; role?: string; tools?: string[]; need?: string };
  loss?: { had?: string; product?: string; kind?: string[]; story?: string };
  verified?: Record<string, string>;
  handles?: Record<string, string>;
  /** A self-report, kept apart from `verified`, which OAuth actually proves. */
  followed_claim?: boolean;
  /**
   * LEGACY. The stage-2 form collected up to five typed addresses before the
   * share link replaced them. Nothing writes this any more, but rows that
   * predate the change still carry it and an admin reading one should still
   * see what that person typed.
   */
  invites?: string[];
  [key: string]: unknown;
};

// How long a row has been sitting there, in the unit a person would say it
// in. Ported from admin-staging-reap.tsx, which needed the same thing for the
// same reason: an absolute timestamp answers "when", and the question about a
// queue is "how long". The exact time stays available in the cell's `title`.
function ago(iso?: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function StatusSelect(
  { id, label, value, labels, onChange }: {
    id: string;
    label: string;
    value: Status;
    labels: Record<Status, string>;
    onChange: (s: Status) => void;
  },
) {
  return (
    <Select
      id={id}
      aria-label={label}
      className="sm:w-40"
      value={value}
      onChange={(e) => onChange(e.target.value as Status)}
    >
      {STATUSES.map((v) => (
        <option key={v} value={v}>{labels[v]}</option>
      ))}
    </Select>
  );
}

// The stored answers are CODES (`x`, `lt10`, `shutdown`), and the map from
// code to sentence lives on the server, served to the join form at
// /api/public/waitlist/options. Reading it here means the admin screen and
// the form cannot disagree about what an answer said.
//
// The fallback is the code itself, deliberately: the options request can fail
// or simply not have landed yet, and a row that reads `lt10` is still a row
// an admin can work with. Blanking the field would be worse.
function labelFor(map: Record<string, string> | undefined, code?: string | null): string {
  if (!code) return '';
  return (map && map[code]) || code;
}

// Keys this component knows how to label. Everything else is shown verbatim
// under "Other answers" rather than dropped: an answers blob spans several
// schema versions, and an admin reading a row is entitled to see what is
// actually stored in it. `_version` is excluded because it is bookkeeping.
const KNOWN_ANSWER_KEYS = new Set([
  '_version', 'made_url', 'made_note', 'country', 'city', 'discovery',
  'referrer_handle', 'group', 'loss', 'verified', 'handles', 'followed_claim',
  'invites',
]);

// An unknown value as TEXT, never as markup. Objects are JSON so a nested
// blob is at least readable; React escapes whatever comes out.
function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return String(value); }
}

// Human-readable rendering of a signup's two-stage survey answers
// (waitlist_signups.answers — stage 1 at join, stage 2 merged in later).
function SurveyAnswers({ answers, options }: { answers: Answers; options?: WaitlistOptions | null }) {
  const lines: ReactNode[] = [];
  const line = (label: string, value: ReactNode) => {
    if (value) {
      lines.push(
        <div key={label}>
          {/* The separating space lives INSIDE the label span rather than
              between two children: a whitespace-only JSX expression cannot
              survive hydration (React #418), and the span carries only a
              colour, so the space renders identically either side of it. */}
          <span className="text-zinc-500 dark:text-zinc-400">{`${label}: `}</span>
          {value}
        </div>,
      );
    }
  };
  const a = answers;
  const o = options || null;
  if (a.made_url) {
    // Selectable text, not an anchor — this screen never renders an
    // API-supplied URL as a clickable href (escaping alone would not stop a
    // `javascript:` scheme). Admins can copy the URL out.
    line('Made', (
      <>
        <span className="select-all break-all">{a.made_url}</span>
        {a.made_note ? ` (${a.made_note})` : ''}
      </>
    ));
  }
  // The country half is a stored CODE — rendered through countryLabel so an
  // admin reads "Germany" rather than "DE", and "Elsewhere in Latin America
  // (region)" rather than "X-LA", which is a retired region answer and not
  // Laos. `city` is free text and passes through untouched. Still a plain
  // text child either way, so React escapes it and the module's rule that no
  // answer is ever an anchor is untouched.
  if (a.country || a.city) {
    line('Where', [a.city, a.country ? countryLabel(a.country) : ''].filter(Boolean).join(', '));
  }
  if (a.discovery && a.discovery.source) {
    const source = labelFor(o?.discovery_sources, a.discovery.source);
    line('Found us', source + (a.discovery.detail ? ` (${a.discovery.detail})` : ''));
  }
  if (a.referrer_handle) line('Referred by', a.referrer_handle);
  if (a.group && Object.keys(a.group).length) {
    const g = a.group;
    line('Group', [
      g.name,
      labelFor(o?.group_sizes, g.size),
      labelFor(o?.group_roles, g.role),
      (g.tools || []).map((t) => labelFor(o?.group_tools, t)).filter(Boolean).join(' / '),
    ].filter(Boolean).join(' · '));
    if (g.need) line('Group need', g.need);
  }
  if (a.loss && Object.keys(a.loss).length) {
    const l = a.loss;
    line('Lost a tool', [
      labelFor(o?.loss_answers, l.had),
      l.product,
      (l.kind || []).map((k) => labelFor(o?.loss_kinds, k)).filter(Boolean).join(' / '),
    ].filter(Boolean).join(' · '));
    if (l.story) line('Loss story', l.story);
  }
  if (a.verified && Object.keys(a.verified).length) {
    line('Verified', Object.entries(a.verified).map(([pf, h]) => (
      <span key={pf} className="text-emerald-700 dark:text-emerald-400">{`✓ ${pf} · ${h}  `}</span>
    )));
  }
  if (a.handles && Object.keys(a.handles).length) {
    line('Handles', Object.entries(a.handles).map(([pf, h]) => `${pf}: ${h}`).join(' · '));
  }
  // A CLAIM, and the copy says so. No network will confirm a follow for us
  // (see the note on `followed_claim` in services/waitlist-questions.js), so
  // an admin must not read this beside `Verified` and think we checked.
  if (a.followed_claim) line('Follow', 'Says they follow us (not verified)');
  // Legacy rows only — see Answers.invites. New signups record who they
  // brought in through invited_by, which surfaces in the Referrals column.
  if (Array.isArray(a.invites) && a.invites.length) {
    line('Invites (typed)', a.invites.join(', '));
  }
  const other = Object.keys(a).filter((k) => !KNOWN_ANSWER_KEYS.has(k)).sort();
  if (other.length) {
    line('Other answers', other.map((k) => `${k}: ${asText(a[k])}`).join(' · '));
  }
  if (!lines.length) return <div className="text-zinc-500 dark:text-zinc-400">No survey answers.</div>;
  return <>{lines}</>;
}

// What the row's own delivery record says about the one mail admitting sends.
// Null on every row in a staging clone: mail_deliveries is staging:private,
// so the table is copied schema-only and the seed writes its own fixtures.
function inviteMailLine(row: WaitlistRow): string | null {
  const m = row.invite_email;
  if (!m || !m.status) {
    if (!row.released_at) return null;
    return 'No delivery recorded.';
  }
  const when = m.created_at ? ` (${fmt(m.created_at)})` : '';
  if (m.status === 'sent') return `Sent${when}`;
  return `${m.status}${when}${m.error ? `: ${m.error}` : ''}`;
}

// The expandable block under a waitlist row: the dates the columns compress,
// what happened to the invite mail, and the survey answers. It is a component
// rather than a fragment the column builder returns because it reads the
// shared options fetch, and a hook needs a component to live in.
function WaitlistDetails({ row }: { row: WaitlistRow }) {
  const options = useWaitlistOptions();
  const mail = inviteMailLine(row);
  const detail = (label: string, value: ReactNode) => (value ? (
    <div key={label}>
      <span className="text-zinc-500 dark:text-zinc-400">{`${label}: `}</span>
      {value}
    </div>
  ) : null);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer select-none text-zinc-500 dark:text-zinc-400 min-h-[36px] flex items-center">
        Details
      </summary>
      <div className="mt-1 space-y-0.5 text-zinc-600 dark:text-zinc-300">
        {detail('Signed up', fmt(row.submitted_at))}
        {detail('Address confirmed', row.confirmed_at
          ? fmt(row.confirmed_at)
          : 'Never. The link in the join email was not followed.')}
        {detail('Admitted', row.released_at ? fmt(row.released_at) : 'Not yet.')}
        {detail('Invite email', mail)}
        {detail('Invite link used by', row.signals?.invited
          ? `${row.signals.invited} signup${row.signals.invited === 1 ? '' : 's'}`
          : null)}
        {detail('Came from', row.invited_by_email
          || (row.invited_by ? `signup #${row.invited_by}` : null))}
        <SurveyAnswers answers={row.answers || {}} options={options} />
      </div>
    </details>
  );
}

// One filtered, paged queue. Both lists on this screen are this component:
// they differ only in their endpoint, their columns and what admitting means.
function Queue<T>({
  hostId, title, subtitle, filterId, filterLabel, statusLabels, endpoint, columns,
  rowKey, empty, errorTitle, actions, extra, onlyFilterId, sortId, exportCsv,
  deleteAction, analytics, panel, search, toolbar, refreshKey,
}: {
  hostId: string;
  title: string;
  subtitle: string;
  filterId: string;
  filterLabel: string;
  statusLabels: Record<Status, string>;
  endpoint: string;
  columns: Column<T>[];
  rowKey: (item: T) => string | number;
  /**
   * The empty state, as a function of the filters that produced it. A single
   * pair of strings could only describe the unfiltered case, so "no rows"
   * under `only=confirmed` read as "nobody has signed up" when what it meant
   * was "nobody waiting has confirmed their address" — and the way out (widen
   * the filter) was exactly what the message failed to mention.
   */
  empty: (state: { status: Status; only: Only; q: string }) => { title: string; body: string };
  errorTitle: string;
  actions?: (item: T, reload: () => void) => ReactNode;
  extra?: (item: T) => ReactNode;
  /** Set to render the second `?only=` narrowing. Omitted: no second select. */
  onlyFilterId?: string;
  /** Set to render the order select. Omitted: the server's FIFO order only. */
  sortId?: string;
  /**
   * A CSV endpoint that takes the same `?status=` / `?only=` filters, set
   * only for an admin allowed to download it. Renders "Export CSV", which
   * downloads EVERY row the filters select rather than the page on screen.
   */
  exportCsv?: { id: string; path: string };
  /**
   * Turns on a checkbox per row plus a "Delete N selected" header button,
   * set only for an admin allowed to write. Omitted: no selection column,
   * same as before this existed.
   */
  deleteAction?: {
    bulkPath: string;
    itemLabel: (item: T) => string;
    confirmTitle: (n: number) => string;
    confirmMessage: (n: number) => string;
  };
  /**
   * Renders "Analytics" immediately before Export CSV, set only where a
   * dashboard exists for this queue. `onClick` is a toggle, not a route —
   * the caller owns the boolean that decides whether `panel` renders.
   */
  analytics?: { id: string; onClick: () => void };
  /**
   * Arbitrary content shown between the header and the table, the same slot
   * onchain-accounts.tsx's `#admin-topo-oa-form` fills for its import panel.
   */
  panel?: ReactNode;
  /**
   * Set to render a search box directly above the table, sent as `?q=` with
   * the other filters (and so carried into Export CSV too). Omitted: none.
   */
  search?: { id: string; label: string; placeholder: string };
  /** More header controls, rendered ahead of Analytics. */
  toolbar?: ReactNode;
  /** Bump to reload the page on screen, e.g. after something else admitted rows. */
  refreshKey?: number;
}) {
  const [status, setStatus] = useState<Status>('pending');
  const [only, setOnly] = useState<Only>('any');
  const [sort, setSort] = useState<Sort>('waiting');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<T[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const [selected, setSelected] = useState<Set<string | number>>(new Set());
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // A new page or a changed filter is a different set of rows, so a
  // selection made under the old ones no longer means anything.
  useEffect(() => { setSelected(new Set()); }, [status, only, sort, q, page]);

  // The filters alone, shared by the page fetch and the export so the file
  // always holds the rows the selects describe.
  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (status !== 'all') params.set('status', status);
    if (onlyFilterId && only !== 'any') params.set('only', only);
    if (search && q) params.set('q', q);
    return params;
  }, [only, onlyFilterId, q, search, status]);

  const load = useCallback(async () => {
    const params = filterParams();
    params.set('page', String(page));
    params.set('per_page', '50');
    // `waiting` is the absence of a sort param, not a value the server knows.
    if (sortId && sort === 'answered') params.set('sort', 'answered');
    const res = await fetchJson(`${endpoint}?${params}`);
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
  }, [endpoint, filterParams, page, sort, sortId]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // The search box drives a paged server query, so it commits on Enter or
  // blur rather than on every keystroke (AGENTS.md, "The console is React").
  // Emptying it is the one exception: that commits at once, since the way
  // back to the whole list should not need a second gesture.
  const commitSearch = useCallback((value: string) => {
    const next = value.trim();
    if (next === q) return;
    setQ(next);
    setPage(1);
  }, [q]);

  const runBulkDelete = useCallback(async () => {
    if (!canWrite() || !deleteAction || !selected.size) return;
    const n = selected.size;
    const okd = await topo()._confirm({
      title: deleteAction.confirmTitle(n),
      message: deleteAction.confirmMessage(n),
      confirmLabel: 'Delete',
    });
    if (!okd) return;
    const { ok, data } = await send('POST', deleteAction.bulkPath, { ids: Array.from(selected) });
    if (!ok || !data?.success) {
      topo()._alert(data?.error || 'Could not delete the selected entries.');
      return;
    }
    setSelected(new Set());
    load();
  }, [deleteAction, load, selected]);

  const blank = empty({ status, only, q });

  return (
    <>
      <ScreenHeader
        title={title}
        subtitle={subtitle}
        actions={(
          <>
            {deleteAction && selected.size > 0 ? (
              <button
                id={`${hostId}-bulk-delete`}
                type="button"
                className={BTN.dangerSm}
                onClick={runBulkDelete}
              >
                {`Delete ${selected.size} selected`}
              </button>
            ) : null}
            <StatusSelect
              id={filterId}
              label={filterLabel}
              value={status}
              labels={statusLabels}
              onChange={(next) => { setStatus(next); setPage(1); }}
            />
            {onlyFilterId ? (
              <Select
                id={onlyFilterId}
                aria-label="Filter by what the signup did"
                className="sm:w-52"
                value={only}
                onChange={(e) => { setOnly(e.target.value as Only); setPage(1); }}
              >
                {ONLY.map((v) => (
                  <option key={v} value={v}>{ONLY_LABELS[v]}</option>
                ))}
              </Select>
            ) : null}
            {sortId ? (
              <Select
                id={sortId}
                aria-label="Order the queue"
                className="sm:w-44"
                value={sort}
                onChange={(e) => { setSort(e.target.value as Sort); setPage(1); }}
              >
                {SORTS.map((v) => (
                  <option key={v} value={v}>{SORT_LABELS[v]}</option>
                ))}
              </Select>
            ) : null}
            {toolbar}
            {analytics ? (
              <button
                id={analytics.id}
                type="button"
                className={BTN.secondarySm}
                title="See signup totals and trends for this queue"
                onClick={analytics.onClick}
              >
                Analytics
              </button>
            ) : null}
            {exportCsv ? (
              <button
                id={exportCsv.id}
                type="button"
                className={BTN.secondarySm}
                title="Download every signup these filters select, not just this page"
                onClick={() => {
                  // Navigation, not a Blob: the server streams the file as an
                  // attachment, the same as the Users screen's export. The
                  // path is a constant and the query is built from the
                  // selects' own fixed values.
                  const query = filterParams().toString();
                  window.location.href = query ? `${exportCsv.path}?${query}` : exportCsv.path;
                }}
              >
                Export CSV
              </button>
            ) : null}
          </>
        )}
      />
      {panel}
      {search ? (
        <div className="mb-3">
          <Input
            id={search.id}
            type="search"
            aria-label={search.label}
            placeholder={search.placeholder}
            maxLength={320}
            autoComplete="off"
            spellCheck={false}
            onBlur={(e) => commitSearch(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitSearch(e.currentTarget.value);
              }
            }}
            onChange={(e) => { if (!e.currentTarget.value) commitSearch(''); }}
          />
        </div>
      ) : null}
      <div id={hostId}>
        {items === null ? <Skeleton rows={4} /> : null}
        {error ? (
          <ErrorState
            title={errorTitle}
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {items !== null && !error && !items.length ? (
          <EmptyState title={blank.title} body={blank.body} />
        ) : null}
        {items !== null && !error && items.length ? (
          <>
            <List
              items={items}
              rowKey={rowKey}
              columns={columns}
              actions={actions ? (it) => actions(it, load) : undefined}
              extra={extra}
              selection={deleteAction ? {
                isSelected: (it) => selected.has(rowKey(it)),
                onToggle: (it, checked) => {
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(rowKey(it)); else next.delete(rowKey(it));
                    return next;
                  });
                },
                allSelected: items.length > 0 && items.every((it) => selected.has(rowKey(it))),
                onToggleAll: (checked) => {
                  setSelected(checked ? new Set(items.map(rowKey)) : new Set());
                },
                itemLabel: (it) => `Select ${deleteAction.itemLabel(it)}`,
              } : undefined}
            />
            <Pager meta={meta} onPage={setPage} />
          </>
        ) : null}
      </div>
    </>
  );
}

// ── Waitlist analytics dashboard (#2748) ────────────────────────────────
//
// A read-only summary layered over the same rows the queue above lists.
// Every figure comes straight off `/api/v4/admin/waitlist/analytics`,
// which itself derives everything from columns the queue already renders
// (`released_at`, `confirmed_at`, `linked_user_id`) — no invented status
// enum on either side of the wire.

type WaitlistAnalytics = {
  totalSignups: number;
  waiting: number;
  admitted: number;
  confirmed: number;
  linked: number;
  series: { day: string; count: number }[];
};

// The signup trend is a single series, so it takes one hue with no legend
// box (the heading above the chart already names what is plotted) — this
// is the same indigo already shipped for a primary/signup-like metric in
// the admin analytics screen (`SPEND_PLATFORM`).
const WL_TREND_COLOR = '#6366f1';

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function WaitlistTrendChart({ series }: { series: { day: string; count: number }[] }) {
  const W = 640;
  const H = 160;
  const padTop = 16;
  const padBottom = 8;
  const n = series.length;
  const counts = series.map((p) => p.count);
  const max = Math.max(1, ...counts);
  const step = n > 1 ? W / (n - 1) : W;
  const x = (i: number) => i * step;
  const y = (v: number) => padTop + (H - padTop - padBottom) * (1 - v / max);
  const points = counts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const lastIndex = n - 1;
  const lastValue = lastIndex >= 0 ? counts[lastIndex] : 0;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      style={{ height: '160px' }}
      role="img"
      aria-label={`Signups per day over the last ${n} days, most recently ${lastValue}`}
    >
      {[0, 0.5, 1].map((f) => {
        const gy = padTop + (H - padTop - padBottom) * f;
        return (
          <line
            key={f}
            x1={0}
            y1={gy}
            x2={W}
            y2={gy}
            stroke="currentColor"
            strokeOpacity={0.12}
            strokeWidth={1}
            className="text-zinc-400 dark:text-zinc-500"
          />
        );
      })}
      {n > 0 ? (
        <polyline
          points={points}
          fill="none"
          stroke={WL_TREND_COLOR}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
      {series.map((p, i) => (
        <circle
          key={p.day}
          cx={x(i)}
          cy={y(p.count)}
          r={i === lastIndex ? 5 : 3}
          fill={WL_TREND_COLOR}
          strokeWidth={2}
          className="stroke-white dark:stroke-zinc-900"
        >
          <title>{`${p.day}: ${p.count} signup${p.count === 1 ? '' : 's'}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// The waiting/admitted split is a status (a signup's lifecycle state), not
// an open-ended category, so it reuses the exact reserved tones the queue's
// own Status column already wears (`Badge tone="amber"` / `tone="green"`)
// rather than picking a new pair.
function WaitlistStatusBreakdown({ waiting, admitted }: { waiting: number; admitted: number }) {
  const total = Math.max(1, waiting + admitted);
  const waitingPct = Math.round((waiting / total) * 100);
  const admittedPct = 100 - waitingPct;
  return (
    <div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
        role="img"
        aria-label={`${waiting} waiting, ${admitted} admitted`}
      >
        {waiting > 0 ? (
          <div
            className="h-full bg-amber-400 dark:bg-amber-500"
            style={{ width: `${waitingPct}%`, marginRight: admitted > 0 ? '2px' : 0 }}
          />
        ) : null}
        {admitted > 0 ? (
          <div className="h-full bg-green-500 dark:bg-green-600" style={{ width: `${admittedPct}%` }} />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="amber" label="Waiting" />
          {`${waiting.toLocaleString()} (${waitingPct}%)`}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Badge tone="green" label="Admitted" />
          {`${admitted.toLocaleString()} (${admittedPct}%)`}
        </span>
      </div>
    </div>
  );
}

function WaitlistAnalyticsPanel({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<WaitlistAnalytics | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    setError(null);
    const res = await fetchJson('/api/v4/admin/waitlist/analytics');
    if (!alive.current) return;
    if (res.ok && res.data?.success) {
      setData(res.data.data);
      return;
    }
    setData(null);
    setError({ status: res.status, message: (res.data && res.data.error) || null });
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div id="admin-topo-wl-analytics-panel">
      <Panel
        title="Waitlist analytics"
        subtitle="Totals and a 30-day trend for the signups in the queue below."
        onClose={onClose}
        closeLabel="Close the waitlist analytics dashboard"
      >
        {data === null && !error ? <Skeleton rows={3} /> : null}
        {error ? (
          <ErrorState
            title="Couldn't load waitlist analytics"
            status={error.status}
            message={error.message}
            onRetry={load}
          />
        ) : null}
        {data ? (
          <div className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              <StatTile label="Total signups" value={data.totalSignups} />
              <StatTile label="Waiting" value={data.waiting} />
              <StatTile label="Admitted" value={data.admitted} />
              <StatTile label="Confirmed email" value={data.confirmed} />
              <StatTile label="Linked to an account" value={data.linked} />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Signups, last 30 days
              </div>
              <WaitlistTrendChart series={data.series} />
            </div>
            <WaitlistStatusBreakdown waiting={data.waiting} admitted={data.admitted} />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

// ── Invites: retired ─────────────────────────────────────────────────────
//
// The switch for invite links skipping the waitlist ("the invite tree")
// lived here. Private membership replaced it: anyone new an invite link
// brings in joins its community straight away as a private member, and is
// admitted from this queue like anybody else (services/community-invites.js).

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── The story landing: what a signed-out visitor is asked to do ─────────
//
// On (the default), the landing tells the first-session story and asks them
// to get started: an account is made on the spot (services/first-session.js).
// Off, it points at the waitlist ("Join the waitlist"). It belongs beside the
// invite setting because it is the same valve.

type StoryLanding = { enabled: boolean; updated_at?: string | null; updated_by?: string | null };

function StoryLandingPanel() {
  const [story, setStory] = useState<StoryLanding | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const saving = useRef(false);

  const load = useCallback(async () => {
    setError(null);
    const { status, ok, data } = await fetchJson('/api/v4/admin/story-landing');
    if (!ok || !data?.success) { setError({ status, message: data?.error || null }); return; }
    setStory(data.data);
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = useCallback(async (next: boolean) => {
    if (!canWrite() || saving.current) return;
    saving.current = true;
    const { ok, data } = await send('PUT', '/api/v4/admin/story-landing', { enabled: next });
    saving.current = false;
    if (!ok || !data?.success) { topo()._alert(data?.error || 'Could not save the landing setting.'); return; }
    setStory(data.data);
  }, []);

  const help = 'Signed-out visitors see what Homeroom is and "Get started", which makes an account '
    + 'and asks them what to make. Off, they are sent to the waitlist instead. Anyone new still '
    + 'waits here until admitted unless they already have access.';
  return (
    <div id="admin-topo-wl-story">
      <Panel title="Landing">
        {error ? (
          <ErrorState title="Couldn't load the landing setting" status={error.status} message={error.message} onRetry={load} />
        ) : null}
        {!error && !story ? <Skeleton rows={1} /> : null}
        {!error && story ? (
          canWrite() ? (
            <CheckField id="admin-topo-wl-story-enabled" label="Signed-out landing asks people to get started" help={help} checked={story.enabled} onChange={toggle} />
          ) : (
            <p className="text-xs text-zinc-600 dark:text-zinc-400">
              <span className="font-medium">{story.enabled ? 'The landing asks people to get started.' : 'The landing points at the waitlist.'}</span>
              {` ${help}`}
            </p>
          )
        ) : null}
        {story?.updated_at ? (
          <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">
            {`Last switched ${fmt(story.updated_at)}${story.updated_by ? ` by ${story.updated_by}` : ''}.`}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

// ── Batch admit: paste a list, see who is there, admit them together ────
//
// For the case the one-row Admit button handles badly: a list of addresses
// that came from somewhere else (a sign-up sheet, an event, a spreadsheet)
// and needs letting in. The panel resolves the paste against the waitlist
// first (POST …/waitlist/resolve), shows what each address turned out to be,
// and only then offers to admit the ones actually waiting
// (POST …/waitlist/bulk-release). Nothing is admitted by the lookup.
//
// The lookup answers from the text it was GIVEN, and Admit acts on the rows
// that answer listed — not on whatever the box holds now. Editing the paste
// after looking it up therefore cannot slip an unreviewed address into the
// admit; it shows as unchecked until "Look up" runs again.

type ResolvedEntry = {
  input: string;
  email: string | null;
  match: 'waiting' | 'admitted' | 'not_found' | 'invalid';
  signup?: {
    id: number;
    email: string;
    submitted_at?: string | null;
    released_at?: string | null;
    confirmed_at?: string | null;
    linked_username?: string | null;
    has_platform_access?: boolean | null;
  };
  account?: { username: string | null; has_platform_access: boolean } | null;
};

type Resolution = {
  entries: ResolvedEntry[];
  skipped: number;
  duplicates: number;
  admit_max: number;
};

type AdmitOutcome = {
  admitted: number[];
  already_admitted: number[];
  not_found: number[];
  failed: number[];
};

const MATCH_BADGE: Record<ResolvedEntry['match'], { tone: string; label: string }> = {
  waiting: { tone: 'amber', label: 'Waiting' },
  admitted: { tone: 'green', label: 'Already admitted' },
  not_found: { tone: 'zinc', label: 'Not on the waitlist' },
  invalid: { tone: 'zinc', label: 'Not an address' },
};

// What else is worth knowing about one resolved address, in a sentence.
function resolvedDetail(e: ResolvedEntry): string {
  if (e.match === 'invalid') return 'This doesn’t look like an email address.';
  if (e.match === 'not_found') {
    if (!e.account) return 'Nobody with this address has joined the waitlist or made an account.';
    const who = e.account.username ? ` (${e.account.username})` : '';
    return e.account.has_platform_access
      ? `Not on the waitlist, but has an account${who} that already has access.`
      : `Not on the waitlist, but has an account${who} without access. Grant it from Users.`;
  }
  const s = e.signup;
  if (!s) return '';
  if (e.match === 'admitted') return `Admitted ${fmt(s.released_at)}.`;
  const bits = [
    s.confirmed_at ? 'Confirmed address' : 'Never confirmed their address',
    s.linked_username ? `account ${s.linked_username}` : 'no account yet',
  ];
  const waited = ago(s.submitted_at);
  if (waited) bits.push(`joined ${waited}`);
  return `${bits.join(' · ')}.`;
}

const RESOLVED_COLUMNS: Column<ResolvedEntry>[] = [
  {
    // Same treatment as the queue's Signup column, so an address reads the
    // same in both tables.
    label: 'Address',
    primary: true,
    tdClass: 'font-mono',
    cell: (e) => e.email || e.input,
  },
  {
    label: 'Found',
    tdClass: 'whitespace-nowrap',
    cell: (e) => <Badge tone={MATCH_BADGE[e.match].tone} label={MATCH_BADGE[e.match].label} />,
  },
  {
    label: 'Details',
    tdClass: 'text-xs text-zinc-600 dark:text-zinc-300',
    cell: (e) => resolvedDetail(e),
  },
];

// The result of the lookup in one line, counts first. (`plural` is the
// Invites panel's, above.)
function resolutionSummary(r: Resolution): string {
  const count = (m: ResolvedEntry['match']) => r.entries.filter((e) => e.match === m).length;
  const parts = [
    `${count('waiting')} waiting`,
    `${count('admitted')} already admitted`,
    `${count('not_found')} not on the waitlist`,
  ];
  const invalid = count('invalid');
  if (invalid) parts.push(`${invalid} not ${invalid === 1 ? 'an address' : 'addresses'}`);
  const aside: string[] = [];
  if (r.duplicates) aside.push(`${plural(r.duplicates, 'repeat', 'repeats')} dropped`);
  if (r.skipped) aside.push(`${plural(r.skipped, 'word', 'words')} without an @ ignored`);
  return `${plural(r.entries.length, 'address', 'addresses')}: ${parts.join(' · ')}.`
    + (aside.length ? ` (${aside.join(', ')}.)` : '');
}

function admitOutcomeLine(o: AdmitOutcome): string {
  const parts = [`Admitted ${plural(o.admitted.length, 'signup', 'signups')}.`];
  const already = o.already_admitted.length;
  if (already) parts.push(`${already} ${already === 1 ? 'was' : 'were'} already in.`);
  if (o.not_found.length) parts.push(`${o.not_found.length} had been deleted from the waitlist.`);
  if (o.failed.length) {
    parts.push(`${o.failed.length} could not be admitted; look the list up again and retry.`);
  }
  return parts.join(' ');
}

function BatchAdmitPanel({ onClose, onAdmitted }: { onClose: () => void; onAdmitted: () => void }) {
  const [text, setText] = useState('');
  const [resolvedText, setResolvedText] = useState<string | null>(null);
  const [result, setResult] = useState<Resolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<'resolve' | 'admit' | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const resolve = useCallback(async (source: string) => {
    // A read, but behind the write gate on the server (see the route), so
    // it is guarded like the admit it exists for.
    if (!canWrite()) return;
    setBusy('resolve');
    setError(null);
    const { ok, data } = await send('POST', '/api/v4/admin/waitlist/resolve', { text: source });
    if (!alive.current) return;
    setBusy(null);
    if (!ok || !data?.success) {
      setResult(null);
      setResolvedText(null);
      setError(data?.error || 'Could not look these addresses up.');
      return;
    }
    setResult(data.data);
    setResolvedText(source);
  }, []);

  const waiting = result ? result.entries.filter((e) => e.match === 'waiting' && e.signup) : [];
  const admitMax = result ? result.admit_max : 0;
  const batch = waiting.slice(0, admitMax);
  const stale = result !== null && resolvedText !== text;

  const admitAll = async () => {
    if (!canWrite() || !batch.length || resolvedText === null) return;
    const n = batch.length;
    const unconfirmed = batch.filter((e) => !e.signup?.confirmed_at).length;
    const okd = await topo()._confirm({
      title: `Admit ${plural(n, 'signup', 'signups')} off the waitlist?`,
      message: `Each gets platform access straight away if they already have an account, `
        + `otherwise the moment they create one, and is emailed a link to sign in or create `
        + `their account.${unconfirmed
          ? ` ${plural(unconfirmed, 'address was', 'addresses were')} never confirmed, so `
            + `${unconfirmed === 1 ? 'that email' : 'those emails'} may not reach anyone.`
          : ''} This cannot be undone from here.`,
      confirmLabel: `Admit ${n}`,
    });
    if (!okd) return;
    setBusy('admit');
    setError(null);
    setNotice(null);
    const { ok, data } = await send('POST', '/api/v4/admin/waitlist/bulk-release', {
      ids: batch.map((e) => e.signup!.id),
    });
    if (!alive.current) return;
    setBusy(null);
    if (!ok || !data?.success) {
      setError(data?.error || 'Could not admit these signups.');
      return;
    }
    setNotice(admitOutcomeLine(data.data));
    onAdmitted();
    // Look the same list up again, so every row reads what it is now and a
    // list longer than one batch shows the rest still waiting.
    resolve(resolvedText);
  };

  const clear = () => {
    setText('');
    setResult(null);
    setResolvedText(null);
    setError(null);
    setNotice(null);
  };

  return (
    <div id="admin-topo-wl-batch-panel">
      <Panel
        title="Batch admit"
        subtitle="Paste a list of email addresses to see which of them are on the waitlist, then admit everyone who is waiting in one go."
        onClose={onClose}
        closeLabel="Close the batch admit tool"
        footer={(
          <>
            <button
              id="admin-topo-wl-batch-resolve"
              type="button"
              className={result && !stale ? BTN.secondary : BTN.primary}
              disabled={busy !== null || !text.trim()}
              onClick={() => resolve(text)}
            >
              {busy === 'resolve' ? 'Looking up…' : 'Look up'}
            </button>
            {result && batch.length ? (
              <button
                id="admin-topo-wl-batch-admit"
                type="button"
                className={BTN.primary}
                disabled={busy !== null || stale}
                title={stale ? 'The list changed since it was looked up. Look it up again first.' : undefined}
                onClick={admitAll}
              >
                {busy === 'admit'
                  ? 'Admitting…'
                  : (waiting.length > admitMax
                    ? `Admit the first ${batch.length} waiting`
                    : `Admit all ${batch.length} waiting`)}
              </button>
            ) : null}
            <button
              id="admin-topo-wl-batch-clear"
              type="button"
              className={BTN.secondary}
              disabled={busy !== null || (!text && !result)}
              onClick={clear}
            >
              Clear
            </button>
          </>
        )}
      >
        <Field
          label="Email addresses"
          htmlFor="admin-topo-wl-batch-input"
          help="One per line, or separated by commas or spaces. A copied spreadsheet column or a mail client’s “Name <address>” list works too."
        >
          <Textarea
            id="admin-topo-wl-batch-input"
            rows={6}
            spellCheck={false}
            placeholder={'jane@example.com\nsam@example.com'}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <FormError message={error} />
        {notice ? (
          <p
            id="admin-topo-wl-batch-notice"
            role="status"
            className="mt-3 rounded-lg bg-green-50 dark:bg-green-950/40 px-3 py-2 text-xs text-green-700 dark:text-green-400"
          >
            {notice}
          </p>
        ) : null}
        {result ? (
          <div id="admin-topo-wl-batch-results" className="mt-4">
            <p className="mb-2 text-xs text-zinc-600 dark:text-zinc-300">{resolutionSummary(result)}</p>
            {stale ? (
              <p className="mb-2 text-xs text-amber-800 dark:text-amber-400">
                The list has changed since it was looked up. Look it up again before admitting.
              </p>
            ) : null}
            {waiting.length > admitMax ? (
              <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">
                {`Admitting sends each person an email, and the hourly email budget is shared with sign-in codes, so one batch admits at most ${admitMax}. Run it again for the rest.`}
              </p>
            ) : null}
            <List
              items={result.entries}
              rowKey={(e, i) => `${i}:${e.input}`}
              columns={RESOLVED_COLUMNS}
            />
          </div>
        ) : null}
      </Panel>
    </div>
  );
}

// What a row is called on this screen: its address — or, for a phone join,
// which has none (#4223), its account, so no row shows a blank name.
const wlIdent = (w: WaitlistRow) => w.email
  || (w.linked_username ? `@${w.linked_username}` : `signup #${w.id}`);

const WAITLIST_COLUMNS: Column<WaitlistRow>[] = [
  {
    label: 'Signup',
    primary: true,
    tdClass: 'font-mono',
    cell: (w) => (
      <>
        {w.email ?? (
          <span className="flex flex-col">
            <span>{wlIdent(w)}</span>
            <span
              className="text-xs text-zinc-500 dark:text-zinc-400"
              title="Joined with a verified phone number, so there is no address"
            >
              {w.phone_last4 ? `Phone ····${w.phone_last4}` : 'Phone'}
            </span>
          </span>
        )}
        {w.confirmed_at ? (
          <span
            className="text-emerald-700 dark:text-emerald-400 text-xs"
            title={`Followed the confirm link in the join email on ${fmt(w.confirmed_at)}`}
          >
            {' ✓ confirmed'}
          </span>
        ) : (
          <span
            className="text-zinc-500 dark:text-zinc-400 text-xs"
            title="Never followed the confirm link in the join email, so this address is unproven"
          >
            {' unconfirmed'}
          </span>
        )}
      </>
    ),
  },
  {
    // Where the row is in the one process this screen runs, said in the two
    // words the action uses. "pending" and "Released <date>" were the old
    // pair, and neither named what an admin was looking at.
    label: 'Status',
    cell: (w) => (w.released_at
      ? <span title={`Admitted ${fmt(w.released_at)}`}><Badge tone="green" label="Admitted" /></span>
      : <Badge tone="amber" label="Waiting" />),
  },
  {
    // The queue question is "how long has this person been waiting", which an
    // absolute timestamp makes the reader compute. The timestamp is still one
    // hover away.
    label: 'Waiting',
    tdClass: 'text-xs text-zinc-500 dark:text-zinc-400',
    cell: (w) => (
      <span title={fmt(w.submitted_at)}>{ago(w.submitted_at) || fmt(w.submitted_at)}</span>
    ),
  },
  {
    // What this signup DID, from services/waitlist-signals.js. Facts, not a
    // score: nothing here reorders the queue by itself, and how much each of
    // these is worth is still an open product decision.
    //
    // The denominator comes from the server (`sections_total`) rather than
    // being typed in here, which is the bug this column shipped with: the
    // section list grew to seven and the column kept saying "/6".
    label: 'Answers',
    hideOnCard: true,
    cell: (w) => {
      const s = w.signals;
      const bits: string[] = [];
      if (s && s.sections_total) bits.push(`${s.sections.length} of ${s.sections_total} answered`);
      if (s && s.verified.length) bits.push(`verified ${s.verified.join(', ')}`);
      return bits.length
        ? <span className="text-xs text-zinc-600 dark:text-zinc-300">{bits.join(' · ')}</span>
        : <span className="text-xs text-zinc-500 dark:text-zinc-400">Nothing answered yet</span>;
    },
  },
  {
    // Both directions of the invite graph. `invited` counts who used this
    // row's link; `invited_by_email` is whose link this row used, which is
    // the half the screen never showed.
    label: 'Referrals',
    cell: (w) => {
      const brought = w.signals?.invited || 0;
      const bits: string[] = [];
      if (brought) bits.push(`Brought in ${brought}`);
      if (w.invited_by_email) bits.push(`Came from ${w.invited_by_email}`);
      else if (w.invited_by) bits.push(`Came from signup #${w.invited_by}`);
      return bits.length
        ? <span className="text-xs text-zinc-600 dark:text-zinc-300">{bits.join(' · ')}</span>
        : <span className="text-xs text-zinc-500 dark:text-zinc-400">None</span>;
    },
  },
  {
    label: 'Account',
    cell: (w) => (w.linked_username ? (
      <>
        {w.linked_username}
        {w.has_platform_access ? (
          <span className="text-emerald-700 dark:text-emerald-400 text-xs">{' (has access)'}</span>
        ) : null}
      </>
    ) : <span className="text-zinc-500 dark:text-zinc-400">no account yet</span>),
  },
];

const bpIdent = (u: BpRow) => u.display_name || u.username || u.email || `user #${u.id}`;

const BP_COLUMNS: Column<BpRow>[] = [
  { label: 'User', primary: true, cell: (u) => u.display_name || u.username || `user #${u.id}` },
  { label: 'Email', cell: (u) => u.email || '—', tdClass: 'text-xs text-zinc-500 font-mono dark:text-zinc-400' },
  { label: 'Requested', cell: (u) => fmt(u.bp_requested_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
  {
    label: 'Status',
    cell: (u) => (u.bp_released_at
      ? <Badge tone="green" label={`Enabled ${fmt(u.bp_released_at)}`} />
      : <Badge tone="amber" label="Waiting" />),
  },
];

// The empty states, per filter combination. Each says what this VIEW is
// empty of and how to widen it, because "No waitlist entries" under
// `only=confirmed` was reporting the filter as if it were the database.
function waitlistEmpty({ status, only, q }: { status: Status; only: Only; q: string }) {
  const scope = status === 'pending' ? 'waiting' : (status === 'released' ? 'admitted' : 'listed');
  // The search goes first: it is the narrowing an admin applied last, and
  // the one most likely to be why the view is empty.
  if (q) {
    const narrowed = status !== 'all' || only !== 'any';
    return {
      title: `No ${scope} signup matches “${q}”`,
      body: 'Search looks for this text anywhere in the address or the account’s username. '
        + (narrowed
          ? 'Clear the search, or set the filters to All and Everyone, to see the rest.'
          : 'Clear the search to see the rest.'),
    };
  }
  if (only === 'confirmed') {
    return {
      title: 'Nobody here has confirmed their address',
      body: `No ${scope} signup has followed the link in its join email. `
        + 'Set the second filter back to Everyone to see the rest.',
    };
  }
  if (only === 'invited') {
    return {
      title: 'Nobody here has brought anyone in',
      body: `No ${scope} signup has had its invite link used. `
        + 'Set the second filter back to Everyone to see the rest.',
    };
  }
  if (status === 'pending') {
    return {
      title: 'Nobody is waiting',
      body: 'Everyone who has signed up is already in. New signups from the public join form land here.',
    };
  }
  if (status === 'released') {
    return {
      title: 'Nobody has been admitted yet',
      body: 'Admit a waiting signup and it moves here, with the date it was let in.',
    };
  }
  return {
    title: 'No waitlist entries',
    body: 'Signups from the public join form land here.',
  };
}

function bpEmpty({ status }: { status: Status; only: Only }) {
  if (status === 'pending') {
    return {
      title: 'No requests waiting',
      body: 'Every request has been handled. A new one appears when someone asks for producer keys from the app.',
    };
  }
  if (status === 'released') {
    return {
      title: 'Nobody is producing blocks yet',
      body: 'Enable a waiting request and it moves here, with the date it happened.',
    };
  }
  return {
    title: 'No block-production requests',
    body: 'Requests appear here when a user asks for producer keys from the app.',
  };
}

// A module constant rather than an inline literal: the Queue's page fetch
// depends on it, so a fresh object per render would re-fetch the page every
// time this screen re-rendered (opening a panel, say).
const WAITLIST_SEARCH = {
  id: 'admin-topo-wl-search',
  label: 'Search the waitlist by email or username',
  placeholder: 'Search by email or username',
};

function WaitlistScreen() {
  const write = canWrite();
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  // Bumped when the batch-admit panel admits rows, so the queue under it
  // re-reads the page it is on instead of listing them as still waiting.
  const [refreshKey, setRefreshKey] = useState(0);
  const onBatchAdmitted = useCallback(() => setRefreshKey((k) => k + 1), []);

  // "Admit", not "Release". The route, the column and the mail kind keep
  // their names; this is the only place a person reads the word.
  const admitWaitlist = useCallback(async (w: WaitlistRow, reload: () => void) => {
    if (!canWrite()) return;
    const unconfirmed = !w.confirmed_at
      ? ' This address was never confirmed, so the email may not reach anyone.'
      : '';
    const okd = await topo()._confirm({
      title: `Admit ${wlIdent(w)} off the waitlist?`,
      message: `They get platform access straight away if they already have an account, `
        + `otherwise the moment they create one.`
        + (w.email
          ? ` They will be emailed a link to sign in or create their account.`
          // A phone join has no address: no mail goes, and until the
          // platform can text (#4096) they find out on their next visit.
          : ` They will find out the next time they open Homeroom.`)
        + `${unconfirmed} This cannot be undone from here.`,
      confirmLabel: 'Admit',
    });
    if (!okd) return;
    const { ok, data } = await send('POST', `/api/v4/admin/waitlist/${w.id}/release`);
    if (!ok || !data?.success) { topo()._alert(data?.error || 'Could not admit this signup.'); return; }
    reload();
  }, []);

  const deleteWaitlistEntry = useCallback(async (w: WaitlistRow, reload: () => void) => {
    if (!canWrite()) return;
    const okd = await topo()._confirm({
      title: `Delete ${wlIdent(w)} from the waitlist?`,
      message: 'This removes the signup and its survey answers entirely. Anyone who used its invite '
        + 'link keeps their own place in line. This cannot be undone.',
      confirmLabel: 'Delete',
    });
    if (!okd) return;
    const { ok, data } = await send('DELETE', `/api/v4/admin/waitlist/${w.id}`);
    if (!ok || !data?.success) { topo()._alert(data?.error || 'Could not delete this signup.'); return; }
    reload();
  }, []);

  const enableBp = useCallback(async (u: BpRow, reload: () => void) => {
    if (!canWrite()) return;
    const okd = await topo()._confirm({
      title: `Enable block production for ${bpIdent(u)}?`,
      message: `Their phone gets the producer key and starts producing blocks the next time `
        + 'the app syncs its profile. This cannot be undone from here.',
      confirmLabel: 'Enable',
    });
    if (!okd) return;
    const { ok, data } = await send('POST', `/api/v4/admin/users/${u.id}/release-bp`);
    if (!ok || !data?.success) {
      topo()._alert(data?.error || 'Could not enable block production.');
      return;
    }
    reload();
  }, []);

  return (
    <>
      <Queue<WaitlistRow>
        hostId="admin-topo-wl-table"
        title="Platform waitlist"
        subtitle="Signups from the public join form. Admitting one grants platform access now if they have an account, or at signup if they do not, and emails them a link to get in."
        filterId="admin-topo-wl-status"
        filterLabel="Filter the waitlist by status"
        statusLabels={WL_STATUS_LABELS}
        onlyFilterId="admin-topo-wl-only"
        sortId="admin-topo-wl-sort"
        endpoint="/api/v4/admin/waitlist"
        search={WAITLIST_SEARCH}
        refreshKey={refreshKey}
        toolbar={write ? (
          <button
            id="admin-topo-wl-batch"
            type="button"
            className={BTN.secondarySm}
            title="Paste a list of email addresses, check who is on the waitlist, and admit them together"
            onClick={() => setShowBatch((s) => !s)}
          >
            Batch admit
          </button>
        ) : null}
        analytics={{ id: 'admin-topo-wl-analytics', onClick: () => setShowAnalytics((s) => !s) }}
        panel={(
          <>
            {showBatch ? (
              <BatchAdmitPanel onClose={() => setShowBatch(false)} onAdmitted={onBatchAdmitted} />
            ) : null}
            {showAnalytics ? <WaitlistAnalyticsPanel onClose={() => setShowAnalytics(false)} /> : null}
            <StoryLandingPanel />
          </>
        )}
        exportCsv={write
          ? { id: 'admin-topo-wl-export', path: '/api/v4/admin/waitlist/export-csv' }
          : undefined}
        columns={WAITLIST_COLUMNS}
        rowKey={(w) => w.id}
        empty={waitlistEmpty}
        errorTitle="Couldn't load the waitlist"
        actions={write ? (w, reload) => (
          <>
            {!w.released_at ? (
              <button
                data-release-wl={w.id}
                data-email={w.email}
                type="button"
                className={BTN.rowPrimary}
                onClick={() => admitWaitlist(w, reload)}
              >
                Admit
              </button>
            ) : null}
            <button
              data-delete-wl={w.id}
              data-email={w.email}
              type="button"
              className={BTN.rowDanger}
              onClick={() => deleteWaitlistEntry(w, reload)}
            >
              Delete
            </button>
          </>
        ) : undefined}
        extra={(w) => <WaitlistDetails row={w} />}
        deleteAction={write ? {
          bulkPath: '/api/v4/admin/waitlist/bulk-delete',
          itemLabel: (w) => wlIdent(w),
          confirmTitle: (n) => `Delete ${n} waitlist ${n === 1 ? 'entry' : 'entries'}?`,
          confirmMessage: (n) => `This removes ${n === 1 ? 'this signup' : 'these signups'} and `
            + `${n === 1 ? 'its' : 'their'} survey answers entirely. This cannot be undone.`,
        } : undefined}
      />
      <div className="mt-10">
        <Queue<BpRow>
          hostId="admin-topo-bpq-table"
          title="Block-producer queue"
          subtitle="Users who asked to produce blocks. Enabling one hands their phone the producer key."
          filterId="admin-topo-bpq-status"
          filterLabel="Filter the block-producer queue by status"
          statusLabels={BP_STATUS_LABELS}
          endpoint="/api/v4/admin/bp-queue"
          columns={BP_COLUMNS}
          rowKey={(u) => u.id}
          empty={bpEmpty}
          errorTitle="Couldn't load block-production requests"
          actions={write ? (u, reload) => (!u.bp_released_at ? (
            <button
              data-release-bp={u.id}
              data-identifier={bpIdent(u)}
              type="button"
              className={BTN.rowPrimary}
              onClick={() => enableBp(u, reload)}
            >
              Enable
            </button>
          ) : null) : undefined}
        />
      </div>
    </>
  );
}

// SurveyAnswers is exported for tests/topochain-waitlist-survey.test.js, which
// renders it against a hostile payload. The staging seed's answers are fixtures
// of our own writing, so a declared browser check cannot reach a real one — and
// the rule this enforces (an API-supplied URL is never a clickable href) is
// exactly the kind that needs executing, not grepping.
//
// WAITLIST_COLUMNS is exported for the same reason, for
// tests/admin-waitlist-status-column.test.js. The Status cell's admitted
// shape cannot be reached by a declared browser check either: the queue opens
// on `status: 'pending'`, whose server filter is `released_at IS NULL`, so an
// admitted row is never in the table a check at `/#admin/waitlist` sees.
//
// The batch-admit copy helpers and waitlistEmpty are exported for
// tests/topochain-admin-waitlist-batch.test.js: a lookup's answer only exists
// after a POST, so no static render or declared check reaches the sentences
// an admin reads about each pasted address.
export {
  SurveyAnswers, WaitlistScreen, WAITLIST_COLUMNS,
  BatchAdmitPanel, admitOutcomeLine, resolutionSummary, resolvedDetail, waitlistEmpty,
};
