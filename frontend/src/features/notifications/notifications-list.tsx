/**
 * The pinned Saved + Invites sections of the Notifications screen — what is
 * left of the bell drawer's contents (#1191 slice 6, conversion 2) after the
 * Streamlined Concept moved the notification list to its own screen. The
 * history below is kept because the descriptor seam it explains still holds.
 *
 * ── What changed, and what deliberately did not ────────────────────────
 *
 * ./notifications.js used to build all three by `innerHTML` and then wire the
 * handlers back on with four `querySelectorAll` sweeps. It now computes a
 * descriptor tree (`rowView` / `savedView` / `inviteView`) and pushes it into
 * ./notifications-store.js; this file is the only writer of the DOM below
 * #notifications-saved and #notifications-invites. (The rows themselves are
 * ./notifications-screen.tsx's — see the header note above.)
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
 * The `Row` component this file used to export as `NotificationRow` went to
 * the screen with the list it drew; what is left here is the two PINNED
 * sections, which have their own row shapes.
 *
 * ── stopPropagation, everywhere ────────────────────────────────────────
 *
 * Every handler here stops the click. That is not defensive habit: each of
 * these actions re-renders its section, React unmounts the clicked node
 * before the event finishes bubbling, and any document-level outside-click
 * handler would then see a target outside the surface and dismiss it under
 * the user. This is the same reason the imperative version passed
 * `e.stopPropagation()` to all four sweeps.
 *
 * ── Initial render ─────────────────────────────────────────────────────
 *
 * `saved: null` / `invites: null` render nothing, which is exactly the markup
 * the hand-written shell shipped. The SSG pass in
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
  /** The app the message was posted in — '' for a conversation save. */
  slug: string;
  /**
   * The conversation it was posted in — 0 for an app-chat save. Exactly one
   * of this and `slug` is set, and which one is what the controller routes
   * and unsaves on; the row itself renders both kinds identically.
   */
  conversationId: number;
  who: string;
  /** Where it was said: the app's name, or the conversation's. */
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
          <BookmarkSolidIcon aria-hidden="true" className="inline-block w-3 h-3 align-middle text-violet-700 dark:text-violet-400" />
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


/**
 * The pinned Saved + Invites sections (Streamlined Concept).
 *
 * They rendered at the top of the drawer's notifications block while the
 * list lived there; the list is the full-screen Notifications view now
 * (./notifications-screen.tsx renders its own rows), and these two sections
 * moved WITH the surface — same ids, same markup, new parent. The plain
 * notification rows that used to follow them (`Row`, its meta/body
 * renderers and the drawer's pager/caught-up/empty chrome) were deleted in
 * the same change: the screen renders richer rows of its own from the same
 * descriptors, and a second renderer with no consumer is exactly the
 * duplication #1191 slice 6 existed to end.
 */
export function NotificationsPinnedSections(): ReactNode {
  const state = useStoreState(notificationsStore) as {
    saved: SavedView[] | null;
    invites: InviteView[] | null;
    touch: boolean;
  };
  const saved = state.saved || [];
  const invites = state.invites || [];

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
          Pinned collaborator-invites section: rendered above the notification
          rows, driven by the authoritative pendingInvites payload (see
          ./notifications.js _renderInvites).
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
    </>
  );
}
