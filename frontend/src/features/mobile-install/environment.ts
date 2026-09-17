/**
 * Where is the shell running? Two facts about the host, read live, and what
 * they add up to for putting one app on a home screen.
 *
 * Both used to be private to install-banner.tsx. An app's "Add to Home
 * Screen" item (Home.menuItemsFor in ../home/home.js, #1508, #2320) asks the
 * same two questions to decide how to open the install page, and two copies of
 * "am I standalone" would be two places for Safari's `navigator.standalone`
 * quirk to be remembered in only one of.
 *
 * Neither is a pure function of an explicit environment like ./detect.ts's
 * rules, deliberately: these ARE the sampling, the one place a component
 * touches `window` for the answer, and they are only ever called from
 * effects or handlers, never during a render.
 */

import { detectMobileOs } from './detect';

/** Launched from a home-screen icon rather than a browser tab. */
export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
    // iOS Safari predates the media query and reports it here instead.
    return (window.navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

/** Inside the Homeroom native app (the `usernode` bridge reports native). */
export function isNativeApp(): boolean {
  const bridge = (window as { usernode?: { isNative?: boolean } }).usernode;
  return !!(bridge && bridge.isNative === true);
}

/**
 * Can this visitor put an app on a home screen, and from where would the
 * install page have to open? (#1508)
 *
 * `/app/<slug>/install` is a page of its own, server-rendered with the app's
 * own manifest and icon, because the browser's install flow reads the
 * manifest of the document it is looking at and the shell's document is the
 * platform PWA. The shell cannot add the app itself; it can only take the
 * person to the page that can, and how depends on where the shell runs:
 *
 *   native       the webview cannot leave for the system browser on its own
 *                (target="_blank" and window.open both do nothing there, see
 *                public/js/nav-link.js), and it is the system browser that
 *                has the share sheet, so the bridge's openExternal is the
 *                only road.
 *   standalone   the shell installed as the platform PWA has no share sheet
 *                either, so the page opens in a browser window that does.
 *   browser      an ordinary same-tab navigation.
 *   none         a laptop has no home screen; nothing is offered.
 *
 * The native app counts as a phone. The OS test is the install banner's,
 * iPad included.
 */
export type InstallHost = 'none' | 'native' | 'standalone' | 'browser';

export function detectInstallHost(): InstallHost {
  if (isNativeApp()) return 'native';
  if (!detectMobileOs(navigator.userAgent, navigator.maxTouchPoints || 0)) return 'none';
  return isStandalone() ? 'standalone' : 'browser';
}
