/**
 * A row — the compact shape the cog drawer used, minus the app column.
 *
 * Extracted from improve-panel.tsx (Streamlined Concept) for the app-context
 * sheet's "Changes in progress" / "Changes in other apps" lists. One row,
 * one implementation — the same rule that unified the notification rows in
 * #1191 slice 6.
 *
 * The Figma board's change row reads: [busy dot] title … relative time,
 * unread dot, chevron. The unread dot means "a session-kind notification
 * about this change is unread" and comes from the notifications store's
 * `sessionUnreadIds` (published by Notifications._renderBadge), so it clears
 * live when the notification is read anywhere.
 *
 * Serves both kinds (#1417). The destination arrives on the row as `href`
 * rather than being built here from an id: a session's id addresses a session
 * page, a work order's addresses nothing the browser can open, and a
 * component that assumed the first would send every task row to a 404.
 *
 * `onNavigate` is the host surface's own dismissal (AppContext.dismissForNav):
 * a row that navigates has to take its modal host down first, and only the
 * host knows which sheet that is.
 */


import { useStoreState } from '../../lib/use-store-state';
import { notificationsStore } from '../notifications/notifications-store.js';

export type SessionRowView = {
  key: string;
  kind: 'session' | 'task';
  id: number;
  appSlug: string | null;
  appName: string;
  title: string;
  href: string;
  status: string | null;
  /** Semantic state, decided in improve-controller.js — never re-derived
      from `status`, which is display copy. */
  state?: 'working' | 'needs-you' | 'paused' | 'ready' | 'handed-off';
  busy: boolean;
  lastActivityAt?: string | null;
};

/** Compact relative time — same buckets as the home grid's helper. */
function relTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const seconds = Math.floor((Date.now() - t) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 86400 * 30) return `${Math.floor(seconds / 86400)}d ago`;
  return `${Math.floor(seconds / (86400 * 30))}mo ago`;
}

export function SessionRow({
  session,
  showApp,
  onNavigate,
}: {
  session: SessionRowView;
  showApp: boolean;
  onNavigate: () => void;
}) {
  const { sessionUnreadIds } = useStoreState(notificationsStore) as {
    sessionUnreadIds: number[];
  };
  const unread = sessionUnreadIds.includes(session.id);
  const time = relTime(session.lastActivityAt);

  return (
    <a
      href={session.href}
      data-improve-row={session.kind}
      className="flex items-center gap-2 px-4 min-h-[44px] text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
      onClick={onNavigate}
    >
      {/*
          THE STATE DOT (owner review) — the reason a change row is worth
          scanning, so it is bright and big enough to find at a glance rather
          than a grey speck.

          It wears the BRAND GRADIENTS at full vibrancy (the four radials from
          the Brand Kit's node 503-20261, the same ones the app tiles carry as
          a whisper). This is the one surface where they are allowed to shout:
          a change's state is exactly the kind of thing a brand's own colour
          language should say, and at 14px a three-stop radial reads as a
          luminous orb rather than a flat dot. Each state's glow is its own
          gradient's key hue — see .improve-state-dot in app.css.

            working    sky      + a breathing animation (the core swells)
            needs-you  sunset   the loudest of the four, for the one state
                                that wants you now
            ready      meadow   green means it is back with you
            paused     lemon    parked, not gone

          Yellow-the-action is not in play here: these are multi-hue gradient
          orbs, not the flat CTA fill, and the row carries no button.

          A work order (#1417) is never busy: its agent runs on the user's own
          machine, where the platform cannot see whether a turn is in flight.
          It keeps the HOLLOW dot — no gradient, nothing to animate — so the
          row reads as "handed off, state unknown here" instead of borrowing a
          liveness claim this side has no way to make.

          Announced exactly once: the dot carries the label only when the row
          renders no status text of its own.
      */}
      <span
        className={
          session.kind === 'task'
            ? 'w-3.5 h-3.5 rounded-full border border-zinc-400 dark:border-zinc-500 shrink-0'
            : `improve-state-dot improve-state-dot--${session.state || (session.busy ? 'working' : 'ready')} w-3.5 h-3.5 rounded-full shrink-0`
        }
        {...(session.status
          ? { 'aria-hidden': 'true' as const }
          : { role: 'img', 'aria-label': 'Ready for you' })}
      />
      {showApp ? (
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-300 shrink-0 max-w-[35%] truncate">
          {session.appName}
        </span>
      ) : null}
      <span className="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">
        {session.title}
      </span>
      {session.status ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-300 shrink-0">
          {session.status}
        </span>
      ) : null}
      {time ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-300 shrink-0">
          {time}
        </span>
      ) : null}
      {unread ? (
        <span
          className="w-2 h-2 rounded-full bg-azure-500 shrink-0"
          role="img"
          aria-label="Unread activity"
          data-session-unread={session.id}
        />
      ) : null}
      {/* NO CHEVRON. The whole row is an anchor and the status dot already
          says this is a live thing you can open; an affordance glyph on every
          row only bought a redundant hint, and it bought it with the width a
          change's TITLE needs — which is the one part of the row a reader
          actually has to read. */}
    </a>
  );
}
