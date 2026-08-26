/**
 * The Notifications SHEET (#notifications-sheet) — Streamlined Concept.
 *
 * All | Unread tabs, TODAY / EARLIER sections, one row per notification with
 * an avatar-initial chip, the source app + relative time as the subtitle, an
 * unread dot and a trailing chevron.
 *
 * ── It was a screen, and a screen needed a back button ─────────────────
 *
 * The bell is in the header on every route, so a full-screen Notifications
 * view had to answer "back to where?" — and it answered "home", which was
 * wrong every time you opened it from somewhere that was not home. As a
 * sheet the question does not arise: it presents over the current screen and
 * dismisses back to it. See ./notifications-sheet-controller.js.
 *
 * ── Ownership ──────────────────────────────────────────────────────────
 *
 * Fully React-owned. The root is an overlay, not a screen root, so it is not
 * in App.SCREEN_IDS and its visibility is `data-open` off
 * ./notifications-sheet-store.js rather than a `hidden` class off the
 * visibility store. No public/js/** module writes a node inside this subtree.
 *
 * ── Data ───────────────────────────────────────────────────────────────
 *
 * Everything renders from ./notifications-store.js — `screenList` is every
 * fetched row (read and unread) as descriptors built by the controller's
 * `rowView`, so this file stays purely presentational like
 * ./notifications-list.tsx. Actions reach the controller through
 * `window.Notifications` (the module must stay import-free — see the store's
 * header). The initial store value renders an empty, hidden screen, which is
 * exactly what the SSG prerender ships.
 */

import { useState, type ReactNode } from 'react';

import { ChevronRightIcon, XIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { notificationsStore } from './notifications-store.js';
import { notificationsSheetStore } from './notifications-sheet-store.js';
import { NotificationsSheet } from './notifications-sheet-controller.js';
import { NotificationsPinnedSections } from './notifications-list';
import type { NotificationRowView } from './notifications-list';

type ScreenRowView = NotificationRowView & {
  createdAtMs: number;
  who: string;
  appLine: string;
};

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Notifications : null) || null;
}

/** Local-midnight boundary — rows at or after it are "Today". */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function AvatarChip({ view }: { view: ScreenRowView }): ReactNode {
  const initial = (view.who || '?').replace(/^@/, '').charAt(0).toUpperCase() || '?';
  return (
    <span
      aria-hidden="true"
      className={'w-8 h-8 shrink-0 rounded-full bg-violet-500/10 text-violet-500 '
        + 'flex items-center justify-center text-sm font-semibold'}
    >
      {view.icon || initial}
    </span>
  );
}

function SectionHead({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-4 pt-4 pb-1 text-[0.7rem] font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
      {children}
    </div>
  );
}

function ScreenRow({ view }: { view: ScreenRowView }): ReactNode {
  return (
    <button
      data-notif-id={view.id}
      className={'w-full text-left px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 '
        + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors flex items-center gap-3'}
      onClick={(event) => {
        event.stopPropagation();
        controller()?._onItemClick(view.id);
      }}
    >
      <AvatarChip view={view} />
      <span className="flex-1 min-w-0">
        <span className="block text-sm text-zinc-800 dark:text-zinc-200 truncate">
          {view.segments.map((segment, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <span
              key={index}
              className={segment.t === 'who'
                ? 'font-semibold text-zinc-900 dark:text-zinc-100'
                : segment.t === 'strong'
                  ? 'font-medium text-zinc-700 dark:text-zinc-300'
                  : undefined}
            >
              {(index > 0 ? ' ' : '') + (segment.t === 'who' ? `@${segment.v}` : segment.v)}
            </span>
          ))}
        </span>
        <span className="block text-xs text-zinc-500 truncate">
          {`${view.appLine} · ${view.time}`}
        </span>
      </span>
      {view.unread ? (
        <span className="w-2 h-2 shrink-0 rounded-full bg-violet-500" aria-label="Unread">
        </span>
      ) : null}
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
    </button>
  );
}

export function NotificationsSheetView() {
  const { open } = useStoreState(notificationsSheetStore) as { open: boolean };

  // Pull-to-refresh went with the screen root. A kit sheet owns the vertical
  // drag for its own dismiss gesture, so a pull-down inside one cannot also
  // mean "reload" — the controller refreshes on open instead.
  const snap = useStoreState(notificationsStore) as {
    screenList: ScreenRowView[] | null;
    screenCanLoadMore?: boolean;
    loadingMore: boolean;
  };
  const [tab, setTab] = useState<'all' | 'unread'>('all');

  const all = snap.screenList || [];
  const unread = all.filter((view) => view.unread);
  const rows = tab === 'unread' ? unread : all;
  const boundary = startOfToday();
  const today = rows.filter((view) => view.createdAtMs >= boundary);
  const earlier = rows.filter((view) => view.createdAtMs < boundary);

  const tabCls = (active: boolean) =>
    'px-1 pb-2 text-sm font-medium border-b-2 transition-colors '
    + (active
      ? 'border-violet-500 text-zinc-900 dark:text-zinc-100'
      : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300');

  return (
    <>
      <div
        id="notifications-sheet-overlay"
        aria-hidden="true"
        {...(open ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40 bg-black/40"
        onClick={() => NotificationsSheet.close()}
      >
      </div>
      <div
        id="notifications-sheet"
        role="dialog"
        aria-label="Notifications"
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className={'fixed z-50 flex flex-col bg-white dark:bg-zinc-900 '
          + 'border-zinc-200 dark:border-zinc-700 shadow-2xl nav-sheet-transition'}
      >
      <div
        id="notifications-screen-tabs"
        className={'sticky top-0 z-10 bg-white dark:bg-zinc-900 flex items-end gap-4 px-5 pt-4 '
          + 'border-b border-zinc-200 dark:border-zinc-800 shrink-0'}
        role="tablist"
        aria-label="Notification filters"
      >
        <button
          role="tab"
          aria-selected={tab === 'all'}
          className={tabCls(tab === 'all')}
          onClick={() => setTab('all')}
        >
          All
        </button>
        <button
          role="tab"
          aria-selected={tab === 'unread'}
          className={tabCls(tab === 'unread')}
          onClick={() => setTab('unread')}
        >
          {unread.length ? `Unread (${unread.length})` : 'Unread'}
        </button>
        <span className="flex-1">
        </span>
        <button
          id="notifications-screen-mark-all"
          className={'pb-2 text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 '
            + 'dark:hover:text-zinc-200 disabled:opacity-40'}
          disabled={!unread.length}
          onClick={() => controller()?.markAllRead()}
        >
          Mark all read
        </button>
        <button
          id="notifications-sheet-close"
          type="button"
          className={'pb-2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 '
            + 'dark:hover:text-zinc-200 un-touch-target'}
          aria-label="Close"
          onClick={() => NotificationsSheet.close()}
        >
          <XIcon className="w-5 h-5" />
        </button>
      </div>
      {/* The sheet's own scroller. The screen root used to be the scroller;
          a sheet's head has to stay put while its rows move, so the rows get
          a box of their own. */}
      <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain platform-safe-scroll">
      {/*
          Saved messages + collaborator invites, pinned above the rows — they
          moved here with the list from the drawer's notifications block.
          Above the tab sections deliberately: an invite is actionable on
          either tab, and a save has no read state to filter by.
      */}
      <NotificationsPinnedSections />
      {today.length ? (
        <>
          <SectionHead>
            Today
          </SectionHead>
          {today.map((view) => <ScreenRow key={view.id} view={view} />)}
        </>
      ) : null}
      {earlier.length ? (
        <>
          <SectionHead>
            Earlier
          </SectionHead>
          {earlier.map((view) => <ScreenRow key={view.id} view={view} />)}
        </>
      ) : null}
      {!rows.length ? (
        <p className="px-4 py-8 text-sm text-zinc-500 text-center">
          {tab === 'unread' ? 'You’re all caught up.' : 'Nothing here yet — you’ll get pinged here.'}
        </p>
      ) : null}
      {snap.screenCanLoadMore ? (
        <div className="px-4 py-3">
          <button
            className="w-full text-center text-xs text-violet-500 hover:underline disabled:opacity-40"
            disabled={snap.loadingMore}
            onClick={() => controller()?.loadOlder()}
          >
            {snap.loadingMore ? 'Loading…' : 'See older notifications'}
          </button>
        </div>
      ) : null}
      </div>
      </div>
    </>
  );
}
