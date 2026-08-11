/**
 * #notifications-panel — the bell dropdown, as a React island (#1079 chunk B).
 *
 * The chassis (root, header row, the three leaf containers) is rendered here;
 * everything inside the containers is rendered by ./notifications.js, which is
 * the retired public/js/notifications.js moved into this bundle unchanged. See
 * the note at the top of that file for why it is a move rather than a rewrite.
 *
 * The division of labour is the same one the rest of the shell already has —
 * React renders the container, one module owns its contents — with the
 * difference that the module is now INSIDE the island. No public/js/** file
 * writes into this subtree any more, which is what the migration's "a region
 * may become stateful only when its entire subtree is React-owned" rule is
 * actually asking for.
 *
 * `hidden` on the root is therefore still toggled by notifications.js
 * (show/hide, and the kit's sheet adoption on touch). React never re-renders
 * `className` here — see the note in @/components/ui/anchored-panel.
 */

import { AnchoredPanel, AnchoredPanelHeader } from '@/components/ui/anchored-panel';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import './notifications.js';

export function NotificationsPanel() {
  // A LAYOUT effect, not a passive one: it runs inside main.tsx's
  // flushSync(hydrateRoot), which is before DOMContentLoaded — where the
  // classic script's init() used to run, only earlier still. A passive effect
  // could be scheduled after app.js's init, and `sv:authed` fires at most
  // once, so a late listener would never get the first fetch.
  useIsomorphicLayoutEffect(() => {
    window.Notifications?.init();
    // The list's pull-to-refresh, moved out of App._wirePullToRefresh() with
    // the panel: it is a kit attachment on a node this island owns, and the
    // list is one of the "static full-screen scrollers" only in the sense
    // that it is never re-created — so attaching it once here, from the same
    // effect as init(), is the same contract in the right place. The kit
    // no-ops it on desktop, exactly as before.
    const list = document.getElementById('notifications-list');
    if (list && window.PlatformUI?.pullToRefresh) {
      window.PlatformUI.pullToRefresh(
        list,
        () => window.Notifications?.refresh() ?? Promise.resolve(),
      );
    }
  }, []);

  return (
    <AnchoredPanel id="notifications-panel">
      <AnchoredPanelHeader title="Notifications">
        <button
          id="notifications-mark-all"
          className="text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200 disabled:opacity-40"
          disabled={true}
        >
          Mark all read
        </button>
      </AnchoredPanelHeader>
      {/*
          Pinned collaborator-invites section: rendered above the grouped
          notification list, driven by the authoritative pendingInvites
          payload (see ./notifications.js renderInvites).
      */}
      <div id="notifications-invites" className="shrink-0 overflow-y-auto max-h-48">
      </div>
      <div id="notifications-list" className="flex-1 overflow-y-auto">
      </div>
      <div id="notifications-empty" className="hidden px-4 py-6 text-sm text-zinc-500 text-center">
        You'll get pinged here when someone proposes a change to an app you use.
      </div>
    </AnchoredPanel>
  );
}
