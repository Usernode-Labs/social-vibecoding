'use strict';

import { useCallback, useEffect, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

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

export interface AppsUsagePayload {
  days: number;
  windows: number[];
  totals: {
    apps: number;
    usedApps: number;
    builtApps: number;
    seconds: number;
    proposed: number;
    merged: number;
    requests: number;
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

const UsageUI = Object.freeze({
  controls: 'grid gap-3 sm:grid-cols-3 mb-4',
  controlLabel: `${AdminUI.label} block mb-1`,
  tiles: 'grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6',
  tile: 'rounded-xl bg-zinc-100 dark:bg-zinc-800 p-3',
  tileFigure: 'text-xl font-semibold text-zinc-900 dark:text-zinc-100 tabular-nums',
  tileLabel: 'text-xs text-zinc-500 dark:text-zinc-400',
  row: 'rounded-xl bg-zinc-100 dark:bg-zinc-800',
  rowButton: 'w-full text-left p-3 rounded-xl hover:bg-zinc-200/60 dark:hover:bg-zinc-700/50 transition-colors',
  rowHead: 'flex flex-wrap items-center justify-between gap-2',
  rowName: 'text-sm font-semibold text-zinc-900 dark:text-zinc-100',
  rowSlug: 'text-xs font-mono text-zinc-500 dark:text-zinc-400',
  rowWhen: 'text-xs text-zinc-500 dark:text-zinc-400 tabular-nums',
  stats: 'grid gap-x-4 gap-y-1 grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 mt-2',
  stat: 'text-xs text-zinc-500 dark:text-zinc-400',
  statFigure: 'text-sm font-medium text-zinc-900 dark:text-zinc-100 tabular-nums',
  detail: 'px-3 pb-3 pt-1 grid gap-3 sm:grid-cols-2 text-sm text-zinc-700 dark:text-zinc-300',
  detailLabel: 'text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400 mb-1',
});

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

/** How an app's status reads, and the badge it wears. Pure. */
export function statusBadge(status: string): { label: string; className: string } {
  if (status === 'running') return { label: 'Running', className: AdminUI.badge.success };
  if (status === 'error') return { label: 'Failed', className: AdminUI.badge.destructive };
  if (status === 'awaiting_secrets') return { label: 'Needs secrets', className: AdminUI.badge.warn };
  return { label: status.replace(/_/g, ' '), className: AdminUI.badge.default };
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function when(iso: string | null): string {
  const t = time(iso);
  if (t === -Infinity) return 'never';
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function Tile({ id, figure, label }: { id: string; figure: string; label: string }) {
  return (
    <div className={UsageUI.tile} data-tile={id}>
      <div className={UsageUI.tileFigure}>{figure}</div>
      <div className={UsageUI.tileLabel}>{label}</div>
    </div>
  );
}

function Stat({ name, figure, label }: { name: string; figure: string | number; label: string }) {
  return (
    <div className={UsageUI.stat} data-stat={name}>
      <span className={UsageUI.statFigure}>{figure}</span> {label}
    </div>
  );
}

function AppRow({ app, open, onToggle }: { app: AppUsage; open: boolean; onToggle: () => void }) {
  const badge = statusBadge(app.status);
  const slug = encodeURIComponent(app.slug);
  return (
    <li className={UsageUI.row} data-app-slug={app.slug} data-open={open ? 'true' : 'false'}>
      <button type="button" className={UsageUI.rowButton} aria-expanded={open} onClick={onToggle}>
        <div className={UsageUI.rowHead}>
          <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
            <span className={UsageUI.rowName}>{app.name}</span>
            <span className={UsageUI.rowSlug}>{app.slug}</span>
            {app.platform ? <span className={AdminUI.badge.secondary}>Platform</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <span className={UsageUI.rowWhen}>{`Last active ${when(app.lastActiveAt)}`}</span>
            <span className={badge.className}>{badge.label}</span>
          </div>
        </div>
        <div className={UsageUI.stats}>
          <Stat name="members" figure={app.members} label={app.members === 1 ? 'member' : 'members'} />
          <Stat name="contributors" figure={app.contributors} label={app.contributors === 1 ? 'contributor' : 'contributors'} />
          <Stat name="users" figure={app.users} label={app.users === 1 ? 'user' : 'users'} />
          <Stat name="time" figure={formatDuration(app.seconds)} label="used" />
          <Stat name="proposed" figure={app.proposed} label="proposed" />
          <Stat name="merged" figure={app.merged} label="merged" />
          <Stat name="requests" figure={app.requests} label={app.requests === 1 ? 'request' : 'requests'} />
        </div>
      </button>
      {open ? (
        <div className={UsageUI.detail} data-app-detail={app.slug}>
          <div>
            <div className={UsageUI.detailLabel}>About</div>
            <p>{`Made by ${app.creator ? `@${app.creator}` : 'an account that no longer exists'} on ${when(app.createdAt)}.`}</p>
            <p>{`Last deployed ${when(app.lastDeployAt)}. Visible to: ${app.visibility || 'unknown'}.`}</p>
            <p>{`${plural(app.newMembers, 'new member')} and ${plural(app.sessions, 'change')} started in this window; ${plural(app.openRequests, 'request')} open now.`}</p>
            <p className="mt-2 flex flex-wrap gap-x-4">
              <a className={AdminUI.btn.link} href={`#app/${slug}`}>Open project</a>
              <a className={AdminUI.btn.link} href="#admin/storage">App storage</a>
            </p>
          </div>
          <div>
            <div className={UsageUI.detailLabel}>
              {`Contributors (${app.contributors}, ${app.shippedContributors} with a change merged)`}
            </div>
            {app.topContributors.length ? (
              <ol className="space-y-0.5" data-app-contributors={app.slug}>
                {app.topContributors.map((c) => (
                  <li key={c.username}>
                    {`@${c.username}: ${plural(c.proposed, 'proposal')}, ${c.merged} merged`}
                  </li>
                ))}
              </ol>
            ) : <p className={AdminUI.muted}>Nobody has proposed a change yet.</p>}
          </div>
        </div>
      ) : null}
    </li>
  );
}

function AppsUsageSection() {
  const [days, setDays] = useState(30);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('used');
  const [openSlug, setOpenSlug] = useState<string | null>(null);
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
  const shown = data ? sortApps(filterApps(data.apps, query), sort) : [];

  return (
    <div className="space-y-4" id="admin-apps-usage">
      <div className={`${AdminUI.card} p-4`}>
        <div className={AdminUI.cardHeader}>
          <h2 className={AdminUI.cardTitle}>Apps &amp; usage</h2>
          <button id="admin-apps-usage-refresh" type="button" className={`${AdminUI.btn.link} text-xs`} onClick={() => load()}>
            Refresh
          </button>
        </div>
        <p className={`${AdminUI.muted} mb-3`}>
          Every app on the platform: its members, the people who have proposed changes to it,
          and how much it was used and built in the chosen window.
        </p>
        <div className={UsageUI.tiles} id="admin-apps-usage-totals">
          <Tile id="apps" figure={t ? String(t.apps) : '–'} label="apps" />
          <Tile id="used" figure={t ? String(t.usedApps) : '–'} label="used in this window" />
          <Tile id="built" figure={t ? String(t.builtApps) : '–'} label="with changes proposed or merged" />
          <Tile id="time" figure={t ? formatDuration(t.seconds) : '–'} label="time spent in apps" />
          <Tile id="merged" figure={t ? `${t.merged} / ${t.proposed}` : '–'} label="merged / proposed" />
          <Tile id="requests" figure={t ? String(t.requests) : '–'} label="requests filed" />
        </div>
      </div>

      <div className={`${AdminUI.card} p-4`}>
        <div className={UsageUI.controls}>
          <div>
            <label className={UsageUI.controlLabel} htmlFor="admin-apps-usage-search">Search</label>
            <input id="admin-apps-usage-search" type="search" className={AdminUI.input} value={query}
              placeholder="Name, slug or creator" onChange={(e) => setQuery(e.target.value)} />
          </div>
          <div>
            <label className={UsageUI.controlLabel} htmlFor="admin-apps-usage-sort">Sort by</label>
            <select id="admin-apps-usage-sort" className={AdminUI.select} value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className={UsageUI.controlLabel} htmlFor="admin-apps-usage-days">Time window</label>
            <select id="admin-apps-usage-days" className={AdminUI.select} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              {windows.map((d) => <option key={d} value={String(d)}>{`Last ${d} days`}</option>)}
            </select>
          </div>
        </div>

        <p className={`${AdminUI.muted} mb-3`} id="admin-apps-usage-summary" data-count={shown.length}
          data-state={failed ? 'failed' : (data ? 'ready' : 'loading')}>
          {failed ? 'Could not read apps & usage. Try Refresh.'
            : !data ? <span className={AdminUI.loading}>Loading…</span>
              : !data.apps.length ? 'No apps yet.'
                : shown.length === data.apps.length ? `${plural(shown.length, 'app')}, last ${data.days} days.`
                  : `${shown.length} of ${plural(data.apps.length, 'app')} match, last ${data.days} days.`}
        </p>

        {shown.length ? (
          <ul className="space-y-2" id="admin-apps-usage-list">
            {shown.map((a) => (
              <AppRow key={a.slug} app={a} open={openSlug === a.slug}
                onToggle={() => setOpenSlug(openSlug === a.slug ? null : a.slug)} />
            ))}
          </ul>
        ) : null}
      </div>
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
