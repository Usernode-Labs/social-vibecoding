/**
 * #5301: whether a request's page is on screen, and which one.
 *
 * ./request-head.tsx publishes its number while it is mounted and clears it
 * when it goes. The platform header reads it: on a request's page the
 * header's own arrow is the page's back, and its title carries the path
 * ("› Request #N"), where every other topic page keeps the "‹ Workshop"
 * chip (./topic-back.tsx). Published by the head itself rather than read off
 * the topic store's body, so the header's arrow and the head that no longer
 * draws a chip are one fact.
 */

import { createStore } from '../../../lib/plain-store.js';

export interface RequestPageState {
  number: number | null;
}

export const requestPageStore = createStore<RequestPageState>({ number: null });
