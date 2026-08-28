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

import { backButtonStore } from './back-button-store.js';
import { headerTitleStore } from './header-title-store.js';

headerTitleStore.setFlush(flushSync);
// Same reason as the title's: App.setBackIcon's callers read the header back
// on their next lines (the ?shot= fixtures assert it within the same task),
// so the notification has to land synchronously.
backButtonStore.setFlush(flushSync);

export { backButtonStore, headerTitleStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.headerTitle = {
    /**
     * @param text The app's name — the chip's text.
     * @param screen The screen within it ('Board', 'Activity'), or '' at the
     *   root. Nothing RENDERS it (the screen bar takes its heading as a prop
     *   from the frame that draws it); it is here because `document.title`
     *   still joins both halves. Defaulted rather than left undefined so a
     *   root screen actively CLEARS what the previous one published.
     */
    set(text: string, screen?: string) {
      headerTitleStore.set({
        text: String(text ?? ''),
        screen: String(screen ?? ''),
      });
    },
  };
  bridge.backButton = {
    /**
     * @param mode 'arrow' shows the anchor, anything else hides it.
     * @param href The resolved destination — setBackIcon defaults it to home.
     */
    set(mode: string, href: string | null) {
      backButtonStore.set({
        mode: mode === 'arrow' ? 'arrow' : 'home',
        href: href || null,
      });
    },
  };
}
