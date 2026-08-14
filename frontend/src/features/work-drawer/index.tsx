/**
 * #work-drawer-panel — the header cog's "your work" drawer, as a React island
 * (#1079 chunk B). Same chrome and position as the notifications panel above
 * it, so both go through the shared anchored-panel primitive.
 *
 * ./work-drawer.js is the retired public/js/work-drawer.js, moved into this
 * bundle unchanged by chunk B; #1191 slice 6's fourth conversion turned its one
 * `innerHTML` site into a store push, so React is now the only writer below
 * #work-drawer-list — and the empty hint and "Mark all read" moved from
 * `classList.toggle` calls into the same store. ./work-drawer-list.tsx renders
 * all three.
 *
 * `hidden` on the ROOT is still the controller's (show/hide, and the kit's
 * sheet adoption on touch), exactly as it is for the bell. React never
 * re-renders `className` here — see the note in @/components/ui/anchored-panel.
 */

import { AnchoredPanel, AnchoredPanelHeader } from '@/components/ui/anchored-panel';
import { XIcon } from '@/components/ui/icons';

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';
import { WorkDrawerBody, WorkDrawerMarkAll } from './work-drawer-list';
import './mount';

export function WorkDrawerPanel() {
  // Layout effect for the same reason as the notifications island: it has to
  // land before app.js's DOMContentLoaded init, because `sv:authed` fires once.
  useIsomorphicLayoutEffect(() => {
    window.WorkDrawer?.init();
  }, []);

  return (
    <AnchoredPanel id="work-drawer-panel">
      <AnchoredPanelHeader title="Your work">
        <WorkDrawerMarkAll />
        <button
          id="work-drawer-close"
          className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
          aria-label="Close"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </AnchoredPanelHeader>
      <WorkDrawerBody />
    </AnchoredPanel>
  );
}
