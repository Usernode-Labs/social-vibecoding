/**
 * Browse's React seam (#1191 slice 6, conversion 3).
 *
 * ./browse.js can't import ./browse-store.js: tests/browse-screen.test.js
 * evaluates that file's real source in a vm context, as classic script text
 * with the import lines stripped, so an imported binding would resolve to
 * nothing at call time. So the store is PLANTED on the controller here, the
 * same shape features/notifications/mount.ts uses, and every render method
 * no-ops while it is null — which is precisely the state the vm harness runs
 * in, and why none of its pure sort/filter/derive tests had to change.
 *
 * setFlush(flushSync) matters for the same reason it does on the other
 * surfaces: App._showOnlyScreen runs inside PlatformUI.transition(fn) and the
 * native kit snapshots the DOM before fn returns, so a store push that lands
 * during a screen transition has to reconcile in the same tick.
 */

import { flushSync } from 'react-dom';

import './browse.js';
import { browseStore } from './browse-store.js';

browseStore.setFlush(flushSync);

export { browseStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as {
    Browse?: Record<string, unknown>;
    UsernodeReact?: Record<string, unknown>;
  };
  if (host.Browse) host.Browse._store = browseStore;
  const bridge = (host.UsernodeReact ||= {});
  bridge.browse = host.Browse;
}
