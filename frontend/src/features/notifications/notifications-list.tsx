/**
 * The bell drawer's contents — the pinned invites section, the flat
 * notification list and the empty hint (#1191 slice 6, conversion 2).
 *
 * ── What changed, and what deliberately did not ────────────────────────
 *
 * ./notifications.js used to build all three by `innerHTML` and then wire the
 * handlers back on with four `querySelectorAll` sweeps. It now computes a
 * descriptor tree (`rowView` / `groupView` / `inviteView`) and pushes it into
 * ./notifications-store.js; this file is the only writer of the DOM below
 * #notifications-invites and #notifications-list.
 *
 * The markup is like-for-like: same class strings, same `data-notif-id` /
 * `data-invite-app` attributes. They stay because they are how the rows were
 * addressed.
 *
 * ── The list is flat (#1385) ───────────────────────────────────────────
 *
 * `Group` and its `data-group-toggle` / `data-group-markread` /
 * `data-group-showmore` chrome are gone, and so is the heavier between-apps
 * divider that separated one app's entry from the next: with rows interleaved
 * in arrival order there are no app runs left for it to sit between, and every
 * row already carries its own `border-b`. `list` is now a flat array of row
 * descriptors — see ./notifications-store.js.
 *
 * What replaced the per-group "Show more" is one pager at the FOOT of the list.
 * It is not the same control moved: the group one revealed already-fetched
 * leaves that the collapsed header was hiding, and only reached the network
 * once it ran out. Nothing is hidden in a flat list, so this one is purely the
 * network call.
 *
 * `Row` is exported as `NotificationRow` because the cog drawer's pinned
 * "Needs attention" section renders these same four session kinds. Conversion
 * 4 converted that host too, and rather than a second renderer it now imports
 * this component and feeds it descriptors from `Notifications._rowView` — one
 * row, one implementation, for the first time since the two drawers split.
 *
 * ── stopPropagation, everywhere ────────────────────────────────────────
 *
 * Every handler here stops the click. That is not defensive habit: the drawer
 * dismisses on a document-level outside click, and each of these actions
 * re-renders the list. React unmounts the clicked node before the event
 * finishes bubbling, so the document handler would see a target that is no
 * longer inside #notifications-panel and close the drawer under the user.
 * This is the same reason the imperative version passed `e.stopPropagation()`
 * to all four sweeps.
 *
 * ── Initial render ─────────────────────────────────────────────────────
 *
 * `invites: null` / `list: null` render nothing and the hint renders `hidden`,
 * which is exactly the markup the hand-written shell shipped. The SSG pass in
 * frontend/scripts/build-shell.mjs prerenders this island in Node, so anything
 * else here would be a hydration mismatch — and a console error on any route
 * fails proposal checks.
 */

import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { BookmarkSolidIcon } from '@/components/ui/icons';

import { useStoreState } from '../../lib/use-store-state';
import { notificationsStore } from './notifications-store.js';

type Segment = { t: 'who' | 'strong' | 'text'; v: string };

export type NotificationRowView = {
  id: number;
  unread: boolean;
  unreadCls: string;
  time: string;
  mb: boolean;
  metaFlex: boolean;
  wrap: boolean;
  icon: string | null;
  segments: Segment[];
  body: { text: string; medium: boolean; mention: boolean } | null;
};

type SavedView = {
  messageId: number;
  slug: string;
  who: string;
  appName: string;
  time: string;
  text: string;
};

type InviteView = {
  appId: number;
  slug: string;
  kind: string;
  icon: string;
  who: string;
  verb: string;
  appName: string;
  time: string;
};

// The controller is a classic-script-shaped global; this island reads it the
// same way app.js does rather than importing it, because ./notifications.js
// must stay import-free (see ./notifications-store.js).
function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Notifications : null) || null;
}

function kit(): any {
  return (typeof window !== 'undefined' ? (window as any).PlatformUI : null) || null;
}

// The widget language's list row (#1191): the hairline between rows is what
// the language keeps — a grouped list IS rows separated by rules — but it sits
// on a white card now rather than under a bordered strip, and the row breathes
// at the language's rhythm.
//
// It does NOT use ListRow from @/components/ui/grouped-list.tsx, and that is
// deliberate rather than pending. A notification row INVERTS the primitive's
// hierarchy: its first line is the small grey meta ("@who · 2h", the group
// name, the unread dot) and the heavier content sits UNDER it, where ListRow
// puts a bold title over a grey subtitle. Passing Meta as `title` would render
// the timestamp at 17px bold and the message underneath it in grey — the
// opposite of what either surface means. Same look, different information
// shape; sharing the classes is not a reason to share the component.
const ROW_CLASS = 'w-full text-left px-4 py-3 border-b border-zinc-200 '
  + 'dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors';

// Unread indicator dot. When unread it's a solid violet dot carrying an
// accessible "Unread" label; when read it's an equal-width invisible spacer so
// read/unread rows stay horizontally aligned (no jitter when a row is marked
// read live).
function UnreadDot({ unread }: { unread: boolean }): ReactNode {
  return unread ? (
    <span
      role="img"
      aria-label="Unread"
      className="inline-block w-2 h-2 rounded-full bg-zinc-900 dark:bg-zinc-100 align-middle mr-1.5 shrink-0"
    >
    </span>
  ) : (
    <span
      aria-hidden="true"
      className="inline-block w-2 h-2 align-middle mr-1.5 shrink-0"
    >
    </span>
  );
}

function metaClass(v: NotificationRowView): string {
  return 'text-xs text-zinc-500 dark:text-zinc-400'
    + (v.mb ? ' mb-1' : '')
    + (v.metaFlex ? ' flex items-center gap-1' : '')
    + (v.wrap ? ' flex-wrap' : '');
}

/**
 * A mention snippet, split on @tokens. The imperative version highlighted them
 * by regex-replacing into an escaped HTML string; splitting the raw text and
 * letting React place the pieces is the same output without the string step.
 */
function mentionParts(text: string): Array<{ text: string; at: boolean }> {
  const out: Array<{ text: string; at: boolean }> = [];
  const re = /(^|[^\w])@([A-Za-z0-9_]{1,32})/g;
  let last = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    out.push({ text: text.slice(last, m.index) + m[1], at: false });
    out.push({ text: `@${m[2]}`, at: true });
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  out.push({ text: text.slice(last), at: false });
  return out.filter((p) => p.text !== '');
}

function Body({ body }: { body: NotificationRowView['body'] }): ReactNode {
  if (!body) return null;
  const cls = 'text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2'
    + (body.medium ? ' font-medium' : '');
  if (!body.mention) return <div className={cls}>{body.text}</div>;
  return (
    <div className={cls}>
      {mentionParts(body.text).map((p, i) => (p.at
        ? <span key={i} className="text-violet-400 font-medium">{p.text}</span>
        : <span key={i}>{p.text}</span>))}
    </div>
  );
}

/**
 * The meta line: unread dot, optional icon, the per-kind segments, the time.
 *
 * Two spacing regimes, both inherited from the string version:
 *  - `metaFlex` rows are a flex row with `gap-1`, so the gap IS the spacing.
 *    The string version joined its pieces with a newline; a flex container
 *    drops whitespace-only text between items, so emitting no separator at all
 *    renders identically.
 *  - the mention/reply row is ordinary inline flow and needs real spaces. They
 *    ride INSIDE the neighbouring string rather than as a separate `{' '}`
 *    child: a whitespace-only expression between two text runs makes them two
 *    adjacent children, which cannot survive hydration (React #418) and is
 *    what tests/shell-build.test.js and the build's own probe both refuse.
 *    That is safe here because a non-flex row's segments always alternate —
 *    two text segments never touch.
 */
function Meta({ view }: { view: NotificationRowView }): ReactNode {
  const flex = view.metaFlex;
  const nodes: ReactNode[] = [<UnreadDot key="dot" unread={view.unread} />];
  if (view.icon) nodes.push(<span key="icon" aria-hidden="true">{view.icon}</span>);
  view.segments.forEach((s, i) => {
    if (s.t === 'who') {
      nodes.push(
        <span key={`s${i}`} className="font-medium text-zinc-800 dark:text-zinc-200">
          {`@${s.v}`}
        </span>,
      );
    } else if (s.t === 'strong') {
      nodes.push(
        <span key={`s${i}`} className="font-medium text-zinc-700 dark:text-zinc-300">{s.v}</span>,
      );
    } else if (flex) {
      nodes.push(<span key={`s${i}`}>{s.v}</span>);
    } else {
      // Bare text, exactly as the string version left it on this one row.
      nodes.push(` ${s.v} `);
    }
  });
  nodes.push(
    <span key="time" className="text-zinc-500 dark:text-zinc-400">{flex ? `· ${view.time}` : ` · ${view.time}`}</span>,
  );
  return <div className={metaClass(view)}>{nodes}</div>;
}

/**
 * One leaf row. Clicking marks it read and routes (see
 * `Notifications._onItemClick`); on touch it also carries the kit's
 * swipe-to-mark-read tray, which only makes sense while it is unread.
 *
 * Exported as `NotificationRow` for the cog drawer, which renders the four
 * session kinds through this very component. It passes `touch={false}`: the
 * HTML flavour this replaced carried no swipe tray, and the drawer's rows sit
 * inside a kit bottom sheet on touch, where a second horizontal gesture would
 * fight the sheet's own.
 */
function Row({ view, touch }: { view: NotificationRowView; touch: boolean }): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const ui = kit();
    if (!touch || !el || !ui?.swipeActions || !view.unread) return;
    ui.swipeActions(el, {
      actions: [{
        label: 'Mark read',
        handler: () => {
          const N = controller();
          N?._markOneRead(view.id);
          N?._renderList();
        },
      }],
    });
  }, [touch, view.id, view.unread]);

  return (
    <button
      ref={ref}
      data-notif-id={view.id}
      className={`${ROW_CLASS} ${view.unreadCls}`}
      onClick={(e) => {
        e.stopPropagation();
        controller()?._onItemClick(view.id);
      }}
    >
      <Meta view={view} />
      <Body body={view.body} />
    </button>
  );
}

export { Row as NotificationRow };

/**
 * One saved message (#1280). Clicking the body opens the message where it
 * lives; the Unsave button — and, on touch, a swipe action carrying the same
 * thing — is the "or there" half of "until unsaved in the message / there".
 *
 * Unsave is a plain button rather than a second bookmark glyph on purpose:
 * the row is already in a section titled "Saved", so an icon whose meaning
 * depends on remembering which state it represents would be the least
 * readable option available.
 */
function Saved({ view, touch }: { view: SavedView; touch: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const ui = kit();
    if (!touch || !el || !ui?.swipeActions) return;
    ui.swipeActions(el, {
      actions: [{
        label: 'Unsave',
        handler: () => controller()?._unsave(view.messageId),
      }],
    });
  }, [touch, view.messageId]);

  return (
    <div
      ref={ref}
      data-saved-message={view.messageId}
      className="flex items-stretch border-b border-zinc-200 dark:border-zinc-800 bg-violet-500/5 border-l-2 border-l-violet-500"
    >
      <button
        className="flex-1 min-w-0 text-left px-3 py-2.5 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          controller()?._onSavedClick(view.messageId);
        }}
      >
        {/*
            The spaces ride inside the neighbouring strings rather than as
            whitespace-only children — see the note on <Meta> for why.
        */}
        <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1">
          {/* The same mark the message's own save button carries — solid
              here, because everything in this section is saved by
              definition — so the two ends of the gesture read as one
              feature. */}
          <BookmarkSolidIcon aria-hidden="true" className="inline-block w-3 h-3 align-middle text-violet-500" />
          <span className="font-medium text-zinc-800 dark:text-zinc-200">{` ${view.who}`}</span>
          {' in '}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{view.appName}</span>
          <span className="text-zinc-500 dark:text-zinc-400">{` · ${view.time}`}</span>
        </div>
        <div className="text-sm text-zinc-700 dark:text-zinc-300 line-clamp-2">{view.text}</div>
      </button>
      <button
        data-saved-unsave={view.messageId}
        className="shrink-0 text-[0.7rem] text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 px-1.5 py-1"
        onClick={(e) => {
          e.stopPropagation();
          controller()?._unsave(view.messageId);
        }}
      >
        Unsave
      </button>
    </div>
  );
}

/**
 * One pinned invite. On touch the whole row is also a swipe target, with the
 * same two actions the buttons carry — the buttons stay for desktop and as the
 * tap path everywhere.
 */
function Invite({ view, touch }: { view: InviteView; touch: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    const ui = kit();
    if (!touch || !el || !ui?.swipeActions) return;
    ui.swipeActions(el, {
      actions: [
        {
          label: 'Accept',
          handler: () => controller()?._acceptInvite(view.appId, view.slug, view.kind),
        },
        {
          label: 'Decline',
          destructive: true,
          handler: () => controller()?._declineInvite(view.appId, view.kind),
        },
      ],
    });
  }, [touch, view.appId, view.slug, view.kind]);

  return (
    <div
      ref={ref}
      className="px-3 py-2.5 border-b border-zinc-200 dark:border-zinc-800 bg-violet-500/5 border-l-2 border-l-violet-500"
      data-invite-app={view.appId}
    >
      {/*
          The spaces ride inside the neighbouring strings rather than as
          whitespace-only children — see the note on <Meta> for why.
      */}
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mb-1.5">
        <span aria-hidden="true">{view.icon}</span>
        <span className="font-medium text-zinc-800 dark:text-zinc-200">{` ${view.who}`}</span>
        {` ${view.verb} `}
        <span className="font-medium text-zinc-700 dark:text-zinc-300">{view.appName}</span>
        <span className="text-zinc-500 dark:text-zinc-400">{` · ${view.time}`}</span>
      </div>
      <div className="flex gap-2">
        <Button
          data-invite-accept={view.appId}
          data-invite-slug={view.slug}
          data-invite-kind={view.kind}
          variant="pill"
          size="xsText"
          onClick={(e) => {
            e.stopPropagation();
            controller()?._acceptInvite(view.appId, view.slug, view.kind);
          }}
        >
          Accept
        </Button>
        <button
          data-invite-decline={view.appId}
          data-invite-kind={view.kind}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-xs font-medium text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            controller()?._declineInvite(view.appId, view.kind);
          }}
        >
          Decline
        </button>
      </div>
    </div>
  );
}


export function NotificationsBody(): ReactNode {
  const state = useStoreState(notificationsStore) as {
    saved: SavedView[] | null;
    invites: InviteView[] | null;
    list: NotificationRowView[] | null;
    empty: boolean;
    caughtUp: boolean;
    olderCount: number;
    showOlder: boolean;
    canLoadMore: boolean;
    loadingMore: boolean;
    touch: boolean;
  };
  const saved = state.saved || [];
  const invites = state.invites || [];
  const rows = state.list || [];

  return (
    <>
      {/*
          #1280: the pinned saved-messages section, above everything else —
          "a top section of notifications". Its own scroller with a cap, for
          the same reason the invites section below has one: a long list of
          saves must not push the notifications themselves off the screen.
      */}
      <div id="notifications-saved" className="shrink-0 overflow-y-auto max-h-48">
        {saved.length ? (
          <div className="px-3 py-1.5 text-[0.7rem] font-semibold text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
            Saved
          </div>
        ) : null}
        {saved.map((s) => (
          <Saved key={s.messageId} view={s} touch={state.touch} />
        ))}
      </div>
      {/*
          Pinned collaborator-invites section: rendered above the grouped
          notification list, driven by the authoritative pendingInvites
          payload (see ./notifications.js _renderInvites).
      */}
      <div id="notifications-invites" className="shrink-0 overflow-y-auto max-h-48">
        {invites.length ? (
          <div className="px-3 py-1.5 text-[0.7rem] font-semibold text-zinc-500 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800">
            Invites
          </div>
        ) : null}
        {invites.map((inv) => (
          <Invite key={`${inv.kind}:${inv.appId}`} view={inv} touch={state.touch} />
        ))}
      </div>
      <div id="notifications-list" className="flex-1 overflow-y-auto">
        {rows.map((row) => (
          <Row key={row.id} view={row} touch={state.touch} />
        ))}
        {/*
            The foot pager (#1385). It sits INSIDE the scroller, after the last
            row, because it is the end of the list rather than drawer chrome —
            unlike #notifications-older-toggle below, which is pinned under the
            scroller and toggles a filter over what is already in hand.
        */}
        {state.canLoadMore ? (
          <button
            id="notifications-load-more"
            type="button"
            disabled={state.loadingMore}
            className="w-full text-left px-3 py-2 text-xs text-violet-500 hover:text-violet-400 disabled:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800"
            onClick={(e) => {
              // Same reason every other handler in this file stops the click:
              // the re-render detaches this node, and the document-level
              // outside-click handler would then dismiss the drawer.
              e.stopPropagation();
              controller()?.loadOlder();
            }}
          >
            {state.loadingMore ? 'Loading…' : 'Load older notifications →'}
          </button>
        ) : null}
      </div>
      {/*
          CAUGHT UP (#1367 follow-up) — nothing unread, but there is history.

          Deliberately a different node and a different sentence from
          #notifications-empty below. That one means "you have never had a
          notification"; this one means "you have dealt with all of them", and
          showing the first to somebody with a month of history reads as the
          drawer having lost it. Only one is ever visible: the store sets
          `empty` only when `olderCount` is 0.
      */}
      <div
        id="notifications-caught-up"
        className={state.caughtUp
          ? 'px-4 py-6 text-sm text-zinc-500 text-center'
          : 'hidden px-4 py-6 text-sm text-zinc-500 text-center'}
      >
        You&rsquo;re all caught up — no new notifications.
      </div>
      {/*
          The footer toggle. Rendered only when there is something behind it,
          so a first-time viewer never sees an "older" button that reveals
          nothing. The count is on the reveal and not on the hide, because
          "See 12 older" answers "is it worth tapping?" while "Hide older"
          only has to undo it.
      */}
      {state.olderCount > 0 ? (
        <button
          id="notifications-older-toggle"
          type="button"
          className="shrink-0 w-full px-4 py-2.5 text-xs font-medium text-violet-600 dark:text-violet-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 border-t border-zinc-200 dark:border-zinc-800 transition-colors"
          aria-expanded={state.showOlder ? 'true' : 'false'}
          onClick={() => controller()?.toggleOlder()}
        >
          {state.showOlder
            ? 'Hide older notifications'
            : `See ${state.olderCount} older notification${state.olderCount === 1 ? '' : 's'}`}
        </button>
      ) : null}
      <div
        id="notifications-empty"
        className={state.empty
          ? 'px-4 py-6 text-sm text-zinc-500 text-center'
          : 'hidden px-4 py-6 text-sm text-zinc-500 text-center'}
      >
        You'll get pinged here when someone proposes a change to an app you use.
      </div>
    </>
  );
}
