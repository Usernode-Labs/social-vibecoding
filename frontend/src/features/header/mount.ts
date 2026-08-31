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
import { clearShellSnapshot, saveShellSnapshot } from '../../lib/shell-snapshot';

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
     * @param text The visible title — forwarded from App.setHeaderTitle.
     * @param subtitle The destination within it ('Board', 'Activity'), or ''
     *   at the root of a screen. Omitted by every caller that has none, and
     *   defaulted here rather than left undefined so a root screen actively
     *   CLEARS a subtitle the previous screen published — a stale "Board"
     *   under the Home title is exactly the bug the second argument invites.
     */
    set(text: string, subtitle?: string) {
      const title = String(text ?? '');
      const sub = String(subtitle ?? '');
      headerTitleStore.set({ text: title, subtitle: sub });
      // Remembered for the next cold paint. The prerendered document has no
      // idea which app or route the viewer was on, so without this the chip
      // reads "dApps" (the store's INITIAL) until auth and routing have both
      // answered — see lib/shell-snapshot.ts.
      saveShellSnapshot({ title, subtitle: sub });
    },
  };
  // Published for public/js/app.js's _dropCachedSession, which clears every
  // other piece of this device's display-only session residue in one place.
  bridge.shellSnapshot = { clear: clearShellSnapshot };
  bridge.backButton = {
    /**
     * @param mode 'arrow' (a level up), 'home' (the house) or 'none' (hidden).
     * @param href The resolved destination — setBackIcon defaults it to home.
     *
     * THREE modes, and the narrowing here has to know that. This read
     * `mode === 'arrow' ? 'arrow' : 'home'`, which was right while 'home'
     * meant hidden and is a bug the moment it means "draw a house": a
     * setBackIcon('none') from Home arrived as 'home' and put a house on the
     * one screen that must not have one. It cost a browser trace to find,
     * because every layer above was correct — app.js computed 'none',
     * published 'none', and this line quietly turned it into 'home'.
     *
     * Anything unrecognised still collapses to 'home' rather than 'none': an
     * unknown mode should leave a way OFF the screen, not remove one.
     */
    set(mode: string, href: string | null) {
      backButtonStore.set({
        mode: mode === 'arrow' ? 'arrow' : (mode === 'none' ? 'none' : 'home'),
        href: href || null,
      });
    },
  };
}
