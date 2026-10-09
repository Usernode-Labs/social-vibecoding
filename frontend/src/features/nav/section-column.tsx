/**
 * #platform-section-column — the column beside the strip (#4417), on a wide
 * window.
 *
 * The desktop rail was one 224px column that tried to be two things: the
 * platform's sections, and a history of what you had been doing (Recents).
 * It is a 76px strip of sections now (./tab-bar.tsx), and beside it a 264px
 * column that belongs to the SECTION on screen, the way Slack's and
 * Discord's second column belongs to the workspace or server you are in:
 *
 *   Communities   the project's places (../dev-board/workshop/project-places.tsx):
 *                 Hub, Needs you, Workshop, then #general and its topics.
 *   Messages      the conversation list. It is the inbox's own list pane,
 *                 drawn in this column's place (app.css, `#messages-screen`),
 *                 not a second copy of it here: its search box, its rows and
 *                 the declared checks that select them stay where they are.
 *   Home, Discover, All communities, a running app: no column.
 *
 * So this element holds the places list and nothing else, and is shown only
 * while a project's page is the screen under the Communities tab. On a phone
 * it is never drawn (app.css): the places are the tray behind the page's
 * place bar there. Folding the rail from the header's sidebar button folds
 * the column with it.
 *
 * Under 1296px it also steps aside while an item's page is open in the panel
 * beside the Workshop's list (`placeStore.side`): the strip, the column, the
 * list and the 560px panel do not all fit, and the panel is what was asked
 * for. The place bar's button is the way to the places meanwhile, as it is
 * with the strip folded, and the column is back when the panel closes.
 *
 * ── The list moves the page, in place ───────────────────────────────
 *
 * The page owns which place is up (../dev-board/workshop/workshop.tsx), as
 * state, because a press there also pushes a history entry and scrolls. It
 * publishes the place it shows and registers the one way to move it
 * (../dev-board/workshop/place-store.ts); this list reads the one and calls
 * the other, so a press here is exactly a press on the tray's list.
 *
 * ── The initial render is the prerender ──────────────────────────────
 *
 * Ships hidden and EMPTY: the place store starts with no project, and the
 * page publishes after it has loaded. `hidden` goes through useHiddenClass.
 */

import { useEffect, useRef, useState } from 'react';

import { useHiddenClass } from '../../lib/legacy-dom';
import { useStoreState } from '../../lib/use-store-state';
import { devWorkshopStore } from '../dev-board/card/cards-store';
import { useCommunity } from '../dev-board/workshop/community-card';
import { openPlace, placeStore } from '../dev-board/workshop/place-store';
import { ProjectPlaces } from '../dev-board/workshop/project-places';
import { navStore } from './nav-store.js';

/** The column's width, which app.css reserves beside the strip. */
export const SECTION_COLUMN_W = 264;

/**
 * From here the column stays beside an item's page open in the Workshop's
 * side panel: the side panel's own 1180px (../dev-board/workshop/workshop.tsx
 * SIDE_QUERY) plus the 116px the strip and the column take over the old rail.
 */
export const COLUMN_BESIDE_SIDE_QUERY = '(min-width: 1296px)';

/** Which section's column is up: the places of a project page in Communities, or none. Pure. */
export function columnFor(input: {
  screen: string | null;
  tab: string | null;
  placeSlug: string | null;
  /** An item's page is open in the panel beside the list. */
  side?: boolean;
  /** The window has room for the column beside that panel. */
  roomBesideSide?: boolean;
}): 'places' | null {
  if (input.side && !input.roomBesideSide) return null;
  if (input.screen === 'app-view' && input.tab === 'workshop' && input.placeSlug) return 'places';
  return null;
}

/** `matchMedia(query).matches`, kept current; false where there is no matchMedia. */
function useMatches(query: string): boolean {
  const read = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(query).matches;
  const [on, setOn] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia(query);
    const apply = () => setOn(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [query]);
  return on;
}

function PlacesColumn({ slug }: { slug: string }) {
  const place = useStoreState(placeStore);
  const v = useStoreState(devWorkshopStore);
  const community = useCommunity(slug);
  return (
    <ProjectPlaces
      slug={slug}
      name={community?.name || slug}
      place={place.place}
      owed={place.owed}
      places={community?.places}
      // #2915: the Workshop's dot, as the page's own list draws it.
      filtered={v.slug === slug && !!v.meta?.filtered && place.place !== 'all'}
      onPlace={(key) => { openPlace(slug, key); }}
    />
  );
}

export function SectionColumn() {
  const ref = useRef<HTMLElement | null>(null);
  const { screen, tab } = useStoreState(navStore);
  const place = useStoreState(placeStore);
  const roomBesideSide = useMatches(COLUMN_BESIDE_SIDE_QUERY);
  const column = columnFor({ screen, tab, placeSlug: place.slug, side: place.side, roomBesideSide });
  useHiddenClass(ref, column === null);
  return (
    <aside
      ref={ref}
      id="platform-section-column"
      className="platform-section-column hidden"
      aria-label="Places"
    >
      {column === 'places' && place.slug ? <PlacesColumn slug={place.slug} /> : null}
    </aside>
  );
}
