/**
 * Which app's starter is framed while its first version is still on its way
 * (#15): `slug`, or '' for none. AppView publishes it on every App tab render
 * (`AppView._publishStarter`, through `UsernodeReact.appStarter`), and
 * ./starter-bar.tsx draws the bar over that app's frame with the way back to
 * the first version's screen.
 *
 * Plain JS, like the other stores in this directory, so nothing in the chain
 * imports React and tests/app-frame-identity.test.js can drive the real one.
 */

import { createStore } from '../../lib/plain-store.js';

export const starterStore = createStore({ slug: '' });
