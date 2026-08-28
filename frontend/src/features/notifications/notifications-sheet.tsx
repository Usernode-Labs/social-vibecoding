/**
 * The Notifications SHEET (#notifications-sheet) — Streamlined Concept.
 *
 * Unread | All | Messages tabs, TODAY / EARLIER sections, one row per
 * notification with an avatar-initial chip, the source app + relative time as
 * the subtitle, an unread dot and a trailing chevron.
 *
 * ── UNREAD LEADS, and it is where the sheet opens ──────────────────────
 *
 * All led for one round. Opening an inbox on everything you have already read
 * is opening it on the answer to a question nobody asked: you tapped the bell
 * BECAUSE it had a count, and the count is the unread. So Unread is first in
 * the strip and is the initial tab, and All is the archive you step sideways
 * into — which is what the footer link at the bottom of a filtered tab now
 * does, rather than paging more rows into a filter you are trying to empty.
 *
 * "Mark all read" went with it. It sat at the far right of the same row as
 * the tabs, in the same ink, and read as a fourth tab you could not select —
 * a destructive-ish action a tap away from three navigation controls. It is
 * an action ON the unread list, so it lives under the Unread tab with the
 * list it acts on, and exists nowhere else.
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
  /**
   * The meta line's attribution — a username, or null. Set only where the
   * source user is the one who DID this; see the note on `rowView` in
   * ./notifications.js for the two kinds that name a person who is the
   * subject rather than the actor.
   */
  by?: string | null;
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
        {/* WHAT KIND. Its own line since the subject stopped sharing one with
            it: the label is the same words on every row of a kind, so it
            scans as a column down the left edge, and the subject below it
            gets the row's whole width to truncate in. Semibold-small keeps
            it legible while ranking it under the subject — and tells it
            apart from the meta line, which is the same size in regular
            weight. A kind with no subject to name (a collaborator invite is
            entirely its own label) renders on the SUBJECT's line instead: a
            heading over nothing is worse than either line alone. */}
        {view.segments.length ? (
          <span className="block text-xs font-semibold text-zinc-500 dark:text-zinc-400 truncate">
            {view.label}
          </span>
        ) : null}
        {/* WHICH ONE — the PR's title, the conversation, the message. The
            row's own content, and the only line whose text differs between
            two notifications of the same kind, so it carries the strong ink. */}
        <span className="block text-sm text-zinc-900 dark:text-zinc-100 truncate">
          {view.segments.length ? view.segments.map((segment, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <span
              key={index}
              className={segment.t === 'who'
                ? 'font-semibold'
                : segment.t === 'strong'
                  ? 'font-medium'
                  : 'text-zinc-700 dark:text-zinc-300'}
            >
              {(index > 0 ? ' ' : '') + (segment.t === 'who' ? `@${segment.v}` : segment.v)}
            </span>
          )) : view.label}
        </span>
        {/* WHERE · WHO · WHEN. Everything the copy used to repeat inside a
            sentence lives on this line instead, which is what let the row
            spend its other two lines on the kind and the subject — see
            rowView in ./notifications.js. `by` is absent on a system row
            (nobody did it) and on the two key rows (the name there is the
            subject). */}
        <span className="block text-xs text-zinc-500 truncate">
          {[view.appLine, view.by ? `by @${view.by}` : null, view.time]
            .filter(Boolean).join(' · ')}
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
  const { open, adopted } = useStoreState(notificationsSheetStore) as {
    open: boolean; adopted: boolean;
  };

  // Pull-to-refresh went with the screen root. A kit sheet owns the vertical
  // drag for its own dismiss gesture, so a pull-down inside one cannot also
  // mean "reload" — the controller refreshes on open instead.
  const snap = useStoreState(notificationsStore) as {
    screenList: ScreenRowView[] | null;
    screenCanLoadMore?: boolean;
    loadingMore: boolean;
  };
  // Unread, not All: the bell is tapped because it has a count.
  const [tab, setTab] = useState<Tab>('unread');

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

  // `whitespace-nowrap`: "Unread (12)" is two words and the strip is a flex
  // row inside a phone-width sheet, so the count wrapped onto a second line
  // and the tab grew a line taller than its neighbours. The label is a label —
  // it does not wrap, it just takes the width it needs.
  const tabCls = (active: boolean) =>
    'shrink-0 whitespace-nowrap px-1 pb-2 text-sm font-medium border-b-2 transition-colors '
    + (active
      ? 'border-violet-500 text-zinc-900 dark:text-zinc-100'
      : 'border-transparent text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300');

  return (
    <>
      {/* The overlay is the WEB presentation's dim. Adopted into a kit sheet
          the kit's own backdrop owns it — see lib/sheet-controller.js. */}
      <div
        id="notifications-sheet-overlay"
        aria-hidden="true"
        {...(open && !adopted ? { 'data-open': '' } : {})}
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
          id="notifications-tab-unread"
          role="tab"
          aria-selected={tab === 'unread'}
          className={tabCls(tab === 'unread')}
          onClick={() => setTab('unread')}
        >
          {unreadCount ? `Unread (${unreadCount})` : 'Unread'}
        </button>
        <button
          id="notifications-tab-all"
          role="tab"
          aria-selected={tab === 'all'}
          className={tabCls(tab === 'all')}
          onClick={() => setTab('all')}
        >
          All
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
      {/*
          "Mark all read", under the tab whose list it empties.

          It used to sit at the far right of the tab row, in tab-sized ink on
          the same baseline as All / Unread / Messages, which made a control
          that CHANGES data look like a fourth place to go. Here it is
          unmistakably an action on the list below it — and it exists only on
          Unread, because "mark all read" while looking at All or at Messages
          is an offer to act on rows you are not being shown.

          Rendered even with nothing unread (disabled), so the strip does not
          reflow the first time you clear the list.
      */}
      {tab === 'unread' ? (
        <div className="flex justify-end px-4 pt-2">
          <button
            id="notifications-screen-mark-all"
            type="button"
            className={'inline-flex items-center h-7 px-3 rounded-full text-xs font-medium '
              + 'text-violet-600 hover:bg-violet-500/10 dark:text-violet-400 '
              + 'disabled:opacity-40 disabled:hover:bg-transparent un-touch-target'}
            disabled={!unread.length}
            onClick={() => controller()?.markAllRead()}
          >
            Mark all read
          </button>
        </div>
      ) : null}
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
      {/*
          THE WAY ON, and it depends on which tab you are standing on.

          On MESSAGES it is a real pager, and it stays on this tab. The reason
          a filtered tab could not page used to be that only one page existed —
          the unfiltered one — so pressing it fetched 100 older rows of
          everything and typically surfaced no new message at all: a spinner,
          and nothing. `?kind=conversation` (src/routes/notifications.js) makes
          a page of older MESSAGES a thing the server can return, so the tab
          now pages itself on its own cursor. See
          Notifications.loadOlderMessages for why that cursor is separate.

          On UNREAD it is still the All tab, and for the reason above that has
          not changed: paging Unread means asking for more of the thing you are
          trying to get to zero, and the older rows are mostly read. What you
          want from the bottom of that list is the unfiltered one.

          On ALL it is the loader it always was.

          Either way it renders only when there IS something more: rows this
          filter is hiding, or another page on the server. An empty Unread tab
          on a quiet account would otherwise offer a link to an equally empty
          All, which is a dead end dressed as a way forward.
      */}
      {tab === 'messages' && snap.messagesCanLoadMore ? (
        <div className="px-4 py-3">
          <button
            id="notifications-see-older-messages"
            type="button"
            className="w-full text-center text-xs text-violet-500 hover:underline disabled:opacity-40"
            disabled={snap.loadingOlderMessages}
            onClick={() => controller()?.loadOlderMessages()}
          >
            {snap.loadingOlderMessages ? 'Loading…' : 'See older message notifications'}
          </button>
        </div>
      ) : tab !== 'all' && (all.length > rows.length || snap.screenCanLoadMore) ? (
        <div className="px-4 py-3">
          <button
            id="notifications-see-older"
            type="button"
            className="w-full text-center text-xs text-violet-500 hover:underline"
            onClick={() => setTab('all')}
          >
            See older notifications
          </button>
        </div>
      ) : tab === 'all' && snap.screenCanLoadMore ? (
        <div className="px-4 py-3">
          <button
            id="notifications-load-older"
            type="button"
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
