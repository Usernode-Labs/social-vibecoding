/**
 * The legacy → React seam for the header title (Streamlined Concept
 * groundwork).
 *
 * Same shape as ../improve/mount.ts: install the flush, publish the setter
 * on the bridge. The one writer is `App.setHeaderTitle()` in
 * public/js/app.js, whose callers read `document.title` (and fire the
 * native `titleChanged` message) on their next lines — so the store's
 * notification must land synchronously, which is what `setFlush(flushSync)`
 * restores once a React consumer subscribes.
 */

import { flushSync } from 'react-dom';

import { headerTitleStore } from './header-title-store.js';

headerTitleStore.setFlush(flushSync);

export { headerTitleStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.headerTitle = {
    /** @param text The visible title — forwarded from App.setHeaderTitle. */
    set(text: string) {
      headerTitleStore.set({ text: String(text ?? '') });
    },
  };
}
