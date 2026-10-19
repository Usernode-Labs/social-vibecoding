/**
 * The Notifications SHEET (#notifications-sheet) — Streamlined Concept.
 *
 * Unread | Messages | All tabs, TODAY / EARLIER sections, one row per
 * notification with an avatar-initial chip, the source app + relative time as
 * the subtitle, and an unread dot in the row's left margin (N6).
 *
 * ── UNREAD LEADS, and it is where the sheet opens ──────────────────────
 *
 * All led for one round. Opening an inbox on everything you have already read
 * is opening it on the answer to a question nobody asked: you tapped the bell
 * BECAUSE it had a count, and the count is the unread. So Unread is first in
 * the strip and is the initial tab, and All is the archive you step sideways
 * into — which is what the Messages footer link still does, rather than paging
 * more rows into a filter you are trying to empty. Unread shows its older rows
 * in place instead (#4700).
 *
 * All is LAST for the same reason it is not first. The strip reads as a
 * narrowing: the count you came for, then the one conversation kind you answer
 * rather than read, then the archive that holds both. With All in the middle
 * the two filtered tabs sat either side of the unfiltered one, so stepping
 * from Unread to Messages meant passing through everything.
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
 * AGENTS LIVE HERE TOO (#2815). The bell had a fourth tab, Agents, listing
 * the running sessions; the Messages screen already puts agents in its chats
 * beside people, so the bell now does the same. The Messages tab is one list,
 * newest first: conversation rows, the agent notifications (a session
 * finished, Claude asked you something, work it submitted — the `agent` flag
 * screenViews sets in ./notifications.js) and the sessions themselves as the
 * same <SessionRow> the Agents tab drew, each at its own last-activity time.
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
 * ── The type is the Improve rail's, not a scale of its own ────────────
 *
 * This sheet shipped with a bespoke iOS-ish ramp — 13/14/15/17/20/22px — while
 * the Improve rail beside it, the surface a viewer most often sees this one
 * next to, runs Tailwind's `text-xs` / `text-sm`. Opened together the bell
 * read a size larger throughout, which is what "the font is way too big" was.
 *
 * Every size here now maps to the role the Improve panel gives it, so the two
 * rails read as one product:
 *
 *     sheet title   22px bold   → text-sm font-semibold   (its h2)
 *     row subject   17px bold   → text-sm font-semibold   (session-row's title)
 *     row meta      15px        → text-xs                 (its metadata)
 *     section label 15px        → text-xs font-medium     (SECTION_LABEL_CLASS)
 *     tab / action  15px semi   → text-sm font-semibold   (its quick actions)
 *     small pill    14px semi   → text-xs font-semibold
 *     count badge   13px bold   → text-[11px] font-semibold (session-row's pill)
 *
 * What did NOT change is the row's leading tile, still `h-11 w-11` where the
 * Improve rail's is `h-8 w-8`. That is a dimension rather than a type size,
 * and the avatar chip is load-bearing here in a way it is not there — a
 * conversation row is a PERSON speaking and the swatch is how you tell whose.
 * If the rows still read heavier than Improve's, that tile is the next lever,
 * and it is a deliberate separate decision.
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

import { OverlayScrim } from '../../lib/overlay-scrim-view';
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { IconTile } from '@/components/ui/icon-tile';
import {
  BookmarkIcon, BookmarkSolidIcon, ChatBubbleTailIcon, ChevronRightIcon, SearchIcon, XIcon,
} from '@/components/ui/icons';

import { UserAvatar, swatchFor } from '../messages/format';
import type { ConversationUser } from '../messages/types';

import { RichMessage, useMessages } from '../../lib/i18n/react';
import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { notificationsStore } from './notifications-store.js';
import { matchesNotificationQuery, normalizeNotificationQuery } from './notifications-search.js';
import { notificationsSheetStore } from './notifications-sheet-store.js';
import { NotificationsSheet } from './notifications-sheet-controller.js';
import { NotificationsPinnedSections } from './notifications-list';
import { improveStore } from '../improve/improve-store.js';
import { SessionRow } from '../improve/session-row';
import type { SessionRowView } from '../improve/session-row';
import type { NotificationRowView } from './notifications-list';

type ScreenRowView = NotificationRowView & {
  /** The unelided instant for the `<time>`'s title (#1808, stampFields). */
  timeTitle?: string;
  createdAtMs: number;
  who: string;
  appLine: string;
  /**
   * #5406: the app the row came from, for the Unread tab's per-app groups.
   * Conversation kinds carry no app — they group under "Other".
   */
  appId?: number | null;
  /**
   * The meta line's attribution — a username, or null. Set only where the
   * source user is the one who DID this; see the note on `rowView` in
   * ./notifications.js for the two kinds that name a person who is the
   * subject rather than the actor.
   */
  by?: string | null;
  /** Set on a conversation row — what the Messages tab filters on. */
  conversation?: boolean;
  /** Set on a row from the Homeroom bot: it wears the bot's own face. */
  bot?: boolean;
  /** Set on an agent-status row (#2815) — the Messages tab lists these too. */
  agent?: boolean;
  conversationId?: number | null;
  /**
   * #4769: the user has bookmarked this row for later. Independent of the
   * read state — saving never reads, reading never saves.
   */
  saved?: boolean;
  /**
   * How many notifications this row stands for. Present only on a genuine
   * collapse (a run of consecutive same-conversation rows, see
   * collapseConversationRuns in ./notifications.js); absent means one.
   */
  count?: number;
};

type Tab = 'all' | 'unread' | 'messages';

/**
 * One entry on the Messages tab: a notification row, or a running session.
 * Both carry `at` (ms) so the tab sorts them as one list, as the Messages
 * screen's chats section does (see buildInbox in ../messages/inbox.ts).
 */
type MessagesEntry =
  | { type: 'notif'; key: string; at: number; view: ScreenRowView }
  | { type: 'session'; key: string; at: number; session: SessionRowView & { sortAt?: number } };

/** The bot as the avatar reads it: a platform account, drawn as its mark. */
const BOT_SENDER: ConversationUser = { id: 0, username: 'homeroom_bot', avatarUrl: null, bot: true };

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Notifications : null) || null;
}

function kit(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

/** Local-midnight boundary — rows at or after it are "Today". */
function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * The row's leading mark, in the language's two shapes: a conversation is
 * a PERSON speaking, so it gets the square swatch avatar Messages uses
 * (the same colour for the same handle); everything else is an EVENT, so
 * it gets the neutral glyph tile with the kind's icon.
 *
 * Run six (14 Oct 2026): the Homeroom bot is drawn as Messages draws it,
 * the Homeroom mark (../messages/format.tsx UserAvatar), not an orange
 * tile of the "H" of its handle.
 */
export function AvatarChip({ view }: { view: ScreenRowView }): ReactNode {
  const who = (view.who || '?').replace(/^@/, '');
  const initial = who.charAt(0).toUpperCase() || '?';
  if (view.conversation && view.bot) {
    // Its image has no text (alt=""): the row's words say who it is from.
    return <UserAvatar user={BOT_SENDER} size="lg" shape="square" />;
  }
  if (view.conversation) {
    return (
      <span
        aria-hidden="true"
        className="w-11 h-11 shrink-0 rounded-xl text-white flex items-center justify-center text-sm font-semibold"
        style={{ backgroundColor: swatchFor(who) }}
      >
        {initial}
      </span>
    );
  }
  return (
    <IconTile size="sm" aria-hidden="true" className="text-base">
      {view.icon || initial}
    </IconTile>
  );
}

function SectionHead({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="px-4 pt-4 pb-1 text-xs font-medium text-zinc-500 dark:text-zinc-500">
      {children}
    </div>
  );
}

/**
 * #5406: the heading of one app's group of unread notifications on the Unread
 * tab, with that app's "Mark read" beside it. The heading is the app's name
 * (the same words each row's meta line already carries); the pill is the
 * sheet's own "Mark all read" pill in miniature, and clears that app's every
 * unread notification — including ones the sheet has not paged in — through
 * the controller's markAppRead. The "Other" group (notifications that belong
 * to no app) renders no button: nothing but Mark all read owns those.
 */
function AppGroupHead({ groupKey, label, appId, onRead }: {
  groupKey: string;
  label: string;
  appId: number | null;
  /** Before the clear: let the group's rows go, so they leave Unread (useHeldUnread). */
  onRead?: () => void;
}): ReactNode {
  const t = useMessages('notifications');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex items-center gap-2 px-4 pt-4 pb-1" data-notif-app-group={groupKey}>
      <span className="flex-1 min-w-0 truncate text-xs font-medium text-zinc-500 dark:text-zinc-500">
        {label}
      </span>
      {appId != null ? (
        <button
          type="button"
          data-notif-app-read={appId}
          className={'inline-flex items-center h-8 px-3 rounded-full text-xs font-semibold '
            + 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 '
            + 'disabled:opacity-40 disabled:hover:bg-zinc-100 dark:disabled:hover:bg-zinc-800 un-touch-target'}
          disabled={busy}
          aria-busy={busy ? 'true' : undefined}
          aria-label={t('notifications:sheet.markAppReadLabel', { app: label })}
          onClick={(event) => {
            // Stopped for the reason every handler in this sheet stops its
            // click: a click that re-renders the list would otherwise bubble
            // to an outside-click listener that dismisses the sheet.
            event.stopPropagation();
            if (busy) return;
            setBusy(true);
            onRead?.();
            Promise.resolve(controller()?.markAppRead(appId))
              .catch(() => false)
              .then(() => setBusy(false));
          }}
        >
          {t('notifications:sheet.markAppRead')}
        </button>
      ) : null}
    </div>
  );
}

/**
 * The Unread tab's groups (#5406): rows bucketed by app, in feed order.
 * The first time an app is seen is its newest notification, so the groups
 * are ordered by their newest row and the rows keep their order inside a
 * group. Rows that belong to no app (messages, friends, account) share one
 * "Other" group, under the key `'other'`; `appId` 0 counts as an app, so the
 * staging demo mocks group and show the button.
 */
type AppGroup = {
  key: string;
  appId: number | null;
  /** The first row's appLine, before the "Other" fallback the renderer applies. */
  appLine: string;
  entries: MessagesEntry[];
};

function groupUnreadByApp(rows: ScreenRowView[]): AppGroup[] {
  const groups: AppGroup[] = [];
  const byKey = new Map<string, AppGroup>();
  for (const view of rows) {
    const key = view.appId != null ? 'a:' + view.appId : 'other';
    let group = byKey.get(key);
    if (!group) {
      group = { key, appId: view.appId ?? null, appLine: view.appLine || '', entries: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.entries.push({ type: 'notif', key: `n:${view.id}`, at: view.createdAtMs || 0, view });
  }
  return groups;
}

/**
 * A row's own buttons, beside the tap that opens the thing (#1688).
 *
 * #2386: a row with TWO actions (a friend request's Accept and Decline) puts
 * them on their own line under the text, lined up with it past the tile.
 * Beside the text, two pills leave a phone's row a few letters wide. One
 * action ("Still yes") keeps its place at the row's end.
 */
function RowActions({ view, actions }: {
  view: { id: number };
  actions: { key: string; label: string; primary?: boolean }[];
}): ReactNode {
  // #3984: "Still yes" on its way. It is a vote, and on a slow network
  // nothing showed until the server answered, so a second press looked like
  // the thing to do. It reads "Sending…" and takes no press until then; the
  // other row actions are not votes and keep their own behaviour.
  const [busy, setBusy] = useState(false);
  const t = useMessages('notifications');
  const buttons = actions.map((a) => (
    // The widget language's filled pill, through the shell's <Button>:
    // the accent one for the row's primary act, the neutral one beside it.
    <Button
      key={a.key}
      type="button"
      data-notif-action={a.key}
      variant={a.primary ? 'pillAccent' : 'pillNeutral'}
      size="default"
      ink={a.primary ? 'solid' : 'neutral'}
      className="shrink-0"
      disabled={a.key === 'still_yes' && busy}
      aria-busy={a.key === 'still_yes' && busy ? 'true' : undefined}
      onClick={(event) => {
        event.stopPropagation();
        if (a.key !== 'still_yes') { controller()?._onRowAction(view.id, a.key); return; }
        if (busy) return;
        setBusy(true);
        Promise.resolve(controller()?._onRowAction(view.id, a.key))
          .catch(() => false)
          .then(() => setBusy(false));
      }}
    >
      {a.key === 'still_yes' && busy ? t('notifications:row.sending') : a.label}
    </Button>
  ));
  if (actions.length > 1) return <div className="flex items-center gap-2 pl-[3.75rem]">{buttons}</div>;
  return <>{buttons}</>;
}

/**
 * The row after `id` in the sheet (or before it, at the end of the list),
 * read off the document before a clear changes the list under it (#3538).
 */
function neighbourRowId(sheet: Element, id: number): string | null {
  const rows = Array.from(sheet.querySelectorAll('[data-notif-id]'));
  const at = rows.findIndex((row) => row.getAttribute('data-notif-id') === String(id));
  if (at < 0) return null;
  const next = rows[at + 1] || rows[at - 1] || null;
  return next ? next.getAttribute('data-notif-id') : null;
}

/**
 * Where focus goes after the × clears a row from the keyboard (#3538). The ×
 * goes with what it cleared (on Unread the whole row leaves; elsewhere the
 * row stays and stops being clearable), and a focused node that leaves the
 * document drops focus on <body>, outside the dialog. So focus moves to the
 * row itself while it is still there, else to its neighbour, else to the
 * sheet's close disc.
 */
function refocusAfterClear(sheet: Element, id: number, neighbourId: string | null): void {
  const focusable = (row: Element | null): HTMLElement | null => {
    if (!row) return null;
    return (row.matches('button') ? row : row.querySelector('button')) as HTMLElement | null;
  };
  const target = focusable(sheet.querySelector(`[data-notif-id="${id}"]`))
    || (neighbourId ? focusable(sheet.querySelector(`[data-notif-id="${neighbourId}"]`)) : null)
    || (sheet.querySelector('#notifications-sheet-close') as HTMLElement | null);
  target?.focus();
}

/**
 * WHAT UNREAD LISTED STAYS LISTED WHILE THE SHEET IS OPEN (polish board #7,
 * 19 Oct 2026). Unread is a live filter over the feed, and the feed is
 * replaced whole by the read the sheet makes as it opens (and by any later
 * one). On an iPhone the sheet opened on "Unread (1)" from the boot copy,
 * and about three seconds later, with no touch, the row had gone and the
 * tab said "You're all caught up": it had been read elsewhere. A list that
 * empties under the eye reads as the app losing it.
 *
 * So every row seen unread while the sheet is open is HELD on Unread until
 * it closes. One that turns read on its own stays where it was, drawn dim
 * and without its dot; the tab's count and Mark all read follow what is
 * still unread. A row the viewer clears (the swipe, the ×, an app's Mark
 * read, Mark all read) is RELEASED first, so it leaves as it always did:
 * that is the viewer's own doing, not the list's.
 */
type HeldUnread = {
  /** Listed on Unread: unread now, or held. */
  listed: (view: ScreenRowView) => boolean;
  /** Let these rows go, so clearing them takes them off Unread. */
  release: (ids: Iterable<ScreenRowView['id']>) => void;
};

type HoldSets = { held: Set<ScreenRowView['id']>; released: Set<ScreenRowView['id']> };

/**
 * One render of useHeldUnread: closed, nothing is held; open, every row
 * unread now is held, unless the viewer has let it go. Changes only the two
 * sets it is handed.
 */
export function holdUnread(sets: HoldSets, open: boolean, all: readonly ScreenRowView[]): void {
  if (!open) {
    sets.held.clear();
    sets.released.clear();
    return;
  }
  for (const view of all) if (view.unread && !sets.released.has(view.id)) sets.held.add(view.id);
}

/** Let rows go (useHeldUnread's `release`). */
export function releaseHeld(sets: HoldSets, ids: Iterable<ScreenRowView['id']>): void {
  for (const id of ids) {
    sets.released.add(id);
    sets.held.delete(id);
  }
}

export function useHeldUnread(open: boolean, all: ScreenRowView[]): HeldUnread {
  const sets = useRef<HoldSets>({ held: new Set(), released: new Set() });
  // Kept in step with the render, not in an effect: an effect runs after the
  // frame that drew the list, and that frame would already be missing the row.
  holdUnread(sets.current, open, all);
  const release = useCallback((ids: Iterable<ScreenRowView['id']>) => releaseHeld(sets.current, ids), []);
  return {
    listed: (view) => view.unread || sets.current.held.has(view.id),
    release,
  };
}

type ScreenRowProps = {
  view: ScreenRowView;
  /** PlatformUI.isTouch() at render time: the swipe on touch, else the ×. */
  touch: boolean;
  /** True on Unread, the one tab a cleared row leaves. */
  removes: boolean;
  /** Read while the sheet was open, and still listed on Unread (useHeldUnread): drawn dim. */
  held?: boolean;
  /** Let the row go before clearing it, so it leaves Unread (useHeldUnread). */
  onRelease?: (ids: Iterable<ScreenRowView['id']>) => void;
};

/**
 * One notification row, in a SLOT of its own (#3538).
 *
 * CLEARING. An unread row can be cleared without opening it. Clearing is
 * marking read (clearNotification in ./notifications.js), so the row leaves
 * Unread and stays in All without its dot; a read row has nothing to clear
 * and offers nothing. There are two ways to do it, one per kind of hand,
 * each the way the system the request pointed at does it:
 *
 *   - ON A PHONE, the swipe. iOS clears a notification with a swipe to the
 *     left, and a long swipe clears it outright. The swipe is the kit's
 *     (PlatformUI.swipeActions), wired the way the Saved and Invite rows in
 *     ./notifications-list.tsx wire theirs: on touch only, from an effect,
 *     after mount. The kit gives the row `touch-action: pan-y` and puts its
 *     drag through the gesture arbiter, so an up-and-down drag on a row
 *     still scrolls the list, and the kit sheet still pulls down from its
 *     grabber as it did; the row takes only a drag that reads as sideways.
 *     The sheet has no sideways gesture of its own (its tabs are tapped), so
 *     nothing else wants that one.
 *
 *     On Unread the long swipe COMMITS, because there the row leaves: it
 *     slides out and collapses, as on the lock screen. On Messages and All
 *     the row stays, so the swipe reveals Clear and a tap on it clears. A
 *     row that slid away and then came straight back without its dot would
 *     say two different things in half a second. The button is the kit's
 *     neutral grey on every tab, not the red of its destructive action,
 *     because clearing deletes nothing.
 *
 *   - AT A DESK, the ×. macOS Notification Center puts a small round × on a
 *     notification's corner while the pointer is over it, and this is that:
 *     the sheet's own white close disc in miniature, on the corner of the
 *     row's tile, drawn on hover. It is a real button BESIDE the row, never
 *     inside it (the row is a button), so it is its own tab stop right after
 *     the row, drawn while either of them has keyboard focus, and named
 *     "Clear notification". It is not rendered on touch at all: there is no
 *     hover there, and an invisible target on a tile's corner is an
 *     accidental clear waiting to happen.
 *
 * WHY THE SLOT. The kit wraps the element it is handed: it moves it into a
 * `.un-swipe` container it inserts in its place, beside the action tray, and
 * a full swipe takes that container out of the document before its handler
 * runs. So the row cannot be a node React places among its siblings, or
 * React would go on removing it from a parent it is no longer in. That is
 * why app-context-sheet.tsx's session rows sit in a <div> of their own
 * (#3515), and it is the same answer here; the × needs a positioned box to
 * sit in anyway. The slot is KEYED on what decides the kit's hold on the
 * row, its read state and its shape, so a row that changes either is a new
 * slot and React drops the old one whole instead of swapping out an element
 * the kit may still be holding. The hairline between rows follows the
 * slot's place in the list rather than the row's (app.css).
 */
function ScreenRow({ view, touch, removes, held = false, onRelease }: ScreenRowProps): ReactNode {
  const t = useMessages('notifications');
  const clearable = view.unread;
  const shape = view.actions && view.actions.length ? 'actions' : 'plain';
  const rowRef = useRef<HTMLElement | null>(null);
  const setRow = useCallback((el: HTMLElement | null) => { rowRef.current = el; }, []);
  useEffect(() => {
    const el = rowRef.current;
    const ui = kit();
    if (!clearable || !touch || !el || !ui?.swipeActions) return undefined;
    const swipe = ui.swipeActions(el, {
      actions: [{
        label: t('notifications:row.clear'),
        // The kit's full swipe belongs to its destructive action, and it
        // takes the row out of the document; only Unread wants that.
        destructive: removes,
        color: 'var(--un-action-neutral)',
        handler: () => {
          onRelease?.([view.id]);
          void controller()?.clearNotification(view.id);
        },
      }],
    });
    return () => swipe.detach();
  }, [clearable, touch, removes, shape, view.id, t, onRelease]);

  // The row's tile, its three lines and the count.
  //
  // N6 (polish board, 19 Oct 2026): THE TITLE GETS THE ROW'S WIDTH. A row's
  // end held an unread dot, a chevron and the bookmark, and on a phone that
  // left the title about 30 characters. The chevron went (the whole row is
  // the tap, as a notification is on the lock screen), and the dot moved
  // into the row's left margin beside the tile, where Mail keeps it.
  const body = (
    <>
      <span className="relative flex shrink-0">
        {view.unread ? (
          <span
            className="absolute -left-3 top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-zinc-900 dark:bg-zinc-100"
            aria-label={t('notifications:row.unreadDot')}
          >
          </span>
        ) : null}
        <AvatarChip view={view} />
      </span>
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
          <span className="block text-xs text-zinc-500 dark:text-zinc-400 truncate">
            {view.label}
          </span>
        ) : null}
        {/* WHICH ONE — the PR's title, the conversation, the message. The
            row's own content, and the only line whose text differs between
            two notifications of the same kind, so it carries the strong ink. */}
        <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {view.segments.length ? view.segments.map((segment, index) => (
            // eslint-disable-next-line react/no-array-index-key
            <span
              key={index}
              className={segment.t === 'who'
                ? 'font-bold'
                : segment.t === 'strong'
                  ? 'font-semibold'
                  : 'font-normal text-zinc-700 dark:text-zinc-300'}
            >
              {(index > 0 ? ' ' : '') + (segment.t === 'who' ? `@${segment.v}` : segment.v)}
            </span>
          )) : view.label}
        </span>
        {/* #3227: what this kind of row means, for the one kind that needs
            saying (kudos). It wraps: a truncated explanation explains nothing. */}
        {view.note ? (
          <span className="block text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
            {view.note}
          </span>
        ) : null}
        {/* WHERE · WHO · WHEN. Everything the copy used to repeat inside a
            sentence lives on this line instead, which is what let the row
            spend its other two lines on the kind and the subject — see
            rowView in ./notifications.js. `by` is absent on a system row
            (nobody did it) and on the two key rows (the name there is the
            subject). */}
        <span className="block text-xs text-zinc-500 truncate">
          {/* The when is its own element so it can carry the unelided instant
              in `title` (#1808) — the rest of the line is plain text, and the
              separator rides inside it rather than as a whitespace-only
              child, same rule as everywhere else on this row. */}
          {view.time ? (
            /* One message per shape of the line: where from, who, when. The
               time keeps its own element, separator included, as a tag. */
            view.appLine && view.by ? (
              <RichMessage
                id="notifications:row.meta.sourceByWhen"
                values={{ source: view.appLine, username: view.by, when: view.time }}
                components={[<time title={view.timeTitle} />]}
              />
            ) : view.appLine ? (
              <RichMessage
                id="notifications:row.meta.sourceWhen"
                values={{ source: view.appLine, when: view.time }}
                components={[<time title={view.timeTitle} />]}
              />
            ) : view.by ? (
              <RichMessage
                id="notifications:row.meta.byWhen"
                values={{ username: view.by, when: view.time }}
                components={[<time title={view.timeTitle} />]}
              />
            ) : <time title={view.timeTitle}>{view.time}</time>
          ) : view.appLine && view.by
            ? t('notifications:row.meta.sourceBy', { source: view.appLine, username: view.by })
            : view.by ? t('notifications:row.meta.by', { username: view.by }) : view.appLine}
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
          className={'shrink-0 min-w-[1.5rem] px-2 h-6 rounded-full text-[11px] font-semibold '
            + 'flex items-center justify-center '
            + (view.unread
              ? 'bg-violet-600 text-white'
              : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400')}
          aria-label={t('notifications:row.runCount', { count: view.count })}
        >
          {view.count > 99 ? '99+' : view.count}
        </span>
      ) : null}
    </>
  );
  // #1688: a row with an action of its own ("Still yes" on a re-confirm ask)
  // keeps the row as the tap that opens the thing, and puts the action
  // beside it as a real button — never a button inside a button.
  const actions = view.actions || [];
  const row = actions.length ? (
    <div
      ref={touch ? undefined : setRow}
      data-notif-id={view.id}
      // #2386: two actions (a friend request's Accept and Decline) stack
      // under the text; see RowActions.
      // #4769: the row's right padding is pr-16, not the px-4 it was, so the
      // bookmark button (16px in from the slot's edge, N6) never sits over
      // the text.
      className={actions.length > 1
        ? 'notifications-row w-full pl-4 pr-16 py-3.5 flex flex-col gap-2'
        : 'notifications-row w-full pl-4 pr-16 py-3.5 flex items-center gap-3'}
    >
      <button
        className="min-w-0 flex-1 text-left flex items-center gap-4"
        onClick={(event) => {
          event.stopPropagation();
          controller()?._onItemClick(view.id);
        }}
      >
        {body}
      </button>
      <RowActions view={view} actions={actions} />
    </div>
  ) : (
    <button
      ref={touch ? undefined : setRow}
      data-notif-id={view.id}
      className={'notifications-row w-full text-left pl-4 pr-16 py-3.5 '
        + 'hover:bg-black/[.03] dark:hover:bg-white/[.04] transition-colors flex items-center gap-4'}
      onClick={(event) => {
        event.stopPropagation();
        controller()?._onItemClick(view.id);
      }}
    >
      {body}
    </button>
  );
  // #4769: the row's own save. Outline until saved, filled violet (the
  // accent) once it is. Absolutely placed 16px in from the slot's right
  // edge, in line with the sheet's close disc above it (N6: it sat 2px from
  // the edge), vertically centred, with a 36px target — a second action on a
  // phone-width row needs a real one. `stopPropagation` first, for the
  // reason every handler in this sheet stops its click: this is not a tap
  // that opens the row.
  const bookmark = (
    <button
      type="button"
      data-notification-save={view.id}
      aria-pressed={view.saved ? 'true' : 'false'}
      aria-label={t(view.saved ? 'notifications:row.unsave' : 'notifications:row.save')}
      className={'absolute right-4 top-1/2 -translate-y-1/2 flex h-9 w-9 items-center justify-center '
        + 'rounded-full transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06] '
        + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500'}
      onClick={(event) => {
        event.stopPropagation();
        controller()?.toggleSave(view.id);
      }}
    >
      {view.saved
        ? <BookmarkSolidIcon aria-hidden="true" className="h-5 w-5 text-violet-700 dark:text-violet-400" />
        : <BookmarkIcon aria-hidden="true" className="h-5 w-5 text-zinc-500 dark:text-zinc-400" />}
    </button>
  );
  // On touch the bookmark is INSIDE the swipe host, so a swipe translates
  // row and bookmark together; on desktop the slot keeps its flat structure,
  // which is what dapp.json's selectors read. The row hands `setRow` to the
  // wrapper on touch and keeps it itself on desktop, because swipeActions
  // must hold whichever node translates.
  const swipeHost = touch ? (
    <div ref={setRow} data-notif-swipe className="relative">
      {row}
      {bookmark}
    </div>
  ) : row;
  return (
    <div
      key={`${clearable ? 'unread' : 'read'}:${shape}`}
      className={held ? 'notifications-row-slot group/notif relative opacity-60' : 'notifications-row-slot group/notif relative'}
      data-notif-held={held ? '' : undefined}
    >
      {swipeHost}
      {clearable && !touch ? (
        <button
          type="button"
          data-notification-clear={view.id}
          aria-label={t('notifications:row.clearLabel')}
          // Hidden until the pointer is over the slot or something in it has
          // keyboard focus, and untouchable while hidden, so a click on the
          // tile's corner opens the row as it always did.
          className={'absolute left-1.5 top-2 flex h-5 w-5 items-center justify-center rounded-full '
            + 'bg-white text-zinc-900 shadow-sm ring-1 ring-black/10 hover:bg-zinc-50 '
            + 'dark:bg-zinc-900 dark:text-zinc-100 dark:ring-white/15 dark:hover:bg-zinc-800 '
            + 'pointer-events-none opacity-0 transition-opacity '
            + 'group-hover/notif:pointer-events-auto group-hover/notif:opacity-100 '
            + 'group-has-[:focus-visible]/notif:pointer-events-auto group-has-[:focus-visible]/notif:opacity-100 '
            + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500'}
          onClick={(event) => {
            // Stopped for the reason every handler in this sheet stops its
            // click: the re-render takes this node out of the document before
            // the event finishes bubbling, and an outside-click listener
            // would then dismiss the sheet under the viewer. The row's own
            // click is not in the way at all; the × is beside it, not in it.
            event.stopPropagation();
            const sheet = event.currentTarget.closest('#notifications-sheet');
            // `detail` is 0 for a click the keyboard made (Enter or Space).
            const fromKeyboard = event.detail === 0;
            const neighbourId = sheet ? neighbourRowId(sheet, view.id) : null;
            onRelease?.([view.id]);
            void controller()?.clearNotification(view.id);
            if (fromKeyboard && sheet) {
              requestAnimationFrame(() => refocusAfterClear(sheet, view.id, neighbourId));
            }
          }}
        >
          <XIcon aria-hidden="true" className="h-3 w-3" strokeWidth="2.5" />
        </button>
      ) : null}
      {/* #4769: AFTER the clear button in DOM order — the declared checks
          read the slot's direct children as row + clear pair, and the
          bookmark joins at the end. Touch renders it inside the swipe host
          instead, so it is not here at all. */}
      {!touch ? bookmark : null}
    </div>
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
    messagesCanLoadMore?: boolean;
    loadingOlderMessages?: boolean;
    /** #5527: the Unread tab's own pager — see loadMoreUnread(). */
    unreadCanLoadMore?: boolean;
    loadingUnread?: boolean;
    /** #5527: bumped when a refresh lands — the auto-fill's trigger. */
    refreshTick?: number;
    /** #3538: the rows' clear is a swipe on touch and a × everywhere else. */
    touch?: boolean;
  };
  // Unread, not All: the bell is tapped because it has a count.
  const [tab, setTab] = useState<Tab>('unread');
  // The Unread tab's own reveal (#4700): "See older notifications" shows the
  // older, mostly read rows IN PLACE instead of jumping to All, and turns
  // into "Hide older notifications" while they are showing. It is a per-visit
  // state, not a preference — an effect below collapses it when the sheet
  // closes or the tab changes, so coming back to Unread starts collapsed
  // again. It starts false, so the prerendered markup is unchanged.
  const [olderShown, setOlderShown] = useState(false);
  // #5405: what the search field holds. It narrows the tab that is open —
  // all three tabs — and a tab change keeps it. It starts '' so the
  // prerendered markup is an empty field; the restore effect below reads
  // the remembered value back after mount (#5460), so the field still holds
  // what you typed when you come back — opening a row closes the sheet, and
  // a query wiped on close was lost on every round trip to a proposal.
  const [query, setQuery] = useState('');
  // #5460: every write to the query goes through this one helper. A
  // non-empty query is remembered for the browser tab's session — the scope
  // AppView.KANBAN_FILTERS_KEY uses for the board's filters: it survives
  // leaving the screen and a reload, and goes away when the tab closes —
  // and an empty one forgets it, so a cleared field stays cleared. Storage
  // that is unavailable (private mode, blocked) changes nothing: the search
  // then just behaves as it did before, within the page.
  const rememberQuery = useCallback((next: string) => {
    setQuery(next);
    try {
      if (next) window.sessionStorage.setItem('usernode:notifications-search', next);
      else window.sessionStorage.removeItem('usernode:notifications-search');
    } catch { /* storage unavailable */ }
  }, []);
  const t = useMessages('notifications');

  // `?shot=notifications-messages` lands on the Messages tab, so the capture
  // pipeline and the declared checks can reach a view that is otherwise only
  // one click away and therefore invisible to both. It is also the address of
  // the agent session rows: they were the Improve panel's, then the Agents
  // tab's (#2718 review), and are the Messages tab's since #2815.
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

  // #5460: the remembered search comes back after mount, not in the initial
  // state — the SSG pass renders this island in Node with no sessionStorage,
  // and the prerendered field has to stay empty so hydration matches (the
  // reason the deep-link effect above spells out). An empty or missing value
  // restores nothing, so a search you cleared stays cleared.
  useEffect(() => {
    try {
      const remembered = window.sessionStorage.getItem('usernode:notifications-search');
      if (remembered) setQuery(remembered.slice(0, 100));
    } catch { /* storage unavailable */ }
  }, []);

  // The expanded Unread view is forgotten when the sheet closes or you leave
  // the tab, so each visit to Unread starts collapsed again (see the state
  // above). The query is NOT: it is remembered for the tab session (#5460),
  // because opening a row closes the sheet, and clearing it here made every
  // round trip to a proposal re-widen the list. An effect, not the initial
  // state, for the hydration reason the deep link above spells out.
  useEffect(() => {
    if (!open) setOlderShown(false);
    else if (tab !== 'unread') setOlderShown(false);
  }, [open, tab]);

  // #5527: the Unread tab fills itself up to the bell's number. The badge
  // counts every unread row on the account; the sheet opens with only the
  // unread among the newest 100 fetched, so a backlog reads as "Unread (46)"
  // over a list of 1. While the pager says there are more unread to bring
  // up, opening the sheet walks it automatically — up to the controller's
  // five batches — so a big catch-up list is already complete when the
  // viewer arrives, and anything still deeper waits behind the foot button
  // rather than hanging the opening.
  //
  // The trigger is a refresh LANDING while the sheet is open (refreshTick),
  // not the open itself: opening the sheet always refreshes first
  // (notifications-sheet-controller's onOpen), and a fill that starts before
  // that refresh lands is thrown away by it — refresh replaces the whole
  // feed. Arming on open and firing when the tick changes is the one order
  // that cannot race. It re-fires on every later refresh too, which is what
  // keeps the tab topped up while it sits open: loadMoreUnread no-ops
  // without a fetch once the list has caught up with the badge, so a
  // refresh on a caught-up tab costs nothing. A reset when the sheet closes
  // makes each opening re-arm.
  const unreadFillTickRef = useRef(null);
  useEffect(() => {
    if (!open) { unreadFillTickRef.current = null; return; }
    if (tab !== 'unread') return;
    if (unreadFillTickRef.current == null) {
      // Armed: remember the tick this opening starts from and fill nothing
      // yet — the refresh that opening triggers has not landed.
      unreadFillTickRef.current = snap.refreshTick;
      return;
    }
    if (unreadFillTickRef.current === snap.refreshTick) return;
    unreadFillTickRef.current = snap.refreshTick;
    if (!snap.unreadCanLoadMore) return;
    controller()?.loadMoreUnread();
  }, [open, tab, snap.refreshTick, snap.unreadCanLoadMore]);

  const all = snap.screenList || [];
  // Unread LISTS what was unread while the sheet has been open (polish #7,
  // useHeldUnread); its count and Mark all read follow what still is.
  const held = useHeldUnread(open, all);
  const unread = all.filter(held.listed);
  const unreadNow = all.filter((view) => view.unread);
  const messages = all.filter((view) => view.conversation || view.agent);
  // WHAT YOU ARE WORKING ON, from the store that already answers it (#2718
  // review). The Improve panel splits the same list in two — this app's and
  // everywhere else — because it is standing inside an app; the bell is not,
  // so it is one list and every row names its app. No second fetch and no
  // second model: a tab that recomputed "which sessions are live" would be a
  // second answer to a question the platform already answers once.
  const improve = useStoreState(improveStore) as {
    sessions: (SessionRowView & { sortAt?: number })[];
    otherSessions: (SessionRowView & { sortAt?: number })[];
    sessionsLoaded: boolean;
  };
  const agentRows = [...(improve.sessions || []), ...(improve.otherSessions || [])];
  const rows = tab === 'unread' ? unread
    : tab === 'messages' ? messages : all;
  // What the tab DRAWS. On Unread expanded (#4700) the older rows — the read
  // ones already in hand, plus any further page the server still has — show
  // UNDER the unread ones, on the same tab. `rows` stays the tab's own filter:
  // the footer's conditions and counts read it, and the list is `shown`.
  const shown = tab === 'unread' && olderShown ? all : rows;
  // #2815: the Messages tab interleaves the sessions with its notification
  // rows by time, one list, newest first — the order the Messages screen's
  // chats section keeps. Stable sort, so a tie keeps notifications first.
  const messageEntries: MessagesEntry[] = tab === 'messages'
    ? [
      ...messages.map((view): MessagesEntry => (
        { type: 'notif', key: `n:${view.id}`, at: view.createdAtMs || 0, view })),
      ...agentRows.map((session): MessagesEntry => (
        { type: 'session', key: `s:${session.key}`, at: session.sortAt || 0, session })),
    ].sort((a, b) => b.at - a.at)
    : [];
  // The tab counts NOTIFICATIONS, not rows. A collapsed conversation row
  // stands for `count` of them, so summing is what keeps this number equal to
  // the one on the bell — after collapsing, `unread.length` would say 1 where
  // the badge says 4.
  const unreadCount = unreadNow.reduce((sum, view) => sum + (view.count || 1), 0);
  const boundary = startOfToday();
  const entries: MessagesEntry[] = tab === 'messages' ? messageEntries
    : shown.map((view) => ({ type: 'notif', key: `n:${view.id}`, at: view.createdAtMs || 0, view }));
  const today = entries.filter((entry) => entry.at >= boundary);
  const earlier = entries.filter((entry) => entry.at < boundary);
  // #5405: the query narrows what the open tab already drew — the same
  // `entries`, notifications and sessions both. Whitespace-only is no query
  // at all. While it is active the headings, the pinned sections and the
  // pager footers step aside, and the empty state is the search one.
  const needle = normalizeNotificationQuery(query);
  const searching = !!needle;
  const matches = searching
    ? entries.filter((entry) => matchesNotificationQuery(entry, needle))
    : entries;
  // #5406: on Unread in its collapsed state — the one the sheet opens in, and
  // the list you are trying to empty — the rows group under one heading per
  // app, with that app's "Mark read" beside it, instead of under Today and
  // Earlier. Unread only: Messages and All keep the time-grouped flat list,
  // and once the older rows are revealed on Unread the tab is the archive
  // again, so it draws Today/Earlier as it always did. `unread` is feed
  // order (newest first), so groupUnreadByApp's insertion order keeps the
  // groups newest-first too.
  const groupedUnread = tab === 'unread' && !olderShown;
  const appGroups = groupedUnread ? groupUnreadByApp(unread) : [];
  const renderAppGroup = (group: AppGroup): ReactNode => (
    <Fragment key={group.key}>
      <AppGroupHead
        groupKey={group.key}
        label={group.key === 'other' || !group.appLine ? t('notifications:sheet.group.other') : group.appLine}
        // N6 (polish board): with one group on the tab its Mark read is Mark
        // all read again, a pill's width apart, so the title row's is the one.
        appId={appGroups.length > 1 ? group.appId : null}
        onRead={() => held.release(group.entries.flatMap((entry) => (entry.type === 'notif' ? [entry.view.id] : [])))}
      />
      {group.entries.map(renderEntry)}
    </Fragment>
  );
  const renderEntry = (entry: MessagesEntry): ReactNode => (entry.type === 'session' ? (
    // The same <SessionRow> the Improve panel and then the Agents tab drew,
    // so a session reads the same wherever you meet it and its busy /
    // awaiting-input state cannot say two different things in two places.
    // `showApp` because the bell is the platform's, not one app's.
    <SessionRow
      key={entry.key}
      session={entry.session}
      showApp
      onNavigate={() => { NotificationsSheet.close?.(); }}
    />
  ) : (
    <ScreenRow
      key={entry.key}
      view={entry.view}
      touch={!!snap.touch}
      removes={tab === 'unread'}
      held={tab === 'unread' && !entry.view.unread && !olderShown}
      onRelease={held.release}
    />
  ));

  // `whitespace-nowrap`: "Unread (12)" is two words and the strip is a flex
  // row inside a phone-width sheet, so the count wrapped onto a second line
  // and the tab grew a line taller than its neighbours. The label is a label —
  // it does not wrap, it just takes the width it needs.
  // The chip rail (see @/components/ui/chip.tsx for the idiom): selection
  // is the language's solid inversion, not an underline or the accent.
  const tabCls = (active: boolean) =>
    'shrink-0 whitespace-nowrap h-9 px-4 rounded-full text-sm font-semibold transition-colors '
    + (active
      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
      : 'bg-white text-zinc-900 hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800');

  return (
    <>
      {/* The overlay is the WEB presentation's dim. Adopted into a kit sheet
          the kit's own backdrop owns it — see lib/sheet-controller.js. */}
      <div
        id="notifications-sheet-overlay"
        aria-hidden="true"
        {...(open && !adopted ? { 'data-open': '' } : {})}
        className="fixed inset-0 z-40"
        onClick={() => NotificationsSheet.close()}
      >
      </div>
      <div
        id="notifications-sheet"
        role="dialog"
        aria-label={t('notifications:sheet.title')}
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className={'fixed z-50 flex flex-col dc-lift dc-lift-panel nav-sheet-transition'}
      >
      {/*
          THE SHEET RISES ON THE LIFT a dev session does — the same radius,
          hairline and two-layer shadow — on `.dc-lift-panel`, which is that
          glass plus a third shadow layer: the modal dim, cast OUTWARD by this
          element instead of painted behind it.

          That inversion is the whole of why the sheet stopped looking dull.
          The dim used to live on #notifications-sheet-overlay at `z-40`, under
          the sheet at `z-50` — and `backdrop-filter` samples whatever is
          painted behind, so the glass was frosting an already-dimmed page and
          composited to #cac7c3. An OUTER box-shadow is clipped to outside the
          border box, so it never enters this element's own backdrop: the sheet
          frosts the undimmed page while the same declaration darkens
          everything around it. The overlay is still there and still dismisses
          on click; it just paints nothing now.

          On top of that surface: a title row of its own — the name, Mark all
          read as a small pill (only on Unread, the tab whose list it empties),
          and the close disc. The tabs under it are the chip rail.
      */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-1 shrink-0">
        <h2 className="flex-1 min-w-0 truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {t('notifications:sheet.title')}
        </h2>
        {tab === 'unread' ? (
          <button
            id="notifications-screen-mark-all"
            type="button"
            className={'inline-flex items-center h-8 px-3 rounded-full text-xs font-semibold '
              + 'bg-zinc-100 text-zinc-900 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-100 dark:hover:bg-zinc-700 '
              + 'disabled:opacity-40 disabled:hover:bg-zinc-100 dark:disabled:hover:bg-zinc-800 un-touch-target'}
            disabled={!unreadNow.length}
            onClick={() => {
              held.release(unread.map((view) => view.id));
              void controller()?.markAllRead();
            }}
          >
            {t('notifications:sheet.markAllRead')}
          </button>
        ) : null}
        <button
          id="notifications-sheet-close"
          type="button"
          className={'flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-zinc-900 shadow-sm '
            + 'hover:bg-zinc-50 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 un-touch-target'}
          aria-label={t('core:common.close')}
          onClick={() => NotificationsSheet.close()}
        >
          <XIcon className="w-5 h-5" />
        </button>
      </div>
      {/*
          #5405: the search field, between the title and the tab strip — the
          Discover field's shape (browse-screen.tsx): a white rounded field,
          a magnifying glass on its left, grey hint text, filtering as you
          type with no button to press. Escape with text in it empties the
          field instead of reaching whatever else would hear it; an empty
          field's Escape is not intercepted.
      */}
      <div id="notifications-search" className="px-4 pt-1 pb-2 shrink-0">
        <div className="relative">
          <SearchIcon
            className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none dark:text-zinc-400"
            aria-hidden="true"
          />
          <input
            id="notifications-search-input"
            type="search"
            value={query}
            onChange={(event) => rememberQuery(event.currentTarget.value.slice(0, 100))}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && event.currentTarget.value) {
                event.preventDefault();
                event.stopPropagation();
                rememberQuery('');
              }
            }}
            placeholder={t('notifications:sheet.search.placeholder')}
            aria-label={t('notifications:sheet.search.placeholder')}
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="search"
            className="w-full rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 pl-9 pr-3 py-2 text-sm text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 focus:outline-none focus:border-violet-400 dark:focus:border-violet-600"
          />
        </div>
      </div>
      <div
        id="notifications-screen-tabs"
        className={'flex gap-2 px-4 pt-1 pb-2 shrink-0 overflow-x-auto '
          + '[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'}
        role="tablist"
        aria-label={t('notifications:sheet.filters')}
      >
        <button
          id="notifications-tab-unread"
          role="tab"
          aria-selected={tab === 'unread'}
          className={tabCls(tab === 'unread')}
          onClick={() => setTab('unread')}
        >
          {unreadCount ? t('notifications:sheet.tab.unreadCount', { count: unreadCount }) : t('notifications:sheet.tab.unread')}
        </button>
        {/*
            Messages, SECOND. One place to catch up on conversations regardless
            of how busy the rest of the feed is: a message sinks fast in a flat
            chronological list that also carries every session, proposal and
            kudos notification, and it is the one kind you answer rather than
            just read. It sits next to Unread because both are filters on what
            still wants something from you; All is the archive behind them.
            Agents are in it too (#2815), as they are on the Messages screen:
            there is no separate Agents tab.
        */}
        <button
          id="notifications-tab-messages"
          role="tab"
          aria-selected={tab === 'messages'}
          className={tabCls(tab === 'messages')}
          onClick={() => setTab('messages')}
        >
          {t('notifications:sheet.tab.messages')}
        </button>
        <button
          id="notifications-tab-all"
          role="tab"
          aria-selected={tab === 'all'}
          className={tabCls(tab === 'all')}
          onClick={() => setTab('all')}
        >
          {t('notifications:sheet.tab.all')}
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
          top ~450px of the sheet (`max-h-64` and `max-h-48`), which is most of a
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
          "Mark all read" lives in the title row above (see the comment on
          the sheet root), as a small pill between the name and the close
          disc.

          It once sat at the far right of the tab row, in tab-sized ink on
          the same baseline as All / Unread / Messages, which made a control
          that CHANGES data look like a fourth place to go; then under the
          rail as a text button. The title-row pill keeps the point of both
          moves — it shares no baseline and no shape with the chips, so it
          cannot be read as a tab — and it still exists only on Unread,
          because "mark all read" while looking at All or at Messages is an
          offer to act on rows you are not being shown. It is rendered even
          with nothing unread (disabled), so the row does not reflow the
          first time you clear the list.
      */}
      {searching ? null : tab === 'messages' ? (
        <button
          id="notifications-all-messages"
          type="button"
          className={'notifications-row w-full text-left px-4 py-3.5 '
            + 'hover:bg-black/[.03] dark:hover:bg-white/[.04] transition-colors flex items-center gap-4 '
            + 'text-sm font-semibold text-violet-700 dark:text-violet-400'}
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
            {t('notifications:sheet.allMessages')}
          </span>
          <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
        </button>
      ) : (
        <NotificationsPinnedSections />
      )}
      {/* #5405: while searching the list is ONLY the matches — no headings,
          no pager — and a query with no matches gets one line saying so. */}
      {searching ? (
        matches.length ? matches.map(renderEntry) : (
          <p id="notifications-search-empty" className="px-4 py-8 text-sm text-zinc-500 dark:text-zinc-500 text-center">
            {t('notifications:sheet.search.noMatches', { query: query.trim() })}
          </p>
        )
      ) : null}
      {!searching && (groupedUnread ? appGroups.map(renderAppGroup) : (
        <>
          {today.length ? (
            <>
              <SectionHead>
                {t('notifications:sheet.today')}
              </SectionHead>
              {today.map(renderEntry)}
            </>
          ) : null}
          {earlier.length ? (
            <>
              <SectionHead>
                {t('notifications:sheet.earlier')}
              </SectionHead>
              {earlier.map(renderEntry)}
            </>
          ) : null}
        </>
      ))}
      {!searching && !entries.length ? (
        <p className="px-4 py-8 text-sm text-zinc-500 text-center">
          {tab === 'unread' ? t('notifications:sheet.empty.unread') : t('notifications:sheet.empty.other')}
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

          On UNREAD it shows the older rows IN PLACE (#4700), where it used to
          be the All tab. Paging Unread still cannot mean "more of the thing
          you are trying to get to zero" — the older rows are mostly read, and
          that is exactly why they now show UNDER the unread ones instead of
          somewhere else. The collapsed footer reveals them, walking the same
          loadOlder cursor the All tab's pager uses (a no-op on its own when
          every loaded row is already in hand); once they are showing the
          button reads "Hide older notifications" and collapses the list back
          to just the unread ones, and a further page offers the ordinary
          pager above it.

          On ALL it is the loader it always was.

          Either way it renders only when there IS something more: rows this
          filter is hiding, or another page on the server. An empty Unread tab
          on a quiet account would otherwise offer a link to an equally empty
          All, which is a dead end dressed as a way forward.
      */}
      {searching ? null : (tab === 'messages' && snap.messagesCanLoadMore ? (
        <div className="px-4 py-3">
          <button
            id="notifications-see-older-messages"
            type="button"
            className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
            disabled={snap.loadingOlderMessages}
            onClick={() => controller()?.loadOlderMessages()}
          >
            {snap.loadingOlderMessages ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.messages')}
          </button>
        </div>
      ) : tab === 'messages' && (all.length > rows.length || snap.screenCanLoadMore) ? (
        <div className="px-4 py-3">
          <button
            id="notifications-see-older"
            type="button"
            className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline"
            onClick={() => setTab('all')}
          >
            {t('notifications:sheet.older.showAll')}
          </button>
        </div>
      ) : tab === 'unread' && !olderShown ? (
        <>
          {/* #5527: the bell's number, completed. The badge counts every
              unread row on the account; the sheet's first page holds only the
              unread among the newest 100 fetched, so a backlog read as
              "Unread (46)" over a list of 1. Opening auto-fills up to five
              batches (the effect above); this is what anything still deeper
              waits behind — it pages `?unread=1`, the exact set the badge
              counts, until the tab is as long as the bell. */}
          {snap.unreadCanLoadMore ? (
            <div className="px-4 py-3">
              <button
                id="notifications-load-unread"
                type="button"
                className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
                disabled={snap.loadingUnread}
                onClick={() => controller()?.loadMoreUnread()}
              >
                {snap.loadingUnread ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.unread')}
              </button>
            </div>
          ) : null}
          {(all.length > unread.length || snap.screenCanLoadMore) ? (
            <div className="px-4 py-3">
              <button
                id="notifications-see-older"
                type="button"
                className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
                disabled={snap.loadingMore}
                onClick={() => {
                  setOlderShown(true);
                  controller()?.loadOlder();
                }}
              >
                {snap.loadingMore ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.reveal')}
              </button>
            </div>
          ) : null}
        </>
      ) : tab === 'unread' && olderShown && (all.length > unread.length || snap.screenCanLoadMore) ? (
        <>
          {snap.screenCanLoadMore ? (
            <div className="px-4 py-3">
              <button
                id="notifications-load-older"
                type="button"
                className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
                disabled={snap.loadingMore}
                onClick={() => controller()?.loadOlder()}
              >
                {snap.loadingMore ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.load')}
              </button>
            </div>
          ) : null}
          <div className="px-4 py-3">
            <button
              id="notifications-hide-older"
              type="button"
              className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline"
              onClick={() => setOlderShown(false)}
            >
              {t('notifications:sheet.older.hide')}
            </button>
          </div>
        </>
      ) : tab === 'all' && snap.screenCanLoadMore ? (
        <div className="px-4 py-3">
          <button
            id="notifications-load-older"
            type="button"
            className="w-full text-center text-sm font-semibold text-violet-700 dark:text-violet-400 hover:underline disabled:opacity-40"
            disabled={snap.loadingMore}
            onClick={() => controller()?.loadOlder()}
          >
            {snap.loadingMore ? t('notifications:sheet.older.loading') : t('notifications:sheet.older.load')}
          </button>
        </div>
      ) : null)}
      </div>
      </div>
      <OverlayScrim panelId="notifications-sheet" backdropId="notifications-sheet-overlay" />
    </>
  );
}
