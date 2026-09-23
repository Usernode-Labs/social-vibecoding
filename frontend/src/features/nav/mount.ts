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
import { readRecentApps, recentAppsStore, rememberRecentApp } from './recent-apps-store.js';

navStore.setFlush(flushSync);
// Same reason as the tab's: App.navigateToApp clears the strip inside
// PlatformUI.transition's reveal callback, and the kit captures the incoming
// page from what that callback did before it returned.
parkedStore.setFlush(flushSync);
recentAppsStore.setFlush(flushSync);

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
     * @param tabOverride Which tab to light, for the one screen the map
     *   cannot answer for. `#app-view` is TWO screens behind one id — the
     *   running app, which lights nothing, and the platform's Workshop for
     *   that app, which is the Workshop section seen through one app and
     *   lights it. TAB_FOR_SCREEN cannot express that: it is a map from
     *   screen to tab, and tests/header-back-home.test.js derives the back
     *   slot from it on the rule that a screen in that map is a tab ROOT and
     *   shows no back control — which the app view, with its ✕, is not.
     */
    setScreen(screenId: string | null, tabOverride?: string | null) {
      const screen = screenId || null;
      // `peek: false` on every screen CHANGE, because that is what a peek is
      // FOR: you reveal the rail over an app to leave it, and the thing you
      // tapped has now happened. Leaving it set would hand the next screen an
      // overlay rail on top of its own.
      //
      // ON A CHANGE, and not on every call. Re-asserting the screen you are
      // already on is not navigation, and clearing the peek there makes any
      // such call yank the rail out from under the pointer that summoned it.
      // Found with a harness that re-asserted the current screen on a 100ms
      // timer: the rail flickered at exactly that rate, on and off, because
      // each tick cleared a peek the pointer immediately re-established.
      // Nothing in the shipped router does that today, which is the whole
      // reason to fix it here rather than trust that nothing ever will.
      const changed = navStore.get().screen !== screen;
      navStore.set({
        screen,
        tab: tabOverride || (screen ? tabForScreen(screen) : null),
        ...(changed ? { peek: false, peekOut: false } : null),
      });
    },
    /**
     * For a classic-script caller. The shipped writer is the Messages store,
     * which is in this bundle and sets `messages` on the nav store itself
     * (../messages/store.ts syncTabBadge, #2794).
     *
     * @param count Conversations with something unread. Clamped at zero so a
     *   caller that subtracts its way negative cannot render "-1 unread".
     */
    setMessages(count: number) {
      const n = Number(count);
      navStore.set({ messages: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 });
    },
    /**
     * Name the fifth tab after the signed-in user (#2760), or put it back to
     * "Me" with null.
     *
     * The one writer is `App._syncViewer()` in public/js/app.js, called
     * wherever `App.user` is assigned and from the sweep both username
     * writers run after changing it. Trimmed, and anything that is not a
     * non-empty string clears it, so a user object that has not loaded its
     * username yet leaves the tab saying "Me" rather than saying nothing.
     *
     * @param name The username, or null/'' for nobody.
     */
    setViewer(name: string | null) {
      const viewer = typeof name === 'string' ? name.trim() : '';
      // A different account (or none) is a different Recents (#2802): the
      // list is read back for whoever is signed in now, and for nobody it
      // is empty. Nothing to do while the name has not changed.
      if ((viewer || null) !== navStore.get().viewer) {
        recentAppsStore.set({ apps: readRecentApps(viewer || null) });
      }
      navStore.set({ viewer: viewer || null });
    },
    /**
     * Offer `app` above the tab bar until it is resumed or dismissed, or
     * clear the offer with null.
     *
     * It takes the app's DISPLAY DATA and not just its slug, because the
     * strip's whole promise is to be instant: a handle that has to fetch a
     * name and an icon before it can draw is a handle that appears after you
     * have given up looking for it. The caller has all four to hand — app.js
     * captures them while the app is on screen (`App._runningApp`, from the
     * record the app view loaded or the launcher's cached row) and parks that
     * capture on the way out, because every way out has cleared both records
     * by the time the screen swap runs (#2762).
     *
     * @param app `{ slug, name, iconUrl, iconEmoji }`, or null to clear.
     */
    park(app: {
      slug?: string; name?: string; iconUrl?: string | null; iconEmoji?: string | null;
    } | null) {
      // The desktop rail's Recents keeps every app you left, with when
      // (#2802). A park with null is the router clearing the strip because
      // you went back into the app; it is still recent, so nothing is removed.
      if (app && app.slug) rememberRecentApp(app, navStore.get().viewer);
      setParked(app && app.slug ? {
        slug: app.slug,
        name: app.name || app.slug,
        iconUrl: app.iconUrl || null,
        iconEmoji: app.iconEmoji || null,
      } : null);
    },
  };
}
