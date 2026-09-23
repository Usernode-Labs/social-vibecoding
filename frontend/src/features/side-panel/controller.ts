/**
 * The side panel beside a running app, on a desktop-width window — the TOP
 * document's half (the panel's own document runs ./embedded.ts).
 *
 * ── What it is ─────────────────────────────────────────────────────────
 *
 * While an app runs on its App tab, the pages ABOUT it — its Workshop, its
 * discussion, a proposal, an issue, a change — and the conversations a
 * notification points at open in a panel beside it instead of replacing it.
 * The app keeps running next to the panel and is never reloaded.
 *
 * ── Why the panel is the platform, framed ─────────────────────────────
 *
 * The platform's screens are singletons behind one router: App._showOnlyScreen
 * shows exactly one root, the running app's iframe and that app's Workshop
 * are two tabs of the same #app-view, the discussion renders into ids the
 * legacy chat module owns, and every store is global. Showing the app and one
 * of those pages at once natively would mean re-architecting the router. So
 * the panel is a same-origin <iframe> of the platform itself at
 * `/?panel=1#<route>`, in an embedded mode that draws no chrome (see
 * lib/side-panel-mode.ts and head.html) — the pages it shows are the real
 * pages, at their phone layout, with no second copy of any of them.
 *
 * ── What this file owns ────────────────────────────────────────────────
 *
 *   - WHEN a navigation goes to the panel (`canTake`): an app on screen on its
 *     App tab, a desktop-width window, not chromeless, not the native app,
 *     not inside the panel itself.
 *   - The two chokepoints that catch a navigation BEFORE it lands: a
 *     capture-phase click on a link, and (where the browser has the
 *     Navigation API) a script's `location.hash = …`. Both refuse the
 *     navigation, so the top window's history is untouched — reverting a hash
 *     after the fact leaves a dead Back entry. The JavaScript entry points
 *     (App.openAppTab, the Messages store, New change) call `take` directly.
 *   - The panel's own history: a stack of the pages opened in it, then the
 *     climb to the list a page belongs to (./routes.ts parentRoute). It is kept
 *     HERE rather than in the browser's session history, because an iframe's
 *     entries are the top window's entries too — and Chromium keeps them after
 *     the frame is gone, as Back presses that do nothing.
 *   - Expand (the page, full width, leaving the app — App._syncParkedApp parks
 *     it) and Close (the panel only).
 *   - Dropping the frame when the app leaves the screen by any route:
 *     App._syncPlatformTabs, the one place that decides whether the running
 *     app is on screen, calls `appPresence`.
 */

import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import {
  frameUrl,
  isPanelRoute,
  isShellAddress,
  parentRoute,
  routeFromUrl,
  samePage,
  titleFor,
} from './routes';
import { INITIAL, sidePanelRefs, sidePanelStore } from './store.js';

/**
 * The panel needs room for both: about 480px of app beside
 * `clamp(360px, 36vw, 560px)` of panel. The rail and the app layer switch to
 * their desktop layout at 768px (`md`), where the app would be left 408px;
 * 1024px (`lg`, which app.css already uses) is the first breakpoint at which
 * the app keeps at least 480px — 655px, in fact. Keep in step with the
 * `(min-width: 1024px)` block in public/css/app.css.
 */
export const DESKTOP_QUERY = '(min-width: 1024px)';

/** A one-shot instruction that rides along with a navigation into the panel. */
export interface PanelHint {
  /** Show the "what a proposal is" hint on the unsent change (New change). */
  proposalHint?: boolean;
}

interface AppLike {
  user?: unknown;
  chromeless?: boolean;
  currentApp?: string | null;
  currentTab?: string;
  embeddedPanel?: boolean;
  _isScreenVisible?: (id: string) => boolean;
  _rootUrl?: (hash?: string) => string;
  _routeFromHash?: () => void;
  navigateHome?: () => void;
  openAppTab?: (slug: string, tab?: string, opts?: unknown) => unknown;
}

interface EmbedLike {
  go?: (route: string, hint: PanelHint | null) => void;
}

function app(): AppLike | null {
  return typeof window === 'undefined' ? null : ((window as unknown as { App?: AppLike }).App || null);
}

/** The panel document's own bridge, when its frame has booted that far. */
function embed(): EmbedLike | null {
  try {
    const win = sidePanelRefs.frame?.contentWindow as unknown as
      { UsernodeReact?: { sidePanelEmbed?: EmbedLike } } | null;
    return win?.UsernodeReact?.sidePanelEmbed || null;
  } catch {
    return null;
  }
}

// ── The panel's history, and the page it is headed for ─────────────────
//
// `stack` holds the pages opened in the panel before the one on screen, most
// recent last. `desired` is the page the panel should be showing — ahead of
// the document while it boots, equal to it afterwards. `ready` is whether the
// document has booted and can be told where to go.
let stack: string[] = [];
// A panel is a column of recent pages, not an archive: the oldest fall off.
const STACK_CAP = 30;
let desired: string | null = null;
let desiredHint: PanelHint | null = null;
let bootHint: PanelHint | null = null;
let ready = false;
let reported = '';
// Set while this module navigates the TOP window itself (Expand, or a link the
// panel's document handed up), so the Navigation API intercept below lets it
// through instead of catching its own navigation.
let bypass = false;

function remember(route: string): void {
  stack.push(route);
  if (stack.length > STACK_CAP) stack.splice(0, stack.length - STACK_CAP);
}

function publish(route: string, extra?: Record<string, unknown>): void {
  sidePanelStore.set({
    route,
    title: titleFor(route, reported),
    canBack: stack.length > 0 || !!parentRoute(route),
    ...extra,
  });
}

function go(route: string, hint: PanelHint | null): void {
  const target = embed();
  if (!target || typeof target.go !== 'function') return;
  try {
    target.go(route, hint);
  } catch {
    /* a frame that is going away mid-call: the next open starts a new one */
  }
}

/**
 * May a navigation to a panel page go to the panel right now?
 *
 * Only in the TOP document, only while an app is running on its App tab, only
 * at desktop width, and not in chromeless mode or the native app — the
 * Homeroom app's WebView owns its own back stack and bridge relay, and the
 * panel is a desktop arrangement. Everywhere else every one of these links
 * navigates exactly as it always has.
 */
export function canTake(): boolean {
  if (typeof window === 'undefined' || isEmbeddedPanel()) return false;
  const A = app();
  if (!A || !A.user || A.chromeless) return false;
  if (!A.currentApp || A.currentTab !== 'app') return false;
  if (typeof A._isScreenVisible === 'function' && !A._isScreenVisible('app-view')) return false;
  try {
    if (document.documentElement.classList.contains('in-native-webview')) return false;
    return window.matchMedia(DESKTOP_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Open `route` in the panel if this is a moment the panel takes it. Returns
 * whether it did, so a caller that asked falls through to its ordinary
 * navigation when it did not.
 */
export function take(route: string, hint?: PanelHint | null): boolean {
  if (!isPanelRoute(route) || !canTake()) return false;
  open(route, hint || null);
  return true;
}

/** Put `route` in the panel, starting its document if there is none yet. */
export function open(route: string, hint?: PanelHint | null): void {
  const s = sidePanelStore.get();
  if (!s.frameSrc) {
    stack = [];
    reported = '';
    ready = false;
    desired = route;
    desiredHint = null;
    // The first page is the frame's own address, so a hint has to reach the
    // document before its router runs: ./embedded.ts asks for it at boot.
    bootHint = hint || null;
    sidePanelStore.set({
      open: true,
      frameSrc: frameUrl(route, window.location.search),
      frameKey: s.frameKey + 1,
      loading: true,
    });
    publish(route);
    return;
  }
  // A panel the viewer had closed starts a fresh history; an open one keeps
  // the page it was on as somewhere to come back to.
  if (!s.open) stack = [];
  else if (s.route && !samePage(s.route, route)) remember(s.route);
  if (!samePage(s.route, route)) reported = '';
  desired = route;
  desiredHint = hint || null;
  sidePanelStore.set({ open: true });
  publish(route);
  if (ready) {
    desiredHint = null;
    go(route, hint || null);
  }
}

/** Close: the panel only. The frame stays, so reopening is a navigation. */
export function close(): void {
  stack = [];
  desiredHint = null;
  if (sidePanelStore.get().open) sidePanelStore.set({ open: false });
}

/** Drop the panel and its document — the app it stood beside is gone. */
export function drop(): void {
  stack = [];
  desired = null;
  desiredHint = null;
  bootHint = null;
  ready = false;
  reported = '';
  const s = sidePanelStore.get();
  if (!s.frameSrc && !s.open && !s.route) return;
  sidePanelStore.set({ ...INITIAL, frameKey: s.frameKey });
}

/**
 * Back: the page opened before this one, and once those are spent, the list
 * this page belongs to — a thread to Messages, a proposal, an issue or a
 * change to its app's Workshop. The control is hidden when there is neither.
 */
export function back(): void {
  const s = sidePanelStore.get();
  if (!s.open || !s.route) return;
  const target = stack.pop() || parentRoute(s.route);
  if (!target) {
    publish(s.route);
    return;
  }
  reported = '';
  desired = target;
  desiredHint = null;
  publish(target);
  if (ready) go(target, null);
}

/**
 * Navigate the top window to `route` with its ordinary routing, as a real
 * history entry. Pushed and routed here rather than by assigning the hash, so
 * it runs once and at once instead of on a later hashchange.
 */
function navigateTop(route: string): void {
  const A = app();
  if (!A) return;
  bypass = true;
  try {
    if (!route) {
      A.navigateHome?.();
      return;
    }
    const url = typeof A._rootUrl === 'function' ? A._rootUrl(`#${route}`) : `/#${route}`;
    window.history.pushState(null, '', url);
    A._routeFromHash?.();
  } finally {
    bypass = false;
  }
}

/**
 * Expand: the page, full width. That leaves the app — which parks it in the
 * recent-app strip, so Resume brings it back (App._syncParkedApp) — and the
 * router's own leave drops the panel in the same transition
 * (App._syncPlatformTabs → appPresence). The drop below covers a route that,
 * for whatever reason, did not take the app off screen.
 */
export function expand(): void {
  const route = sidePanelStore.get().route;
  if (route) navigateTop(route);
  if (sidePanelStore.get().open || sidePanelStore.get().frameSrc) drop();
}

/**
 * The router's word on whether the running app is still on screen, from
 * App._syncPlatformTabs — every route out of an app passes through it: the
 * header's close, a tab, the peeked rail, Back, Expand, chromeless, the
 * signed-out shell. Switching straight to ANOTHER app keeps the answer true,
 * and keeps the panel.
 */
export function appPresence(inApp: boolean): void {
  if (!inApp) drop();
}

/** Is the panel on screen (the viewer has it open)? */
export function isOpen(): boolean {
  const s = sidePanelStore.get();
  return !!(s.open && s.frameSrc);
}

// ── What the panel's document tells this one (./embedded.ts) ───────────

/** Its first page is routed: show it, or send it where the viewer went since. */
function embeddedReady(route: string, title: string): void {
  const s = sidePanelStore.get();
  if (!s.frameSrc) return;
  ready = true;
  reported = title || '';
  sidePanelStore.set({ loading: false });
  if (desired && !samePage(desired, route)) {
    const hint = desiredHint;
    desiredHint = null;
    reported = '';
    publish(desired);
    go(desired, hint);
    return;
  }
  desiredHint = null;
  if (route) {
    desired = route;
    publish(route);
  }
}

/**
 * It moved, or retitled. `push` is a navigation the viewer made INSIDE the
 * panel, which Back comes back from; anything else is the same page settling
 * (a canonical address, a title that loaded, the session a new change became).
 */
function embeddedNavigated(route: string, title: string, push: boolean): void {
  const s = sidePanelStore.get();
  if (!s.frameSrc || !ready || !route) return;
  if (push && s.route && !samePage(s.route, route)) remember(s.route);
  reported = title || '';
  desired = route;
  publish(route);
}

/**
 * The panel never runs an app. Its document hands an app's App tab up here:
 * the app beside the panel is the one that is asked for (nothing to do), or
 * another app, which REPLACES the running one — and the panel stays.
 */
function embeddedOpenApp(slug: string): void {
  window.setTimeout(() => {
    const A = app();
    if (!A || !slug) return;
    if (A.currentApp === slug && A.currentTab === 'app') return;
    A.openAppTab?.(slug, 'app');
  }, 0);
}

/**
 * A link inside the panel to somewhere the panel does not go — a profile, a
 * tab, Settings: the top window goes there, which leaves the app (and so
 * drops the panel), exactly as following it from the app's own menu would.
 * On the top window's own turn of the event loop, never inside the call from
 * the frame that is about to be removed.
 */
function embeddedLeave(route: string): void {
  window.setTimeout(() => navigateTop(route), 0);
}

/** A `history.back()` inside the panel's document is the panel's Back. */
function embeddedBack(): void {
  window.setTimeout(back, 0);
}

/** The hint for the first page, once — ./embedded.ts asks as it installs. */
function takeBootHint(): PanelHint | null {
  const hint = bootHint;
  bootHint = null;
  return hint;
}

export const embeddedApi = {
  ready: embeddedReady,
  navigated: embeddedNavigated,
  openApp: embeddedOpenApp,
  leave: embeddedLeave,
  back: embeddedBack,
  takeBootHint,
};

// ── The two chokepoints ──────────────────────────────────────────────────

/**
 * A plain click on a link to a panel page, in the top document. Capture phase
 * on `window`, so it runs before any handler below it and before the browser
 * follows the link: `preventDefault` here is what keeps the top window's
 * history untouched. Propagation is NOT stopped — the mark menu's rows still
 * dismiss their sheet in their own handler — and NavLink-bound handlers see
 * `defaultPrevented` and stand down (NavLink.isNativeClick).
 *
 * Modified clicks (a new tab or window) and links with a target or a download
 * are the browser's, exactly as before.
 */
export function onClickCapture(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0) return;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const origin = window.location.origin;
  const target = e.target as Element | null;
  const a = (target && typeof target.closest === 'function'
    ? target.closest('a[href]') : null) as HTMLAnchorElement | null;
  if (!a) return;
  if (a.target && a.target !== '_self') return;
  if (a.hasAttribute('download')) return;
  if (!isShellAddress(a.href, origin)) return;
  const route = routeFromUrl(a.href);
  if (!isPanelRoute(route) || !canTake()) return;
  e.preventDefault();
  open(route, null);
}

interface NavigateEventLike {
  navigationType?: string;
  hashChange?: boolean;
  cancelable?: boolean;
  downloadRequest?: string | null;
  formData?: unknown;
  destination?: { url?: string };
  preventDefault(): void;
}

/**
 * A script's `location.hash = '#…'` to a panel page, where the browser has
 * the Navigation API: refused before it lands, and opened in the panel. Only
 * PUSHES, never a traversal — the browser's Back to a page the viewer was on
 * before opening the app is not "following a link", it is leaving the app.
 */
export function onNavigate(e: NavigateEventLike): void {
  if (bypass) return;
  if (e.navigationType !== 'push' || !e.hashChange || !e.cancelable) return;
  if (e.downloadRequest || e.formData) return;
  const url = e.destination && e.destination.url;
  if (!url) return;
  const route = routeFromUrl(url);
  if (!isPanelRoute(route) || !canTake()) return;
  e.preventDefault();
  open(route, null);
}

/** Install both chokepoints. The top document only. */
export function installIntercepts(win: Window): void {
  if (isEmbeddedPanel()) return;
  win.addEventListener('click', onClickCapture, true);
  const nav = (win as unknown as {
    navigation?: { addEventListener?: (type: string, fn: (e: NavigateEventLike) => void) => void };
  }).navigation;
  if (nav && typeof nav.addEventListener === 'function') {
    nav.addEventListener('navigate', onNavigate);
  }
}

/** The bridge: window.UsernodeReact.sidePanel (see ./mount.ts). */
export const SidePanel = {
  canTake,
  take,
  open,
  close,
  drop,
  back,
  expand,
  appPresence,
  isOpen,
  embedded: embeddedApi,
};

/** For tests: forget everything between cases. */
export function _resetForTests(): void {
  stack = [];
  desired = null;
  desiredHint = null;
  bootHint = null;
  ready = false;
  reported = '';
  bypass = false;
  sidePanelStore.set({ ...INITIAL });
  sidePanelRefs.frame = null;
}
