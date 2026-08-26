/**
 * `#notifications-panel` — the bell's surface, back as its own sheet (#1436).
 *
 * ── What moved, and what deliberately did not ──────────────────────────
 *
 * The MARKUP moved out of the hamburger verbatim: the same header row, the
 * same `#notifications-mark-all` button, the same `<NotificationsBody/>`. The
 * DATA did not move at all — ./notifications-store.js still owns the rows and
 * the unread counts, ./notifications.js still drives them, and
 * `Notifications._renderBadge` still paints `#notifications-badge`. The ids
 * are the ones the overhaul retired, un-retired rather than respelled, which
 * is what makes that true.
 *
 * ── Why the list scrolls and the chrome does not ───────────────────────
 *
 * Kept exactly as the drawer had it, and for the reason recorded there: the
 * saved and invites sections are capped at `max-h-48` EACH, so on a short
 * viewport those two caps alone can eat the whole block and leave the list at
 * zero height — the notifications themselves, invisible, in the notifications
 * panel. One scroller over all three lets them share the space in the order
 * they are written. So `#notifications-body-scroll` is the flex child that
 * grows and scrolls; the header above it is `shrink-0`.
 *
 * ── First render is the prerender ──────────────────────────────────────
 *
 * The store ships closed and the list ships empty, so the SSG pass in
 * frontend/scripts/build-shell.mjs emits exactly what hydration produces.
 * `Mark all read` ships `disabled`, as it did in the drawer, because there is
 * nothing to mark until the first fetch lands. Rows arrive from the store,
 * never from the initial render — a mismatch is a console.error, and a console
 * error on any route fails proposal checks.
 *
 * ── Why `data-open` and not `hidden` ───────────────────────────────────
 *
 * The panel is always in the document and translated off-screen, which is what
 * gives the slide a transition to run with no display:none reflow dance for
 * the controller to get right. The native kit writes CLASSES to this node when
 * it adopts it (`.platform-sheet-adopted`), never attributes, so `data-open`
 * is safe to reconcile where `className` would not be — the same split the
 * Improve panel documents.
 */

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { NotificationsBody } from './notifications-list';
import { NotificationsSheet } from './sheet-controller.js';
import { notificationsSheetStore } from './sheet-store.js';
// Installs the store's flush and publishes the controllers. It rode the
// hamburger island while the list lived there; it belongs to whichever island
// renders #notifications-list, which is this one now.
import './mount';

export function NotificationsPanel() {
  const { open } = useStoreState(notificationsSheetStore);
  const close = () => NotificationsSheet.close();

  // A LAYOUT effect, not a passive one: it runs inside main.tsx's
  // flushSync(hydrateRoot), which is before DOMContentLoaded — where the
  // classic script's init() used to run, only earlier still. A passive effect
  // could be scheduled AFTER app.js's init, and `sv:authed` fires at most
  // once, so a late listener would never get the first fetch.
  useIsomorphicLayoutEffect(() => {
    window.Notifications?.init();
    // The list's pull-to-refresh, a kit attachment on a node this island owns.
    // The list is never re-created, so attaching once here — from the same
    // effect as init() — is the contract the bell's original island had. The
    // kit no-ops it on desktop, exactly as before.
    const list = document.getElementById('notifications-list');
    if (list && window.PlatformUI?.pullToRefresh) {
      window.PlatformUI.pullToRefresh(
        list,
        () => window.Notifications?.refresh() ?? Promise.resolve(),
      );
    }
  }, []);

  return (
    <>
      <div
        id="notifications-overlay"
        aria-hidden="true"
        {...(open ? { 'data-open': '' } : {})}
        className="shell-sheet-overlay fixed inset-0 z-40 bg-black/40"
        onClick={close}
      >
      </div>
      <div
        id="notifications-panel"
        role="dialog"
        aria-label="Notifications"
        aria-hidden={open ? undefined : 'true'}
        {...(open ? { 'data-open': '' } : {})}
        className="shell-sheet shell-sheet-transition fixed z-50 flex flex-col bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700 shadow-2xl"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 shrink-0">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Notifications
          </span>
          <span className="flex-1">
          </span>
          {/* Ships disabled and is enabled by Notifications._render once
              there is an unread row — the same contract it had in the
              drawer, same id, same writer. */}
          <button
            id="notifications-mark-all"
            className="text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-40"
            disabled={true}
          >
            Mark all read
          </button>
        </div>
        {/* The one scroller. See the header comment for why it is here and
            not on #notifications-list. */}
        <div id="notifications-body-scroll" className="flex-1 min-h-0 overflow-y-auto">
          <NotificationsBody />
        </div>
      </div>
    </>
  );
}
