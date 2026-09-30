/**
 * THE COMMUNITY'S COLOUR ON THE HEADER, while you are in a project: on its
 * page (the Hub, Discussion, Needs you, the Workshop, a card or a session
 * under them) and in the running app itself (#852).
 *
 * The colour is lib/community-color.ts's, from the header's own record of
 * the app (../improve/improve-store.js). It lands on <html> as
 * `--community-tint` with `data-community-tint`, so app.css paints the bar
 * from it ("The project's colour"), and the page's band and Open app read
 * the same property rather than working it out a second time.
 *
 * HELD ACROSS A SWITCH. Going from one community to another clears the
 * header's record while the next app loads (improve-status.js publishes no
 * target for a pending load), and an icon the colour is read from takes a
 * moment more. Dropping the tint for that gap flashed the bar back to its
 * own surface between the two colours; so while you stay in the app view,
 * the last colour stays until the next is known.
 */

import { useEffect, useRef } from 'react';

import { useResolvedCommunityColor } from '../../lib/community-color';
import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';

export function useCommunityHeaderTint(): string | null {
  const { slug, iconUrl, iconEmoji, iconColor } = useStoreState(improveStore) as {
    slug: string | null; iconUrl: string | null; iconEmoji: string | null; iconColor: string | null;
  };
  const { screen } = useStoreState(navStore) as { screen: string | null };
  const inApp = screen === 'app-view';
  const live = useResolvedCommunityColor(inApp && slug ? { color: iconColor, iconUrl, iconEmoji, key: slug } : null);
  const held = useRef<string | null>(null);
  if (!inApp) held.current = null;
  else if (live) held.current = live;
  const tint = inApp ? (live || held.current) : null;
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
