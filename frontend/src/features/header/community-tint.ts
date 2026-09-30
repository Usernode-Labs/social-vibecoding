/**
 * THE COMMUNITY'S COLOUR ON THE HEADER, while you are on a project's pages
 * under the Communities tab: the Hub, Discussion, Needs you, the Workshop,
 * and a card or a session under them (#852). NOT in the running app: there
 * the bar is the standard one, taking the app's tone as it always has.
 *
 * The colour is lib/community-color.ts's, from the header's own record of
 * the app (../improve/improve-store.js). It lands on <html> as
 * `--community-tint` with `data-community-tint`, so app.css paints the bar
 * from it ("The project's colour"), and the page's band and Open app read
 * the same property rather than working it out a second time.
 *
 * WHICH HALF is the store's `tab`: 'dev' is the project's pages, anything
 * else with a target is the running app.
 *
 * HELD ACROSS A SWITCH. Going from one community to another clears the
 * header's record while the next app loads (improve-status.js publishes no
 * target for a pending load, and setTarget(null) resets `tab` to 'app'), and
 * an icon the colour is read from takes a moment more. Dropping the tint for
 * that gap flashed the bar back to its own surface between the two colours;
 * so while the app view is up and no target is known, the last colour stays
 * until the next is.
 */

import { useEffect, useRef } from 'react';

import { useResolvedCommunityColor } from '../../lib/community-color';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';

export function useCommunityHeaderTint(): string | null {
  const { slug, tab, iconUrl, iconEmoji, iconColor } = useStoreState(improveStore) as {
    slug: string | null; tab: string; iconUrl: string | null; iconEmoji: string | null; iconColor: string | null;
  };
  const { screen } = useStoreState(navStore) as { screen: string | null };
  const inView = screen === 'app-view';
  // A project's pages: a target, on its Dev half.
  const onPages = inView && !!slug && tab === 'dev';
  // The running app: a target on any other half. No target is the gap
  // between two, which is neither.
  const inRunningApp = inView && !!slug && tab !== 'dev';
  const live = useResolvedCommunityColor(onPages ? { color: iconColor, iconUrl, iconEmoji, key: slug as string } : null);
  const held = useRef<string | null>(null);
  if (!inView || inRunningApp) held.current = null;
  else if (live) held.current = live;
  const tint = inView && !inRunningApp ? (live || held.current) : null;
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (tint) {
      root.style.setProperty('--community-tint', tint);
      root.setAttribute('data-community-tint', '');
    } else {
      root.style.removeProperty('--community-tint');
      root.removeAttribute('data-community-tint');
    }
  }, [tint]);
  return tint;
}
