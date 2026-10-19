/**
 * The green "still loaded" dot (#2902).
 *
 * The last few apps opened stay running in hidden frames (./app-frame-store.js,
 * `kept`), so resuming one is instant and shows it exactly as it was left. The
 * dot is how the viewer can tell which apps those are: it sits on the app's
 * tile on Home and on its App row in the desktop sidebar
 * (../nav/rail-communities.tsx), and it goes the moment the frame does —
 * evicted as least recently used, dropped for a new build, or at sign-out.
 *
 * Read straight off the frame store, so it can never disagree with what is
 * actually loaded. The store's initial state has no frames, which is also what
 * the prerender rendered, so the first client render draws no dot and
 * hydration agrees.
 */

import { useMessages } from '../../lib/i18n/react';
import { t } from '../../lib/i18n/runtime';
import { useStoreState } from '../../lib/use-store-state';
import { appFrameStore, liveAppSlugs } from './app-frame-store.js';

/** Slugs with a live frame right now. */
export function useLiveAppSlugs(): string[] {
  return liveAppSlugs(useStoreState(appFrameStore));
}

/**
 * The app whose frame is MOUNTED, or null (#3074): on screen, parked behind
 * its Workshop, or hidden behind any other screen the viewer went to without
 * backing out to Home. Only leaving for Home retires it into the kept frames
 * and clears this, so it is NOT "the app on screen" — the rail asks the
 * router for that (currentAppOnScreen below, #3096). Starts null,
 * as the prerender did.
 */
export function useCurrentAppSlug(): string | null {
  return useStoreState(appFrameStore).slug || null;
}

/**
 * The app ON SCREEN, which is the only app lit (#3096), or null.
 *
 * NOT the mounted frame on its own: the frame store's `slug` stays set while
 * the frame is mounted, which outlasts every way of leaving but Home (a tab,
 * the app's own Workshop, its discussion). The router's answer decides: the
 * app is on screen only while its screen is `#app-view` AND no tab is lit
 * (`#app-view` with a tab lit is the app's Workshop, where the lit tab is
 * the sidebar's one "you are here").
 */
export function currentAppOnScreen(input: {
  /** The mounted frame's slug, '' or null when none is. */
  frameSlug: string | null;
  /** navStore's `screen`: the root the router last revealed. */
  screen: string | null;
  /** navStore's `tab`: the tab that screen lights, or null. */
  tab: string | null;
}): string | null {
  if (input.screen !== 'app-view' || input.tab) return null;
  return input.frameSlug || null;
}

/** What the dot means, for a row's or a tile's accessible name: one fact
 *  among others there, joined by listText (lib/i18n). Read when rendering. */
export function liveAppLabel(): string {
  return t('core:liveApp.stillOpen');
}

/**
 * The dot itself. Decorative to assistive tech — the owning control adds
 * liveAppLabel() to its own name — and `title` for a pointer that hovers it.
 */
export function LiveAppDot({ className }: { className: string }) {
  const translate = useMessages();
  return <span className={`app-live-dot ${className}`} title={translate('core:liveApp.dotTitle')} aria-hidden="true" />;
}
