/**
 * The platform limits area: the card at the top of the Notifications sheet
 * that tells FULL admins when a platform-wide limit is near, at or over the
 * line where Homeroom starts refusing people, and the red dot on the bell
 * while anything is refusing now. Mockup:
 * https://claude.ai/artifact/N1gaZjTozP3JJ5GujhxEJj
 *
 * WHAT IT SHOWS. One row per limit that is past its line
 * (services/platform-limits-view.js decides which, and in what order: worst
 * first). The app limit, the session limit, the bot's OpenRouter credit,
 * the shared database's connections, and the cluster's own: the database's
 * disk, each runtime namespace's quota and the nodes' volume pools
 * (services/platform-capacity.js). Each row is the figure in words, what
 * breaks, and ONE action to where it is fixed: Raise the limit (Admin ›
 * Limits), Add credit (OpenRouter's own page, a fixed address), Check again
 * (re-reads a figure that could not be read).
 *
 * NO DISMISS. There is no close button and no swipe: a row leaves only once
 * its figure is back under its line, by the same margin the alerts use. That
 * is the point of it: a limit that is still full is still breaking things.
 *
 * TONE. Amber for near, red for at, over and out. The shell's caution
 * vocabulary is amber only (the Alert primitive's `notice`); red here is the
 * one deliberate exception, because "Homeroom is refusing people now" has to
 * read as different from "it will soon". It is the error ink the shell
 * already uses for the bell's own badge.
 *
 * WHO. Full admins only: the read is `GET /api/admin/platform-limits`,
 * which answers 403 to everyone else, and nothing here asks unless
 * App.user.canAdminWrite. View-only admins never see it.
 *
 * OWNERSHIP. Both islands render nothing until their data arrives in an
 * effect, so the prerendered shell is unchanged and hydration matches. Their
 * whole subtree is React's; no public/js module writes into it.
 *
 * LIVE. The figures arrive on boot, when the sheet opens, every five minutes
 * while the page is visible, and when the server says a level moved (the
 * `platform_limits_changed` socket frame, routed by app.js to
 * `window.UsernodeReact.platformLimits.refresh`).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';

import { buttonVariants } from '@/components/ui/button';
import { SectionHeader } from '@/components/ui/grouped-list';
import { IconTile } from '@/components/ui/icon-tile';
import {
  AppWindowIcon, ArchiveBoxIcon, ArrowPathIcon, ArrowTopRightOnSquareIcon, ArrowsRightLeftIcon, ChartBarIcon,
  TerminalIcon, WalletIcon,
} from '@/components/ui/icons';
import { cn } from '@/lib/utils';

import { useMessages } from '../../lib/i18n/react';

export type QuotaKey = 'quota_apps' | 'quota_workers' | 'quota_builds';
export type LimitKey = 'apps' | 'sessions' | 'openrouter_credit' | 'db_connections'
  | 'db_disk' | 'node_pool' | QuotaKey;
export type LimitState = 'over' | 'at' | 'out' | 'near' | 'unknown';

export interface LimitRow {
  key: LimitKey;
  state: LimitState;
  used?: number;
  cap?: number;
  left?: number;
  percent?: number;
  balanceCents?: number | null;
  warnCents?: number | null;
  urgentCents?: number | null;
  daysLeft?: number | null;
  since?: string | null;
  measuredAt?: string | null;
  urgent?: boolean;
  reason?: string;
  /** #6901: people turned away at this limit, once that is counted. */
  turnedAway?: number | null;
  /** The cluster's limits: what the figure is about (the fullest volume or
   * node, or a quota's tightest resource and its own used and hard values). */
  detail?: { volume?: string; node?: string; namespace?: string; resource?: string; used?: string; hard?: string } | null;
}

export interface LimitsPayload {
  rows: LimitRow[];
  broken: boolean;
  checkedAt?: string | null;
}

/** OpenRouter's own page for adding credit: a constant, never from a response. */
export const OPENROUTER_CREDITS_URL = 'https://openrouter.ai/settings/credits';
/** Admin › Limits, where the app and session limits are raised. */
export const LIMITS_HREF = '#admin/limits';
/** Admin › Health & status, which shows the database's connections. */
export const STATUS_HREF = '#admin/status';

const READ_PATH = '/api/admin/platform-limits';
const CHECK_PATH = '/api/admin/platform-limits/check';
const POLL_MS = 5 * 60 * 1000;
const FRESH_MS = 30 * 1000;
const KEYS: ReadonlySet<string> = new Set([
  'apps', 'sessions', 'openrouter_credit', 'db_connections',
  'db_disk', 'node_pool', 'quota_apps', 'quota_workers', 'quota_builds',
]);
const STATES: ReadonlySet<string> = new Set(['over', 'at', 'out', 'near', 'unknown']);
const BROKEN: ReadonlySet<string> = new Set(['over', 'at', 'out']);

/** Pure: keep only rows this view knows how to draw. */
export function normalizeLimits(data: unknown): LimitsPayload | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as { rows?: unknown }).rows;
  if (!Array.isArray(raw)) return null;
  const rows = raw.filter((row): row is LimitRow => !!row && typeof row === 'object'
    && KEYS.has(String((row as LimitRow).key)) && STATES.has(String((row as LimitRow).state)));
  return {
    rows,
    broken: rows.some((row) => BROKEN.has(row.state)),
    checkedAt: typeof (data as { checkedAt?: unknown }).checkedAt === 'string'
      ? (data as { checkedAt: string }).checkedAt : null,
  };
}

// ── The store: one read shared by the sheet's card and the bell's dot ──

const listeners = new Set<() => void>();
let snapshot: LimitsPayload | null = null;
let inflight: Promise<void> | null = null;
let lastRead = 0;
let started = false;

function isFullAdmin(): boolean {
  if (typeof window === 'undefined') return false;
  const app = (window as unknown as { App?: { user?: { canAdminWrite?: boolean } } }).App;
  return !!app?.user?.canAdminWrite;
}

function publish(next: LimitsPayload | null): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** Read the figures again (full admins only). Keeps what is shown on a failure. */
export function refreshPlatformLimits(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (!isFullAdmin()) {
    if (snapshot) publish(null);
    return Promise.resolve();
  }
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(READ_PATH, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (res.status === 401 || res.status === 403) {
        publish(null);
        return;
      }
      if (!res.ok) return;
      publish(normalizeLimits(await res.json()));
      lastRead = Date.now();
    } catch {
      // Offline or a deploy: what is shown stays until the next read.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** "Check again": the sweeps re-read every figure, then the area is redrawn. */
export async function checkPlatformLimitsAgain(): Promise<boolean> {
  try {
    const res = await fetch(CHECK_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
    if (!res.ok) return false;
    publish(normalizeLimits(await res.json()));
    lastRead = Date.now();
    return true;
  } catch {
    return false;
  }
}

function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.platformLimits = { refresh: () => { void refreshPlatformLimits(); } };
  document.addEventListener('sv:authed', () => { void refreshPlatformLimits(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRead > FRESH_MS) void refreshPlatformLimits();
  });
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshPlatformLimits();
  }, POLL_MS);
  void refreshPlatformLimits();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The figures, or null (not a full admin, not read yet, or nothing to show). */
export function usePlatformLimits(): LimitsPayload | null {
  const value = useSyncExternalStore(subscribe, () => snapshot, () => null);
  useEffect(() => { start(); }, []);
  return value;
}

// ── Words ──────────────────────────────────────────────────────────────

type Translate = (key: string, values?: Record<string, unknown>) => string;

function dollars(cents: number | null | undefined): string {
  const n = Number.isFinite(cents as number) ? Math.max(0, Number(cents)) / 100 : 0;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: n >= 10 ? 0 : 2,
  }).format(n);
}

/** Whole MiB (the volume figures) as GiB: one decimal under ten. */
function gib(mib: number | null | undefined): string {
  const n = Number.isFinite(mib as number) ? Math.max(0, Number(mib)) / 1024 : 0;
  return String(n < 10 ? Math.round(n * 10) / 10 : Math.round(n));
}

// A Kubernetes quantity ("42500m", "96Gi", "340") as a number of its base unit.
const QUANTITY: Record<string, number> = {
  m: 1e-3, '': 1, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40,
};
function quantity(raw: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]*)$/.exec(String(raw ?? '').trim());
  if (!m || !Object.prototype.hasOwnProperty.call(QUANTITY, m[2])) return null;
  return Number(m[1]) * QUANTITY[m[2]];
}
const BYTE_RESOURCES: ReadonlySet<string> = new Set(['memory', 'memory_limits', 'scratch', 'scratch_limits', 'storage']);
const CPU_RESOURCES: ReadonlySet<string> = new Set(['cpu', 'cpu_limits']);
const RESOURCE_WORDS: Record<string, string> = {
  pods: 'notifications:limits.quota.resource.pods',
  cpu: 'notifications:limits.quota.resource.cpu',
  cpu_limits: 'notifications:limits.quota.resource.cpu_limits',
  memory: 'notifications:limits.quota.resource.memory',
  memory_limits: 'notifications:limits.quota.resource.memory_limits',
  scratch: 'notifications:limits.quota.resource.scratch',
  scratch_limits: 'notifications:limits.quota.resource.scratch_limits',
  storage: 'notifications:limits.quota.resource.storage',
  volumes: 'notifications:limits.quota.resource.volumes',
  services: 'notifications:limits.quota.resource.services',
  secrets: 'notifications:limits.quota.resource.secrets',
  config_maps: 'notifications:limits.quota.resource.config_maps',
  jobs: 'notifications:limits.quota.resource.jobs',
  builds: 'notifications:limits.quota.resource.builds',
};

/** A quota's tightest resource in words: "CPU requested: 42.5 of 48". */
function quotaFigure(detail: LimitRow['detail'], t: Translate): string | null {
  if (!detail || !detail.resource || !RESOURCE_WORDS[detail.resource]) return null;
  const used = quantity(detail.used);
  const hard = quantity(detail.hard);
  if (used == null || hard == null) return null;
  const say = (n: number) => {
    if (BYTE_RESOURCES.has(String(detail.resource))) return `${gib(n / 2 ** 20)} GiB`;
    if (CPU_RESOURCES.has(String(detail.resource))) return String(Math.round(n * 10) / 10);
    return String(Math.round(n));
  };
  return t('notifications:limits.quota.figure', {
    resource: t(RESOURCE_WORDS[detail.resource]), used: say(used), hard: say(hard),
  });
}

// Each namespace quota's own words: its title, and what stops when it fills.
const QUOTA_WORDS: Record<QuotaKey, { title: string; titleUnknown: string; near: string; at: string }> = {
  quota_apps: {
    title: 'notifications:limits.quota.apps.title',
    titleUnknown: 'notifications:limits.quota.apps.titleUnknown',
    near: 'notifications:limits.quota.apps.near',
    at: 'notifications:limits.quota.apps.at',
  },
  quota_workers: {
    title: 'notifications:limits.quota.workers.title',
    titleUnknown: 'notifications:limits.quota.workers.titleUnknown',
    near: 'notifications:limits.quota.workers.near',
    at: 'notifications:limits.quota.workers.at',
  },
  quota_builds: {
    title: 'notifications:limits.quota.builds.title',
    titleUnknown: 'notifications:limits.quota.builds.titleUnknown',
    near: 'notifications:limits.quota.builds.near',
    at: 'notifications:limits.quota.builds.at',
  },
};

function clock(iso: string | null | undefined): string | null {
  const at = Date.parse(String(iso || ''));
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export type RowTone = 'near' | 'broken' | 'unknown';
export type RowAction = { kind: 'raise' | 'credit' | 'status' | 'check'; label: string; href: string | null; external: boolean };

export interface RowView {
  key: LimitKey;
  tone: RowTone;
  kicker: string;
  title: string;
  sub: string;
  meter: number | null;
  action: RowAction;
}

/** Pure: a row's words and look, in the catalog's own words. */
export function rowView(row: LimitRow, t: Translate): RowView {
  const tone: RowTone = row.state === 'unknown' ? 'unknown' : (BROKEN.has(row.state) ? 'broken' : 'near');
  const counted = row.key !== 'openrouter_credit';
  let kicker: string;
  if (row.state === 'unknown') kicker = t('notifications:limits.kicker.unknown');
  else if (row.key === 'openrouter_credit') {
    kicker = row.state === 'near' ? t('notifications:limits.kicker.low') : t('notifications:limits.kicker.out');
  } else if (row.state === 'over') kicker = t('notifications:limits.kicker.over');
  else if (row.state === 'near') kicker = t('notifications:limits.kicker.near');
  else kicker = t('notifications:limits.kicker.at');
  const meter = counted && row.state !== 'unknown' && Number.isFinite(row.percent as number)
    ? Math.max(0, Math.min(100, Number(row.percent))) : null;
  const raise: RowAction = { kind: 'raise', label: t('notifications:limits.action.raise'), href: LIMITS_HREF, external: false };
  const check: RowAction = { kind: 'check', label: t('notifications:limits.action.check'), href: null, external: false };
  const figures = { used: row.used ?? 0, cap: row.cap ?? 0 };
  let title = '';
  let sub = '';
  let action = raise;

  if (row.key === 'apps') {
    title = row.state === 'unknown' ? t('notifications:limits.apps.titleUnknown') : t('notifications:limits.apps.title', figures);
    sub = row.state === 'unknown' ? t('notifications:limits.unknown.read')
      : row.state === 'near' ? t('notifications:limits.apps.near', { cap: figures.cap, count: row.left ?? 0 })
        : row.state === 'over' ? t('notifications:limits.apps.over') : t('notifications:limits.apps.at');
    if (row.state === 'unknown') action = check;
  } else if (row.key === 'sessions') {
    title = row.state === 'unknown' ? t('notifications:limits.sessions.titleUnknown') : t('notifications:limits.sessions.title', figures);
    sub = row.state === 'unknown' ? t('notifications:limits.unknown.read')
      : row.state === 'near' ? t('notifications:limits.sessions.near', { cap: figures.cap }) : t('notifications:limits.sessions.at');
    if (row.state === 'unknown') action = check;
  } else if (row.key === 'db_disk' || row.key === 'node_pool' || row.key in QUOTA_WORDS) {
    // The cluster's own (services/platform-capacity.js): what fixes them is
    // in the infrastructure, so the action is where the cluster is shown.
    const unknown = row.state === 'unknown';
    const when = clock(row.measuredAt);
    const stale = when ? t('notifications:limits.unknown.stale', { time: when }) : t('notifications:limits.unknown.read');
    const cluster: RowAction = { kind: 'status', label: t('notifications:limits.action.cluster'), href: STATUS_HREF, external: false };
    action = unknown ? check : cluster;
    if (row.key === 'db_disk') {
      title = unknown ? t('notifications:limits.dbDisk.titleUnknown')
        : t('notifications:limits.dbDisk.title', { used: gib(row.used), cap: gib(row.cap) });
      sub = unknown ? stale : row.state === 'near' ? t('notifications:limits.dbDisk.near') : t('notifications:limits.dbDisk.at');
    } else if (row.key === 'node_pool') {
      const node = row.detail?.node || '';
      title = unknown ? t('notifications:limits.nodePool.titleUnknown')
        : t('notifications:limits.nodePool.title', { used: gib(row.used), cap: gib(row.cap) });
      const what = row.state === 'near' ? t('notifications:limits.nodePool.near') : t('notifications:limits.nodePool.at');
      sub = unknown ? stale : (node ? `${t('notifications:limits.nodePool.node', { node })} ${what}` : what);
    } else {
      const words = QUOTA_WORDS[row.key as QuotaKey];
      title = unknown ? t(words.titleUnknown) : t(words.title, { percent: Math.max(0, Math.round(Number(row.percent) || 0)) });
      const figure = quotaFigure(row.detail, t);
      const what = row.state === 'near' ? t(words.near) : t(words.at);
      sub = unknown ? stale : (figure ? `${figure} ${what}` : what);
    }
  } else if (row.key === 'db_connections') {
    title = row.state === 'unknown' ? t('notifications:limits.connections.titleUnknown') : t('notifications:limits.connections.title', figures);
    sub = row.state === 'unknown' ? t('notifications:limits.unknown.read')
      : row.state === 'near' ? t('notifications:limits.connections.near', { cap: figures.cap }) : t('notifications:limits.connections.at');
    action = row.state === 'unknown' ? check
      : { kind: 'status', label: t('notifications:limits.action.status'), href: STATUS_HREF, external: false };
  } else {
    const credit: RowAction = { kind: 'credit', label: t('notifications:limits.action.credit'), href: OPENROUTER_CREDITS_URL, external: true };
    action = credit;
    if (row.state === 'out') {
      title = t('notifications:limits.credit.titleOut');
      const since = clock(row.since);
      sub = since ? t('notifications:limits.credit.outSince', { time: since }) : t('notifications:limits.credit.out');
    } else if (row.state === 'unknown') {
      title = t('notifications:limits.credit.titleUnknown');
      const when = clock(row.measuredAt);
      sub = row.reason === 'stale' && when
        ? t('notifications:limits.credit.unknownStale', { time: when, amount: dollars(row.balanceCents) })
        : t('notifications:limits.credit.unknownNoAnswer', { amount: dollars(row.balanceCents) });
      action = check;
    } else {
      title = t('notifications:limits.credit.title', { amount: dollars(row.balanceCents) });
      const line = dollars(row.urgent ? row.urgentCents : row.warnCents);
      const days = Number.isFinite(row.daysLeft as number) ? Math.max(1, Math.round(Number(row.daysLeft))) : null;
      sub = days != null
        ? t('notifications:limits.credit.near', { line, count: days })
        : t('notifications:limits.credit.nearNoDays', { line });
    }
  }
  if (Number.isFinite(row.turnedAway as number) && Number(row.turnedAway) > 0) {
    sub = `${sub} ${t('notifications:limits.turnedAway', { count: Number(row.turnedAway) })}`;
  }
  return { key: row.key, tone, kicker, title, sub, meter, action };
}

// ── The card ───────────────────────────────────────────────────────────

const TILE_TONE: Record<RowTone, string> = {
  near: 'bg-amber-500/15 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400',
  broken: 'bg-red-500/10 text-red-600 dark:bg-red-500/15 dark:text-red-400',
  unknown: '',
};
const KICKER_TONE: Record<RowTone, string> = {
  near: 'text-amber-700 dark:text-amber-400',
  broken: 'text-red-600 dark:text-red-400',
  unknown: 'text-zinc-500 dark:text-zinc-400',
};
const ROW_TONE: Record<RowTone, string> = {
  near: '',
  broken: 'bg-red-500/[0.04] dark:bg-red-500/[0.06]',
  unknown: '',
};
const METER_TONE: Record<RowTone, string> = {
  near: 'bg-amber-500',
  broken: 'bg-red-500 dark:bg-red-400',
  unknown: 'bg-zinc-400',
};
const ACTION_LOOK: Record<RowTone, string> = {
  broken: buttonVariants({ variant: 'pillAccent', size: 'xsText', ink: 'solid', layout: 'iconRow' }),
  near: buttonVariants({ variant: 'pillNeutral', size: 'xsText', ink: 'accent', layout: 'iconRow' }),
  unknown: buttonVariants({ variant: 'pillNeutral', size: 'xsText', ink: 'neutral', layout: 'iconRow' }),
};

function RowIcon({ name }: { name: LimitKey }) {
  if (name === 'apps') return <AppWindowIcon aria-hidden="true" />;
  if (name === 'sessions') return <TerminalIcon aria-hidden="true" />;
  if (name === 'db_connections') return <ArrowsRightLeftIcon aria-hidden="true" />;
  if (name === 'db_disk' || name === 'node_pool') return <ArchiveBoxIcon aria-hidden="true" />;
  if (name === 'quota_apps' || name === 'quota_workers' || name === 'quota_builds') return <ChartBarIcon aria-hidden="true" />;
  return <WalletIcon aria-hidden="true" />;
}

function ActionControl({ view, busy, onCheck }: { view: RowView; busy: boolean; onCheck: () => void }) {
  const t = useMessages('notifications');
  const look = cn(ACTION_LOOK[view.tone], 'min-h-[32px] font-semibold');
  if (view.action.kind === 'check') {
    return (
      <button type="button" className={look} disabled={busy} onClick={onCheck} data-limit-action="check">
        <ArrowPathIcon aria-hidden="true" className={cn('h-3.5 w-3.5', busy ? 'animate-spin' : '')} />
        <span>{busy ? t('notifications:limits.action.checking') : view.action.label}</span>
      </button>
    );
  }
  return (
    <a
      className={look}
      href={view.action.href || undefined}
      data-limit-action={view.action.kind}
      {...(view.action.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
    >
      <span>{view.action.label}</span>
      {view.action.external ? (
        <>
          <ArrowTopRightOnSquareIcon aria-hidden="true" className="h-3.5 w-3.5" />
          <span className="sr-only">{t('notifications:limits.action.newTab')}</span>
        </>
      ) : null}
    </a>
  );
}

/** The card itself, from a payload. Pure render: the tests draw it directly. */
export function PlatformLimitsCard({ payload, busy = false, onCheck = () => {} }: {
  payload: LimitsPayload | null;
  busy?: boolean;
  onCheck?: () => void;
}) {
  const t = useMessages('notifications');
  if (!payload || !payload.rows.length) return null;
  const views = payload.rows.map((row) => rowView(row, t as Translate));
  return (
    <section className="px-3 pt-1 pb-2 shrink-0" data-platform-limits="" aria-label={t('notifications:limits.heading')}>
      <SectionHeader className="px-1 pt-1 pb-1.5">{t('notifications:limits.heading')}</SectionHeader>
      <div className="rounded-[20px] bg-white dark:bg-zinc-900 overflow-hidden shadow-[inset_0_0_0_1px_var(--app-sheet-line),0_1px_2px_rgba(0,0,0,0.05)]">
        <ul className="max-h-[40vh] overflow-y-auto overscroll-contain">
          {views.map((view, i) => (
            <li
              key={view.key}
              data-limit-row={view.key}
              data-limit-tone={view.tone}
              className={cn('flex gap-3 px-4 py-3.5', i > 0 ? 'border-t border-[color:var(--app-sheet-line)]' : '', ROW_TONE[view.tone])}
            >
              <IconTile size="sm" className={cn('[&>svg]:h-[22px] [&>svg]:w-[22px]', TILE_TONE[view.tone])}>
                <RowIcon name={view.key} />
              </IconTile>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className={cn('text-xs font-semibold', KICKER_TONE[view.tone])}>{view.kicker}</span>
                <span className="text-[15px] font-[650] leading-5 text-zinc-900 dark:text-zinc-100">{view.title}</span>
                <span className="text-[13px] leading-[18px] text-zinc-500 dark:text-zinc-400">{view.sub}</span>
                {view.meter != null ? (
                  <span className="mt-2 block h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" aria-hidden="true">
                    <span className={cn('block h-1 rounded-full', METER_TONE[view.tone])} style={{ width: `${view.meter}%` }} />
                  </span>
                ) : null}
                <div className="mt-2.5 flex">
                  <ActionControl view={view} busy={busy} onCheck={onCheck} />
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="border-t border-[color:var(--app-sheet-line)] px-4 pt-2.5 pb-3 text-xs text-zinc-500 dark:text-zinc-400">
          {t('notifications:limits.foot')}
        </p>
      </div>
    </section>
  );
}

/** The sheet's island: the card for full admins, read again as the sheet opens. */
export function PlatformLimitsArea({ open }: { open: boolean }) {
  const payload = usePlatformLimits();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && Date.now() - lastRead > FRESH_MS) void refreshPlatformLimits();
  }, [open]);
  return (
    <PlatformLimitsCard
      payload={payload}
      busy={busy}
      onCheck={() => {
        if (busy) return;
        setBusy(true);
        void checkPlatformLimitsAgain().finally(() => setBusy(false));
      }}
    />
  );
}

/** The bell's island: a red dot while a limit is refusing people now. */
export function PlatformLimitsDot() {
  const payload = usePlatformLimits();
  if (!payload || !payload.broken) return null;
  return (
    <span
      data-platform-limits-dot=""
      aria-hidden="true"
      className="absolute -bottom-0.5 -end-0.5 h-2.5 w-2.5 rounded-full bg-red-600 ring-2 ring-white dark:ring-zinc-900"
    />
  );
}
