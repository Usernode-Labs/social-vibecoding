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

import { ChevronRightIcon } from '@/components/ui/icons';

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

          Two states for a session, because with paused rows filtered out of
          these lists (see isParked in ../improve/improve-controller.js) two
          is all there is: AMBER PULSING while an AI turn is in flight — the
          platform's own "something is building" colour, borrowed from the
          header's deploy dot — and SOLID EMERALD once it stops, which is the
          success green that says the change is back with you. The halo ring
          is what makes either readable against a busy row at arm's length.

          A work order (#1417) is never busy: its agent runs on the user's
          own machine, where the platform cannot see whether a turn is in
          flight. It keeps the HOLLOW dot, so the row reads as "handed off,
          state unknown here" instead of borrowing a liveness claim this side
          has no way to make.

          Announced exactly once: the dot carries the label only when the row
          renders no status text of its own.
      */}
      <span
        className={
          session.busy
            ? 'w-2.5 h-2.5 rounded-full bg-amber-400 ring-2 ring-amber-400/30 shrink-0 animate-pulse'
            : session.kind === 'task'
              ? 'w-2.5 h-2.5 rounded-full border border-zinc-400 dark:border-zinc-500 shrink-0'
              : 'w-2.5 h-2.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/25 shrink-0'
        }
        {...(session.status
          ? { 'aria-hidden': 'true' as const }
          : { role: 'img', 'aria-label': 'Ready for you' })}
      />
      {showApp ? (
        <span className="text-xs font-medium text-zinc-500 dark:text-zinc-400 shrink-0 max-w-[35%] truncate">
          {session.appName}
        </span>
      ) : null}
      <span className="text-sm text-zinc-800 dark:text-zinc-200 flex-1 min-w-0 truncate">
        {session.title}
      </span>
      {session.status ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
          {session.status}
        </span>
      ) : null}
      {time ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400 shrink-0">
          {time}
        </span>
      ) : null}
      {unread ? (
        <span
          className="w-2 h-2 rounded-full bg-violet-500 shrink-0"
          role="img"
          aria-label="Unread activity"
          data-session-unread={session.id}
        />
      ) : null}
      <ChevronRightIcon className="w-4 h-4 shrink-0 text-zinc-400 dark:text-zinc-500" />
    </a>
  );
}
