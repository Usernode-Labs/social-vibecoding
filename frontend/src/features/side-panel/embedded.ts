/**
 * The side panel's OWN document — the platform at `/?panel=1#<route>`, framed
 * beside a running app (see ./controller.ts for why the panel is the platform
 * itself). Everything here runs only when lib/side-panel-mode.ts says this
 * document is that frame, and it is installed at module scope, before
 * App.init routes anything.
 *
 * ── Three jobs ─────────────────────────────────────────────────────────
 *
 * 1. NO HISTORY OF ITS OWN. An iframe's navigations are entries in the TOP
 *    window's session history, and Chromium keeps them after the frame is
 *    removed — so every page opened in the panel would come back later as a
 *    Back press that does nothing. The panel's history is the top document's
 *    stack instead (./controller.ts), and this document only ever REPLACES
 *    its entry:
 *      - history.pushState is replaceState here, reported as a push;
 *      - a link inside the panel is followed with location.replace, or for a
 *        clean app path with replaceState and the router's own popstate;
 *      - a script's `location.hash = …` is caught by the Navigation API where
 *        the browser has it, and taken with location.replace;
 *      - history.back() is the panel's Back, never a traversal — a traversal
 *        from in here would move the TOP window.
 * 2. REPORT. After every settled navigation and every title change, the top
 *    document hears the route, the header title this document would have
 *    drawn, and whether the viewer went somewhere (Back returns from it) or
 *    the same page settled.
 * 3. FORWARD what the panel does not show (App.restoreFromHash asks):
 *    an app's App tab goes to the running app beside the panel, and any
 *    other address outside the panel's pages (a tab, a profile, Settings)
 *    goes to the top window, which leaves the app for it.
 */

import { isEmbeddedPanel } from '../../lib/side-panel-mode';
import { headerTitleStore } from '../header/header-title-store.js';
import type { PanelHint } from './controller';
import { appTabSlug, embeddedAllows, isShellAddress, routeFromUrl } from './routes';

interface TopPanel {
  ready?: (route: string, title: string) => void;
  navigated?: (route: string, title: string, push: boolean) => void;
  openApp?: (slug: string) => void;
  leave?: (route: string) => void;
  back?: () => void;
  takeBootHint?: () => PanelHint | null;
}

type Win = Window & {
  App?: { _routeFromHash?: () => void; _currentRoute?: string | null };
  AppView?: { _proposalHint?: boolean };
  UsernodeReact?: Record<string, unknown>;
  navigation?: { addEventListener?: (type: string, fn: (e: NavigateLike) => void) => void };
};

interface NavigateLike {
  navigationType?: string;
  hashChange?: boolean;
  cancelable?: boolean;
  downloadRequest?: string | null;
  formData?: unknown;
  destination?: { url?: string; sameDocument?: boolean };
  preventDefault(): void;
}

export interface EmbeddedRuntime {
  /** The top document sends the panel to `route` (open, Back, a page it was headed for). */
  go(route: string, hint: PanelHint | null): void;
  /** App.restoreFromHash asks: is `route` the top window's? If so it has gone there. */
  forward(route: string): boolean;
  /** An app's App tab, asked for in here: the running app beside the panel. */
  openApp(slug: string): void;
  /** Has the first page been routed and reported? */
  isBooted(): boolean;
}

export function installEmbeddedRuntime(win: Win): EmbeddedRuntime | null {
  if (!isEmbeddedPanel()) return null;
  const hist = win.history;
  const loc = win.location;
  const replaceState = hist.replaceState.bind(hist);

  const top = (): TopPanel | null => {
    try {
      const host = (win.parent as Win).UsernodeReact as
        { sidePanel?: { embedded?: TopPanel } } | undefined;
      return host?.sidePanel?.embedded || null;
    } catch {
      return null;
    }
  };

  let booted = false;
  // Did the viewer go somewhere since the last report? Set by every
  // navigation that is theirs; cleared by a report.
  let pendingPush = false;
  // Was this navigation the top document's own (open, Back)? Those are
  // already on its stack, so they report as the page settling.
  let fromTop = false;
  let timer = 0;
  // The address of the page on screen, for a forward to put back.
  let lastUrl = loc.href;

  const route = () => routeFromUrl(loc.href);
  // Has a page titled the header yet? Until one has, the store holds the
  // prerender's placeholder — the platform's name, which is no page's title —
  // and a panel that has just booted would read "Homeroom" until its page
  // loaded enough to title itself. Reported as '' instead, so the top falls
  // back to the page's kind ("Discussion", "Messages").
  let titled = false;
  const title = () => {
    if (!titled) return '';
    const t = headerTitleStore.get();
    return String((t && t.text) || '');
  };

  function flush(): void {
    timer = 0;
    const push = pendingPush && !fromTop;
    pendingPush = false;
    fromTop = false;
    if (!booted) return;
    lastUrl = loc.href;
    top()?.navigated?.(route(), title(), push);
  }
  // One report per turn of the event loop, after the router's own
  // synchronous rewrites (a canonical app path, a healed mixed address) have
  // landed — so a navigation and its canonicalisation are one report.
  function schedule(): void {
    if (!timer) timer = win.setTimeout(flush, 0);
  }

  // ── 1. No history of its own ─────────────────────────────────────────
  hist.pushState = function pushState(state: unknown, unused: string, url?: string | URL | null) {
    pendingPush = true;
    replaceState(state, unused, url);
    schedule();
  };
  hist.replaceState = function replace(state: unknown, unused: string, url?: string | URL | null) {
    replaceState(state, unused, url);
    schedule();
  };
  hist.back = function back() {
    top()?.back?.();
  };
  hist.forward = function forward() { /* the panel has no forward */ };
  hist.go = function goDelta(delta?: number) {
    if (typeof delta === 'number' && delta < 0) top()?.back?.();
  };

  /**
   * Follow a shell address inside this document, replacing its entry. The
   * address keeps THIS document's query — `panel=1` and whatever the top
   * handed down (`demo`, a preview's `token`) — because a link spells only a
   * path and a fragment, and a document that lost `panel=1` would boot the
   * whole chrome on its next load.
   */
  function follow(href: string): void {
    let url: URL;
    try { url = new URL(href, loc.href); } catch { return; }
    url.search = loc.search;
    pendingPush = true;
    if (url.pathname === loc.pathname) {
      if (url.hash === loc.hash) {
        // The same address: no event would fire, so route it directly.
        win.App?._routeFromHash?.();
        schedule();
        return;
      }
      loc.replace(url.href); // a fragment navigation: hashchange routes it
      return;
    }
    replaceState(hist.state, '', url.href);
    // The router's own entry point for an address that changed under it.
    win.dispatchEvent(new PopStateEvent('popstate', { state: hist.state }));
    schedule();
  }

  // A link inside the panel, after every handler below the window has had
  // its say: one that called preventDefault did its own navigating (through
  // the router, which is covered above), so only the default is taken over.
  win.addEventListener('click', (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = e.target as Element | null;
    const a = (target && typeof target.closest === 'function'
      ? target.closest('a[href]') : null) as HTMLAnchorElement | null;
    if (!a) return;
    if (a.target && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    if (!isShellAddress(a.href, loc.origin)) return;
    e.preventDefault();
    follow(a.href);
  });

  // A script's `location.hash = …` (and anything the click above missed).
  // Without the Navigation API that one assignment still adds an entry — the
  // one leak left, in browsers that do not have it.
  const nav = win.navigation;
  if (nav && typeof nav.addEventListener === 'function') {
    nav.addEventListener('navigate', (e: NavigateLike) => {
      if (e.navigationType !== 'push' || !e.cancelable) return;
      if (e.downloadRequest || e.formData) return;
      const dest = e.destination && e.destination.url;
      if (!dest) return;
      if (e.hashChange) {
        e.preventDefault();
        pendingPush = true;
        // After the refused navigation has unwound.
        win.queueMicrotask(() => loc.replace(dest));
        return;
      }
      if (e.destination && e.destination.sameDocument === false) {
        e.preventDefault();
        if (isShellAddress(dest, loc.origin)) win.queueMicrotask(() => follow(dest));
        else win.open(dest, '_blank', 'noopener');
      }
    });
  }

  // A fragment change nobody marked. Where the browser has the Navigation
  // API every PUSH was marked on its way in (above), so an unmarked one is a
  // REPLACE — a rewrite such as a `#name` channel reference becoming the
  // channel's own address — and the same page settling. Without it a
  // script's `location.hash = …` arrives here unannounced, and is a push.
  const marksPushes = !!(nav && typeof nav.addEventListener === 'function');
  win.addEventListener('hashchange', () => {
    if (!fromTop && !marksPushes) pendingPush = true;
    schedule();
  });
  win.addEventListener('popstate', () => schedule());
  headerTitleStore.subscribe(() => {
    titled = true;
    schedule();
  });

  // ── 2. Boot ────────────────────────────────────────────────────────────
  // The first page is the frame's own address. A hint the top had for it (New
  // change's one-shot "what a proposal is") has to be in place before the
  // router runs, which is on DOMContentLoaded — after this module.
  try {
    const hint = top()?.takeBootHint?.();
    if (hint && hint.proposalHint && win.AppView) win.AppView._proposalHint = true;
  } catch { /* no top panel: nothing to apply */ }

  // `sv:authed` fires once, from the authed boot, right before its first
  // restoreFromHash; the report goes a turn later, after that pass.
  win.document.addEventListener('sv:authed', () => {
    win.setTimeout(() => {
      booted = true;
      pendingPush = false;
      fromTop = false;
      lastUrl = loc.href;
      top()?.ready?.(route(), title());
    }, 0);
  }, { once: true });

  // ── 3. Forward ─────────────────────────────────────────────────────────
  // Put this document's address back on the page it is still showing, after
  // a navigation it handed to the top window instead of taking.
  function restore(): void {
    replaceState(hist.state, '', lastUrl);
    if (win.App) win.App._currentRoute = loc.hash || '';
    pendingPush = false;
  }

  const runtime: EmbeddedRuntime = {
    go(next: string, hint: PanelHint | null) {
      fromTop = true;
      if (hint && hint.proposalHint && win.AppView) win.AppView._proposalHint = true;
      const url = next.startsWith('app/')
        ? `/${next}${loc.search}`
        : `/${loc.search}#${next}`;
      // Routed on THIS document's own turn, never inside the top window's
      // call. The top calls in here from its own handlers (a click, a
      // navigate event), which makes the TOP document the one the browser
      // resolves a relative `location.replace('#…')` against — the Messages
      // store rewriting a `#name` reference to `#messages/<id>` would then
      // send this frame to the top window's path, out of the panel mode
      // altogether. A callback of this document's own runs with this
      // document as its entry, and a microtask still lands before anything
      // the top does next.
      const land = () => {
        replaceState(hist.state, '', url);
        try {
          win.App?._routeFromHash?.();
        } finally {
          schedule();
        }
      };
      if (typeof win.queueMicrotask === 'function') win.queueMicrotask(land);
      else win.setTimeout(land, 0);
    },
    forward(next: string): boolean {
      if (!booted || embeddedAllows(next)) return false;
      const panel = top();
      if (!panel) return false;
      restore();
      const slug = appTabSlug(next);
      if (slug) panel.openApp?.(slug);
      else panel.leave?.(next);
      return true;
    },
    openApp(slug: string): void {
      if (!slug) return;
      // Reached from the router's app branch, the address already names the
      // App tab; from a button (openAppTab, switchTab) it has not moved.
      if (booted && appTabSlug(route())) restore();
      top()?.openApp?.(slug);
    },
    isBooted: () => booted,
  };
  return runtime;
}
