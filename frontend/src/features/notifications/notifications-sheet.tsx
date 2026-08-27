/**
 * The Notifications SHEET (#notifications-sheet) — Streamlined Concept.
 *
 * All | Unread | Messages tabs, TODAY / EARLIER sections, one row per
 * notification with an avatar-initial chip, the source app + relative time as
 * the subtitle, an unread dot and a trailing chevron.
 *
 * ── Messages, and why it has a tab of its own ──────────────────────────
 *
 * A message notification is one row in a flat chronological list that also
 * carries every session completion, proposal nudge and kudos on a busy
 * account, so it sinks within hours — and it is the one kind you ANSWER
 * rather than just read. The tab is the place to catch up on conversations
 * whatever the rest of the feed is doing, and it carries the way out of the
 * sheet: `#notifications-all-messages` opens the same #messages screen the
 * app chip's Messages row does.
 *
 * The rows on it are already collapsed per conversation — a run of
 * consecutive same-conversation notifications renders as one row with a
 * count, see collapseConversationRuns in ./notifications.js — so a friend
 * sending four lines is one entry here, not four.
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

import { ChatBubbleTailIcon, ChevronRightIcon, XIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
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
  /** Set on a conversation row — what the Messages tab filters on. */
  conversation?: boolean;
  conversationId?: number | null;
  /**
   * How many notifications this row stands for. Present only on a genuine
   * collapse (a run of consecutive same-conversation rows, see
   * collapseConversationRuns in ./notifications.js); absent means one.
   */
  count?: number;
};

type Tab = 'all' | 'unread' | 'messages';

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
      {/*
          A collapsed conversation run says how many it stands for. Only ever
          rendered above 1, so an ordinary row is unchanged — and it is a
          COUNT, not an alerting badge: it sits in the row's own ink when the
          run is read, violet only while it is still waiting on you.
      */}
      {view.count && view.count > 1 ? (
        <span
          className={'shrink-0 min-w-[1.25rem] px-1.5 h-5 rounded-full text-[0.65rem] font-semibold '
            + 'flex items-center justify-center '
            + (view.unread
              ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400')}
          aria-label={`${view.count} notifications`}
        >
          {view.count > 99 ? '99+' : view.count}
        </span>
      ) : null}
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
  const [tab, setTab] = useState<Tab>('all');

  // `?shot=notifications-messages` lands on the Messages tab, so the capture
  // pipeline and the declared checks can reach a view that is otherwise only
  // one click away and therefore invisible to both.
  //
  // In an effect and not in the initial state, for the reason every deep link
  // in this bundle is: the SSG pass renders this island in Node, where there
  // is no `location` and the prerendered markup has to match the client's
  // first pass byte for byte. Reading it during render would mismatch on
  // hydration, and a console error on any route fails proposal checks.
  useIsomorphicLayoutEffect(() => {
    let shot: string | null = null;
    try { shot = new URLSearchParams(window.location.search).get('shot'); }
    catch { shot = null; }
    if (shot === 'notifications-messages') setTab('messages');
  }, []);

  const all = snap.screenList || [];
  const unread = all.filter((view) => view.unread);
  const messages = all.filter((view) => view.conversation);
  const rows = tab === 'unread' ? unread : tab === 'messages' ? messages : all;
  // The tab counts NOTIFICATIONS, not rows. A collapsed conversation row
  // stands for `count` of them, so summing is what keeps this number equal to
  // the one on the bell — after collapsing, `unread.length` would say 1 where
  // the badge says 4.
  const unreadCount = unread.reduce((sum, view) => sum + (view.count || 1), 0);
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
          {unreadCount ? `Unread (${unreadCount})` : 'Unread'}
        </button>
        {/*
            Messages. One place to catch up on conversations regardless of how
            busy the rest of the feed is: a message sinks fast in a flat
            chronological list that also carries every session, proposal and
            kudos notification, and it is the one kind you answer rather than
            just read.
        */}
        <button
          id="notifications-tab-messages"
          role="tab"
          aria-selected={tab === 'messages'}
          className={tabCls(tab === 'messages')}
          onClick={() => setTab('messages')}
        >
          Messages
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
      {/*
          The Messages tab is a messages-only view, so Saved and Invites step
          aside on it — they are neither, and between them they can hold the
          top ~384px of the sheet (each is `max-h-48`), which is most of a
          phone's first screen.
          
          In their place, the way OUT: this tab lists the conversations that
          pinged you, and the next thing you want is the rest of them. It goes
          to the same #messages screen the app chip's Messages row does — one
          destination, reached from either place — and dismisses the sheet
          first, because on touch it is a modal kit sheet that would otherwise
          cover the screen it just sent you to (the contract _onItemClick
          follows for every row that routes).
      */}
      {tab === 'messages' ? (
        <button
          id="notifications-all-messages"
          type="button"
          className={'w-full text-left px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 '
            + 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors flex items-center gap-3 '
            + 'text-sm font-medium text-violet-600 dark:text-violet-400'}
          onClick={(event) => {
            event.stopPropagation();
            NotificationsSheet.close();
            const bridge = (window as any).UsernodeReact?.messages;
            if (bridge?.open) bridge.open();
            else window.location.hash = '#messages';
          }}
        >
          <ChatBubbleTailIcon className="w-5 h-5 shrink-0" />
          <span className="flex-1 min-w-0">
            All messages
          </span>
          <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
        </button>
      ) : (
        <NotificationsPinnedSections />
      )}
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
          {tab === 'unread' ? 'You’re all caught up.' : 'Nothing here yet. You’ll get pinged here.'}
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
