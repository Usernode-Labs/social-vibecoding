/**
 * The opened topic's head — the card and everything under it — as one
 * publish. See ./model.ts for why the body decomposes and the card did not.
 */

import { createContext } from 'react';

import { createStore } from '../../../lib/plain-store.js';
import type { DevCardModel } from '../card/model';
import type { TopicBody } from './model';

export interface TopicHeadState {
  item?: any;
  card: DevCardModel | null;
  body: TopicBody | null;
  /**
   * #6608: the project this head was painted for, and the route it was
   * published on. A page's thread list reads the slug from here, and the
   * panel's status pill is reported against the route, so a stale publish
   * cannot take on the page the viewer has moved to.
   */
  slug?: string | null;
  route?: string | null;
  /** The route names a different topic whose page is not loaded yet. */
  loading?: boolean;
}

/**
 * What the painted head knows about its own address (#6608). A change's
 * thread list and the panel's pill both read this rather than the global
 * `AppView.appData.slug`, which has already moved to the next project when
 * the page is still the previous one's.
 */
export const TopicPageContext = createContext<{ slug: string | null; route: string | null }>({
  slug: null,
  route: null,
});

export const topicHeadStore = createStore<TopicHeadState>({ card: null, body: null });
