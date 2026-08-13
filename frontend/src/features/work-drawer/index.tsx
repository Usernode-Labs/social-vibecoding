/**
 * #work-drawer-panel — the header cog's "your work" drawer, as a React island
 * (#1079 chunk B). Same chrome and position as the notifications panel above
 * it, so both go through the shared anchored-panel primitive.
 *
 * ./work-drawer.js is the retired public/js/work-drawer.js, moved into this
 * bundle unchanged; it owns everything inside #work-drawer-list and the
 * `hidden` toggling of the root. See ../notifications/index.tsx for the full
 * rationale — this island is its twin.
 */

import { AnchoredPanel, AnchoredPanelHeader } from '@/components/ui/anchored-panel';
import { XIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import './work-drawer.js';

export function WorkDrawerPanel() {
  // Layout effect for the same reason as the notifications island: it has to
  // land before app.js's DOMContentLoaded init, because `sv:authed` fires once.
  useIsomorphicLayoutEffect(() => {
    window.WorkDrawer?.init();
  }, []);

  return (
    <AnchoredPanel id="work-drawer-panel">
      <AnchoredPanelHeader title="Your work">
        <button
          id="work-drawer-mark-all"
          className="hidden text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          Mark all read
        </button>
        <button
          id="work-drawer-close"
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          aria-label="Close"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </AnchoredPanelHeader>
      <div id="work-drawer-list" className="flex-1 overflow-y-auto">
      </div>
      <div id="work-drawer-empty" className="hidden px-4 py-6 text-sm text-zinc-500 text-center">
        Nothing in flight — start a dev session from any app's Dev tab.
      </div>
    </AnchoredPanel>
  );
}
