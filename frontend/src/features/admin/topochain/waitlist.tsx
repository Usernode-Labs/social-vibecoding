'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { fetchJson, send } from './api.ts';
import { countryLabel } from './countries.ts';
import { BTN } from './tokens.ts';
import {
  Badge, EmptyState, ErrorState, List, Pager, ScreenHeader, Select, Skeleton, fmt,
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
// The sort select is the one addition, and it follows the same naming.

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
  email: string;
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
  rowKey, empty, errorTitle, actions, extra, onlyFilterId, sortId,
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
  empty: (state: { status: Status; only: Only }) => { title: string; body: string };
  errorTitle: string;
  actions?: (item: T, reload: () => void) => ReactNode;
  extra?: (item: T) => ReactNode;
  /** Set to render the second `?only=` narrowing. Omitted: no second select. */
  onlyFilterId?: string;
  /** Set to render the order select. Omitted: the server's FIFO order only. */
  sortId?: string;
}) {
  const [status, setStatus] = useState<Status>('pending');
  const [only, setOnly] = useState<Only>('any');
  const [sort, setSort] = useState<Sort>('waiting');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<T[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: '50' });
    if (status !== 'all') params.set('status', status);
    if (onlyFilterId && only !== 'any') params.set('only', only);
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
  }, [endpoint, only, onlyFilterId, page, sort, sortId, status]);

  useEffect(() => { load(); }, [load]);

  const blank = empty({ status, only });

  return (
    <>
      <ScreenHeader
        title={title}
        subtitle={subtitle}
        actions={(
          <>
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
          </>
        )}
      />
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
            />
            <Pager meta={meta} onPage={setPage} />
          </>
        ) : null}
      </div>
    </>
  );
}

const WAITLIST_COLUMNS: Column<WaitlistRow>[] = [
  {
    label: 'Signup',
    primary: true,
    tdClass: 'font-mono',
    cell: (w) => (
      <>
        {w.email}
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
      ? <Badge tone="green" label={`Admitted ${fmt(w.released_at)}`} />
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
function waitlistEmpty({ status, only }: { status: Status; only: Only }) {
  const scope = status === 'pending' ? 'waiting' : (status === 'released' ? 'admitted' : 'listed');
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

function WaitlistScreen() {
  const write = canWrite();

  // "Admit", not "Release". The route, the column and the mail kind keep
  // their names; this is the only place a person reads the word.
  const admitWaitlist = useCallback(async (w: WaitlistRow, reload: () => void) => {
    if (!canWrite()) return;
    const unconfirmed = !w.confirmed_at
      ? ' This address was never confirmed, so the email may not reach anyone.'
      : '';
    const okd = await topo()._confirm({
      title: `Admit ${w.email} off the waitlist?`,
      message: `They get platform access straight away if they already have an account, `
        + `otherwise the moment they create one. They will be emailed a link to sign in or `
        + `create their account.${unconfirmed} This cannot be undone from here.`,
      confirmLabel: 'Admit',
    });
    if (!okd) return;
    const { ok, data } = await send('POST', `/api/v4/admin/waitlist/${w.id}/release`);
    if (!ok || !data?.success) { topo()._alert(data?.error || 'Could not admit this signup.'); return; }
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
        columns={WAITLIST_COLUMNS}
        rowKey={(w) => w.id}
        empty={waitlistEmpty}
        errorTitle="Couldn't load the waitlist"
        actions={write ? (w, reload) => (!w.released_at ? (
          <button
            data-release-wl={w.id}
            data-email={w.email}
            type="button"
            className={BTN.rowPrimary}
            onClick={() => admitWaitlist(w, reload)}
          >
            Admit
          </button>
        ) : null) : undefined}
        extra={(w) => <WaitlistDetails row={w} />}
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
export { SurveyAnswers, WaitlistScreen };
