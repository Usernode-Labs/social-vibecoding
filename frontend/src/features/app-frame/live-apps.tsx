/**
 * The green "still loaded" dot (#2902).
 *
 * The last few apps opened stay running in hidden frames (./app-frame-store.js,
 * `kept`), so resuming one is instant and shows it exactly as it was left. The
 * dot is how the viewer can tell which apps those are: it sits on the app's
 * tile on Home and on its row in the rail's Recents, and it goes the moment
 * the frame does — evicted as least recently used, dropped for a new build, or
 * at sign-out.
 *
 * Read straight off the frame store, so it can never disagree with what is
 * actually loaded. The store's initial state has no frames, which is also what
 * the prerender rendered, so the first client render draws no dot and
 * hydration agrees.
 */

import { useStoreState } from '../../lib/use-store-state';
import { appFrameStore, liveAppSlugs } from './app-frame-store.js';

/** Slugs with a live frame right now. */
export function useLiveAppSlugs(): string[] {
  return liveAppSlugs(useStoreState(appFrameStore));
}

/**
 * The app the viewer is in right now, or null (#3074): the mounted frame, on
 * screen or parked behind its Workshop. Leaving for Home retires it into the
 * kept frames and clears this. Starts null, as the prerender did.
 */
export function useCurrentAppSlug(): string | null {
  return useStoreState(appFrameStore).slug || null;
}

/** What the dot means, for a row's or a tile's accessible name. */
export const LIVE_APP_LABEL = 'still open';

/**
 * The dot itself. Decorative to assistive tech — the owning control adds
 * LIVE_APP_LABEL to its own name — and `title` for a pointer that hovers it.
 */
export function LiveAppDot({ className }: { className: string }) {
  return <span className={`app-live-dot ${className}`} title="Still open" aria-hidden="true" />;
}
