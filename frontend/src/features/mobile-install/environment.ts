/**
 * Where is the shell running? Two facts about the host, read live.
 *
 * Both used to be private to install-banner.tsx. The app menu's "Add to Home
 * Screen" row (../app-context/app-context-sheet.tsx, #1508) asks the same two
 * questions to decide how to open the install page, and two copies of "am I
 * standalone" would be two places for Safari's `navigator.standalone` quirk
 * to be remembered in only one of.
 *
 * Neither is a pure function of an explicit environment like ./detect.ts's
 * rules, deliberately: these ARE the sampling, the one place a component
 * touches `window` for the answer, and they are only ever called from
 * effects or handlers, never during a render.
 */

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
