'use strict';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AdminUI } from './admin-console.js';
import {
  QUEUES, dollars, loadDone, nextIndex, queueCounts, queueFromHash, queueItems, saveDone,
  type OverviewData, type QueueItem, type QueueKey,
} from './admin-queues';
import { dialogShowing, isTypingTarget } from '../improve/suggest-shortcut';
import { mountLegacyPortal, unmountLegacyPortal } from '../../lib/legacy-portals';

// Operations overview, the console's landing section (#admin, #admin/overview),
// drawn as the Inbox since #6455: every duty is a queue you work through one
// item at a time, and finishing one hands you the next.
//
// ONE /api/admin/overview read feeds it (through AdminConsole._fetchQueueData,
// which the sidebar's counts share): apps wedged in a non-terminal creation
// state, workers whose session is gone, and today's LLM spenders. Each is a
// queue, and Needs you is all three. The address names the queue one level
// below the section, #admin/overview/<all|stuck|orphans|spenders>, which this
// module reads on render and writes back with replaceState, the way
// Campaigns owns #admin/campaigns/<id> (AdminConsole._writeHash leaves an
// address that deep alone).
//
// Two panes: the queue's items, then the selected item's detail with the
// actions that exist today, all of them navigation to the section that holds
// the lever (Health & status for a worker, Apps & usage for an app, Model
// costs or Limits for a spender). Nothing here writes to the server. "Mark
// done for now" hides an item for this browser session (sessionStorage) and
// selects the next one, with Undo for five seconds.
//
// PERMISSIONS: any admin, full or view-only. Pure read surface, so no
// canAdminWrite gate.
//
// On a phone's level 1 the same module renders into #admin-mobile-overview
// (AdminConsole._renderMobileMenu): there it is the compact Queues card above
// the grouped section menu, each row a drill-in to its queue.

const REFRESH_MS = 30_000;
const UNDO_MS = 5_000;

const ROW = 'flex items-center gap-3 w-full text-start rounded-lg px-3 py-2.5 text-sm transition-colors';
const ROW_ON = 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100';
const ROW_OFF = 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800/60';
const MUTED_SM = 'text-xs text-zinc-500 dark:text-zinc-400';
const STAT = 'inline-flex items-baseline gap-1.5';
const STAT_N = 'text-base font-semibold text-zinc-900 dark:text-zinc-100';

const consoleApi = (): any => (typeof window !== 'undefined' ? (window as any).AdminConsole : null);

// Mounted views hear a fresh payload through here (AdminConsole._paintQueues
// calls AdminOverview.refreshCounts after every read), and the chassis switches
// the queue of a mounted view through setQueue.
const listeners = new Set<() => void>();
let queueSetter: ((q: QueueKey) => void) | null = null;

function upTime(seconds: number): string {
  const m = Math.round((seconds || 0) / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** One line naming an item, for its list row and its detail's heading. */
export function itemTitle(item: QueueItem): string {
  if (item.kind === 'stuck') return item.slug;
  if (item.kind === 'orphan') return item.name;
  return item.username;
}

/** The second line of an item's row. */
export function itemSubtitle(item: QueueItem): string {
  if (item.kind === 'stuck') return `Stuck app · ${item.dbStatus} · by ${item.createdBy || 'unknown'}`;
  if (item.kind === 'orphan') {
    return `Orphan worker · ${item.appSlug ? `app ${item.appSlug}` : 'no app'} · up ${upTime(item.uptimeSeconds)}`
      + (item.sessionArchived ? ' · session archived' : '');
  }
  return `Spent ${dollars(item.costCents)} today`;
}

/** The actions an item offers, all navigation; the first is Enter's. */
export function itemActions(item: QueueItem): Array<{ label: string; section: string }> {
  if (item.kind === 'stuck') return [{ label: 'Open Apps & usage', section: 'apps' }];
  if (item.kind === 'orphan') {
    return [{ label: 'Open Health & status', section: 'status' }]
      .concat(item.appSlug ? [{ label: 'Open Apps & usage', section: 'apps' }] : []);
  }
  return [{ label: 'Open Model costs', section: 'model-costs' }, { label: 'Open Limits', section: 'limits' }];
}

function useQueueData() {
  const [data, setData] = useState<OverviewData | null>(() => consoleApi()?._queueData || null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const hear = () => { if (alive.current) setData(consoleApi()?._queueData || null); };
    listeners.add(hear);
    return () => { alive.current = false; listeners.delete(hear); };
  }, []);
  const load = useCallback(async () => {
    const c = consoleApi();
    if (!c) return;
    setLoading(true);
    await c._fetchQueueData();
    if (!alive.current) return;
    setLoading(false);
    setData(c._queueData || null);
  }, []);
  return { data, loading, load };
}

// The header's three figures. The ids are what the declared checks and the
// tests select on (#admin-overview-stuck above all), kept from the tiles this
// view replaced.
function Figures({ data, loading, onRefresh }: { data: OverviewData | null; loading: boolean; onRefresh: () => void }) {
  const stuck = data?.stuckApps?.length ?? 0;
  const orphans = data?.orphanWorkers?.length ?? 0;
  const spend = data?.llmToday?.totalSpendCents ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-zinc-500 dark:text-zinc-400">
      <span className={STAT}><span id="admin-overview-stuck" className={STAT_N}>{data ? stuck : '-'}</span>{' stuck apps'}</span>
      <span className={STAT}><span id="admin-overview-orphan" className={STAT_N}>{data ? orphans : '-'}</span>{' orphan workers'}</span>
      <span className={STAT}><span id="admin-overview-llm" className={STAT_N}>{data ? dollars(spend) : '-'}</span>{' LLM spend today'}</span>
      <button id="admin-refresh-overview" type="button" className={`${AdminUI.btn.link} text-xs ms-auto`}
        disabled={loading} onClick={onRefresh}>{loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>
  );
}

function Mark({ item }: { item: QueueItem }) {
  return item.severity === 'broken'
    ? <span className={AdminUI.badge.destructive}>Broken</span>
    : <span className={AdminUI.badge.secondary}>Info</span>;
}

function Detail({ item, onDone }: { item: QueueItem; onDone: () => void }) {
  const c = consoleApi();
  const actions = itemActions(item);
  const facts: Array<[string, string]> = item.kind === 'stuck'
    ? [['Database status', item.dbStatus], ['Created by', item.createdBy || 'unknown'], ['Created', when(item.createdAt)]]
    : item.kind === 'orphan'
      ? [['App', item.appSlug || 'none'], ['Up for', upTime(item.uptimeSeconds)], ['Session', item.sessionArchived ? 'archived' : 'gone']]
      : [['Spent today', dollars(item.costCents)]];
  const why = item.kind === 'stuck'
    ? 'This app never finished being created. Find it in Apps & usage to see where it stopped.'
    : item.kind === 'orphan'
      ? 'This worker is still running but its session is gone. Health & status lists it with the platform\'s workers.'
      : 'One of today\'s biggest spenders on the platform\'s models. Model costs shows what changes cost; Limits holds the caps.';
  return (
    <div id="admin-queue-detail" className={`${AdminUI.card} p-4`} aria-live="polite">
      <div className="flex items-start justify-between gap-3 mb-1">
        <h3 className={`${AdminUI.cardTitle} font-mono break-all`}>{itemTitle(item)}</h3>
        <Mark item={item} />
      </div>
      <p className={`${AdminUI.muted} mb-4`}>{why}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm mb-5">
        {facts.map(([k, v]) => [
          <dt key={`${k}-k`} className="text-zinc-500 dark:text-zinc-400">{k}</dt>,
          <dd key={`${k}-v`} className="text-zinc-900 dark:text-zinc-100 break-all">{v}</dd>,
        ])}
      </dl>
      <div className="flex flex-wrap gap-2">
        {actions.map((a, i) => (
          <button key={a.section} type="button" data-queue-action={a.section}
            className={i === 0 ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
            onClick={() => c?.go?.(a.section)}>{a.label}</button>
        ))}
        <button type="button" data-queue-done className={AdminUI.btn.outlineSm} onClick={onDone}>Mark done for now</button>
      </div>
      <p className={`${MUTED_SM} mt-4 hidden md:block`}>
        <kbd className={AdminUI.kbd}>j</kbd> <kbd className={AdminUI.kbd}>k</kbd> to move, <kbd className={AdminUI.kbd}>Enter</kbd> to open, <kbd className={AdminUI.kbd}>x</kbd> to mark done
      </p>
    </div>
  );
}

function QueueView() {
  const { data, loading, load } = useQueueData();
  const [queue, setQueue] = useState<QueueKey>(() => queueFromHash(typeof location !== 'undefined' ? location.hash : ''));
  const [done, setDone] = useState<Set<string>>(() => loadDone());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const items = useMemo(() => queueItems(data, queue, done), [data, queue, done]);
  const counts = useMemo(() => queueCounts(data, done), [data, done]);
  const index = Math.max(0, items.findIndex((i) => i.id === selectedId));
  const selected = items.length ? items[index] : null;

  // Read on mount, then every 30 seconds while the tab is visible; coming
  // back to the tab reads at once. destroy() unmounts, which clears both.
  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  useEffect(() => {
    queueSetter = (q) => { setQueue(q); setSelectedId(null); };
    // The sidebar lights the queue this view opened on.
    consoleApi()?._paintQueues?.();
    return () => { queueSetter = null; };
  }, []);

  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  const switchQueue = useCallback((q: QueueKey) => {
    const c = consoleApi();
    try { history.replaceState(null, '', `#admin/overview/${q}`); } catch { /* non-fatal */ }
    setQueue(q);
    setSelectedId(null);
    c?._markRouted?.();
    c?._paintQueues?.();
  }, []);

  const markDone = useCallback((item: QueueItem | null) => {
    if (!item) return;
    const at = items.findIndex((i) => i.id === item.id);
    const rest = items.filter((i) => i.id !== item.id);
    const next = rest[nextIndex(at, rest.length)] || null;
    const fresh = new Set(done);
    fresh.add(item.id);
    saveDone(fresh);
    setDone(fresh);
    setSelectedId(next ? next.id : null);
    setUndo({ id: item.id, label: itemTitle(item) });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
    consoleApi()?._paintQueues?.();
  }, [items, done]);

  const undoDone = useCallback(() => {
    if (!undo) return;
    const fresh = new Set(done);
    fresh.delete(undo.id);
    saveDone(fresh);
    setDone(fresh);
    setSelectedId(undo.id);
    setUndo(null);
    if (undoTimer.current) clearTimeout(undoTimer.current);
    consoleApi()?._paintQueues?.();
  }, [undo, done]);

  // Desktop keys, while focus is not in a field and nothing is in front of
  // the page: j / k move, Enter opens the item's first action, x marks done.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const c = consoleApi();
      if (!c || !c._open || c._isMobile()) return;
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return;
      if (isTypingTarget(e.target) || dialogShowing(document)) return;
      // A focused control answers its own Enter, except a queue row, whose
      // Enter is the item's action like everywhere else in the list.
      const target = e.target as HTMLElement | null;
      if (e.key === 'Enter' && (target?.tagName === 'BUTTON' || target?.tagName === 'A')
        && !target.hasAttribute('data-queue-item')) return;
      if (!items.length) return;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const to = Math.min(items.length - 1, Math.max(0, index + (e.key === 'j' ? 1 : -1)));
        setSelectedId(items[to].id);
        listRef.current?.querySelector<HTMLElement>(`[data-queue-item="${CSS.escape(items[to].id)}"]`)?.scrollIntoView?.({ block: 'nearest' });
      } else if (e.key === 'Enter' && selected) {
        e.preventDefault();
        c.go(itemActions(selected)[0].section);
      } else if (e.key === 'x' && selected) {
        e.preventDefault();
        markDone(selected);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [items, index, selected, markDone]);

  const label = QUEUES.find((q) => q.key === queue)?.label || 'Needs you';

  return (
    <div id="admin-queue-view" data-admin-queue-view={queue} className="space-y-4">
      <div className={`${AdminUI.card} p-4`}>
        <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
          <h2 className={AdminUI.cardTitle}>{label}</h2>
          <span className={MUTED_SM}>{data ? `${items.length} ${items.length === 1 ? 'item' : 'items'}` : ''}</span>
        </div>
        <Figures data={data} loading={loading} onRefresh={load} />
        <div className="flex flex-wrap gap-2 mt-3" role="group" aria-label="Queues">
          {QUEUES.map((q) => (
            <button key={q.key} type="button" data-queue-switch={q.key} aria-pressed={q.key === queue}
              className={q.key === queue ? AdminUI.btn.primarySm : AdminUI.btn.outlineSm}
              onClick={() => switchQueue(q.key)}>
              {q.label}{counts && counts[q.key] ? ` · ${counts[q.key]}` : ''}
            </button>
          ))}
        </div>
      </div>

      {undo ? (
        <div className={`${AdminUI.card} px-4 py-2 flex items-center justify-between gap-3 text-sm`} role="status">
          <span className="min-w-0 truncate">{`Marked ${undo.label} done for now.`}</span>
          <button type="button" data-queue-undo className={`${AdminUI.btn.link} text-sm`} onClick={undoDone}>Undo</button>
        </div>
      ) : null}

      {!data ? <p className={AdminUI.loading}>Loading…</p> : null}

      {data && !items.length ? (
        <div id="admin-queue-empty" className={`${AdminUI.card} p-8 text-center`}>
          <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Inbox zero</p>
          <p className={`${AdminUI.muted} mt-1`}>
            {queue === 'all' ? 'No stuck apps, no orphan workers and no LLM spend recorded today.' : `Nothing in ${label} right now.`}
            {done.size ? ' Items you marked done stay hidden until this tab closes.' : ''}
          </p>
        </div>
      ) : null}

      {data && items.length ? (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 items-start">
          <div className={`${AdminUI.card} p-2`}>
            <ul id="admin-queue-list" ref={listRef} role="listbox" aria-label={label} className="space-y-0.5">
              {items.map((item, i) => {
                const on = i === index;
                return (
                  <li key={item.id} role="option" aria-selected={on}>
                    <button type="button" data-queue-item={item.id} data-severity={item.severity}
                      className={`${ROW} ${on ? ROW_ON : ROW_OFF}`}
                      onClick={() => setSelectedId(item.id)}>
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-mono font-medium">{itemTitle(item)}</span>
                        <span className={`block truncate ${MUTED_SM}`}>{itemSubtitle(item)}</span>
                      </span>
                      <Mark item={item} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {selected ? <Detail item={selected} onDone={() => markDone(selected)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

// A phone's level 1: the queues as a card of rows over the grouped menu, each
// row a drill-in to its queue. A zero says nothing.
function QueuesCard() {
  const { data, load } = useQueueData();
  useEffect(() => { load(); }, [load]);
  // Read fresh on each paint: a queue view marks items done between the
  // card's mounts, and the card should count what the view will show.
  const counts = queueCounts(data, loadDone());
  return (
    <div>
      <h2 className={`${AdminUI.sectionTitle} mb-3`}>Queues</h2>
      <nav id="admin-mobile-queues" aria-label="Queues" className={`${AdminUI.card} overflow-hidden -mx-4`}>
        {QUEUES.map((q, i) => {
          const n = counts ? counts[q.key] : 0;
          return (
            <button key={q.key} type="button" data-admin-queue={q.key}
              className={`flex items-center gap-3 w-full text-start min-h-[44px] px-4 py-2 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors${i ? ' border-t border-zinc-100 dark:border-zinc-800' : ''}`}
              onClick={() => consoleApi()?._openQueue?.(q.key)}>
              <span className="flex-1 min-w-0 text-sm font-medium truncate">{q.label}</span>
              <span className={`${n ? '' : 'hidden '}${q.key === 'spenders' ? AdminUI.badge.secondary : AdminUI.badge.destructive}`}>{n}</span>
            </button>
          );
        })}
      </nav>
      <p className={`${MUTED_SM} mt-2`}>
        <span id="admin-overview-stuck">{data ? data.stuckApps?.length ?? 0 : '-'}</span>{' stuck apps, '}
        <span id="admin-overview-orphan">{data ? data.orphanWorkers?.length ?? 0 : '-'}</span>{' orphan workers, '}
        <span id="admin-overview-llm">{data ? dollars(data.llmToday?.totalSpendCents ?? 0) : '-'}</span>{' LLM spend today. '}
        <button id="admin-refresh-overview" type="button" className={`${AdminUI.btn.link} text-xs`} onClick={load}>Refresh</button>
      </p>
    </div>
  );
}

let host: Element | null = null;

const AdminOverview = {
  render(el: Element) {
    host = el;
    mountLegacyPortal(el, el.id === 'admin-mobile-overview' ? <QueuesCard /> : <QueueView />);
  },

  destroy() {
    unmountLegacyPortal(host);
    host = null;
  },

  /** Switch a mounted queue view to `queue`; false when none is mounted. */
  setQueue(queue: QueueKey): boolean {
    if (!queueSetter) return false;
    queueSetter(queue);
    return true;
  },

  /** A fresh payload arrived: mounted views read it. */
  refreshCounts() {
    for (const hear of [...listeners]) hear();
  },
};

// Published on the global because AdminConsole._renderSection dispatches
// section modules through window[modName]. Guarded: the SSG prerender pass
// evaluates this module in Node, where there is no window.
if (typeof window !== 'undefined') (window as any).AdminOverview = AdminOverview;

export { AdminOverview, QueueView, QueuesCard };
