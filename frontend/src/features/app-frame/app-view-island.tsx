/**
 * `#app-view` — the App/Dev screen, as a React island (#1085 chunk H, step 2).
 *
 * The last region chunk H converts, and last on purpose: it is the one that
 * holds another app's live document. Its markup is unchanged from the
 * hand-written shell except for one added node, `#app-frame-host` — see
 * ./app-frame.tsx for why the frame had to move out of `#app-content` and into
 * a sibling React owns end to end.
 *
 * What is NOT owned here, deliberately:
 *
 * - **`#app-content`'s children.** It still ships EMPTY and every Dev surface,
 *   status placeholder and screenshot state is still an `innerHTML` write from
 *   `public/js/**`. React renders no children for it, so it never reconciles
 *   anything inside it.
 * - **`#app-view`'s `hidden` class.** `#app-view` is not in
 *   `App.REACT_SCREEN_IDS`, so app.js's visibility seam still toggles the class
 *   directly — which is safe precisely because `className` here is a constant
 *   string React writes once at hydration and never again.
 * - **`data-app-surface`.** `AppView._setSurface` keeps writing the attribute
 *   imperatively, for the same reason: the rendered value is constant, so React
 *   never overwrites what it wrote. Its default stays `platform`.
 */

import { useRef, type ReactNode } from 'react';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { AppFrameHost } from './app-frame';
import { appFrameStore } from './app-frame-store.js';

export function AppViewIsland(): ReactNode {
  const state = useStoreState(appFrameStore);
  const contentRef = useRef<HTMLDivElement | null>(null);
  // Exactly one of the two halves is on screen. `#app-content` was never
  // hidden before, because it was the only child; the toggle goes through the
  // ref so its class string stays a constant prop.
  useHiddenClass(contentRef, state.active);

  return (
    <div
      id="app-view"
      className="hidden flex flex-col"
      data-app-surface="platform"
      style={{ flex: "1", minHeight: "0", height: "0" }}
    >
      <div
        id="app-content"
        ref={contentRef}
        className="flex-1"
        style={{ minHeight: "0", overflow: "hidden" }}
      >
        {/* Tab content renders here */}
      </div>
      <AppFrameHost />
    </div>
  );
}
