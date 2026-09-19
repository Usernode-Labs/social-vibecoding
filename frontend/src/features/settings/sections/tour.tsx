/**
 * Settings → Welcome tour: the way back to the eight-step tour Home runs on
 * first sign-in (../../home/tour).
 *
 * The tour's own Skip says "You can reopen this from Settings", so this
 * section is the other half of that sentence rather than a nicety. It is one
 * button: clear the stored "finished" flag for this account, ask for the tour
 * again, and go to Home, which is where every step points.
 *
 * ── Why this pane may hold a handler at all ───────────────────────────
 *
 * ./index.tsx's header explains that the panes are STATIC because settings.js
 * binds every control inside them by id, once, and a React re-render of a
 * pane would silently stop those listeners firing. This one holds no state
 * and therefore never re-renders, and settings.js binds nothing inside it:
 * #settings-tour-replay is React's, the same way ./theme.tsx's segments are.
 */

import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/field';

import { requestTour } from '../../home/tour/tour-request';
import { clearDone, currentUserId } from '../../home/tour/tour-storage';

function replay(): void {
  clearDone(currentUserId());
  // Ask first, navigate second: the overlay waits for Home to be on screen
  // before it opens, so the order only decides whether it waits at all.
  requestTour();
  (window as unknown as { App?: { navigateHome?: () => void } }).App?.navigateHome?.();
}

export function TourSection() {
  return (
    <div data-settings-section="tour" className="hidden">
      <div id="settings-tour-section">
        <SectionHeading title="Welcome tour">
          The guided walk through Homeroom you were shown the first time you signed in.
        </SectionHeading>
        <Button
          id="settings-tour-replay"
          type="button"
          layout="shrink"
          size="narrow"
          onClick={replay}
        >
          Replay the tour
        </Button>
        <p id="settings-tour-hint" className="mt-2 text-xs text-zinc-500 dark:text-zinc-500">
          It starts again on your home screen.
        </p>
      </div>
    </div>
  );
}
