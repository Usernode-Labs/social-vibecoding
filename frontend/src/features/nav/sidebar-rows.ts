/**
 * THE DESKTOP'S SIDEBAR OF ROWS (D, 18 Oct 2026), and the one width it
 * starts at.
 *
 * From 1024px the rail is one 184px sidebar for the whole platform: Home,
 * Discover and Messages, then your communities under a Communities heading
 * (./rail-communities.tsx), then your pinned and recent apps under theirs
 * (./strip-apps.tsx), and you at its foot. It takes the place of the 76px
 * strip (#4417) and of the switcher the header's name opened: the sidebar
 * lists the communities itself, so on a window this wide the header's name is
 * a name again (../header/header-title.tsx), and All communities is a column
 * beside what waits on you (../workshop/index.tsx). From 768px to 1024px the
 * strip and the header's switcher are as they were; under 768px the phone's
 * bar and drawer are untouched.
 *
 * app.css draws all of it inside one `@media (min-width: 1024px)` block; the
 * components ask the same question here only where markup has to differ,
 * never for layout.
 */

import { useEffect, useState } from 'react';

/** The sidebar of rows, from here up. app.css's block says the same width. */
export const SIDEBAR_ROWS_QUERY = '(min-width: 1024px)';

/**
 * Whether the sidebar of rows is up. FALSE ON THE FIRST RENDER, whatever the
 * window, so the prerendered document and the first client render agree; the
 * real answer lands in an effect and follows the window after that.
 */
export function useSidebarRows(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(SIDEBAR_ROWS_QUERY);
    const apply = () => setOn(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);
  return on;
}
