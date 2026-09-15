import { useEffect, useRef } from 'react';

export function nativeBackEnabled({ visible, mode, href, slug, tab }: {
  visible: boolean; mode: string; href: string | null;
  slug: string | null; tab: string | null;
}): boolean {
  return visible && mode === 'arrow' && !!href && !(slug && tab === 'app');
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
