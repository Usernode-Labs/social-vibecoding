/**
 * THE SIDEBAR'S SEARCH, handed to All communities (D, 18 Oct 2026).
 *
 * The Communities heading in the desktop's sidebar of rows shows a search
 * glyph while it is hovered (../nav/rail-communities.tsx). Pressing it is
 * pressing All communities, with the search box at the top of the list
 * focused and lit, ready to type. The sidebar cannot reach into the screen,
 * and the screen may not be mounted yet, so the press is a REQUEST kept
 * here: a number that goes up by one each time. The screen (./index.tsx)
 * answers each new number once, after it is showing, by focusing its box;
 * the light stays until focus leaves it.
 */

import { createStore } from '../../lib/plain-store.js';
import { goToCommunity } from './community-scope';

export const communitiesSearchStore = createStore({ asked: 0 });

/** All communities, with its search box focused and lit. */
export function openCommunitiesSearch(): void {
  communitiesSearchStore.set({ asked: (communitiesSearchStore.get().asked || 0) + 1 });
  goToCommunity(null);
}
