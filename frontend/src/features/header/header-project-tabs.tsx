/**
 * A project's tabs in the header's one row, on a wide window.
 *
 * On a phone the tabs are a band under the header
 * (features/dev-board/workshop/project-band.tsx). From 768px up the header
 * has the room, so they sit after the community's name and ⌄, and app.css
 * does not draw the band: one row, as the desktop design has it.
 *
 * Rendered only while a project page has published itself and the window is
 * wide, both of which are learned after the first paint (an effect-settled
 * media flag, and a store the page writes from an effect), so the prerender
 * and the first client render agree on nothing here.
 */

import { useEffect, useState } from 'react';

import { useStoreState } from '../../lib/use-store-state';
import { improveStore } from '../improve/improve-store.js';
import { navStore } from '../nav/nav-store.js';
import { ProjectBand, projectTabsStore, requestProjectTab } from '../dev-board/workshop/project-band';

const WIDE_QUERY = '(min-width: 768px)';

function useWide(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(WIDE_QUERY);
    const apply = () => setWide(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);
  return wide;
}

export function HeaderProjectTabs() {
  const wide = useWide();
  const tabs = useStoreState(projectTabsStore);
  const { slug } = useStoreState(improveStore) as { slug: string | null };
  const { screen } = useStoreState(navStore) as { screen: string | null };
  // The page is up, about the app the header is naming. On All items, the
  // Workshop's page, the Workshop tab stays lit (./project-band.tsx litTab).
  if (!wide || !tabs.slug || tabs.slug !== slug || screen !== 'app-view') return null;
  return (
    <ProjectBand
      inHeader
      tab={tabs.tab}
      owed={tabs.owed}
      filtered={tabs.filtered}
      onTab={(key) => requestProjectTab(tabs.slug as string, key)}
    />
  );
}
