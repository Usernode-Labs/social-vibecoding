'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';
// The console's shared page parts (26 Nov 2026): this page is built from the
// same header, figures, bar and list as every other admin page. The figures
// row is imported under another name because this file already exports a
// `Figures` type for the payload.
import { BTN } from './topochain/tokens.ts';
import {
  Badge, Figures as FigureRow, Input, List, ScreenHeader, Segmented, Select, Toolbar,
} from './topochain/ui.tsx';
import type { Column, Figure } from './topochain/ui.tsx';

// Apps & usage (#admin/apps): every app on the platform, who is in it, who
// has built it and how much it is being used, over the last 7, 30 or 90
// days. The figures are services/admin-apps-usage.js's, which says what each
// one counts. Search, sort and expand happen here on the one payload; only
// the time window goes back to the server.
//
// Read-only, so view-only admins see all of it.
//
// Ids are what dapp.json's declared check and
// tests/admin-apps-usage-section.test.js select on.

const console_ = () => (window as any).AdminConsole;

export interface Contributor {
  username: string;
  proposed: number;
  merged: number;
}

export interface AppUsage {
  slug: string;
  name: string;
  status: string;
  platform: boolean;
  visibility: string | null;
  creator: string | null;
  createdAt: string | null;
  lastDeployAt: string | null;
  lastActiveAt: string | null;
  members: number;
  newMembers: number;
  contributors: number;
  shippedContributors: number;
  topContributors: Contributor[];
  users: number;
  seconds: number;
  sessions: number;
  proposed: number;
  merged: number;
  requests: number;
  openRequests: number;
}

export interface Figures {
  apps: number;
  usedApps: number;
  builtApps: number;
  seconds: number;
  proposed: number;
  merged: number;
  requests: number;
}

export interface AppsUsagePayload {
  days: number;
  windows: number[];
  totals: Figures & {
    split: { platform: Figures; apps: Figures };
  };
  apps: AppUsage[];
}

export const SORTS: { key: string; label: string }[] = [
  { key: 'used', label: 'Most time used' },
  { key: 'users', label: 'Most users' },
  { key: 'members', label: 'Most members' },
  { key: 'contributors', label: 'Most contributors' },
  { key: 'merged', label: 'Most changes merged' },
  { key: 'active', label: 'Last active' },
  { key: 'newest', label: 'Newest' },
  { key: 'name', label: 'Name' },
];

/** Seconds as a short duration: "45s", "12m", "3h 20m", "2d 4h". Pure. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const time = (iso: string | null) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
};

/** The apps whose name, slug or creator contains the query. Pure. */
export function filterApps(apps: AppUsage[], query: string): AppUsage[] {
  const q = query.trim().toLowerCase();
  if (!q) return apps;
  return apps.filter((a) => [a.name, a.slug, a.creator || '']
    .some((v) => String(v).toLowerCase().includes(q)));
}

/** The apps in a sort's order, ties broken by name. Pure; never mutates. */
export function sortApps(apps: AppUsage[], key: string): AppUsage[] {
  const byName = (a: AppUsage, b: AppUsage) => a.name.localeCompare(b.name) || a.slug.localeCompare(b.slug);
  const desc = (f: (a: AppUsage) => number) => (a: AppUsage, b: AppUsage) => f(b) - f(a) || byName(a, b);
  const order: Record<string, (a: AppUsage, b: AppUsage) => number> = {
    used: desc((a) => a.seconds),
    users: desc((a) => a.users),
    members: desc((a) => a.members),
    contributors: desc((a) => a.contributors),
    merged: desc((a) => a.merged),
    active: desc((a) => time(a.lastActiveAt)),
    newest: desc((a) => time(a.createdAt)),
    name: byName,
  };
  return [...apps].sort(order[key] || order.used);
}

/**
 * How an app's status reads, and the badge it wears. Pure. `tone` is the
 * shared Badge's: the status is repeated down the list, so the usual one
 * (Running) is the soft mint, and only trouble is loud.
 */
export function statusBadge(status: string): { label: string; className: string; tone: string } {
  if (status === 'running') return { label: 'Running', className: AdminUI.badge.success, tone: 'mint' };
  if (status === 'error') return { label: 'Failed', className: AdminUI.badge.destructive, tone: 'red' };
  if (status === 'awaiting_secrets') return { label: 'Needs secrets', className: AdminUI.badge.warn, tone: 'amber' };
  return { label: status.replace(/_/g, ' '), className: AdminUI.badge.default, tone: 'zinc' };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function when(iso: string | null): string {
  const t = time(iso);
  if (t === -Infinity) return 'never';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The platform / apps split under each total, in the tile's own format.
 * Null when there is no payload yet, so the tile draws as it does while
 * loading. Pure.
 */
export function tileSplits(t: AppsUsagePayload['totals'] | null): Record<string, string> | null {
  if (!t || !t.split) return null;
  const { platform: p, apps: o } = t.split;
  return {
    apps: `${p.apps} platform · ${o.apps} apps`,
    used: `${p.usedApps} platform · ${o.usedApps} apps`,
    built: `${p.builtApps} platform · ${o.builtApps} apps`,
    time: `Platform ${formatDuration(p.seconds)} · apps ${formatDuration(o.seconds)}`,
    merged: `Platform ${p.merged} / ${p.proposed} · apps ${o.merged} / ${o.proposed}`,
    requests: `Platform ${p.requests} · apps ${o.requests}`,
  };
}

// A row's figure, with the hook the old row's stat carried.
const stat = (name: string, figure: string | number) => (
  <span data-stat={name} className="tabular-nums">{figure}</span>
);

const APP_COLUMNS: Column<AppUsage>[] = [
  {
    label: 'App',
    primary: true,
    cell: (app) => (
      <span data-app-slug={app.slug} className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-semibold">{app.name}</span>
        <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">{app.slug}</span>
        {app.platform ? <Badge label="Platform" tone="violet" /> : null}
      </span>
    ),
  },
  {
    label: 'Status',
    cell: (app) => {
      const badge = statusBadge(app.status);
      return <Badge label={badge.label} tone={badge.tone} />;
    },
  },
  { label: 'Members', cell: (app) => stat('members', app.members) },
  { label: 'Contributors', cell: (app) => stat('contributors', app.contributors) },
  { label: 'Users', cell: (app) => stat('users', app.users) },
  { label: 'Time used', cell: (app) => stat('time', formatDuration(app.seconds)) },
  { label: 'Proposed', cell: (app) => stat('proposed', app.proposed) },
  { label: 'Merged', cell: (app) => stat('merged', app.merged) },
  { label: 'Requests', cell: (app) => stat('requests', app.requests) },
  { label: 'Last active', cell: (app) => <span className="tabular-nums">{when(app.lastActiveAt)}</span> },
];

// What the row's arrow opens (ui.tsx `List`, `details`): who made the app and
// who has built it. It was a block the whole row toggled.
function AppDetails({ app }: { app: AppUsage }) {
  const slug = encodeURIComponent(app.slug);
  return (
    <div className="grid gap-3 sm:grid-cols-2 text-xs text-zinc-600 dark:text-zinc-300" data-app-detail={app.slug}>
      <div className="space-y-1">
        <p className="text-zinc-500 dark:text-zinc-400">About</p>
        <p>{`Made by ${app.creator ? `@${app.creator}` : 'an account that no longer exists'} on ${when(app.createdAt)}.`}</p>
        <p>{`Last deployed ${when(app.lastDeployAt)}. Visible to: ${app.visibility || 'unknown'}.`}</p>
        <p>{`${plural(app.newMembers, 'new member')} and ${plural(app.sessions, 'change')} started in this window; ${plural(app.openRequests, 'request')} open now.`}</p>
        <p className="flex flex-wrap gap-x-4">
          <a className={AdminUI.btn.link} href={`#app/${slug}`}>Open project</a>
          <a className={AdminUI.btn.link} href="#admin/storage">App storage</a>
        </p>
      </div>
      <div className="space-y-1">
        <p className="text-zinc-500 dark:text-zinc-400">
          {`Contributors (${app.contributors}, ${app.shippedContributors} with a change merged)`}
        </p>
        {app.topContributors.length ? (
          <ol className="space-y-0.5" data-app-contributors={app.slug}>
            {app.topContributors.map((c) => (
              <li key={c.username}>
                {`@${c.username}: ${plural(c.proposed, 'proposal')}, ${c.merged} merged`}
              </li>
            ))}
          </ol>
        ) : <p>Nobody has proposed a change yet.</p>}
      </div>
    </div>
  );
}

function AppsUsageSection() {
  const [days, setDays] = useState(30);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('used');
  const [data, setData] = useState<AppsUsagePayload | null>(null);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    const { data: next } = await console_().fetchJson(`/api/admin/apps-usage?days=${days}`);
    // A later window change, or leaving the section, wins.
    if (mine !== seq.current) return;
    if (!next || typeof next !== 'object' || !Array.isArray(next.apps)) { setFailed(true); return; }
    setFailed(false);
    setData(next as AppsUsagePayload);
  }, [days]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { seq.current += 1; }, []);

  const windows = data?.windows?.length ? data.windows : [7, 30, 90];
  const t = data?.totals;
  const splits = tileSplits(t || null);
  const shown = data ? sortApps(filterApps(data.apps, query), sort) : [];

  // The totals are the payload's own, so the tiles cost no read. The value
  // keeps the `data-tile` hook dapp.json's declared check selects on. A
  // shared figure has no second line, so the platform / apps split is its
  // tooltip.
  const tile = (key: string, value: string | null, label: string, tone: Figure['tone']): Figure => ({
    key,
    label,
    tone,
    value: <span data-tile={key}>{value === null ? '–' : value}</span>,
    detail: (splits && splits[key]) || undefined,
  });
  const figures: Figure[] = [
    tile('apps', t ? String(t.apps) : null, 'apps', 'sky'),
    tile('used', t ? String(t.usedApps) : null, 'used in this window', 'green'),
    tile('built', t ? String(t.builtApps) : null, 'with changes proposed or merged', 'yellow'),
    tile('time', t ? formatDuration(t.seconds) : null, 'time spent in apps', 'sky'),
    tile('merged', t ? `${t.merged} / ${t.proposed}` : null, 'merged / proposed', 'green'),
    tile('requests', t ? String(t.requests) : null, 'requests filed', 'yellow'),
  ];

  return (
    <div id="admin-apps-usage">
      <ScreenHeader
        title="Apps & usage"
        subtitle="Every app on the platform: its members, the people who have proposed changes to it, and how much it was used and built in the chosen window."
        actions={(
          <button id="admin-apps-usage-refresh" type="button" className={BTN.secondarySm} onClick={() => load()}>
            Refresh
          </button>
        )}
      />
      <FigureRow id="admin-apps-usage-totals" items={figures} />

      {/* Search, order and window are the list's, so they sit in the one bar
          over it (26 Nov 2026). The search filters the payload already here,
          so it answers as it is typed. */}
      <Toolbar>
        <div className="min-w-[14rem] flex-1">
          <Input id="admin-apps-usage-search" type="search" aria-label="Search" value={query}
            placeholder="Name, slug or creator" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="w-full sm:w-56">
          <Select id="admin-apps-usage-sort" aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </Select>
        </div>
        <Segmented
          id="admin-apps-usage-days"
          label="Time window"
          value={String(days)}
          options={windows.map((d) => ({ value: String(d), label: `${d} days`, title: `Last ${d} days` }))}
          onChange={(next) => setDays(Number(next))}
        />
      </Toolbar>

      <p className={`${AdminUI.muted} mb-3`} id="admin-apps-usage-summary" data-count={shown.length}
        data-state={failed ? 'failed' : (data ? 'ready' : 'loading')}>
        {failed ? 'Could not read apps & usage. Try Refresh.'
          : !data ? <span className={AdminUI.loading}>Loading…</span>
            : !data.apps.length ? 'No apps yet.'
              : shown.length === data.apps.length ? `${plural(shown.length, 'app')}, last ${data.days} days.`
                : `${shown.length} of ${plural(data.apps.length, 'app')} match, last ${data.days} days.`}
      </p>

      {shown.length ? (
        <div id="admin-apps-usage-list">
          <List
            items={shown}
            columns={APP_COLUMNS}
            rowKey={(app) => app.slug}
            details={(app) => <AppDetails app={app} />}
          />
        </div>
      ) : null}
    </div>
  );
}

let host: Element | null = null;

const AdminAppsUsage = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, <AppsUsageSection />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminAppsUsage = AdminAppsUsage;

export { AdminAppsUsage };
