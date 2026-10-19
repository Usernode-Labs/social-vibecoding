import { useEffect, useRef } from 'react';

/**
 * Whether the native back-swipe is on: only where the page HAS a back control
 * with a destination, and never while a dialog or sheet is open.
 *
 * That control is the header's arrow (`mode === 'arrow'` with an `href`)
 * everywhere but one family of routes. On a Workshop topic (an issue, a
 * proposal, a governance vote or a shared session) the back is the
 * "‹ Workshop" chip at the top of the pane, and the header draws none (#2916),
 * so the header passes the chip's destination as `paneHref`. Without it the
 * swipe would switch off on exactly the pages whose back control moved.
 *
 * A running app needs no rule of its own: its bar shows ✕ (`mode: 'close'`),
 * not an arrow. The improve target's `slug`/`tab` must not decide it either.
 * That target outlives the app: on every platform screen it still names the
 * platform's own app on its App tab, so a rule keyed on it kept the swipe off
 * everywhere (#3623).
 *
 * An open dialog takes the swipe away too. WebKit's gesture walks to the
 * record under the dialog and slides the whole page, so it springs back with
 * the dialog still up; a sheet closes by its own controls and device back.
 *
 * So does the phone's Communities drawer (../nav-drawer/, `drawerOn`): its
 * pan is the page's swipe back there, from the left edge too, and WebKit's
 * would take the same finger. A Workshop topic opened from the community's
 * pages is under the drawer now (polish board #23), chip and all.
 */
export function nativeBackEnabled({ visible, mode, href, paneHref = null, dialogOpen = false, drawerOn = false }: {
  visible: boolean; mode: string; href: string | null;
  paneHref?: string | null; dialogOpen?: boolean; drawerOn?: boolean;
}): boolean {
  if (!visible || dialogOpen || drawerOn) return false;
  return (mode === 'arrow' && !!href) || !!paneHref;
}

type NativeHost = {
  usernode?: {
    isNative?: boolean;
    setBackNavigationEnabled?: (state: { enabled: boolean }) => Promise<unknown>;
  };
  NativeChrome?: { getInfo(): Promise<{ degraded?: boolean; capabilities?: string[] } | null> };
};

// One native write at a time: a delayed capability probe or enable must never
// leave the gesture enabled after the user has entered an embedded app.
export function createBackNavigationPublisher(host: NativeHost) {
  let desired = false;
  let running: Promise<void> | null = null;
  let revision = 0;
  async function drain() {
    do {
      const current = revision;
      try {
        const bridge = host.usernode;
        if (!bridge?.isNative || !bridge.setBackNavigationEnabled) return;
        const info = await host.NativeChrome?.getInfo();
        if (info?.degraded || !info?.capabilities?.includes('setBackNavigationEnabled')) return;
        const enabled = desired;
        await bridge.setBackNavigationEnabled({ enabled });
      } catch (_) {
        // Navigation remains usable on older clients or a retiring realm.
        // A later route/lifecycle publication retries; no unbounded loop.
      }
      if (current === revision) return;
    } while (true);
  }
  return {
    setEnabled(enabled: boolean): Promise<void> {
      desired = enabled;
      revision += 1;
      if (!running) running = drain().finally(() => { running = null; });
      return running;
    },
  };
}

export function useNativeBackNavigation(enabled: boolean) {
  const current = useRef(enabled);
  current.current = enabled;
  const publisher = useRef<ReturnType<typeof createBackNavigationPublisher> | null>(null);
  useEffect(() => {
    const target = createBackNavigationPublisher(window as unknown as NativeHost);
    publisher.current = target;
    const resume = () => { void target.setEnabled(current.current); };
    const leave = () => { void target.setEnabled(false); };
    window.addEventListener('pageshow', resume);
    window.addEventListener('pagehide', leave);
    window.addEventListener('sv:authed', resume);
    return () => {
      window.removeEventListener('pageshow', resume);
      window.removeEventListener('pagehide', leave);
      window.removeEventListener('sv:authed', resume);
      publisher.current = null;
      leave();
    };
  }, []);
  useEffect(() => { void publisher.current?.setEnabled(enabled); }, [enabled]);
}
