/**
 * Mobile browsers collapse their toolbars when the document scrolls. The
 * native/installed shell and viewport-bound surfaces (app frames and chats)
 * keep their element scrollers. Only <html> is written here; React continues
 * to own the screen roots. Controllers use PlatformUI.scrollElement() when
 * reading or restoring a page's position.
 */
export const MOBILE_PAGE_QUERY = '(max-width: 767px), (hover: none) and (pointer: coarse)';

const AUTH_PAGES = [
  'auth-login-screen', 'auth-register-screen', 'auth-waiting-screen',
  'auth-waitlist-screen', 'auth-more-screen', 'auth-landing-screen',
];
const PAGES = ['home-screen', 'browse-screen', 'leaderboard-screen', 'profile-screen', 'settings-screen'];

export function pageScroller(doc: Document, preferred?: string | null): HTMLElement | null {
  const visible = (id: string) => {
    const el = doc.getElementById(id);
    return el && !el.classList.contains('hidden') ? el : null;
  };
  for (const id of AUTH_PAGES) {
    const root = visible(id);
    if (!root) continue;
    if (id !== 'auth-landing-screen') return root;
    // The guest app viewer shares the landing root but needs a bounded frame.
    return visible('auth-landing-scroll');
  }
  // A zoom transition can temporarily paint both the incoming and outgoing
  // roots. The router's revealed screen is authoritative during that overlap.
  if (preferred && PAGES.includes(preferred) && visible(preferred)) return visible(preferred);
  const appView = visible('app-view');
  if (appView) {
    return appView.dataset.appSurface === 'platform' && visible('app-content')
      ? visible('dev-forum-scroll') : null;
  }
  for (const id of PAGES) if (visible(id)) return visible(id);
  return null;
}

export function allowsPageScroll(win: Window, doc: Document): boolean {
  return win.self === win.top
    && win.matchMedia(MOBILE_PAGE_QUERY).matches
    && !win.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches
    && !(win.navigator as Navigator & { standalone?: boolean }).standalone
    && !doc.documentElement.classList.contains('in-native-webview');
}

export function createBrowserScroll(doc: Document, win: Window) {
  let active: HTMLElement | null = null;
  let lastTop = 0;
  const positions = new Map<string, number>();
  const originalRestoration = win.history?.scrollRestoration;
  const root = () => (doc.scrollingElement || doc.documentElement) as HTMLElement;
  const preferred = () => (win as Window & { App?: { _revealedScreen?: string } }).App?._revealedScreen;
  const remember = () => {
    // Dev owns per-app feed memory and restores it after the feed loads.
    if (active && active.id !== 'dev-forum-scroll') positions.set(active.id, lastTop);
  };
  const capture = () => {
    if (!active) return;
    lastTop = root().scrollTop;
    remember();
  };
  const sync = () => {
    const enabled = allowsPageScroll(win, doc);
    // Hash routes share a document. Browser history restoration otherwise
    // races the per-screen positions when Back also triggers a transition.
    if (win.history && originalRestoration) {
      win.history.scrollRestoration = enabled ? 'manual' : originalRestoration;
    }
    const next = enabled ? pageScroller(doc, preferred()) : null;
    if (next === active) return;
    const previous = active;
    // lastTop survives layout clamping when a route hides the outgoing page.
    remember();
    const previousTop = lastTop;
    const top = next ? (positions.get(next.id) ?? next.scrollTop) : 0;
    active = next;
    if (next) doc.documentElement.dataset.browserScroller = next.id;
    else delete doc.documentElement.dataset.browserScroller;
    if (previous) previous.scrollTop = previousTop;
    root().scrollTop = top;
    lastTop = root().scrollTop;
    // Notify effects which also follow the page when the offset stays at 0.
    win.dispatchEvent(new Event('usernode:page-scroll'));
  };
  return {
    capture,
    sync,
    scrollElement(el: HTMLElement | null) {
      // Callers can restore immediately after a synchronous screen render,
      // before the MutationObserver has received the visibility change.
      sync();
      return el && el === active ? root() : el;
    },
    onScroll(event: Event) {
      if (event.target === doc && active === pageScroller(doc, preferred())) capture();
      else if (!active && event.target === pageScroller(doc, preferred())) {
        const el = event.target as HTMLElement;
        positions.set(el.id, el.scrollTop);
      }
    },
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  const controller = createBrowserScroll(document, window);
  (window as Window & { UsernodeBrowserScroll?: typeof controller }).UsernodeBrowserScroll = controller;
  // Observe the visibility seam after React applies it, including the landing
  // app viewer and Dev sub-views which change without a top-level route swap.
  new MutationObserver(controller.sync).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ['class', 'data-app-surface'],
  });
  document.addEventListener('scroll', controller.onScroll, { capture: true, passive: true });
  window.addEventListener('resize', controller.sync);
  window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)')
    .addEventListener('change', controller.sync);
  controller.sync();
}
