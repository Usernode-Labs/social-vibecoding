/**
 * Whether a topic is open BESIDE the Workshop's list right now (#4457).
 *
 * app-view.js owns the fact (AppView._topicBeside decides routing and
 * history); this store only tells the two React readers that draw around it:
 * the topic frame, which lays the item out beside the list instead of as a
 * whole page, and the "‹ Workshop" chip, which goes while the list is right
 * there beside the item. One fact, two readers, the way the back chip and
 * the header's arrow share `topicBackHref`.
 */

import { createStore } from '../../lib/plain-store.js';

export interface TopicBesideState {
  up: boolean;
  /** The app whose Workshop the panel sits beside. */
  slug: string | null;
  /** The Workshop tab it was opened from ('workshop', 'all', 'week'). */
  tab: string | null;
}

export const topicBesideStore = createStore<TopicBesideState>({
  up: false,
  slug: null,
  tab: null,
});
