/**
 * The App tab's placeholder state. See ./app-status.tsx.
 *
 * Plain JS, like the other two stores in this directory, so nothing in the
 * chain imports React — `tests/app-frame-identity.test.js` drives the real
 * controller in Node.
 */

import { createStore } from '../../lib/plain-store.js';

export const appStatusStore = createStore({ view: null });
