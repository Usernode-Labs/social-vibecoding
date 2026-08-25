'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { fetchJson, send } from './api.ts';
import { BTN } from './tokens.ts';
import {
  EmptyState, ErrorState, List, Pager, ScreenHeader, Select, Skeleton, fmt,
} from './ui.tsx';
import type { Column, PageMeta } from './ui.tsx';

// Waitlist — the platform waitlist (email-keyed queue with release) and the
// block-producer queue (users who asked to produce blocks), stacked on one
// screen. Onboarding-flow alignment: "release" on the platform list grants
// access now (if an account exists) or at account creation; "release" on the
// BP list is the manual key release that lets the mobile node enable block
// production.
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

const STATUSES = ['pending', 'released', 'all'] as const;
type Status = typeof STATUSES[number];

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
  invites?: string[];
  admit_together?: boolean;
};

function StatusSelect(
  { id, label, value, onChange }: { id: string; label: string; value: Status; onChange: (s: Status) => void },
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
        <option key={v} value={v}>{`${v[0].toUpperCase()}${v.slice(1)}`}</option>
      ))}
    </Select>
  );
}

// Human-readable rendering of a signup's two-stage survey answers
// (waitlist_signups.answers — stage 1 at join, stage 2 merged in later).
// Only known keys are surfaced.
function SurveyAnswers({ answers }: { answers: Answers }) {
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
  if (a.country || a.city) line('Where', [a.city, a.country].filter(Boolean).join(', '));
  if (a.discovery && a.discovery.source) {
    line('Found us', a.discovery.source + (a.discovery.detail ? ` (${a.discovery.detail})` : ''));
  }
  if (a.referrer_handle) line('Referred by', a.referrer_handle);
  if (a.group && Object.keys(a.group).length) {
    const g = a.group;
    line('Group', [g.name, g.size, g.role, (g.tools || []).join('/')].filter(Boolean).join(' · '));
    if (g.need) line('Group need', g.need);
  }
  if (a.loss && Object.keys(a.loss).length) {
    const l = a.loss;
    line('Lost a tool', [l.had, l.product, (l.kind || []).join('/')].filter(Boolean).join(' · '));
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
  if (Array.isArray(a.invites) && a.invites.length) {
    line('Invites', (
      <>
        {a.invites.join(', ')}
        {a.admit_together ? <span className="text-zinc-500 dark:text-zinc-400">{' (only together)'}</span> : null}
      </>
    ));
  } else if (a.admit_together) {
    line('Invites', <span className="text-zinc-500 dark:text-zinc-400">only together</span>);
  }
  if (!lines.length) return <div className="text-zinc-500 dark:text-zinc-400">No survey answers.</div>;
  return <>{lines}</>;
}

// One filtered, paged queue. Both lists on this screen are this component:
// they differ only in their endpoint, their columns and what Release means.
function Queue<T>({
  hostId, title, subtitle, filterId, filterLabel, endpoint, columns, rowKey,
  emptyTitle, emptyBody, errorTitle, actions, extra,
}: {
  hostId: string;
  title: string;
  subtitle: string;
  filterId: string;
  filterLabel: string;
  endpoint: string;
  columns: Column<T>[];
  rowKey: (item: T) => string | number;
  emptyTitle: string;
  emptyBody: string;
  errorTitle: string;
  actions?: (item: T, reload: () => void) => ReactNode;
  extra?: (item: T) => ReactNode;
}) {
  const [status, setStatus] = useState<Status>('pending');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<T[] | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [error, setError] = useState<{ status: number; message: string | null } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), per_page: '50' });
    if (status !== 'all') params.set('status', status);
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
  }, [endpoint, page, status]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <ScreenHeader
        title={title}
        subtitle={subtitle}
        actions={(
          <StatusSelect
            id={filterId}
            label={filterLabel}
            value={status}
            onChange={(next) => { setStatus(next); setPage(1); }}
          />
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
          <EmptyState title={emptyTitle} body={emptyBody} />
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
    label: 'Email',
    primary: true,
    tdClass: 'font-mono',
    cell: (w) => (
      <>
        {w.email}
        {w.confirmed_at ? (
          <span
            className="text-emerald-700 dark:text-emerald-400 text-xs"
            title="Followed the confirm link in the join email"
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
  { label: 'Joined', cell: (w) => fmt(w.submitted_at), tdClass: 'text-xs text-zinc-500 dark:text-zinc-400' },
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
  {
    label: 'Status',
    cell: (w) => (w.released_at
      ? (
        <span className="text-emerald-700 dark:text-emerald-400 text-xs">
          {`Released ${fmt(w.released_at)}`}
        </span>
      )
      : <span className="text-amber-800 dark:text-amber-400 text-xs">pending</span>),
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
      ? (
        <span className="text-emerald-700 dark:text-emerald-400 text-xs">
          {`Released ${fmt(u.bp_released_at)}`}
        </span>
      )
      : <span className="text-amber-800 dark:text-amber-400 text-xs">pending</span>),
  },
];

function WaitlistScreen() {
  const write = canWrite();

  const releaseWaitlist = useCallback(async (w: WaitlistRow, reload: () => void) => {
    if (!canWrite()) return;
    const okd = await topo()._confirm({
      title: 'Release off the waitlist?',
      message: `${w.email} gets platform access: immediately if they already have an account, otherwise the moment they create one. They'll be emailed a link to sign in or create their account.`,
      confirmLabel: 'Release',
    });
    if (!okd) return;
    const { ok, data } = await send('POST', `/api/v4/admin/waitlist/${w.id}/release`);
    if (!ok || !data?.success) { topo()._alert(data?.error || 'Release failed.'); return; }
    reload();
  }, []);

  const releaseBp = useCallback(async (u: BpRow, reload: () => void) => {
    if (!canWrite()) return;
    const okd = await topo()._confirm({
      title: 'Release block production?',
      message: `${bpIdent(u)}'s phone will start producing blocks the next time the app syncs its profile.`,
      confirmLabel: 'Release keys',
    });
    if (!okd) return;
    const { ok, data } = await send('POST', `/api/v4/admin/users/${u.id}/release-bp`);
    if (!ok || !data?.success) { topo()._alert(data?.error || 'Release failed.'); return; }
    reload();
  }, []);

  return (
    <>
      <Queue<WaitlistRow>
        hostId="admin-topo-wl-table"
        title="Platform waitlist"
        subtitle="Signups from the public join form. Releasing grants access."
        filterId="admin-topo-wl-status"
        filterLabel="Filter the waitlist by status"
        endpoint="/api/v4/admin/waitlist"
        columns={WAITLIST_COLUMNS}
        rowKey={(w) => w.id}
        emptyTitle="No waitlist entries"
        emptyBody="Signups from the public join form land here."
        errorTitle="Couldn't load the waitlist"
        actions={write ? (w, reload) => (!w.released_at ? (
          <button
            data-release-wl={w.id}
            data-email={w.email}
            type="button"
            className={BTN.rowPrimary}
            onClick={() => releaseWaitlist(w, reload)}
          >
            Release
          </button>
        ) : null) : undefined}
        extra={(w) => (w.answers ? (
          <details className="text-xs">
            <summary className="cursor-pointer select-none text-zinc-500 dark:text-zinc-400 min-h-[36px] flex items-center">
              Survey answers
            </summary>
            <div className="mt-1 space-y-0.5 text-zinc-600 dark:text-zinc-300">
              <SurveyAnswers answers={w.answers} />
            </div>
          </details>
        ) : null)}
      />
      <div className="mt-10">
        <Queue<BpRow>
          hostId="admin-topo-bpq-table"
          title="Block-producer queue"
          subtitle="Users who asked to produce blocks. Releasing hands over the key."
          filterId="admin-topo-bpq-status"
          filterLabel="Filter the block-producer queue by status"
          endpoint="/api/v4/admin/bp-queue"
          columns={BP_COLUMNS}
          rowKey={(u) => u.id}
          emptyTitle="No block-production requests"
          emptyBody="Requests appear here when a user asks for producer keys from the app."
          errorTitle="Couldn't load block-production requests"
          actions={write ? (u, reload) => (!u.bp_released_at ? (
            <button
              data-release-bp={u.id}
              data-identifier={bpIdent(u)}
              type="button"
              className={BTN.rowPrimary}
              onClick={() => releaseBp(u, reload)}
            >
              Release keys
            </button>
          ) : null) : undefined}
        />
      </div>
    </>
  );
}

// SurveyAnswers is exported for tests/topochain-waitlist-survey.test.js, which
// renders it against a hostile payload. The staging seed leaves `answers` empty,
// so a declared browser check cannot reach this block at all — and the rule it
// enforces (an API-supplied URL is never a clickable href) is exactly the kind
// that needs executing, not grepping.
export { SurveyAnswers, WaitlistScreen };
