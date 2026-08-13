/**
 * #notifications-panel — the bell dropdown, as a React island (#1079 chunk B).
 *
 * The chassis (root, header row) is rendered here; the three leaf containers
 * and everything in them are rendered by ./notifications-list.tsx from the
 * descriptor tree ./notifications.js pushes into ./notifications-store.js.
 *
 * #1191 slice 6 finished this island. Chunk B moved the module into the bundle
 * and left it writing the containers by `innerHTML`; conversion 2 turned those
 * three `innerHTML` sites into store pushes, so React is now the only writer
 * below #notifications-invites and #notifications-list.
 *
 * `hidden` on the root is therefore still toggled by notifications.js
 * (show/hide, and the kit's sheet adoption on touch). React never re-renders
 * `className` here — see the note in @/components/ui/anchored-panel.
 */

import { AnchoredPanel, AnchoredPanelHeader } from '@/components/ui/anchored-panel';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { NotificationsBody } from './notifications-list';
import './mount';

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
      <NotificationsBody />
    </AnchoredPanel>
  );
}
