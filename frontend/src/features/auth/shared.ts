/**
 * Shared plumbing for the anonymous shell's six screens (#1080, step 2
 * chunk C).
 *
 * These screens were `public/js/auth-screens.js`, a 1,965-line module that
 * owned both the routing between them and every screen's behaviour. The
 * conversion moves them one at a time, and while it runs the two halves have
 * to interoperate: the legacy module keeps `window.AuthScreens` (the router
 * `App.restoreFromHash` calls into) and each converted screen PATCHES its
 * per-screen entry points onto that object at hydration. `show()` looks its
 * hooks up on `AuthScreens` by name at call time, so a patched method is
 * indistinguishable from the original — and hydration runs before
 * DOMContentLoaded (see main.tsx), i.e. before the router's first call.
 *
 * The last chunk retires the module and this file grows the router itself.
 */

import { useIsomorphicLayoutEffect } from '../../lib/legacy-dom';

/** The route names `AuthScreens.show()` accepts, and their screen roots. */
export const AUTH_SCREEN_IDS: Record<string, string> = {
  landing: 'auth-landing-screen',
  login: 'auth-login-screen',
  signup: 'auth-login-screen', // sub-view of the login screen
  register: 'auth-register-screen',
  waiting: 'auth-waiting-screen',
  waitlist: 'auth-waitlist-screen',
  more: 'auth-more-screen',
  'reset-password': 'auth-login-screen',
};

/** One public app as `/api/public/apps` returns it. */
export interface PublicApp {
  slug?: string;
  name?: string;
  url?: string;
  icon_url?: string | null;
  icon_emoji?: string | null;
  requires_login?: boolean;
}

/** Full zoom opts, forwarded to the kit verbatim by {@link zoomFx}. */
export interface ZoomOpts {
  type: string;
  el?: Element | null;
  fromEl?: () => Element | null;
  outEl?: Element | null;
  fallback?: string;
  after?: () => void;
}

interface LegacyWindow {
  PlatformUI?: {
    transition(fn: () => void, opts: { type?: string } & Record<string, unknown>): void;
    pullToRefresh(
      el: Element | null,
      onRefresh: () => void,
      opts?: Record<string, unknown>,
    ): { detach(): void };
  };
  Offline?: { isOffline(): boolean; nudge(): void };
  App?: {
    user?: { username?: string; hasPlatformAccess?: boolean } | null;
    _setScreenVisible?(id: string, visible: boolean): void;
    _refreshOrReload?(fn: () => unknown): void;
    enterAuthed?(user: unknown): void;
    enterAnonymous?(): Promise<void> | void;
    clearSessionSnapshot?(): void;
    restoreFromHash?(): void;
  };
  Settings?: { logout?(): void };
  AppView?: {
    mountViewerCover?(
      viewer: Element,
      frame: Element | null,
      app: PublicApp,
      opts: { timers: number[]; isCurrent: () => boolean },
    ): void;
    forgetSafeAreaFrame?(id: string): void;
    scheduleSafeAreaBroadcast?(): void;
  };
  AuthScreens?: Record<string, unknown>;
  // The native bridge (usernode-native). Absent in a regular browser, which is
  // the NORMAL state for the wallet fast path — see LoginScreen's walletDetect.
  usernode?: { isNative?: boolean };
  getNodeAddress?(): Promise<string | null>;
  signMessage?(message: string): Promise<{ publicKey: string; signature: string }>;
}

/** `window`, with the legacy globals these screens talk to declared. */
export function legacy(): LegacyWindow {
  return window as unknown as LegacyWindow;
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

/**
 * Screen transitions come from the platform's native kit via the PlatformUI
 * seam; when the kit failed to load the mutation just runs without animation.
 */
export function fx(fn: () => void, type?: string): void {
  const ui = legacy().PlatformUI;
  if (ui) ui.transition(fn, { type });
  else fn();
}

/**
 * Same seam, but forwarding the full zoom opts (el / fromEl / outEl /
 * fallback / after). Zoom callers split their mutation into fn (reveal the
 * incoming element) + after (conceal the outgoing one), so the no-kit path has
 * to run BOTH halves.
 *
 * Under a `?shot=` deep link the kit is skipped and the cut is instant. Shots
 * assert settled END-states (`?shot=anon-back` needs two full open/close
 * cycles stamped inside capture.js's shared ASSERT_MAX_MS window), and the
 * kit's zoom-out alone runs ~2s — cinematics would spend the whole assertion
 * budget. Real navigation never carries a shot param, so users always get the
 * kit path.
 */
function isShotUrl(): boolean {
  try {
    return new URLSearchParams(location.search).has('shot');
  } catch {
    return false;
  }
}

export function zoomFx(fn: () => void, opts: ZoomOpts): void {
  const ui = legacy().PlatformUI;
  if (ui && !isShotUrl()) {
    ui.transition(fn, opts as unknown as { type?: string } & Record<string, unknown>);
  } else {
    fn();
    if (typeof opts.after === 'function') opts.after();
  }
}

/**
 * Every credential exchange on these screens is a server round trip, so
 * offline they can only fail — and the user got a bare "Network error" that
 * read like a wrong password (#1021). Guard first, and say what's actually
 * wrong.
 *
 * The check is Offline's probe result, not navigator.onLine: the flag
 * false-positives behind captive portals, which is exactly where a submit would
 * hang. When it says nothing is wrong we let the request go — an unguarded real
 * failure still falls back to its own catch.
 */
export function blockedOffline(setError?: (msg: string) => void): boolean {
  let offline = false;
  try {
    const off = legacy().Offline;
    offline = !!(off && off.isOffline());
  } catch {
    offline = false;
  }
  if (!offline) return false;
  if (setError) setError("You're offline. Signing in needs a connection.");
  try {
    legacy().Offline?.nudge();
  } catch {
    /* ignore */
  }
  return true;
}

/** Does a (possibly waiting-room) session exist right now? */
export function hasSession(): boolean {
  return !!legacy().App?.user;
}

/** Are we inside the Usernode native app (bridge present)? */
export function isNative(): boolean {
  const w = legacy();
  return !!(w.usernode && w.usernode.isNative);
}

/**
 * Reload-free login completion, called after ANY successful credential
 * exchange. Still the legacy router's method — it re-fetches /api/auth/me and
 * hands over to `App.enterAuthed` — so it is reached by name, like every other
 * hook on that object, until the router itself crosses over.
 */
export function finishLogin(): void {
  const fn = legacy().AuthScreens?.finishLogin as undefined | (() => unknown);
  if (fn) void fn();
}

/**
 * Patch per-screen entry points onto `window.AuthScreens`.
 *
 * Registered in a LAYOUT effect, not a passive one: `flushSync` in main.tsx
 * guarantees layout effects have run when hydration returns, which is still
 * before DOMContentLoaded and therefore before the router's first `show()`.
 * The previous values are restored on unmount so a hot reload can't leave a
 * dead closure installed.
 */
export function useAuthScreensPatch(patch: Record<string, unknown>): void {
  useIsomorphicLayoutEffect(() => {
    const host = legacy().AuthScreens;
    if (!host) return;
    const previous: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      previous[key] = host[key];
      host[key] = patch[key];
    }
    return () => {
      for (const key of Object.keys(previous)) host[key] = previous[key];
    };
    // The patch object is rebuilt every render; its identity is not the
    // dependency, the mount is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** `hidden` first, exactly where the hand-written markup had it. */
export function hiddenFirst(hidden: boolean, rest: string): string {
  return hidden ? `hidden ${rest}` : rest;
}

/** `hidden` appended, as `classList.add('hidden')` would have left it. */
export function hiddenLast(hidden: boolean, rest: string): string {
  return hidden ? `${rest} hidden` : rest;
}
