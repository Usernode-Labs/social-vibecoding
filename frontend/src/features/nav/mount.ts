/**
 * The legacy → React seam for the platform tab bar.
 *
 * Same shape as ../header/mount.ts: install the flush, publish the setter on
 * the bridge. The one writer is `App._syncPlatformTabs()` in
 * public/js/app.js, which runs inside `PlatformUI.transition`'s callback —
 * the kit captures the outgoing page from whatever that callback did to the
 * DOM before it returned, so a store notification that lands in a later task
 * would animate a bar that still lit the previous tab. `setFlush(flushSync)`
 * is what keeps the update inside that window.
 */

import { flushSync } from 'react-dom';

import { navStore, tabForScreen } from './nav-store.js';
import { parkedStore, setParked } from './parked-store.js';

navStore.setFlush(flushSync);
// Same reason as the tab's: App.navigateToApp clears the strip inside
// PlatformUI.transition's reveal callback, and the kit captures the incoming
// page from what that callback did before it returned.
parkedStore.setFlush(flushSync);

export { navStore, parkedStore };

if (typeof window !== 'undefined') {
  const host = window as unknown as { UsernodeReact?: Record<string, unknown> };
  const bridge = (host.UsernodeReact ||= {});
  bridge.nav = {
    /**
     * Light the tab that owns `screenId`, or none at all.
     *
     * It takes the SCREEN, not the tab, because the router knows which root
     * it revealed and should not also have to know which of the five
     * sections owns it — that mapping is ./nav-store.js's TAB_FOR_SCREEN,
     * and keeping it on this side means a screen added later is one entry in
     * one map rather than a second list to remember in app.js.
     *
     * An unrecognised id (an app view, an auth screen, the empty string
     * before the first swap) lights nothing, which is also the prerender.
     *
     * @param screenId A root from App.SCREEN_IDS, or null/'' for none.
     */
    setScreen(screenId: string | null) {
      const screen = screenId || null;
      navStore.set({ screen, tab: screen ? tabForScreen(screen) : null });
    },
    /**
     * @param count Conversations with something unread. Clamped at zero so a
     *   caller that subtracts its way negative cannot render "-1 unread".
     */
    setMessages(count: number) {
      const n = Number(count);
      navStore.set({ messages: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 });
    },
    /**
     * Offer `app` above the tab bar until it is resumed or dismissed, or
     * clear the offer with null.
     *
     * It takes the app's DISPLAY DATA and not just its slug, because the
     * strip's whole promise is to be instant: a handle that has to fetch a
     * name and an icon before it can draw is a handle that appears after you
     * have given up looking for it. The caller has all four to hand — app.js
     * parks from AppView.appData, the record it already loaded to draw the
     * app's own header.
     *
     * @param app `{ slug, name, iconUrl, iconEmoji }`, or null to clear.
     */
    park(app: {
      slug?: string; name?: string; iconUrl?: string | null; iconEmoji?: string | null;
    } | null) {
      setParked(app && app.slug ? {
        slug: app.slug,
        name: app.name || app.slug,
        iconUrl: app.iconUrl || null,
        iconEmoji: app.iconEmoji || null,
      } : null);
    },
  };
}
