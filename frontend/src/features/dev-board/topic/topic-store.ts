/**
 * The opened topic's head — the card and everything under it — as one
 * publish. See ./model.ts for why the body decomposes and the card did not.
 */

import { createStore } from '../../../lib/plain-store.js';
import type { DevCardModel } from '../card/model';
import type { TopicBody } from './model';

export interface TopicHeadState {
  card: DevCardModel | null;
  body: TopicBody | null;
}

export const topicHeadStore = createStore<TopicHeadState>({ card: null, body: null });
