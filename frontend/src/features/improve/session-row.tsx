/**
 * A row — the compact shape the cog drawer used, minus the app column.
 *
 * Extracted from improve-panel.tsx (Streamlined Concept) because the surface
 * that renders it moved: the app-context sheet's "Changes in progress" /
 * "Changes in other apps" lists. One row, one implementation — the same rule
 * that unified the notification rows in #1191 slice 6.
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
};

export function SessionRow({
  session,
  showApp,
  onNavigate,
}: {
  session: SessionRowView;
  showApp: boolean;
  onNavigate: () => void;
}) {
  return (
    <a
      href={session.href}
      data-improve-row={session.kind}
      className="flex items-center gap-2 px-4 min-h-[44px] text-left hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
      onClick={onNavigate}
    >
      {/* The busy dot is the whole reason a session row is worth scanning:
          it says an AI turn is in flight right now. Pulsing only while busy —
          a static dot on every row would say nothing.

          A work order is never busy: its agent runs on the user's own machine,
          where the platform cannot see whether a turn is in flight. It gets
          the idle dot, hollow rather than filled, so the row reads as "handed
          off, state unknown here" instead of borrowing a liveness claim this
          side has no way to make. */}
      <span
        className={
          session.busy
            ? 'w-2 h-2 rounded-full bg-emerald-500 shrink-0 animate-pulse'
            : session.kind === 'task'
              ? 'w-2 h-2 rounded-full border border-zinc-400 dark:border-zinc-500 shrink-0'
              : 'w-2 h-2 rounded-full bg-zinc-300 dark:bg-zinc-600 shrink-0'
        }
        aria-hidden="true"
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
    </a>
  );
}
