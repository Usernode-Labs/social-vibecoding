/**
 * `#home-apps-more` — "Show all N apps", the collapsed grid's way out.
 *
 * It has always lived OUTSIDE `#app-list` so the grid's re-render could not
 * take the button away mid-click. That is still why it is a separate host;
 * what changes is that it is no longer re-rendered by hand on every paint,
 * so the listener that `_renderAppsMore` re-attached each time is attached
 * once, by React, to an element that survives.
 */

import { useMessages } from '../../lib/i18n/react';
import { useStoreState } from '../../lib/use-store-state';
import { chromeStore } from './chrome-store';

function controller(): any {
  return (typeof window !== 'undefined' ? (window as any).Home : null) || null;
}

const MORE_BTN = 'rounded-lg px-3 py-1.5 text-xs font-medium text-violet-700 '
  + 'dark:text-violet-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors';

/**
 * The host, as a pure function of what drives it: the count. Split from the
 * store-connected wrapper below for the same reason `WidgetStripBody` is: the
 * button's behaviour was executed coverage before the conversion (it was a
 * listener `_renderAppsMore` attached), and a component that reads a store
 * through a hook cannot be called as a function to get at its handler.
 *
 * #4757/#5654: this line used to carry a compact New project entry beside
 * Show all while the collapsed grid held the Create tile back (#3047), and
 * the pair was read left to right with the entry on the right. #5825 moved
 * that entry up to the My apps heading (index.tsx), which is the screen's
 * action seat — so the line is the expander alone, and it takes the right end
 * the entry used to hold, where it sits under the heading's action and flush
 * with the grid's right edge. The line's own host, id and padding are
 * unchanged.
 */
export function AppsMoreBody({ moreCount }: { moreCount: number }) {
  const t = useMessages('home');
  return (
    <div id="home-apps-more" className={moreCount ? 'px-2 pb-1 sm:px-3' : 'hidden px-2 pb-1 sm:px-3'}>
      {moreCount ? (
        <div className="flex items-center justify-end">
          <button
            type="button"
            id="home-apps-more-btn"
            className={`text-right ${MORE_BTN}`}
            onClick={() => {
              const home = controller();
              if (!home) return;
              home._appsExpanded = true;
              home.render();
            }}
          >
            {t('home:grid.showAll', { count: moreCount })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppsMore() {
  const { moreCount } = useStoreState(chromeStore);
  return <AppsMoreBody moreCount={moreCount} />;
}
