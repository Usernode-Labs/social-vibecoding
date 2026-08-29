/**
 * `#home-apps-more` — "Show all N apps", the two-row default's way out.
 *
 * It has always lived OUTSIDE `#app-list` so the grid's re-render could not
 * take the button away mid-click. That is still why it is a separate host;
 * what changes is that it is no longer re-rendered by hand on every paint,
 * so the listener that `_renderAppsMore` re-attached each time is attached
 * once, by React, to an element that survives.
 */

import { useStoreState } from '../../lib/use-store-state';
import { chromeStore } from './chrome-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

/**
 * The host, as a pure function of the one number that drives it. Split from
 * the store-connected wrapper below for the same reason `WidgetStripBody` is:
 * the button's behaviour was executed coverage before the conversion (it was a
 * listener `_renderAppsMore` attached), and a component that reads a store
 * through a hook cannot be called as a function to get at its handler.
 */
export function AppsMoreBody({ moreCount }: { moreCount: number }) {
  return (
    <div id="home-apps-more" className={moreCount ? 'px-2 pb-1 sm:px-3' : 'hidden px-2 pb-1 sm:px-3'}>
      {moreCount ? (
        <button
          type="button"
          id="home-apps-more-btn"
          // A TEXT BUTTON, so it takes the link ink: `azure-800` /
          // `dark:azure-200` (Lc 77.8 light, -81.4 on the dark card — a pair
          // at parity). The 700/400 spelling it replaces was 68.0 / -51.8,
          // which is body-minimum on one side and non-content on the other.
          // The 700 tier is what chip, wash and fill SURFACES keep; ink on a
          // plain ground is 800.
          className="w-full rounded-lg px-3 py-1.5 text-xs font-medium text-azure-800 dark:text-azure-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          onClick={() => {
            const home = controller();
            if (!home) return;
            home._appsExpanded = true;
            home.render();
          }}
        >
          {`Show all ${moreCount} apps`}
        </button>
      ) : null}
    </div>
  );
}

export function AppsMore() {
  const { moreCount } = useStoreState(chromeStore);
  return <AppsMoreBody moreCount={moreCount} />;
}
