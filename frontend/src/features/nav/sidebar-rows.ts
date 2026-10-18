/**
 * THE DESKTOP'S SIDEBAR OF ROWS (D, 18 Oct 2026), and the one width it
 * starts at.
 *
 * On every desktop window, from 768px, the rail is one 212px sidebar for the
 * whole platform: Home, Discover and Messages, then your communities under a
 * Communities heading (./rail-communities.tsx), then your pinned and recent
 * apps under theirs (./strip-apps.tsx), and you at its foot. The community
 * whose page is up nests its places under its row, and the inbox its latest
 * conversations under Messages (v3, ./rail-nest.tsx), so there is no second
 * column beside it. It takes the place of the 76px strip (#4417) and of the
 * switcher the header's name opened: the sidebar lists the communities
 * itself, so the header's name is a name again (../header/header-title.tsx).
 * Under 768px the phone's bar and drawer are untouched.
 *
 * FROM 768px, NOT 1024px (18 Oct 2026). It began at 1024px, with the strip
 * and its 264px column below that, but the strip and the column are 340px
 * where the sidebar holding the same things is 212px: the narrower windows
 * had the wider navigation. So it goes straight from the sidebar to the
 * phone's bar.
 *
 * app.css draws all of it inside one `@media (min-width: 768px)` block, after
 * the rail's own; the components ask the same question here only where
 * markup has to differ, never for layout.
 */

import { useEffect, useState } from 'react';

/** The sidebar of rows, from here up. app.css's block says the same width. */
export const SIDEBAR_ROWS_QUERY = '(min-width: 768px)';

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
