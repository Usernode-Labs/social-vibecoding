import { detectMobileOs, type MobileOs } from './detect';
import { isNativeApp, isStandalone } from './environment';

/**
 * "Add Homeroom to your home screen", a row in the mark menu (Evan, 20 Oct
 * 2026), wherever Homeroom itself is not on the home screen yet: a phone's
 * browser, and the window an app saved to the home screen opens in.
 *
 *   steps    a browser tab: the install banner's steps sheet
 *            (./install-steps-sheet.tsx), Share then Add to Home Screen.
 *   browser  the window an app's own icon opened (App.launchedFromAppIcon,
 *            public/js/app.js): it has no Share button and no browser menu,
 *            so Homeroom opens in the browser, at an address that puts the
 *            steps up there (takeArrival).
 *   null     a laptop, the native app, or Homeroom's own home-screen window.
 *
 * Read from handlers and from effects after mount, never during a render the
 * prerender has to match.
 */
export type HomeroomHomeScreen = { os: MobileOs; via: 'steps' | 'browser' } | null;

export function homeroomHomeScreen(): HomeroomHomeScreen {
  if (typeof window === 'undefined' || isNativeApp()) return null;
  const os = detectMobileOs(navigator.userAgent, navigator.maxTouchPoints || 0);
  if (!os) return null;
  if (!isStandalone()) return { os, via: 'steps' };
  const app = (window as { App?: { launchedFromAppIcon?: boolean } }).App;
  return app?.launchedFromAppIcon ? { os, via: 'browser' } : null;
}

const ARRIVAL = 'home-screen=homeroom';

/**
 * Homeroom in a browser window of its own, as Home.menuItemsFor opens an
 * app's install page from a home-screen window. Called in the tap itself:
 * a window opened after a promise is one a phone may block.
 */
export function openHomeroomInBrowser(): void {
  window.open(`/?${ARRIVAL}`, '_blank', 'noopener');
}

let arrived: boolean | null = null;

/**
 * Whether this page was opened by openHomeroomInBrowser. The parameter comes
 * off the address the first time this is asked, so a reload or a copied link
 * does not bring the steps back and the address saved to the home screen is
 * Homeroom's own. Every other parameter is kept byte for byte (a staging
 * preview's ?token= rides there), as App._routeSearch keeps them.
 */
export function takeArrival(): boolean {
  if (arrived !== null) return arrived;
  arrived = false;
  try {
    const raw = window.location.search.replace(/^\?/, '');
    const parts = raw ? raw.split('&') : [];
    const kept = parts.filter((part) => part !== ARRIVAL);
    if (kept.length === parts.length) return false;
    arrived = true;
    const search = kept.length ? `?${kept.join('&')}` : '';
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
  } catch {
    /* an address that cannot be read or rewritten opens no steps */
  }
  return arrived;
}
